import 'dart:io';

import 'package:buzz/shared/client_state/client_state_projection.dart';
import 'package:buzz/shared/client_state/client_state_database.dart';
import 'package:buzz/shared/client_state/client_state_projector.dart';
import 'package:buzz/shared/client_state/client_state_worker.dart';
import 'package:buzz/shared/relay/nostr_models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nostr/nostr.dart' as nostr;

const _viewerSecret =
    '0000000000000000000000000000000000000000000000000000000000000001';
const _authorSecret =
    '0000000000000000000000000000000000000000000000000000000000000002';
const _relaySecret =
    '0000000000000000000000000000000000000000000000000000000000000003';
const _otherViewerSecret =
    '0000000000000000000000000000000000000000000000000000000000000004';
const _channelId = '11111111-1111-4111-8111-111111111111';

void main() {
  late Directory directory;
  late String databasePath;
  late ClientStateProjection projection;

  setUp(() async {
    directory = await Directory.systemTemp.createTemp('buzz-dart-state-');
    databasePath = '${directory.path}/state.sqlite';
    projection = _projection(databasePath);
  });

  tearDown(() async {
    await projection.dispose();
    if (directory.existsSync()) directory.deleteSync(recursive: true);
  });

  test('projects the Android hot path and persists it', () async {
    final viewerPubkey = _pubkey(_viewerSecret);
    final authorPubkey = _pubkey(_authorSecret);
    final metadata = _signed(
      _relaySecret,
      kind: 39000,
      createdAt: 100,
      tags: const [
        ['d', _channelId],
        ['name', 'Fast lane'],
        ['t', 'stream'],
        ['public'],
        ['about', 'Client projections'],
      ],
    );
    final membership = _signed(
      _relaySecret,
      kind: 39002,
      createdAt: 101,
      tags: [
        ['d', _channelId],
        ['p', viewerPubkey, '', 'member'],
        ['p', authorPubkey, '', 'owner'],
      ],
    );
    final root = _signed(
      _authorSecret,
      kind: 9,
      content: 'alpha launch',
      createdAt: 200,
      tags: [
        ['h', _channelId],
        ['p', viewerPubkey],
      ],
    );
    final reply = _signed(
      _authorSecret,
      kind: 9,
      content: 'reply from the future',
      createdAt: 201,
      tags: [
        ['h', _channelId],
        ['e', root.id, '', 'reply'],
        ['p', viewerPubkey],
      ],
    );
    final reaction = _signed(
      _viewerSecret,
      kind: 7,
      content: '👍',
      createdAt: 202,
      tags: [
        ['e', root.id],
      ],
    );
    final edit = _signed(
      _authorSecret,
      kind: 40003,
      content: 'beta launch',
      createdAt: 203,
      tags: [
        ['h', _channelId],
        ['e', root.id],
      ],
    );

    expect(
      await projection.configure('https://relay.test/', viewerPubkey),
      isTrue,
    );
    await projection.applyEvents([
      reply,
      metadata,
      membership,
      root,
      reaction,
      edit,
    ]);

    final channels = await projection.channels();
    expect(channels, hasLength(1));
    expect(channels!.single['name'], 'Fast lane');
    expect(channels.single['member_count'], 2);
    expect(channels.single['is_member'], isTrue);
    expect(channels.single['unread_count'], 2);
    expect(channels.single['last_event_at'], 201);

    final channelEvents = await projection.channelEvents(_channelId, limit: 50);
    expect(channelEvents, hasLength(6));
    final threadEvents = await projection.threadEvents(root.id, limit: 50);
    expect(threadEvents!.map((event) => event.id).toSet(), {
      root.id,
      reply.id,
      reaction.id,
      edit.id,
    });

    final search = await projection.search('beta lau');
    expect(search, hasLength(1));
    final searchedMessage = search!.single['message'] as Map;
    expect(searchedMessage['content'], 'beta launch');
    final reactions = searchedMessage['reactions'] as List;
    expect(reactions, hasLength(1));
    expect((reactions.single as Map)['emoji'], '👍');
    expect((reactions.single as Map)['current_user_reaction_id'], reaction.id);
    final activity = await projection.activity();
    expect(activity, hasLength(1));
    expect(activity!.single['conversation_id'], root.id);
    expect(activity.single['category'], 'mention');
    expect(activity.single['read'], isFalse);

    final deleteEdit = _signed(
      _authorSecret,
      kind: 5,
      createdAt: 204,
      tags: [
        ['e', edit.id],
      ],
    );
    final deleteReaction = _signed(
      _viewerSecret,
      kind: 5,
      createdAt: 205,
      tags: [
        ['e', reaction.id],
      ],
    );
    await projection.applyEvents([deleteEdit, deleteReaction]);
    final repaired = await projection.search('alpha lau');
    expect(repaired, hasLength(1));
    final repairedMessage = repaired!.single['message'] as Map;
    expect(repairedMessage['content'], 'alpha launch');
    expect(repairedMessage['reactions'], isEmpty);

    await projection.applyReadMarkers({_channelId: 200});
    expect((await projection.channels())!.single['unread_count'], 1);
    await projection.applyReadMarkers({'thread:${root.id}': 201});
    expect((await projection.channels())!.single['unread_count'], 0);
    expect((await projection.activity())!.single['read'], isTrue);
    await projection.applyReadMarkers({'thread:${root.id}': 1});
    expect((await projection.channels())!.single['unread_count'], 0);

    final lateReply = _signed(
      _authorSecret,
      kind: 9,
      content: 'late historical reply',
      createdAt: 150,
      tags: [
        ['h', _channelId],
        ['e', root.id, '', 'reply'],
      ],
    );
    await projection.applyEvents([lateReply]);
    expect((await projection.channels())!.single['unread_count'], 0);

    await projection.dispose();
    projection = _projection(databasePath);
    expect(
      await projection.configure('https://relay.test', viewerPubkey),
      isTrue,
    );
    expect((await projection.channels())!.single['name'], 'Fast lane');
  });

  test(
    'converges for late events, duplicates, and deletion tombstones',
    () async {
      final viewerPubkey = _pubkey(_viewerSecret);
      final newerMetadata = _signed(
        _relaySecret,
        kind: 39000,
        createdAt: 20,
        tags: const [
          ['d', _channelId],
          ['name', 'New name'],
          ['public'],
        ],
      );
      final olderMetadata = _signed(
        _relaySecret,
        kind: 39000,
        createdAt: 10,
        tags: const [
          ['d', _channelId],
          ['name', 'Old name'],
          ['public'],
        ],
      );
      final membership = _signed(
        _relaySecret,
        kind: 39002,
        createdAt: 21,
        tags: [
          ['d', _channelId],
          ['p', viewerPubkey],
        ],
      );
      final olderMembership = _signed(
        _relaySecret,
        kind: 39002,
        createdAt: 11,
        tags: const [
          ['d', _channelId],
        ],
      );
      final latest = _signed(
        _authorSecret,
        kind: 9,
        content: 'latest message',
        createdAt: 100,
        tags: const [
          ['h', _channelId],
        ],
      );
      final doomed = _signed(
        _authorSecret,
        kind: 9,
        content: 'must never flash',
        createdAt: 50,
        tags: const [
          ['h', _channelId],
        ],
      );
      final deletion = _signed(
        _authorSecret,
        kind: 5,
        createdAt: 70,
        tags: [
          ['h', _channelId],
          ['e', doomed.id],
        ],
      );

      await projection.configure('https://relay.test', viewerPubkey);
      await projection.applyEvents([
        newerMetadata,
        olderMembership,
        membership,
        latest,
      ]);
      await projection.applyEvents([olderMetadata, latest, deletion]);
      await projection.applyEvents([doomed]);

      expect((await projection.channels())!.single['name'], 'New name');
      final events = await projection.channelEvents(_channelId, limit: 50);
      expect(events!.where((event) => event.id == latest.id), hasLength(1));
      expect(await projection.search('must never'), isEmpty);

      final deleteCurrentMetadata = _signed(
        _relaySecret,
        kind: 5,
        createdAt: 200,
        tags: [
          ['e', newerMetadata.id],
        ],
      );
      final deleteCurrentMembership = _signed(
        _relaySecret,
        kind: 5,
        createdAt: 201,
        tags: [
          ['e', membership.id],
        ],
      );
      await projection.applyEvents([deleteCurrentMetadata]);
      final rebuilt = (await projection.channels())!.single;
      expect(rebuilt['name'], 'Old name');
      await projection.applyEvents([deleteCurrentMembership]);
      expect(await projection.channels(), isEmpty);
    },
  );

  test('uses the lower event id to break replaceable timestamp ties', () async {
    final first = _signed(
      _relaySecret,
      kind: 39000,
      createdAt: 100,
      tags: const [
        ['d', _channelId],
        ['name', 'First candidate'],
        ['public'],
      ],
    );
    final second = _signed(
      _relaySecret,
      kind: 39000,
      createdAt: 100,
      tags: const [
        ['d', _channelId],
        ['name', 'Second candidate'],
        ['public'],
      ],
    );
    final membership = _signed(
      _relaySecret,
      kind: 39002,
      createdAt: 101,
      tags: [
        ['d', _channelId],
        ['p', _pubkey(_viewerSecret)],
      ],
    );
    final winner = first.id.compareTo(second.id) < 0 ? first : second;
    final loser = identical(winner, first) ? second : first;
    final winnerName = identical(winner, first)
        ? 'First candidate'
        : 'Second candidate';

    await projection.configure('https://relay.test', _pubkey(_viewerSecret));
    await projection.applyEvents([loser, winner, membership]);

    expect((await projection.channels())!.single['name'], winnerName);
  });

  test('groups activity before limiting conversations', () async {
    final viewerPubkey = _pubkey(_viewerSecret);
    final root = _signed(
      _authorSecret,
      kind: 9,
      content: 'first conversation',
      createdAt: 100,
      tags: [
        ['h', _channelId],
        ['p', viewerPubkey],
      ],
    );
    final approval = _signed(
      _authorSecret,
      kind: 46010,
      content: 'approval in thread',
      createdAt: 101,
      tags: [
        ['h', _channelId],
        ['e', root.id, '', 'reply'],
        ['p', viewerPubkey],
      ],
    );
    final reply = _signed(
      _authorSecret,
      kind: 9,
      content: 'newer reply',
      createdAt: 102,
      tags: [
        ['h', _channelId],
        ['e', root.id, '', 'reply'],
        ['p', viewerPubkey],
      ],
    );
    final independent = _signed(
      _authorSecret,
      kind: 9,
      content: 'second conversation',
      createdAt: 99,
      tags: [
        ['h', _channelId],
        ['p', viewerPubkey],
      ],
    );

    await projection.configure('https://relay.test', viewerPubkey);
    await projection.applyEvents([approval, root, reply, independent]);

    final activity = await projection.activity(limit: 2);
    expect(activity, hasLength(2));
    expect(activity!.first['conversation_id'], root.id);
    expect(activity.first['category'], 'needs_action');
    expect(
      (await projection.threadEvents(
        root.id,
        limit: 20,
      ))!.where((event) => event.kind == 9 && event.parentEventId != null),
      hasLength(1),
    );
  });

  test('invalid signature rejects the whole snapshot batch', () async {
    final viewerPubkey = _pubkey(_viewerSecret);
    final metadata = _signed(
      _relaySecret,
      kind: 39000,
      createdAt: 1,
      tags: const [
        ['d', _channelId],
        ['name', 'Atomic snapshot'],
        ['public'],
      ],
    );
    final valid = _signed(
      _authorSecret,
      kind: 9,
      content: 'authentic',
      createdAt: 2,
      tags: const [
        ['h', _channelId],
      ],
    );
    final tampered = NostrEvent(
      id: valid.id,
      pubkey: valid.pubkey,
      createdAt: valid.createdAt,
      kind: valid.kind,
      tags: valid.tags,
      content: 'tampered',
      sig: valid.sig,
    );

    await projection.configure('https://relay.test', viewerPubkey);
    await projection.applyEvents([metadata, tampered]);

    expect(await projection.channels(), isEmpty);
  });

  test('fences persisted state by relay and viewer', () async {
    final viewerPubkey = _pubkey(_viewerSecret);
    final metadata = _signed(
      _relaySecret,
      kind: 39000,
      createdAt: 1,
      tags: const [
        ['d', _channelId],
        ['name', 'Private scope'],
        ['public'],
      ],
    );
    final membership = _signed(
      _relaySecret,
      kind: 39002,
      createdAt: 2,
      tags: [
        ['d', _channelId],
        ['p', viewerPubkey],
      ],
    );
    await projection.configure('https://relay.test', viewerPubkey);
    await projection.applyEvents([metadata, membership]);
    expect(await projection.channels(), hasLength(1));

    expect(
      await projection.configure('https://relay.test', 'invalid'),
      isFalse,
    );
    expect(await projection.channels(), isNull);
    await projection.configure(
      'https://relay.test',
      _pubkey(_otherViewerSecret),
    );
    expect(await projection.channels(), isEmpty);
    expect(await projection.configure('https://relay.test', null), isFalse);
    expect(await projection.channels(), isNull);
  });

  test('does not project an old relay event into a newer scope', () async {
    final firstViewer = _pubkey(_viewerSecret);
    final secondViewer = _pubkey(_otherViewerSecret);
    final metadata = _signed(
      _relaySecret,
      kind: 39000,
      createdAt: 1,
      tags: const [
        ['d', _channelId],
        ['name', 'Old relay event'],
        ['public'],
      ],
    );
    final membership = _signed(
      _relaySecret,
      kind: 39002,
      createdAt: 2,
      tags: [
        ['d', _channelId],
        ['p', firstViewer],
      ],
    );

    await projection.configure('https://first.test', firstViewer);
    final oldApply = projection.applyEvents([metadata, membership]);
    final scopeChange = projection.configure(
      'https://second.test',
      secondViewer,
    );
    await Future.wait([oldApply, scopeChange]);

    expect(await projection.channels(), isEmpty);
  });

  test(
    'bounds pending commands before they enter the worker isolate',
    () async {
      final lane = await ClientStateWorkerLane.start(
        path: databasePath,
        scope: 'https://relay.test\n${_pubkey(_viewerSecret)}',
        viewerPubkey: _pubkey(_viewerSecret),
        name: 'bounded-client-state-test',
        maxPendingRequests: 1,
      );
      final first = lane.request(const {
        'op': 'channels',
        'members_only': true,
      });
      final rejected = lane.request(const {
        'op': 'channels',
        'members_only': true,
      });

      await expectLater(rejected, throwsA(isA<ClientStateWorkerQueueFull>()));
      expect(await first, isEmpty);
      await lane.close();
    },
  );

  test('rebuilds one thread and channel once per projection batch', () {
    final viewerPubkey = _pubkey(_viewerSecret);
    final scope = 'https://relay.test\n$viewerPubkey';
    final root = _signed(
      _authorSecret,
      kind: 9,
      createdAt: 100,
      tags: const [
        ['h', _channelId],
      ],
    );
    final replies = [
      for (var index = 0; index < 128; index += 1)
        _signed(
          _authorSecret,
          kind: 9,
          createdAt: 101 + index,
          content: 'reply $index',
          tags: [
            ['h', _channelId],
            ['e', root.id, '', 'root'],
            ['e', root.id, '', 'reply'],
          ],
        ),
    ];
    final database = initializeClientStateDatabase(databasePath);
    addTearDown(database.close);

    final result = applyClientStateEvents(database, scope, viewerPubkey, [
      root,
      ...replies,
    ]);

    expect(result['inserted'], 129);
    expect(result['thread_rebuilds'], 1);
    expect(result['channel_rollups'], 1);
    expect(
      database.select(
        'SELECT reply_count FROM thread_summaries WHERE scope=? AND root_id=?',
        [scope, root.id],
      ).single['reply_count'],
      128,
    );
  });

  test(
    'bounds a 5k warm channel before crossing the isolate boundary',
    () async {
      final viewerPubkey = _pubkey(_viewerSecret);
      final authorPubkey = _pubkey(_authorSecret);
      final scope = 'https://relay.test\n$viewerPubkey';
      final database = initializeClientStateDatabase(databasePath);
      database.execute('BEGIN');
      final insert = database.prepare('''INSERT INTO events(
           scope, event_id, pubkey, created_at, kind, channel_id, target_id,
           root_id, parent_id, broadcast, content, tags_json, sig, deleted
         ) VALUES(?, ?, ?, ?, 9, ?, NULL, NULL, NULL, 0, ?, ?, ?, 0)''');
      try {
        for (var index = 0; index < 5000; index += 1) {
          insert.execute([
            scope,
            index.toRadixString(16).padLeft(64, '0'),
            authorPubkey,
            10000 + index,
            _channelId,
            'message $index',
            '[["h","$_channelId"]]',
            '0' * 128,
          ]);
        }
        database.execute('COMMIT');
      } catch (_) {
        database.execute('ROLLBACK');
        rethrow;
      } finally {
        insert.close();
        database.close();
      }

      await projection.configure('https://relay.test', viewerPubkey);
      final events = await projection.channelEvents(_channelId, limit: 5000);

      expect(events, hasLength(ClientStateProjection.eventPageSize));
      expect(events!.first.createdAt, 14800);
      expect(events.last.createdAt, 14999);
    },
  );

  test(
    'does not enumerate a relay batch synchronously on the UI isolate',
    () async {
      final viewerPubkey = _pubkey(_viewerSecret);
      final event = _signed(
        _authorSecret,
        kind: 9,
        content: 'background batch',
        createdAt: 100,
        tags: const [
          ['h', _channelId],
        ],
      );
      await projection.configure('https://relay.test', viewerPubkey);
      var enumerated = 0;
      final events = () sync* {
        for (var index = 0; index < 256; index += 1) {
          enumerated += 1;
          yield event;
        }
      }();

      final applying = projection.applyEvents(events);

      expect(enumerated, 0);
      await applying;
      expect(enumerated, 256);
    },
  );
}

ClientStateProjection _projection(String path) => ClientStateProjection(
  supportsPlatform: () => true,
  databasePath: () async => path,
);

String _pubkey(String secret) =>
    nostr.Schnorr.derivePublicKey(secret).toLowerCase();

NostrEvent _signed(
  String secret, {
  required int kind,
  required int createdAt,
  List<List<String>> tags = const [],
  String content = '',
}) {
  final event = nostr.Event.from(
    kind: kind,
    content: content,
    secretKey: secret,
    createdAt: createdAt,
    tags: tags,
    verify: true,
  );
  return NostrEvent(
    id: event.id,
    pubkey: event.pubkey,
    createdAt: event.createdAt,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
    sig: event.sig,
  );
}
