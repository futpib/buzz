import 'dart:convert';

import 'package:buzz/shared/client_state/client_state_projection.dart';
import 'package:buzz/shared/relay/nostr_models.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

const _channel = MethodChannel('buzz/client_state');

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_channel, null);
  });

  test('opens a scope, projects events, and decodes query rows', () async {
    final calls = <MethodCall>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_channel, (call) async {
          calls.add(call);
          if (call.method == 'isSupported' || call.method == 'open') {
            return true;
          }
          final command =
              jsonDecode(call.arguments as String) as Map<String, dynamic>;
          if (command['op'] == 'channel_events' ||
              command['op'] == 'thread_events') {
            return jsonEncode({
              'ok': true,
              'value': [_event.toJson()],
              'error': null,
            });
          }
          return jsonEncode({'ok': true, 'value': {}, 'error': null});
        });
    final projection = ClientStateProjection(supportsPlatform: () => true);

    expect(await projection.configure('https://relay.test/', 'AA'), isTrue);
    await projection.applyEvents([_event]);
    final events = await projection.channelEvents('channel');
    final threadEvents = await projection.threadEvents('root');

    expect(events, [_event]);
    expect(threadEvents, [_event]);
    final apply =
        jsonDecode(calls[2].arguments as String) as Map<String, dynamic>;
    expect(apply['op'], 'apply');
    expect((apply['events'] as List).single['id'], _event.id);
  });

  test(
    'closing an identity scope prevents commands using stale state',
    () async {
      final calls = <MethodCall>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(_channel, (call) async {
            calls.add(call);
            if (call.method == 'isSupported' || call.method == 'open') {
              return true;
            }
            return jsonEncode({'ok': true, 'value': [], 'error': null});
          });
      final projection = ClientStateProjection(supportsPlatform: () => true);

      expect(await projection.configure('https://relay.test', 'aa'), isTrue);
      expect(await projection.configure('https://relay.test', null), isFalse);
      expect(await projection.channels(), isNull);

      expect(calls.map((call) => call.method), [
        'isSupported',
        'open',
        'close',
      ]);
    },
  );

  test('native command error degrades to a cache miss', () async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_channel, (call) async {
          if (call.method == 'isSupported' || call.method == 'open') {
            return true;
          }
          return jsonEncode({'ok': false, 'value': null, 'error': 'bad query'});
        });
    final projection = ClientStateProjection(supportsPlatform: () => true);

    await projection.configure('https://relay.test', 'aa');

    expect(await projection.search('hello'), isNull);
  });
}

const _event = NostrEvent(
  id: 'event-id',
  pubkey: 'aa',
  createdAt: 123,
  kind: 9,
  tags: [
    ['h', 'channel'],
  ],
  content: 'hello',
  sig: 'signature',
);
