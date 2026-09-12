import 'dart:convert';

import '../../shared/relay/relay.dart';
import 'channel_window.dart';

class ThreadPageCursor {
  final int createdAt;
  final String eventId;

  const ThreadPageCursor({required this.createdAt, required this.eventId});
}

class ThreadWindowPage {
  final ThreadPageCursor? startCursor;
  final List<NostrEvent> events;
  final Map<String, ChannelWindowThreadSummary> threadSummaries;
  final ThreadPageCursor? nextCursor;
  final bool hasMore;

  const ThreadWindowPage({
    required this.startCursor,
    required this.events,
    this.threadSummaries = const {},
    required this.nextCursor,
    required this.hasMore,
  });
}

ThreadWindowPage parseThreadWindowResponse(
  List<NostrEvent> events, {
  required String channelId,
  required String rootId,
  required String threadHeadId,
  required ThreadPageCursor? startCursor,
}) {
  final boundsEvents = events
      .where((event) => event.kind == EventKind.channelWindowBounds)
      .toList();
  if (boundsEvents.length != 1) {
    throw const FormatException(
      'Thread window response must contain exactly one bounds event.',
    );
  }
  final boundsEvent = boundsEvents.single;
  if (boundsEvent.getTagValue('h') != channelId ||
      boundsEvent.getTagValue('e') != rootId ||
      boundsEvent.getTagValue('d') !=
          _expectedBoundsKey(channelId, rootId, threadHeadId, startCursor)) {
    throw const FormatException(
      'Thread window bounds do not match the request.',
    );
  }

  final Object? decoded;
  try {
    decoded = jsonDecode(boundsEvent.content);
  } catch (error) {
    throw FormatException('Invalid thread window bounds JSON: $error');
  }
  if (decoded is! Map<String, dynamic> || decoded['has_more'] is! bool) {
    throw const FormatException('Invalid thread window bounds payload.');
  }
  final hasMore = decoded['has_more'] as bool;
  final nextCursor = _parseCursor(decoded['next_cursor']);
  if (hasMore != (nextCursor != null)) {
    throw const FormatException(
      'Thread window has_more and next_cursor disagree.',
    );
  }

  final rowIds = {
    for (final event in events)
      if (EventKind.channelTimelineContentKinds.contains(event.kind)) event.id,
  };
  final summaries = <String, ChannelWindowThreadSummary>{};
  for (final event in events) {
    if (event.kind != EventKind.channelThreadSummary) continue;
    final targetId = event.getTagValue('e');
    if (targetId == null ||
        !rowIds.contains(targetId) ||
        event.getTagValue('d') != targetId ||
        event.getTagValue('h') != channelId) {
      throw const FormatException(
        'Thread summary does not match a retained reply.',
      );
    }
    summaries[targetId] = parseChannelWindowThreadSummary(event);
  }

  return ThreadWindowPage(
    startCursor: startCursor,
    events: [
      for (final event in events)
        if (event.kind != EventKind.channelWindowBounds &&
            event.kind != EventKind.channelThreadSummary)
          event,
    ],
    threadSummaries: summaries,
    nextCursor: nextCursor,
    hasMore: hasMore,
  );
}

ThreadPageCursor? _parseCursor(Object? value) {
  if (value == null) return null;
  if (value is! Map<String, dynamic>) {
    throw const FormatException('Invalid thread window cursor.');
  }
  final createdAt = value['created_at'];
  final eventId = value['id'];
  if (createdAt is! int ||
      eventId is! String ||
      !RegExp(r'^[0-9a-fA-F]{64}$').hasMatch(eventId)) {
    throw const FormatException('Invalid thread window cursor fields.');
  }
  return ThreadPageCursor(createdAt: createdAt, eventId: eventId);
}

String _expectedBoundsKey(
  String channelId,
  String rootId,
  String threadHeadId,
  ThreadPageCursor? cursor,
) {
  final suffix = cursor == null
      ? 'head'
      : '${cursor.createdAt}:${cursor.eventId}';
  return 'thread:$channelId:$rootId:$threadHeadId:$suffix';
}
