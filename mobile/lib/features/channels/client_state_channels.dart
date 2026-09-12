part of 'channels_provider.dart';

extension _ClientStateChannels on ChannelsNotifier {
  Future<List<Channel>?> _readProjectedChannels() async {
    final rows = await ClientStateProjection.instance.channels();
    if (rows == null) return null;
    final channels = <Channel>[];
    for (final row in rows) {
      final id = row['channel_id'] as String?;
      final createdAt = row['created_at'] as int?;
      if (id == null || createdAt == null) continue;
      final lastEventAt = row['last_event_at'] as int?;
      if (lastEventAt != null) _latestObservedByChannel[id] = lastEventAt;
      channels.add(
        Channel(
          id: id,
          name: row['name'] as String? ?? id,
          channelType: row['channel_type'] as String? ?? 'stream',
          visibility: row['visibility'] as String? ?? 'private',
          description: row['description'] as String? ?? '',
          topic: row['topic'] as String?,
          createdBy: row['created_by'] as String? ?? '',
          createdAt: DateTime.fromMillisecondsSinceEpoch(createdAt * 1000),
          memberCount: row['member_count'] as int? ?? 0,
          lastMessageAt: lastEventAt == null
              ? null
              : DateTime.fromMillisecondsSinceEpoch(lastEventAt * 1000),
          archivedAt: row['archived'] == true
              ? DateTime.fromMillisecondsSinceEpoch(createdAt * 1000)
              : null,
          isMember: row['is_member'] as bool? ?? false,
          cachedUnreadCount: row['unread_count'] as int? ?? 0,
        ),
      );
    }
    return channels;
  }

  Future<void> _refreshAfterProjectedChannels(
    Future<({List<Channel>? channels, Object? error, StackTrace? stackTrace})>
    refresh,
    String relayBaseUrl,
    String? pubkey,
  ) async {
    try {
      final refreshed = await _unwrapAuthoritativeRefresh(refresh);
      if (_lifecycleRef.read(relayConfigProvider).baseUrl != relayBaseUrl ||
          _lifecycleRef.read(myPubkeyProvider)?.toLowerCase() != pubkey) {
        return;
      }
      _installProjectedRefresh(refreshed);
    } on _StaleChannelRefresh {
      // A newer scope or refresh owns state.
    } catch (error, stackTrace) {
      debugPrint(
        '[ChannelsNotifier] background refresh after local projection failed: '
        '$error\n$stackTrace',
      );
    }
  }

  Future<({List<Channel>? channels, Object? error, StackTrace? stackTrace})>
  _captureAuthoritativeRefresh() async {
    try {
      return (
        channels: await _fetch(subscribeLive: true),
        error: null,
        stackTrace: null,
      );
    } catch (error, stackTrace) {
      return (channels: null, error: error, stackTrace: stackTrace);
    }
  }

  Future<List<Channel>> _unwrapAuthoritativeRefresh(
    Future<({List<Channel>? channels, Object? error, StackTrace? stackTrace})>
    refresh,
  ) async {
    final outcome = await refresh;
    if (outcome.error case final error?) {
      Error.throwWithStackTrace(error, outcome.stackTrace!);
    }
    return outcome.channels!;
  }
}
