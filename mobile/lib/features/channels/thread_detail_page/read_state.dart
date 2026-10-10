part of '../thread_detail_page.dart';

void _useThreadReplyReadState(
  WidgetRef ref,
  String threadHeadId,
  List<TimelineMessage> replies,
) {
  final readState = ref.watch(readStateProvider);
  final visibleReplyReadKey = replies
      .map((reply) => '${reply.id}:${reply.createdAt}')
      .join(',');

  useEffect(() {
    if (!readState.isReady || replies.isEmpty) return null;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(readStateProvider.notifier).markContextsRead({
        for (final reply in replies) msgContextKey(reply.id): reply.createdAt,
      });
    });
    return null;
  }, [threadHeadId, readState.isReady, visibleReplyReadKey]);
}
