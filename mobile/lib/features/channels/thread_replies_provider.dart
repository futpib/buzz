import 'dart:async';
import 'dart:collection';

import 'package:flutter/foundation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../shared/client_state/client_state_projection.dart';
import '../../shared/relay/relay.dart';
import 'channel_event_order.dart';
import 'channel_window.dart';
import 'pending_local_messages_provider.dart';
import 'thread_window.dart';

const _threadWindowPageSize = 100;
const _legacyThreadPageSize = 200;

class ThreadRepliesArgs {
  final String channelId;
  final String rootId;
  final String threadHeadId;

  const ThreadRepliesArgs({
    required this.channelId,
    required this.rootId,
    String? threadHeadId,
  }) : threadHeadId = threadHeadId ?? rootId;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ThreadRepliesArgs &&
          channelId == other.channelId &&
          rootId == other.rootId &&
          threadHeadId == other.threadHeadId;

  @override
  int get hashCode => Object.hash(channelId, rootId, threadHeadId);
}

ThreadRepliesArgs _localReplyArgs(ThreadRepliesArgs args) =>
    ThreadRepliesArgs(channelId: args.channelId, rootId: args.rootId);

/// Disposable local snapshot used while the authoritative relay query is in
/// flight. It includes edits, reactions, and deletions as well as replies.
final projectedThreadEventsProvider = FutureProvider.autoDispose
    .family<List<NostrEvent>?, ThreadRepliesArgs>(
      (ref, args) => ClientStateProjection.instance.threadEvents(
        args.rootId,
        limit: _legacyThreadPageSize,
      ),
    );

/// The authoritative newest thread page. Modern relays return a bounded
/// view-shaped window; older relays fall back to bounded NIP-01 pages.
final threadWindowProvider = FutureProvider.autoDispose
    .family<ThreadWindowPage, ThreadRepliesArgs>((ref, args) async {
      // A reply missed while the socket is stale cannot invalidate this
      // one-shot query. Refresh mounted threads when the session recovers;
      // auto-dispose also makes reopening a thread start from relay truth.
      ref.listen(relaySessionProvider, (previous, next) {
        if (previous?.status != SessionStatus.connected &&
            next.status == SessionStatus.connected) {
          ref.invalidateSelf();
        }
      });
      final session = ref.read(relaySessionProvider.notifier);
      final localReplies = ref.read(
        threadLocalRepliesProvider(_localReplyArgs(args)).notifier,
      );
      final pendingMessages = ref.read(
        pendingLocalMessagesProvider(args.channelId).notifier,
      );
      void confirmAuthoritative(Iterable<NostrEvent> events) {
        final ids = events.map((event) => event.id).toSet();
        localReplies.confirm(ids);
        pendingMessages.confirm(ids);
      }

      final firstResponse = await session.queryRelay([
        _threadWindowFilter(args, null),
      ]);
      if (firstResponse.any(
        (event) => event.kind == EventKind.channelWindowBounds,
      )) {
        final page = parseThreadWindowResponse(
          firstResponse,
          channelId: args.channelId,
          rootId: args.rootId,
          threadHeadId: args.threadHeadId,
          startCursor: null,
        );
        confirmAuthoritative(page.events);
        return page;
      }
      debugPrint(
        '[threadWindowProvider] view-shaped thread window unavailable; '
        'using bounded legacy pages',
      );
      final legacyResponse = args.threadHeadId == args.rootId
          ? firstResponse
          : await session.queryRelay([_legacyThreadFilter(args, null)]);
      final legacy = _parseLegacyThreadPage(
        legacyResponse,
        startCursor: null,
        pageSize: _threadWindowPageSize,
      );
      confirmAuthoritative(legacy.events);
      return legacy;
    });

class ThreadReplyPageEvents extends ListBase<NostrEvent> {
  final ThreadWindowPage window;

  ThreadReplyPageEvents(this.window);

  @override
  int get length => window.events.length;

  @override
  set length(int value) => throw UnsupportedError('Thread page is immutable.');

  @override
  NostrEvent operator [](int index) => window.events[index];

  @override
  void operator []=(int index, NostrEvent value) =>
      throw UnsupportedError('Thread page is immutable.');
}

final threadRepliesProvider = FutureProvider.autoDispose
    .family<List<NostrEvent>, ThreadRepliesArgs>((ref, args) async {
      final window = await ref.watch(threadWindowProvider(args).future);
      return ThreadReplyPageEvents(window);
    });

class ThreadReplyPaginationState {
  final List<ThreadWindowPage> olderPages;
  final bool isLoading;
  final Object? error;
  final String? headKey;

  const ThreadReplyPaginationState({
    this.olderPages = const [],
    this.isLoading = false,
    this.error,
    this.headKey,
  });

  List<NostrEvent> get events => [
    for (final page in olderPages) ...page.events,
  ];
}

