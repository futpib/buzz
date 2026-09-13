import 'dart:io';

import 'package:sqlite3/sqlite3.dart';

/// On-disk schema version for the disposable Android projection.
const clientStateSchemaVersion = 1;

/// Opens an existing compatible client-state database.
Database openClientStateDatabase(String path) {
  Directory(File(path).parent.path).createSync(recursive: true);
  final database = sqlite3.open(path)
    ..execute('PRAGMA busy_timeout = 5000')
    ..execute('PRAGMA journal_mode = WAL')
    ..execute('PRAGMA synchronous = NORMAL')
    ..execute('PRAGMA foreign_keys = ON');
  try {
    _initialize(database);
    return database;
  } catch (_) {
    database.close();
    rethrow;
  }
}

void _initialize(Database database) {
  final versionRows = database.select(
    'SELECT version FROM client_state_schema LIMIT 1',
  );
  if (versionRows.isNotEmpty) {
    final version = versionRows.first['version'] as int;
    if (version != clientStateSchemaVersion) {
      throw StateError('unsupported client-state schema $version');
    }
    return;
  }
  throw StateError('client-state schema has no version');
}

/// Create the initial schema, or open the existing compatible schema.
Database initializeClientStateDatabase(String path) {
  try {
    return openClientStateDatabase(path);
  } on SqliteException catch (error) {
    if (!error.message.contains('no such table: client_state_schema')) {
      rethrow;
    }
  }

  final database = sqlite3.open(path)
    ..execute('PRAGMA busy_timeout = 5000')
    ..execute('PRAGMA journal_mode = WAL')
    ..execute('PRAGMA synchronous = NORMAL')
    ..execute('PRAGMA foreign_keys = ON');
  try {
    database.execute(_schemaSql);
    return database;
  } catch (_) {
    database.close();
    rethrow;
  }
}

/// Atomically removes one relay-and-viewer scope after lost backpressure.
void clearClientStateScope(Database database, String scope) {
  database.execute('BEGIN IMMEDIATE');
  try {
    for (final table in _scopedTables) {
      database.execute('DELETE FROM $table WHERE scope=?', [scope]);
    }
    database.execute('COMMIT');
  } catch (_) {
    try {
      database.execute('ROLLBACK');
    } catch (_) {
      // Preserve the original cache invalidation failure.
    }
    rethrow;
  }
}

const _scopedTables = <String>[
  'event_search',
  'event_mentions',
  'thread_participants',
  'thread_summaries',
  'reactions',
  'message_edits',
  'unread_events',
  'read_markers',
  'pending_memberships',
  'channels',
  'deleted_events',
  'events',
  'projection_meta',
];

const _schemaSql = '''
BEGIN;
CREATE TABLE client_state_schema(version INTEGER NOT NULL);
INSERT INTO client_state_schema(version) VALUES(1);

CREATE TABLE projection_meta(
  scope TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE events(
  scope TEXT NOT NULL,
  event_id TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  kind INTEGER NOT NULL,
  channel_id TEXT,
  target_id TEXT,
  root_id TEXT,
  parent_id TEXT,
  broadcast INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  sig TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(scope, event_id)
);
CREATE INDEX events_channel_page
  ON events(scope, channel_id, created_at DESC, event_id ASC);
CREATE INDEX events_thread_page
  ON events(scope, root_id, created_at ASC, event_id ASC);
CREATE INDEX events_kind
  ON events(scope, kind, created_at DESC, event_id ASC);
CREATE INDEX events_target
  ON events(scope, target_id, kind, created_at DESC, event_id ASC);

CREATE TABLE deleted_events(
  scope TEXT NOT NULL,
  target_event_id TEXT NOT NULL,
  deletion_event_id TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  PRIMARY KEY(scope, target_event_id)
);

CREATE TABLE channels(
  scope TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  metadata_event_id TEXT NOT NULL,
  metadata_created_at INTEGER NOT NULL,
  name TEXT NOT NULL,
  channel_type TEXT NOT NULL,
  visibility TEXT NOT NULL,
  description TEXT NOT NULL,
  topic TEXT,
  archived INTEGER NOT NULL,
  is_member INTEGER NOT NULL DEFAULT 0,
  member_count INTEGER NOT NULL DEFAULT 0,
  membership_event_id TEXT,
  membership_created_at INTEGER,
  last_event_id TEXT,
  last_event_at INTEGER,
  unread_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(scope, channel_id)
);
CREATE INDEX channels_display
  ON channels(scope, is_member DESC, archived, last_event_at DESC, name);

CREATE TABLE pending_memberships(
  scope TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  is_member INTEGER NOT NULL,
  member_count INTEGER NOT NULL,
  PRIMARY KEY(scope, channel_id)
);

CREATE TABLE read_markers(
  scope TEXT NOT NULL,
  context_id TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY(scope, context_id)
);

CREATE TABLE unread_events(
  scope TEXT NOT NULL,
  event_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  root_id TEXT,
  created_at INTEGER NOT NULL,
  unread INTEGER NOT NULL,
  PRIMARY KEY(scope, event_id)
);
CREATE INDEX unread_by_channel
  ON unread_events(scope, channel_id, unread);
CREATE INDEX unread_by_thread ON unread_events(scope, root_id);

CREATE TABLE message_edits(
  scope TEXT NOT NULL,
  target_event_id TEXT NOT NULL,
  edit_event_id TEXT NOT NULL,
  edit_created_at INTEGER NOT NULL,
  content TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  PRIMARY KEY(scope, target_event_id)
);

CREATE TABLE reactions(
  scope TEXT NOT NULL,
  reaction_event_id TEXT NOT NULL,
  target_event_id TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(scope, reaction_event_id)
);
CREATE INDEX reactions_target
  ON reactions(scope, target_event_id, emoji, pubkey, created_at DESC);

CREATE TABLE thread_summaries(
  scope TEXT NOT NULL,
  root_id TEXT NOT NULL,
  reply_count INTEGER NOT NULL DEFAULT 0,
  last_reply_at INTEGER,
  PRIMARY KEY(scope, root_id)
);

CREATE TABLE thread_participants(
  scope TEXT NOT NULL,
  root_id TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  last_reply_at INTEGER NOT NULL,
  PRIMARY KEY(scope, root_id, pubkey)
);
CREATE INDEX thread_participants_recent
  ON thread_participants(scope, root_id, last_reply_at DESC, pubkey);

CREATE TABLE event_mentions(
  scope TEXT NOT NULL,
  event_id TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  PRIMARY KEY(scope, event_id, pubkey)
);
CREATE INDEX event_mentions_recipient
  ON event_mentions(scope, pubkey, event_id);

CREATE VIRTUAL TABLE event_search USING fts5(
  scope UNINDEXED,
  event_id UNINDEXED,
  channel_id UNINDEXED,
  content,
  tokenize='unicode61'
);
COMMIT;
''';
