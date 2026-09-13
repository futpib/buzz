import 'dart:convert';

import 'package:nostr/nostr.dart' as nostr;
import 'package:sqlite3/sqlite3.dart';

import '../relay/nostr_models.dart';

/// SQL list of event kinds that contribute visible message/thread rows.
const messageKindsSql =
    '9,40001,40002,40008,40099,43001,43002,43003,43004,43005,43006,'
    '45001,45003,48100,48103';

const _messageKinds = <int>{
  9,
  40001,
  40002,
  40008,
  40099,
  43001,
  43002,
  43003,
  43004,
  43005,
  43006,
  45001,
  45003,
  48100,
  48103,
};
const _unreadKinds = <int>{9, 40001, 40002, 45001, 45003};
const _relevantKinds = <int>{
  ..._messageKinds,
  1,
  5,
  7,
  9005,
  39000,
  39002,
  40003,
  46010,
  46011,
  46012,
};

/// Verifies and atomically projects a bounded relay event batch.
Map<String, Object?> applyClientStateEvents(
  Database database,
  String scope,
  String viewerPubkey,
  List<Object?> rawEvents,
) {
  if (rawEvents.length > 10000) {
    throw ArgumentError.value(rawEvents.length, 'events', 'maximum is 10000');
  }
  var ignored = 0;
  final events = <_ProjectedEvent>[];
  for (final raw in rawEvents) {
    final Map<String, dynamic> map;
    if (raw is NostrEvent) {
      map = raw.toJson();
    } else if (raw is Map) {
      map = Map<String, dynamic>.from(raw);
    } else {
      throw const FormatException('event must be a Nostr event or map');
    }
    final kind = map['kind'];
    if (kind is! int) throw const FormatException('event kind must be an int');
    if (!_relevantKinds.contains(kind)) {
      ignored += 1;
      continue;
    }
    // Validation runs before the transaction so one bad signature rejects the
    // whole snapshot without leaving a partial projection.
    events.add(_ProjectedEvent.fromNostr(nostr.Event.fromMap(map)));
  }

  database.execute('BEGIN IMMEDIATE');
  try {
    _ensureScope(database, scope);
    var inserted = 0;
    var duplicates = 0;
    for (final event in events) {
      if (_insertEvent(database, scope, viewerPubkey, event)) {
        inserted += 1;
      } else {
        duplicates += 1;
      }
    }
    if (inserted > 0) {
      database.execute(
        'UPDATE projection_meta SET revision=revision+1 WHERE scope=?',
        [scope],
      );
    }
    final revision = _revision(database, scope);
    database.execute('COMMIT');
    return {
      'inserted': inserted,
      'duplicates': duplicates,
      'ignored': ignored,
      'revision': revision,
    };
  } catch (_) {
    _rollback(database);
    rethrow;
  }
}

/// Monotonically merges decoded read markers into one projection scope.
int applyClientStateReadMarkers(
  Database database,
  String scope,
  String viewerPubkey,
  List<Object?> rawMarkers,
) {
  if (rawMarkers.length > 10000) {
    throw ArgumentError.value(rawMarkers.length, 'markers', 'maximum is 10000');
  }
  database.execute('BEGIN IMMEDIATE');
  try {
    _ensureScope(database, scope);
    final affectedChannels = <String>{};
    var changed = false;
    for (final raw in rawMarkers) {
      if (raw is! Map) throw const FormatException('read marker must be a map');
      final marker = Map<String, dynamic>.from(raw);
      final contextId = marker['context_id'];
      final readAt = marker['read_at'];
      if (contextId is! String || contextId.isEmpty || readAt is! int) {
        throw const FormatException('invalid read marker');
      }
      database.execute(
        '''INSERT INTO read_markers(scope, context_id, read_at) VALUES(?, ?, ?)
           ON CONFLICT(scope, context_id) DO UPDATE SET read_at=excluded.read_at
           WHERE excluded.read_at > read_markers.read_at''',
        [scope, contextId, readAt],
      );
      if (database.updatedRows == 0) continue;
      changed = true;
      _collectMarkerChannels(database, scope, contextId, affectedChannels);
    }
    for (final channelId in affectedChannels) {
      _recomputeUnread(database, scope, viewerPubkey, channelId);
      _refreshChannelRollup(database, scope, channelId);
    }
    if (changed) {
      database.execute(
        'UPDATE projection_meta SET revision=revision+1 WHERE scope=?',
        [scope],
      );
    }
    final revision = _revision(database, scope);
    database.execute('COMMIT');
    return revision;
  } catch (_) {
    _rollback(database);
    rethrow;
  }
}