class ThreadReplyPaginationNotifier
    extends Notifier<ThreadReplyPaginationState> {
  final ThreadRepliesArgs args;
  bool _loadInFlight = false;

  ThreadReplyPaginationNotifier(this.args);

  @override
  ThreadReplyPaginationState build() => const ThreadReplyPaginationState();

  Future<void> loadOlder() async {
    if (_loadInFlight) return;
    _loadInFlight = true;
    var headKey = state.headKey;
    var retainedPages = state.olderPages;
    try {
      final newestEvents = await ref.read(threadRepliesProvider(args).future);
      if (newestEvents is! ThreadReplyPageEvents) return;
      final newest = newestEvents.window;
      headKey = _threadHeadKey(newestEvents);
      retainedPages = state.headKey == headKey
          ? state.olderPages
          : const <ThreadWindowPage>[];
      final tail = retainedPages.isEmpty ? newest : retainedPages.last;
      final cursor = tail.nextCursor;
      if (!tail.hasMore || cursor == null) return;

      state = ThreadReplyPaginationState(
        olderPages: retainedPages,
        isLoading: true,
        headKey: headKey,
      );
      final page = await _fetchThreadWindowPage(
        ref.read(relaySessionProvider.notifier),
        args,
        cursor,
        legacyFallback: tail.isLegacyFallback,
      );
      state = ThreadReplyPaginationState(
        olderPages: [...state.olderPages, page],
        headKey: headKey,
      );
    } catch (error) {
      state = ThreadReplyPaginationState(
        olderPages: retainedPages,
        error: error,
        headKey: headKey,
      );
    } finally {
      _loadInFlight = false;
    }
  }
}

final threadReplyPaginationProvider = NotifierProvider.autoDispose
    .family<
      ThreadReplyPaginationNotifier,
      ThreadReplyPaginationState,
      ThreadRepliesArgs
    >(ThreadReplyPaginationNotifier.new);

bool threadHasOlderReplies(
  List<NostrEvent>? newestEvents,
  ThreadReplyPaginationState pagination,
) {
  final newest = newestEvents is ThreadReplyPageEvents
      ? newestEvents.window
      : null;
  final retainedPages = pagination.headKey == _threadHeadKey(newestEvents)
      ? pagination.olderPages
      : const <ThreadWindowPage>[];
  final tail = retainedPages.isEmpty ? newest : retainedPages.last;
  return tail?.hasMore ?? false;
}

String? _threadHeadKey(List<NostrEvent>? events) {
  if (events is! ThreadReplyPageEvents) return null;
  final window = events.window;
  final ids = window.events
      .where(
        (event) => EventKind.channelTimelineContentKinds.contains(event.kind),
      )
      .map((event) => event.id)
      .join(',');
  final cursor = window.nextCursor;
  return '$ids|${cursor?.createdAt}:${cursor?.eventId}|${window.hasMore}|'
      '${window.isLegacyFallback}';
}

List<NostrEvent> _retainedPaginationEvents(
  List<NostrEvent>? newestEvents,
  ThreadReplyPaginationState pagination,
) => pagination.headKey == _threadHeadKey(newestEvents)
    ? pagination.events
    : const [];

Map<String, ChannelWindowThreadSummary> threadReplySummaries(
  List<NostrEvent>? newestEvents,
  ThreadReplyPaginationState pagination,
) {
  if (newestEvents is! ThreadReplyPageEvents) return const {};
  final pages = pagination.headKey == _threadHeadKey(newestEvents)
      ? pagination.olderPages
      : const <ThreadWindowPage>[];
  return {
    ...newestEvents.window.threadSummaries,
    for (final page in pages) ...page.threadSummaries,
  };
}

Future<ThreadWindowPage> _fetchThreadWindowPage(
  RelaySessionNotifier session,
  ThreadRepliesArgs args,
  ThreadPageCursor cursor, {
  required bool legacyFallback,
}) async {
  final pageSize = legacyFallback
      ? _legacyThreadPageSize
      : _threadWindowPageSize;
  final response = await session.queryRelay([
    legacyFallback
        ? _legacyThreadFilter(args, cursor)
        : _threadWindowFilter(args, cursor),
  ]);
  if (!response.any((event) => event.kind == EventKind.channelWindowBounds)) {
    return _parseLegacyThreadPage(
      response,
      startCursor: cursor,
      pageSize: pageSize,
    );
  }
  return parseThreadWindowResponse(
    response,
    channelId: args.channelId,
    rootId: args.rootId,
    threadHeadId: args.threadHeadId,
    startCursor: cursor,
  );
}

NostrFilter _threadWindowFilter(
  ThreadRepliesArgs args,
  ThreadPageCursor? cursor,
) => NostrFilter(
  kinds: EventKind.channelTimelineContentKinds,
  tags: {
    '#e': [args.rootId],
    '#h': [args.channelId],
  },
  limit: _threadWindowPageSize,
  until: cursor?.createdAt,
  extensions: {
    'thread_window': true,
    'include_aux': true,
    'thread_parent': args.threadHeadId,
    if (cursor != null) 'before_id': cursor.eventId,
  },
);

