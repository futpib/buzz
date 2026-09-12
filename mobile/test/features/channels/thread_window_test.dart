import 'dart:convert';

import 'package:buzz/features/channels/thread_window.dart';
import 'package:buzz/shared/relay/relay.dart';
import 'package:flutter_test/flutter_test.dart';

const _channel = 'channel';
const _root = 'root';
const _cursorId =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

void main() {
  test('parses rows and aux while keeping bounds out of the timeline', () {
    final page = parseThreadWindowResponse(
      [
        _event('reply', EventKind.streamMessage),
        _event('reaction', 7),
        _bounds(),
      ],
      channelId: _channel,
      rootId: _root,
      threadHeadId: _root,
      startCursor: null,
    );

    expect(page.events.map((event) => event.id), ['reply', 'reaction']);
    expect(page.hasMore, isFalse);
    expect(page.nextCursor, isNull);
  });

  test('requires bounds to match the root, channel, and request cursor', () {
    const cursor = ThreadPageCursor(createdAt: 12, eventId: _cursorId);
    expect(
      () => parseThreadWindowResponse(
        [_bounds(dTag: 'thread:channel:root:root:head')],
        channelId: _channel,
        rootId: _root,
        threadHeadId: _root,
        startCursor: cursor,
      ),
      throwsFormatException,
    );
    expect(
      () => parseThreadWindowResponse(
        [_bounds(root: 'other')],
        channelId: _channel,
        rootId: _root,
        threadHeadId: _root,
        startCursor: null,
      ),
      throwsFormatException,
    );
  });

  test('decodes an authoritative continuation cursor', () {
    final page = parseThreadWindowResponse(
      [
        _bounds(
          content: {
            'has_more': true,
            'next_cursor': {'created_at': 12, 'id': _cursorId},
          },
        ),
      ],
      channelId: _channel,
      rootId: _root,
      threadHeadId: _root,
      startCursor: null,
    );

    expect(page.hasMore, isTrue);
    expect(page.nextCursor?.createdAt, 12);
    expect(page.nextCursor?.eventId, _cursorId);
  });

  test('attaches nested-thread summaries to retained replies', () {
    final page = parseThreadWindowResponse(
      [_event('reply', EventKind.streamMessage), _summary('reply'), _bounds()],
      channelId: _channel,
      rootId: _root,
      threadHeadId: _root,
      startCursor: null,
    );

    expect(page.events.map((event) => event.id), ['reply']);
    expect(page.threadSummaries['reply']?.replyCount, 4);
    expect(page.threadSummaries['reply']?.descendantCount, 7);
  });
}

NostrEvent _event(String id, int kind) => NostrEvent(
  id: id,
  pubkey: 'pubkey',
  createdAt: 10,
  kind: kind,
  tags: const [],
  content: '',
  sig: '',
);

NostrEvent _summary(String targetId) => NostrEvent(
  id: 'summary',
  pubkey: 'relay',
  createdAt: 10,
  kind: EventKind.channelThreadSummary,
  tags: [
    ['d', targetId],
    ['e', targetId],
    ['h', _channel],
  ],
  content: jsonEncode({
    'reply_count': 4,
    'descendant_count': 7,
    'last_reply_at': 20,
    'participants': const <String>[],
  }),
  sig: '',
);

NostrEvent _bounds({
  String root = _root,
  String? dTag,
  Map<String, Object?> content = const {'has_more': false, 'next_cursor': null},
}) => NostrEvent(
  id: 'bounds',
  pubkey: 'relay',
  createdAt: 10,
  kind: EventKind.channelWindowBounds,
  tags: [
    ['d', dTag ?? 'thread:$_channel:$root:$root:head'],
    ['e', root],
    ['h', _channel],
  ],
  content: jsonEncode(content),
  sig: '',
);
