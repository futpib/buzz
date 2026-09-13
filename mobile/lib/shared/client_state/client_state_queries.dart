import 'dart:convert';

import 'package:sqlite3/sqlite3.dart';

const _messageColumns = '''
e.event_id AS event_id,
e.kind AS kind,
e.pubkey AS pubkey,
e.created_at AS created_at,
COALESCE(m.content, e.content) AS effective_content,
COALESCE(m.tags_json, e.tags_json) AS effective_tags_json,
e.channel_id AS channel_id,
e.root_id AS root_id,
e.parent_id AS parent_id,
m.edit_event_id IS NOT NULL AS edited
''';

/// Returns the locally materialized channel list for a scope.
List<Map<String, Object?>> queryClientStateChannels(
  Database database,
  String scope,
  bool membersOnly,
) => database
    .select(
      '''SELECT c.channel_id, c.name, c.channel_type, c.visibility,
         c.description, c.topic, c.archived, c.is_member, c.member_count,
         c.last_event_id, c.last_event_at, c.unread_count,
         e.pubkey AS created_by, c.metadata_created_at AS created_at
       FROM channels c
       JOIN events e ON e.scope=c.scope AND e.event_id=c.metadata_event_id
       WHERE c.scope=? AND (?=0 OR c.is_member=1)
       ORDER BY c.archived ASC,
         COALESCE(c.last_event_at, c.metadata_created_at) DESC,
         c.name COLLATE NOCASE ASC, c.channel_id ASC''',
      [scope, membersOnly ? 1 : 0],
    )
    .map(
      (row) => <String, Object?>{
        'channel_id': row['channel_id'],
        'name': row['name'],
        'channel_type': row['channel_type'],
        'visibility': row['visibility'],
        'description': row['description'],
        'topic': row['topic'],
        'archived': (row['archived'] as int) != 0,
        'is_member': (row['is_member'] as int) != 0,
        'member_count': row['member_count'],
        'last_event_id': row['last_event_id'],
        'last_event_at': row['last_event_at'],
        'unread_count': row['unread_count'],
        'created_by': row['created_by'],
        'created_at': row['created_at'],
      },
    )
    .toList(growable: false);

/// Returns raw events and overlays needed to paint a channel snapshot.
List<Map<String, Object?>> queryClientStateChannelEvents(
  Database database,
  String scope,
  String channelId,
  int limit,
) => _relatedEvents(database, scope, 'e.channel_id=?', [
  channelId,
], limit.clamp(1, 5000));

/// Returns raw events and overlays needed to paint a thread snapshot.
List<Map<String, Object?>> queryClientStateThreadEvents(
  Database database,
  String scope,
  String rootId,
  int limit,
) => _relatedEvents(database, scope, '(e.event_id=? OR e.root_id=?)', [
  rootId,
  rootId,
], limit.clamp(1, 5000));

List<Map<String, Object?>> _relatedEvents(
  Database database,
  String scope,
  String seedPredicate,
  List<Object?> seedParameters,
  int limit,
) {
  if (seedParameters.isEmpty) throw StateError('event seed is required');
  final rows = database.select(
    '''WITH RECURSIVE related(event_id) AS (
         SELECT e.event_id FROM events e
         WHERE e.scope=? AND $seedPredicate
         UNION
         SELECT e.event_id FROM events e
         JOIN related r ON e.target_id=r.event_id
         WHERE e.scope=?
       ), latest AS (
         SELECT e.event_id, e.pubkey, e.created_at, e.kind, e.tags_json,
                e.content, e.sig
         FROM events e JOIN related r ON r.event_id=e.event_id
         WHERE e.scope=?
         ORDER BY e.created_at DESC, e.event_id ASC LIMIT ?
       )
       SELECT event_id, pubkey, created_at, kind, tags_json, content, sig
       FROM latest ORDER BY created_at ASC, event_id ASC''',
    [scope, ...seedParameters, scope, scope, limit],
  );
  return rows
      .map(
        (row) => <String, Object?>{
          'id': row['event_id'],
          'pubkey': row['pubkey'],
          'created_at': row['created_at'],
          'kind': row['kind'],
          'tags': jsonDecode(row['tags_json'] as String),
          'content': row['content'],
          'sig': row['sig'],
        },
      )
      .toList(growable: false);
}