void _rollback(Database database) {
  try {
    database.execute('ROLLBACK');
  } catch (_) {
    // Preserve the original projection failure.
  }
}

void _ensureScope(Database database, String scope) {
  database.execute(
    'INSERT OR IGNORE INTO projection_meta(scope, revision) VALUES(?, 0)',
    [scope],
  );
}

int _revision(Database database, String scope) =>
    database.select('SELECT revision FROM projection_meta WHERE scope=?', [
          scope,
        ]).single['revision']
        as int;

bool _insertEvent(
  Database database,
  String scope,
  String viewerPubkey,
  _ProjectedEvent event,
) {
  final channelId = event.kind == 39000 || event.kind == 39002
      ? event.firstTag('d')
      : event.firstTag('h');
  final targetId = event.lastTag('e');
  final thread = event.threadReference;
  final deleted =
      database
              .select(
                '''SELECT EXISTS(
         SELECT 1 FROM deleted_events WHERE scope=? AND target_event_id=?
       ) AS value''',
                [scope, event.id],
              )
              .single['value']
          as int;
  database.execute(
    '''INSERT OR IGNORE INTO events(
         scope, event_id, pubkey, created_at, kind, channel_id, target_id,
         root_id, parent_id, broadcast, content, tags_json, sig, deleted
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
    [
      scope,
      event.id,
      event.pubkey,
      event.createdAt,
      event.kind,
      channelId,
      targetId,
      thread.rootId,
      thread.parentId,
      event.hasTagValue('broadcast', '1') ? 1 : 0,
      event.content,
      jsonEncode(event.tags),
      event.sig,
      deleted,
    ],
  );
  if (database.updatedRows == 0) return false;

  for (final mentioned in event.tagValues('p')) {
    database.execute(
      '''INSERT OR IGNORE INTO event_mentions(scope, event_id, pubkey)
         VALUES(?, ?, ?)''',
      [scope, event.id, mentioned.toLowerCase()],
    );
  }
  if (deleted != 0) return true;

  switch (event.kind) {
    case 39000:
      _projectChannelMetadata(database, scope, event);
    case 39002:
      _projectMembership(database, scope, viewerPubkey, event);
    case 5:
    case 9005:
      _projectDeletion(database, scope, viewerPubkey, event);
    case 40003:
      _projectEdit(database, scope, event);
    case 7:
      _projectReaction(database, scope, event);
    default:
      if (_messageKinds.contains(event.kind)) {
        _projectMessage(database, scope, viewerPubkey, event);
      }
  }
  return true;
}

void _projectChannelMetadata(
  Database database,
  String scope,
  _ProjectedEvent event,
) {
  final channelId = event.firstTag('d');
  if (channelId == null) return;
  final existing = database.select(
    '''SELECT metadata_created_at, metadata_event_id FROM channels
       WHERE scope=? AND channel_id=?''',
    [scope, channelId],
  );
  if (existing.isNotEmpty &&
      !_incomingWins(
        event.createdAt,
        event.id,
        existing.first['metadata_created_at'] as int,
        existing.first['metadata_event_id'] as String,
      )) {
    return;
  }
  final pending = database.select(
    '''SELECT event_id, created_at, is_member, member_count
       FROM pending_memberships WHERE scope=? AND channel_id=?''',
    [scope, channelId],
  );
  final membership = pending.isEmpty ? null : pending.first;
  database.execute(
    '''INSERT INTO channels(
         scope, channel_id, metadata_event_id, metadata_created_at, name,
         channel_type, visibility, description, topic, archived, is_member,
         member_count, membership_event_id, membership_created_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, channel_id) DO UPDATE SET
         metadata_event_id=excluded.metadata_event_id,
         metadata_created_at=excluded.metadata_created_at,
         name=excluded.name,
         channel_type=excluded.channel_type,
         visibility=excluded.visibility,
         description=excluded.description,
         topic=excluded.topic,
         archived=excluded.archived''',
    [
      scope,
      channelId,
      event.id,
      event.createdAt,
      event.firstTag('name') ?? '',
      event.firstTag('t') ?? (event.hasTag('hidden') ? 'dm' : 'stream'),
      event.hasTag('private') ? 'private' : 'open',
      event.firstTag('about') ?? '',
      event.firstTag('topic'),
      event.hasTagValue('archived', 'true') ? 1 : 0,
      membership?['is_member'] ?? 0,
      membership?['member_count'] ?? 0,
      membership?['event_id'],
      membership?['created_at'],
    ],
  );
  _refreshChannelRollup(database, scope, channelId);
}

void _projectMembership(
  Database database,
  String scope,
  String viewerPubkey,
  _ProjectedEvent event,
) {
  final channelId = event.firstTag('d');
  if (channelId == null) return;
  final members = event
      .tagValues('p')
      .map((value) => value.toLowerCase())
      .toSet();
  final existing = database.select(
    '''SELECT created_at, event_id FROM pending_memberships
       WHERE scope=? AND channel_id=?''',
    [scope, channelId],
  );
  if (existing.isNotEmpty &&
      !_incomingWins(
        event.createdAt,
        event.id,
        existing.first['created_at'] as int,
        existing.first['event_id'] as String,
      )) {
    return;
  }
  final isMember = members.contains(viewerPubkey) ? 1 : 0;
  database.execute(
    '''INSERT INTO pending_memberships(
         scope, channel_id, event_id, created_at, is_member, member_count
       ) VALUES(?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, channel_id) DO UPDATE SET
         event_id=excluded.event_id, created_at=excluded.created_at,
         is_member=excluded.is_member, member_count=excluded.member_count''',
    [scope, channelId, event.id, event.createdAt, isMember, members.length],
  );
  database.execute(
    '''UPDATE channels SET is_member=?, member_count=?,
         membership_event_id=?, membership_created_at=?
       WHERE scope=? AND channel_id=?''',
    [isMember, members.length, event.id, event.createdAt, scope, channelId],
  );
}

void _projectMessage(
  Database database,
  String scope,
  String viewerPubkey,
  _ProjectedEvent event,
) {
  final channelId = event.firstTag('h');
  if (channelId == null) return;
  final rootId = event.threadReference.rootId;
  if (_unreadKinds.contains(event.kind)) {
    final unread =
        event.pubkey != viewerPubkey &&
        _isUnread(
          database,
          scope,
          channelId,
          event.id,
          rootId,
          event.createdAt,
        );
    database.execute(
      '''INSERT OR REPLACE INTO unread_events(
           scope, event_id, channel_id, root_id, created_at, unread
         ) VALUES(?, ?, ?, ?, ?, ?)''',
      [scope, event.id, channelId, rootId, event.createdAt, unread ? 1 : 0],
    );
  }
  _replaceSearchRow(database, scope, event.id);
  if (rootId != null) _rebuildThreadSummary(database, scope, rootId);
  _refreshChannelRollup(database, scope, channelId);
}

void _projectEdit(Database database, String scope, _ProjectedEvent event) {
  final targetId = event.lastTag('e');
  if (targetId == null) return;
  final existing = database.select(
    '''SELECT edit_created_at, edit_event_id FROM message_edits
       WHERE scope=? AND target_event_id=?''',
    [scope, targetId],
  );
  if (existing.isNotEmpty &&
      !_incomingWins(
        event.createdAt,
        event.id,
        existing.first['edit_created_at'] as int,
        existing.first['edit_event_id'] as String,
      )) {
    return;
  }
  database.execute(
    '''INSERT INTO message_edits(
         scope, target_event_id, edit_event_id, edit_created_at, content, tags_json
       ) VALUES(?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, target_event_id) DO UPDATE SET
         edit_event_id=excluded.edit_event_id,
         edit_created_at=excluded.edit_created_at,
         content=excluded.content, tags_json=excluded.tags_json''',
    [
      scope,
      targetId,
      event.id,
      event.createdAt,
      event.content,
      jsonEncode(event.tags),
    ],
  );
  _replaceSearchRow(database, scope, targetId);
}

void _projectReaction(Database database, String scope, _ProjectedEvent event) {
  final targetId = event.lastTag('e');
  final emoji = event.content.trim();
  if (targetId == null || emoji.isEmpty) return;
  database.execute(
    '''INSERT OR IGNORE INTO reactions(
         scope, reaction_event_id, target_event_id, pubkey, emoji, created_at, deleted
       ) VALUES(?, ?, ?, ?, ?, ?, 0)''',
    [scope, event.id, targetId, event.pubkey, emoji, event.createdAt],
  );
}

void _projectDeletion(
  Database database,
  String scope,
  String viewerPubkey,
  _ProjectedEvent event,
) {
  for (final targetId in event.tagValues('e')) {
    if (!_isHexId(targetId)) continue;
    database.execute(
      '''INSERT OR IGNORE INTO deleted_events(
           scope, target_event_id, deletion_event_id, deleted_at
         ) VALUES(?, ?, ?, ?)''',
      [scope, targetId, event.id, event.createdAt],
    );
    final targets = database.select(
      '''SELECT kind, channel_id, root_id, target_id FROM events
         WHERE scope=? AND event_id=?''',
      [scope, targetId],
    );
    database.execute(
      'UPDATE events SET deleted=1 WHERE scope=? AND event_id=?',
      [scope, targetId],
    );
    database.execute(
      '''UPDATE reactions SET deleted=1
         WHERE scope=? AND reaction_event_id=?''',
      [scope, targetId],
    );
    database.execute('DELETE FROM unread_events WHERE scope=? AND event_id=?', [
      scope,
      targetId,
    ]);
    database.execute('DELETE FROM event_search WHERE scope=? AND event_id=?', [
      scope,
      targetId,
    ]);
    if (targets.isEmpty) continue;
    final target = targets.first;
    final kind = target['kind'] as int;
    final channelId = target['channel_id'] as String?;
    final rootId = target['root_id'] as String?;
    if (kind == 40003 && target['target_id'] is String) {
      _rebuildEdit(database, scope, target['target_id'] as String);
    }
    if (kind == 39000 && channelId != null) {
      _rebuildChannelMetadata(database, scope, channelId);
    }
    if (kind == 39002 && channelId != null) {
      _rebuildMembership(database, scope, channelId, viewerPubkey);
    }
    if (rootId != null) _rebuildThreadSummary(database, scope, rootId);
    if (channelId != null) {
      _recomputeUnread(database, scope, viewerPubkey, channelId);
      _refreshChannelRollup(database, scope, channelId);
    }
  }
}

void _rebuildEdit(Database database, String scope, String targetId) {
  database.execute(
    'DELETE FROM message_edits WHERE scope=? AND target_event_id=?',
    [scope, targetId],
  );
  final candidates = database.select(
    '''SELECT event_id, created_at, content, tags_json FROM events
       WHERE scope=? AND kind=40003 AND target_id=? AND deleted=0
       ORDER BY created_at DESC, event_id ASC LIMIT 1''',
    [scope, targetId],
  );
  if (candidates.isNotEmpty) {
    final row = candidates.first;
    database.execute(
      '''INSERT INTO message_edits(
           scope, target_event_id, edit_event_id, edit_created_at, content, tags_json
         ) VALUES(?, ?, ?, ?, ?, ?)''',
      [
        scope,
        targetId,
        row['event_id'],
        row['created_at'],
        row['content'],
        row['tags_json'],
      ],
    );
  }
  _replaceSearchRow(database, scope, targetId);
}

void _rebuildChannelMetadata(
  Database database,
  String scope,
  String channelId,
) {
  database.execute('DELETE FROM channels WHERE scope=? AND channel_id=?', [
    scope,
    channelId,
  ]);
  final candidates = database.select(
    '''SELECT event_id, pubkey, created_at, kind, content, tags_json, sig
       FROM events WHERE scope=? AND channel_id=? AND kind=39000 AND deleted=0
       ORDER BY created_at DESC, event_id ASC LIMIT 1''',
    [scope, channelId],
  );
  if (candidates.isNotEmpty) {
    _projectChannelMetadata(
      database,
      scope,
      _ProjectedEvent.fromRow(candidates.first),
    );
  }
}

void _rebuildMembership(
  Database database,
  String scope,
  String channelId,
  String viewerPubkey,
) {
  database.execute(
    'DELETE FROM pending_memberships WHERE scope=? AND channel_id=?',
    [scope, channelId],
  );
  database.execute(
    '''UPDATE channels SET is_member=0, member_count=0,
       membership_event_id=NULL, membership_created_at=NULL
       WHERE scope=? AND channel_id=?''',
    [scope, channelId],
  );
  final candidates = database.select(
    '''SELECT event_id, pubkey, created_at, kind, content, tags_json, sig
       FROM events WHERE scope=? AND channel_id=? AND kind=39002 AND deleted=0
       ORDER BY created_at DESC, event_id ASC LIMIT 1''',
    [scope, channelId],
  );
  if (candidates.isNotEmpty) {
    _projectMembership(
      database,
      scope,
      viewerPubkey,
      _ProjectedEvent.fromRow(candidates.first),
    );
  }
}

void _replaceSearchRow(Database database, String scope, String eventId) {
  database.execute('DELETE FROM event_search WHERE scope=? AND event_id=?', [
    scope,
    eventId,
  ]);
  final rows = database.select(
    '''SELECT e.channel_id, COALESCE(m.content, e.content) AS content
       FROM events e LEFT JOIN message_edits m
         ON m.scope=e.scope AND m.target_event_id=e.event_id
       WHERE e.scope=? AND e.event_id=? AND e.deleted=0
         AND e.kind IN (9,40001,40002,45001,45003)''',
    [scope, eventId],
  );
  if (rows.isEmpty || rows.first['channel_id'] == null) return;
  database.execute(
    '''INSERT INTO event_search(scope, event_id, channel_id, content)
       VALUES(?, ?, ?, ?)''',
    [scope, eventId, rows.first['channel_id'], rows.first['content']],
  );
}

void _rebuildThreadSummary(Database database, String scope, String rootId) {
  final summary = database
      .select(
        '''SELECT COUNT(*) AS count, MAX(created_at) AS last FROM events
       WHERE scope=? AND root_id=? AND deleted=0
         AND kind IN ($messageKindsSql)''',
        [scope, rootId],
      )
      .single;
  database.execute(
    '''INSERT INTO thread_summaries(scope, root_id, reply_count, last_reply_at)
       VALUES(?, ?, ?, ?)
       ON CONFLICT(scope, root_id) DO UPDATE SET
         reply_count=excluded.reply_count, last_reply_at=excluded.last_reply_at''',
    [scope, rootId, summary['count'], summary['last']],
  );
  database.execute(
    'DELETE FROM thread_participants WHERE scope=? AND root_id=?',
    [scope, rootId],
  );
  database.execute(
    '''INSERT INTO thread_participants(scope, root_id, pubkey, last_reply_at)
       SELECT scope, root_id, pubkey, MAX(created_at) FROM events
       WHERE scope=? AND root_id=? AND deleted=0
         AND kind IN ($messageKindsSql)
       GROUP BY scope, root_id, pubkey''',
    [scope, rootId],
  );
}

void _recomputeUnread(
  Database database,
  String scope,
  String viewerPubkey,
  String channelId,
) {
  database.execute(
    '''UPDATE unread_events AS u SET unread=CASE
       WHEN EXISTS(
         SELECT 1 FROM events e WHERE e.scope=u.scope AND e.event_id=u.event_id
           AND e.deleted=0 AND e.pubkey<>?
       ) AND u.created_at > MAX(
         COALESCE((SELECT read_at FROM read_markers r
           WHERE r.scope=u.scope AND r.context_id=u.channel_id), -1),
         COALESCE((SELECT read_at FROM read_markers r
           WHERE r.scope=u.scope AND r.context_id='msg:' || u.event_id), -1),
         COALESCE((SELECT read_at FROM read_markers r
           WHERE r.scope=u.scope AND r.context_id='thread:' || u.root_id), -1)
       ) THEN 1 ELSE 0 END
       WHERE u.scope=? AND u.channel_id=?''',
    [viewerPubkey, scope, channelId],
  );
}

bool _isUnread(
  Database database,
  String scope,
  String channelId,
  String eventId,
  String? rootId,
  int createdAt,
) {
  final readAt =
      database
              .select(
                '''SELECT MAX(read_at) AS value FROM read_markers
       WHERE scope=? AND context_id IN (?, ?, ?)''',
                [
                  scope,
                  channelId,
                  'msg:$eventId',
                  rootId == null ? '' : 'thread:$rootId',
                ],
              )
              .single['value']
          as int?;
  return readAt == null || createdAt > readAt;
}

void _refreshChannelRollup(Database database, String scope, String channelId) {
  final latest = database.select(
    '''SELECT event_id, created_at FROM events
       WHERE scope=? AND channel_id=? AND deleted=0
         AND kind IN (9,40001,40002,45001,45003)
       ORDER BY created_at DESC, event_id ASC LIMIT 1''',
    [scope, channelId],
  );
  final unread =
      database
              .select(
                '''SELECT COUNT(*) AS value FROM unread_events
       WHERE scope=? AND channel_id=? AND unread=1''',
                [scope, channelId],
              )
              .single['value']
          as int;
  database.execute(
    '''UPDATE channels SET last_event_id=?, last_event_at=?, unread_count=?
       WHERE scope=? AND channel_id=?''',
    [
      latest.isEmpty ? null : latest.first['event_id'],
      latest.isEmpty ? null : latest.first['created_at'],
      unread,
      scope,
      channelId,
    ],
  );
}

void _collectMarkerChannels(
  Database database,
  String scope,
  String contextId,
  Set<String> channels,
) {
  if (contextId.startsWith('msg:')) {
    final rows = database.select(
      'SELECT channel_id FROM events WHERE scope=? AND event_id=?',
      [scope, contextId.substring(4)],
    );
    if (rows.isNotEmpty && rows.first['channel_id'] is String) {
      channels.add(rows.first['channel_id'] as String);
    }
  } else if (contextId.startsWith('thread:')) {
    final rootId = contextId.substring(7);
    final rows = database.select(
      '''SELECT DISTINCT channel_id FROM events
         WHERE scope=? AND (root_id=? OR event_id=?) AND channel_id IS NOT NULL''',
      [scope, rootId, rootId],
    );
    channels.addAll(rows.map((row) => row['channel_id'] as String));
  } else {
    channels.add(contextId);
  }
}

bool _incomingWins(
  int incomingAt,
  String incomingId,
  int oldAt,
  String oldId,
) =>
    incomingAt > oldAt ||
    (incomingAt == oldAt && incomingId.compareTo(oldId) < 0);

bool _isHexId(String value) =>
    value.length == 64 && RegExp(r'^[0-9a-fA-F]+$').hasMatch(value);

class _ProjectedEvent {
  const _ProjectedEvent({
    required this.id,
    required this.pubkey,
    required this.createdAt,
    required this.kind,
    required this.tags,
    required this.content,
    required this.sig,
  });

  factory _ProjectedEvent.fromNostr(nostr.Event event) => _ProjectedEvent(
    id: event.id,
    pubkey: event.pubkey.toLowerCase(),
    createdAt: event.createdAt,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
    sig: event.sig,
  );

  factory _ProjectedEvent.fromRow(Row row) => _ProjectedEvent(
    id: row['event_id'] as String,
    pubkey: (row['pubkey'] as String).toLowerCase(),
    createdAt: row['created_at'] as int,
    kind: row['kind'] as int,
    tags: (jsonDecode(row['tags_json'] as String) as List<dynamic>)
        .map((tag) => (tag as List<dynamic>).cast<String>())
        .toList(),
    content: row['content'] as String,
    sig: row['sig'] as String,
  );

  final String id;
  final String pubkey;
  final int createdAt;
  final int kind;
  final List<List<String>> tags;
  final String content;
  final String sig;

  String? firstTag(String key) {
    for (final tag in tags) {
      if (tag.length >= 2 && tag.first == key) return tag[1];
    }
    return null;
  }

  String? lastTag(String key) {
    for (final tag in tags.reversed) {
      if (tag.length >= 2 && tag.first == key) return tag[1];
    }
    return null;
  }

  Iterable<String> tagValues(String key) sync* {
    for (final tag in tags) {
      if (tag.length >= 2 && tag.first == key) yield tag[1];
    }
  }

  bool hasTag(String key) =>
      tags.any((tag) => tag.isNotEmpty && tag.first == key);

  bool hasTagValue(String key, String value) =>
      tags.any((tag) => tag.length >= 2 && tag.first == key && tag[1] == value);

  ({String? rootId, String? parentId}) get threadReference {
    String? root;
    String? reply;
    for (final tag in tags) {
      if (tag.length < 4 || tag.first != 'e' || !_isHexId(tag[1])) continue;
      if (tag[3] == 'root') root = tag[1];
      if (tag[3] == 'reply') reply = tag[1];
    }
    if (reply == null) return (rootId: null, parentId: null);
    return (rootId: root ?? reply, parentId: reply);
  }
}