NostrFilter _legacyThreadFilter(
  ThreadRepliesArgs args,
  ThreadPageCursor? cursor,
) => NostrFilter(
  kinds: EventKind.channelTimelineContentKinds,
  tags: {
    '#e': [args.threadHeadId],
    '#h': [args.channelId],
  },
  limit: cursor == null ? _threadWindowPageSize : _legacyThreadPageSize,
  until: cursor?.createdAt,
  extensions: {if (cursor != null) 'before_id': cursor.eventId},
);

ThreadWindowPage _parseLegacyThreadPage(
  List<NostrEvent> response, {
  required ThreadPageCursor? startCursor,
  required int pageSize,
}) {
  final events = [
    for (final event in response)
      if (EventKind.channelTimelineContentKinds.contains(event.kind)) event,
  ];
  final last = events.isEmpty ? null : events.last;
  final hasMore = response.length >= pageSize && last != null;
  return ThreadWindowPage(
    startCursor: startCursor,
    events: events,
    nextCursor: hasMore
        ? ThreadPageCursor(createdAt: last.createdAt, eventId: last.id)
        : null,
    hasMore: hasMore,
    isLegacyFallback: true,
  );
}

class ThreadLocalRepliesNotifier extends Notifier<List<NostrEvent>> {
  final ThreadRepliesArgs args;

  ThreadLocalRepliesNotifier(this.args);

  @override
  List<NostrEvent> build() => const [];

  void add(NostrEvent event) {
    state = _mergeReplies(state, [event]);
  }

  void remove(String eventId) {
    state = state.where((event) => event.id != eventId).toList();
  }

  void confirm(Set<String> eventIds) {
    if (!state.any((event) => eventIds.contains(event.id))) return;
    state = state.where((event) => !eventIds.contains(event.id)).toList();
  }
}

final threadLocalRepliesProvider =
    NotifierProvider.family<
      ThreadLocalRepliesNotifier,
      List<NostrEvent>,
      ThreadRepliesArgs
    >(ThreadLocalRepliesNotifier.new);

/// Relay-backed replies merged with signed local replies that are still
/// waiting for acknowledgement.
///
/// The relay query is route-scoped, while the optimistic local overlay stays
/// alive until confirmation so it can survive closing and reopening a thread.
final threadRepliesWithLocalProvider = Provider.autoDispose
    .family<AsyncValue<List<NostrEvent>>, ThreadRepliesArgs>((ref, args) {
      final relayReplies = ref.watch(threadRepliesProvider(args));
      final pagination = ref.watch(threadReplyPaginationProvider(args));
      final localReplyArgs = _localReplyArgs(args);
      final localReplies = ref.watch(
        threadLocalRepliesProvider(localReplyArgs),
      );
      final pagedEvents = _retainedPaginationEvents(
        relayReplies.value,
        pagination,
      );
      final authoritative = relayReplies.value == null
          ? null
          : mergeThreadEvents(relayReplies.value!, pagedEvents);
      if (authoritative != null && localReplies.isNotEmpty) {
        final authoritativeIds = authoritative.map((event) => event.id).toSet();
        if (localReplies.any((event) => authoritativeIds.contains(event.id))) {
          final localRepliesNotifier = ref.read(
            threadLocalRepliesProvider(localReplyArgs).notifier,
          );
          final pendingMessagesNotifier = ref.read(
            pendingLocalMessagesProvider(args.channelId).notifier,
          );
          Future.microtask(() {
            localRepliesNotifier.confirm(authoritativeIds);
            pendingMessagesNotifier.confirm(authoritativeIds);
          });
        }
      }
      if (localReplies.isEmpty) {
        return relayReplies.whenData(
          (events) => mergeThreadEvents(events, pagedEvents),
        );
      }
      if (authoritative != null) {
        return AsyncData(mergeThreadEvents(authoritative, localReplies));
      }
      return relayReplies.when(
        data: (events) => AsyncData(
          mergeThreadEvents(
            mergeThreadEvents(events, pagedEvents),
            localReplies,
          ),
        ),
        loading: () => AsyncData(localReplies),
        error: (error, stackTrace) => AsyncData(localReplies),
      );
    });

/// Union two event lists by id, newest-wins, in timeline order.
///
/// The thread view needs this to fold the channel's live socket events into its
/// own one-shot query result: the query asks for content kinds only, so
/// reactions, edits, and deletions that land while a thread is open never reach
/// it on their own.
List<NostrEvent> mergeThreadEvents(
  Iterable<NostrEvent> first,
  Iterable<NostrEvent> second,
) => _mergeReplies(first, second);

List<NostrEvent> _mergeReplies(
  Iterable<NostrEvent> first,
  Iterable<NostrEvent> second,
) {
  final byId = <String, NostrEvent>{};
  for (final event in [...first, ...second]) {
    byId[event.id] = event;
  }
  return byId.values.toList()..sort(compareThreadRepliesChronologically);
}