/// Returns locally grouped activity conversations for a viewer.
List<Map<String, Object?>> queryClientStateActivity(
  Database database,
  String scope,
  String viewerPubkey,
  int limit,
) {
  final rows = database.select(
    '''WITH categorized AS (
       SELECT e.*,
         CASE
           WHEN e.kind IN (46010,46011,46012) AND em.event_id IS NOT NULL THEN 0
           WHEN e.kind IN (1,9,40002,45001,45003)
             AND em.event_id IS NOT NULL AND e.pubkey<>? THEN 1
           WHEN e.kind IN (43001,43002,43003,43004,43005,43006)
             AND em.event_id IS NOT NULL THEN 2
           WHEN e.kind=9 AND c.channel_type='dm' AND e.pubkey<>? THEN 3
         END AS category,
         CASE
           WHEN e.root_id IS NOT NULL THEN e.root_id
           WHEN e.kind=9 AND c.channel_type='dm'
             THEN 'dm:' || COALESCE(e.channel_id, '')
           ELSE e.event_id
         END AS conversation_id
       FROM events e
       LEFT JOIN event_mentions em
         ON em.scope=e.scope AND em.event_id=e.event_id AND em.pubkey=?
       LEFT JOIN channels c ON c.scope=e.scope AND c.channel_id=e.channel_id
       WHERE e.scope=? AND e.deleted=0
     ), ranked AS (
       SELECT categorized.*,
         ROW_NUMBER() OVER (
           PARTITION BY conversation_id ORDER BY created_at DESC, event_id ASC
         ) AS conversation_position,
         MIN(category) OVER (PARTITION BY conversation_id) AS best_category,
         MAX(created_at) OVER (PARTITION BY conversation_id) AS latest_activity_at
       FROM categorized WHERE category IS NOT NULL
     )
     SELECT $_messageColumns, e.best_category, e.conversation_id,
            e.latest_activity_at
     FROM ranked e
     LEFT JOIN message_edits m
       ON m.scope=e.scope AND m.target_event_id=e.event_id
     WHERE e.conversation_position=1
     ORDER BY e.latest_activity_at DESC, e.event_id ASC LIMIT ?''',
    [viewerPubkey, viewerPubkey, viewerPubkey, scope, limit.clamp(1, 500)],
  );
  final messages = rows.map(_messageFromRow).toList(growable: false);
  _attachReactions(database, scope, viewerPubkey, messages);
  return [
    for (var index = 0; index < messages.length; index += 1)
      <String, Object?>{
        'conversation_id': rows[index]['conversation_id'],
        'message': messages[index],
        'category': _activityCategory(rows[index]['best_category'] as int),
        'latest_activity_at': rows[index]['latest_activity_at'],
        'read': _activityIsRead(
          database,
          scope,
          messages[index],
          rows[index]['latest_activity_at'] as int,
        ),
      },
  ];
}

/// Searches the local FTS projection and attaches effective overlays.
List<Map<String, Object?>> queryClientStateSearch(
  Database database,
  String scope,
  String viewerPubkey,
  String input,
  int limit,
) {
  if (utf8.encode(input).length > 1024) {
    throw ArgumentError.value(input, 'text', 'maximum is 1024 UTF-8 bytes');
  }
  final matchQuery = _ftsQuery(input);
  if (matchQuery == null) return const [];
  final rows = database.select(
    '''SELECT $_messageColumns, bm25(event_search) AS score
       FROM event_search
       JOIN events e
         ON e.scope=event_search.scope AND e.event_id=event_search.event_id
       LEFT JOIN message_edits m
         ON m.scope=e.scope AND m.target_event_id=e.event_id
       WHERE event_search MATCH ? AND event_search.scope=? AND e.deleted=0
       ORDER BY bm25(event_search), e.created_at DESC, e.event_id ASC LIMIT ?''',
    [matchQuery, scope, limit.clamp(1, 500)],
  );
  final messages = rows.map(_messageFromRow).toList(growable: false);
  _attachReactions(database, scope, viewerPubkey, messages);
  return [
    for (var index = 0; index < messages.length; index += 1)
      <String, Object?>{
        'message': messages[index],
        'score': rows[index]['score'],
      },
  ];
}

