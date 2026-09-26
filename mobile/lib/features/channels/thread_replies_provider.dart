import 'dart:async';
import 'dart:collection';

import 'package:flutter/foundation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:hooks_riverpod/misc.dart' show KeepAliveLink;

import '../../shared/client_state/client_state_projection.dart';
import '../../shared/relay/relay.dart';
import 'channel_event_order.dart';
import 'channel_window.dart';
import 'channel_messages_provider.dart';
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
      void confirmAuthoritative(Iterable<NostrEvent> events) {
        if (!ref.mounted) return;
        final ids = events.map((event) => event.id).toSet();
        final channelProvider = channelMessagesProvider(args.channelId);
        if (ref.mounted && ref.exists(channelProvider)) {
          ref
              .read(channelProvider.notifier)
              .cacheConfirmedThreadReplies(
                events.where(
                  (event) =>
                      EventKind.channelTimelineContentKinds.contains(
                        event.kind,
                      ) &&
                      event.threadReference.parentId != null,
                ),
              );
        }
        ref
            .read(threadLocalRepliesProvider(_localReplyArgs(args)).notifier)
            .confirm(ids);
        ref
            .read(pendingLocalMessagesProvider(args.channelId).notifier)
            .confirm(ids);
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

final threadPageRepliesProvider = FutureProvider.autoDispose
    .family<List<NostrEvent>, ThreadRepliesArgs>((ref, args) async {
      final window = await ref.watch(threadWindowProvider(args).future);
      return ThreadReplyPageEvents(window);
    });

/// Complete scans reconcile deletion ownership. A bounded display page must
/// never be used as evidence that an unseen reply was deleted.
final threadRepliesProvider = FutureProvider.autoDispose
    .family<List<NostrEvent>, ThreadRepliesArgs>((ref, args) async {
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
      final channelProvider = channelMessagesProvider(args.channelId);
      final channelMessages = ref.exists(channelProvider)
          ? ref.read(channelProvider.notifier)
          : null;
      final cachedReplyIds = channelMessages?.cachedThreadReplyIds(args.rootId);
      final unconfirmedIds = channelMessages?.unconfirmedThreadReplyIds(
        args.rootId,
      );
      final queryVersion = channelMessages?.beginThreadQuery(args.rootId);
      if (queryVersion != null) {
        ref.onDispose(
          () => channelMessages?.failThreadQuery(args.rootId, queryVersion),
        );
      }
      try {
        final replies = await fetchCompleteThreadReplies(session, args);
        // Explicit markers also settle unacknowledged local sends, whose
        // absence cannot prove deletion even in an insertion-complete scan.
        final missingIds =
            unconfirmedIds?.difference(
              replies.map((event) => event.id).toSet(),
            ) ??
            <String>{};
        final deletions = <NostrEvent>[];
        // One bounded request per scan keeps opening a thread responsive even
        // when many sends are awaiting ACKs. Excess IDs remain provisional.
        final targets =
            channelMessages?.nextThreadDeletionProofTargets(missingIds) ??
            const <String>[];
        // Per-target limits keep repeated markers from crowding another ID out.
        if (targets.isNotEmpty) {
          deletions.addAll(
            await session.queryRelay([
              for (final target in targets)
                NostrFilter(
                  kinds: const [EventKind.deletion, EventKind.nip29DeleteEvent],
                  tags: {
                    '#h': [args.channelId],
                    '#e': [target],
                  },
                  limit: 1,
                ),
            ]),
          );
        }
        if (ref.mounted && ref.exists(channelProvider)) {
          final channel = ref.read(channelProvider.notifier);
          final deletedTargets = {
            for (final event in deletions)
              for (final tag in event.tags)
                if (tag.length > 1 && tag[0] == 'e') tag[1],
          };
          final applied = channel.cacheCompleteThreadQuery(
            args.rootId,
            cachedReplyIds ?? {},
            replies,
            provisionalReplyIds: missingIds.difference(deletedTargets),
            queryVersion: queryVersion,
          );
          if (deletions.isNotEmpty) {
            channel.cacheThreadDeletions(
              deletions,
              scopedTargetIds: targets.toSet(),
              reconciledTargetIds: applied ? missingIds : const {},
            );
          }
        }
        return replies;
      } catch (_) {
        if (queryVersion != null) {
          channelMessages?.failThreadQuery(args.rootId, queryVersion);
        }
        rethrow;
      }
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
      final newestEvents = await ref.read(
        threadPageRepliesProvider(args).future,
      );
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

class _ThreadCursor {
  final int createdAt;
  final String eventId;

  const _ThreadCursor({required this.createdAt, required this.eventId});
}

/// Exhaustively scans a thread using insertion-complete cursor pages.
/// [isCurrent] lets a background refresh stop between pages after disposal.
Future<List<NostrEvent>> fetchCompleteThreadReplies(
  RelaySessionNotifier session,
  ThreadRepliesArgs args, {
  bool Function()? isCurrent,
}) async {
  final replies = <NostrEvent>[];
  // -1 precedes unsigned Nostr timestamps. A non-null cursor selects the
  // insertion-complete route and writer-verified EOF instead of a stale head.
  _ThreadCursor? cursor = const _ThreadCursor(
    createdAt: -1,
    eventId: '0000000000000000000000000000000000000000000000000000000000000000',
  );
  for (var page = 0; page < 500; page++) {
    if (isCurrent != null && !isCurrent()) {
      throw StateError('Thread scan superseded');
    }
    final events = await session.queryRelay([
      _threadRepliesFilter(args, cursor),
    ]);
    replies.addAll(events);
    if (events.length < 200) return replies;
    final last = events.last;
    cursor = _ThreadCursor(createdAt: last.createdAt, eventId: last.id);
  }
  throw Exception('Thread ${args.rootId} exceeded the page safety limit.');
}

NostrFilter _threadRepliesFilter(
  ThreadRepliesArgs args,
  _ThreadCursor? cursor,
) {
  return NostrFilter(
    kinds: EventKind.channelTimelineContentKinds,
    tags: {
      '#e': [args.rootId],
      '#h': [args.channelId],
    },
    limit: 200,
    extensions: {
      // The relay binds this as signed i32. Include every representable depth.
      'depth_limit': 0x7fffffff,
      if (cursor != null) 'thread_cursor': cursor.createdAt,
      if (cursor != null) 'thread_cursor_id': cursor.eventId,
    },
  );
}

class ThreadLocalRepliesNotifier extends Notifier<List<NostrEvent>> {
  final ThreadRepliesArgs args;

  ThreadLocalRepliesNotifier(this.args);

  @override
  List<NostrEvent> build() {
    // Keep optimistic replies across route disposal, but release empty overlays.
    KeepAliveLink? retention;
    listenSelf((previous, next) {
      if (next.isNotEmpty) {
        retention ??= ref.keepAlive();
      } else {
        retention?.close();
        retention = null;
      }
    });
    return const [];
  }

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

final threadLocalRepliesProvider = NotifierProvider.autoDispose
    .family<ThreadLocalRepliesNotifier, List<NostrEvent>, ThreadRepliesArgs>(
      ThreadLocalRepliesNotifier.new,
    );

/// Relay-backed replies merged with signed local replies that are still
/// waiting for acknowledgement.
///
/// The relay query is route-scoped, while the optimistic local overlay stays
/// alive until confirmation so it can survive closing and reopening a thread.
final threadRepliesWithLocalProvider = Provider.autoDispose
    .family<AsyncValue<List<NostrEvent>>, ThreadRepliesArgs>((ref, args) {
      final relayReplies = ref.watch(threadPageRepliesProvider(args));
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
          final channelMessages = ref.read(
            channelMessagesProvider(args.channelId).notifier,
          );
          final confirmedReplies = authoritative
              .where(
                (event) => localReplies.any((local) => local.id == event.id),
              )
              .toList();
          Future.microtask(() {
            channelMessages.cacheConfirmedThreadReplies(confirmedReplies);
            localRepliesNotifier.confirm(authoritativeIds);
            pendingMessagesNotifier.confirm(authoritativeIds);
          });
        }
      }
      if (authoritative != null) {
        return AsyncData(mergeThreadEvents(authoritative, localReplies));
      }
      if (localReplies.isEmpty) return relayReplies;
      return AsyncData(localReplies);
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