Map<String, Object?> _messageFromRow(Row row) => <String, Object?>{
  'event_id': row['event_id'],
  'kind': row['kind'],
  'pubkey': row['pubkey'],
  'created_at': row['created_at'],
  'content': row['effective_content'],
  'tags': jsonDecode(row['effective_tags_json'] as String),
  'channel_id': row['channel_id'],
  'root_id': row['root_id'],
  'parent_id': row['parent_id'],
  'edited': (row['edited'] as int) != 0,
  'reactions': <Map<String, Object?>>[],
};

void _attachReactions(
  Database database,
  String scope,
  String viewerPubkey,
  List<Map<String, Object?>> messages,
) {
  if (messages.isEmpty) return;
  final ids = messages.map((message) => message['event_id'] as String).toList();
  final placeholders = List.filled(ids.length, '?').join(',');
  final rows = database.select(
    '''SELECT target_event_id, emoji, pubkey, reaction_event_id FROM (
       SELECT target_event_id, emoji, pubkey, reaction_event_id, deleted,
         ROW_NUMBER() OVER (
           PARTITION BY target_event_id, emoji, pubkey
           ORDER BY created_at DESC, reaction_event_id ASC
         ) AS position
       FROM reactions WHERE scope=? AND target_event_id IN ($placeholders)
     ) WHERE position=1 AND deleted=0
     ORDER BY target_event_id, emoji, pubkey''',
    [scope, ...ids],
  );
  final grouped = <String, Map<String, List<({String pubkey, String id})>>>{};
  for (final row in rows) {
    final targetId = row['target_event_id'] as String;
    final emoji = row['emoji'] as String;
    grouped.putIfAbsent(targetId, () => {}).putIfAbsent(emoji, () => []).add((
      pubkey: row['pubkey'] as String,
      id: row['reaction_event_id'] as String,
    ));
  }
  for (final message in messages) {
    final groups = grouped[message['event_id']];
    if (groups == null) continue;
    message['reactions'] = [
      for (final entry in groups.entries)
        <String, Object?>{
          'emoji': entry.key,
          'count': entry.value.length,
          'user_pubkeys': [for (final user in entry.value) user.pubkey],
          'current_user_reaction_id': entry.value
              .where((user) => user.pubkey == viewerPubkey)
              .firstOrNull
              ?.id,
        },
    ];
  }
}

bool _activityIsRead(
  Database database,
  String scope,
  Map<String, Object?> message,
  int latestActivityAt,
) {
  final contexts = <String>[];
  final rootId = message['root_id'] as String?;
  final channelId = message['channel_id'] as String?;
  if (rootId != null) {
    contexts.add('thread:$rootId');
  } else if (channelId != null) {
    contexts.add(channelId);
  }
  contexts.add('msg:${message['event_id']}');
  final placeholders = List.filled(contexts.length, '?').join(',');
  final readAt =
      database
              .select(
                '''SELECT MAX(read_at) AS value FROM read_markers
       WHERE scope=? AND context_id IN ($placeholders)''',
                [scope, ...contexts],
              )
              .single['value']
          as int?;
  return readAt != null && readAt >= latestActivityAt;
}

String _activityCategory(int value) => switch (value) {
  0 => 'needs_action',
  1 => 'mention',
  2 => 'agent_activity',
  3 => 'activity',
  _ => throw StateError('unknown activity category $value'),
};

String? _ftsQuery(String input) {
  final terms = input
      .split(RegExp(r'\s+'))
      .where((term) => term.isNotEmpty)
      .map((term) => '"${term.replaceAll('"', '""')}"*')
      .toList(growable: false);
  return terms.isEmpty ? null : terms.join(' AND ');
}
