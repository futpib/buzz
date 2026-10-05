import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';

import '../relay/nostr_models.dart';
import 'client_state_worker.dart';

typedef ClientStateDatabasePath = Future<String> Function();

/// Android-local, disposable read model used as an instant startup cache.
///
/// The projection and SQLite queries run in long-lived Dart isolates. Relay
/// queries remain authoritative and continue in the background, so projection
/// failures degrade to the existing network path.
class ClientStateProjection {
  ClientStateProjection({
    bool Function()? supportsPlatform,
    ClientStateDatabasePath? databasePath,
    int maxPendingWorkerRequests = 128,
  }) : _supportsPlatform = supportsPlatform ?? (() => Platform.isAndroid),
       _databasePath = databasePath ?? _defaultDatabasePath,
       _maxPendingWorkerRequests = maxPendingWorkerRequests;

  static final instance = ClientStateProjection();

  /// Keep isolate message copies short enough that relay catch-up cannot starve
  /// Flutter's platform-message and frame handling on the caller isolate.
  static const _eventBatchSize = 128;

  /// A warm cache is a first-paint page, not a replacement for timeline
  /// pagination. Returning thousands of event maps across an isolate boundary
  /// can itself block Android's UI thread while Dart reconstructs the objects.
  static const eventPageSize = 200;
  final bool Function() _supportsPlatform;
  final ClientStateDatabasePath _databasePath;
  final int _maxPendingWorkerRequests;
  Future<void> _configuration = Future.value();
  _ClientStatePair? _active;
  int _generation = 0;
  String? _requestedScope;

  Future<bool> configure(String relayUrl, String? viewerPubkey) {
    final requestedPubkey = viewerPubkey?.trim().toLowerCase();
    final requestedRelay = relayUrl.trim().replaceFirst(RegExp(r'/+$'), '');
    final requestedScope = requestedPubkey == null || requestedPubkey.isEmpty
        ? null
        : '$requestedRelay\n$requestedPubkey';
    if (_requestedScope != requestedScope) {
      _requestedScope = requestedScope;
      _generation += 1;
    }
    final completer = Completer<bool>();
    _configuration = _configuration.then((_) async {
      try {
        completer.complete(await _configureNow(relayUrl, viewerPubkey));
      } catch (error, stackTrace) {
        debugPrint(
          '[ClientStateProjection] configure failed: $error\n$stackTrace',
        );
        completer.complete(false);
      }
    });
    return completer.future;
  }

  Future<bool> _configureNow(String relayUrl, String? viewerPubkey) async {
    if (!_supportsPlatform()) return false;
    final normalizedPubkey = viewerPubkey?.trim().toLowerCase();
    if (normalizedPubkey == null || normalizedPubkey.isEmpty) {
      final previous = _active;
      _active = null;
      await previous?.retire();
      return false;
    }
    final normalizedRelay = relayUrl.trim().replaceFirst(RegExp(r'/+$'), '');
    final nextScope = '$normalizedRelay\n$normalizedPubkey';
    if (_active?.scope == nextScope) return true;

    final previous = _active;
    _active = null;
    ClientStateWorkerLane? writer;
    try {
      if (!_isHexPubkey(normalizedPubkey)) {
        throw const FormatException(
          'viewer pubkey must be 64 hexadecimal characters',
        );
      }
      if (normalizedRelay.isEmpty ||
          normalizedRelay.contains(RegExp(r'[\r\n]'))) {
        throw const FormatException(
          'relay URL must be non-empty and single-line',
        );
      }
      final path = await _databasePath();
      writer = await ClientStateWorkerLane.start(
        path: path,
        scope: nextScope,
        viewerPubkey: normalizedPubkey,
        name: 'buzz-client-state-writer',
        maxPendingRequests: _maxPendingWorkerRequests,
      );
      final reader = await ClientStateWorkerLane.start(
        path: path,
        scope: nextScope,
        viewerPubkey: normalizedPubkey,
        name: 'buzz-client-state-reader',
        maxPendingRequests: _maxPendingWorkerRequests,
      );
      _active = _ClientStatePair(nextScope, writer, reader);
    } catch (_) {
      await writer?.close();
      await previous?.retire();
      rethrow;
    }
    await previous?.retire();
    return true;
  }

  Future<void> applyEvents(Iterable<NostrEvent> events) async {
    final generation = _generation;
    final configuration = _configuration;
    await _withActive<void>(generation, configuration, (active) async {
      final iterator = events.iterator;
      while (true) {
        final batch = <NostrEvent>[];
        while (batch.length < _eventBatchSize && iterator.moveNext()) {
          batch.add(iterator.current);
        }
        if (batch.isEmpty) return;
        await active.writer.request({'op': 'apply', 'events': batch});
      }
    }, invalidateOnBackpressure: true);
  }

  Future<void> applyReadMarkers(Map<String, int> contexts) async {
    final generation = _generation;
    final configuration = _configuration;
    if (contexts.isEmpty) return;
    await _withActive<void>(generation, configuration, (active) async {
      await active.writer.request({
        'op': 'apply_read_markers',
        'markers': [
          for (final entry in contexts.entries)
            {'context_id': entry.key, 'read_at': entry.value},
        ],
      });
    }, invalidateOnBackpressure: true);
  }

  Future<List<Map<String, dynamic>>?> channels() =>
      _mapListCommand({'op': 'channels', 'members_only': true});

  Future<List<NostrEvent>?> channelEvents(
    String channelId, {
    int limit = eventPageSize,
  }) async {
    final rows = await _mapListCommand({
      'op': 'channel_events',
      'channel_id': channelId,
      'limit': limit.clamp(1, eventPageSize),
    });
    if (rows == null) return null;
    return [for (final row in rows) NostrEvent.fromJson(row)];
  }

  Future<List<NostrEvent>?> threadEvents(
    String rootId, {
    int limit = eventPageSize,
  }) async {
    final rows = await _mapListCommand({
      'op': 'thread_events',
      'root_id': rootId,
      'limit': limit.clamp(1, eventPageSize),
    });
    if (rows == null) return null;
    return [for (final row in rows) NostrEvent.fromJson(row)];
  }

  Future<List<Map<String, dynamic>>?> activity({int limit = 100}) =>
      _mapListCommand({'op': 'activity', 'limit': limit});

  Future<List<Map<String, dynamic>>?> search(String text, {int limit = 20}) =>
      _mapListCommand({'op': 'search', 'text': text, 'limit': limit});

  /// Stop worker isolates. Production keeps the singleton alive for the app.
  @visibleForTesting
  Future<void> dispose() async {
    _generation += 1;
    _requestedScope = null;
    await _configuration;
    final previous = _active;
    _active = null;
    await previous?.retire();
  }

  Future<List<Map<String, dynamic>>?> _mapListCommand(
    Map<String, Object?> command,
  ) async {
    final generation = _generation;
    final configuration = _configuration;
    final value = await _withActive<Object?>(
      generation,
      configuration,
      (active) => active.reader.request(command),
    );
    if (value is! List) return null;
    return [
      for (final row in value)
        if (row is Map) Map<String, dynamic>.from(row),
    ];
  }

  Future<T?> _withActive<T>(
    int generation,
    Future<void> configuration,
    Future<T> Function(_ClientStatePair active) work, {
    bool invalidateOnBackpressure = false,
  }) async {
    // Unsupported platforms never have a projection to wait for. In particular,
    // do not await a singleton future owned by an earlier test's async zone.
    if (!_supportsPlatform()) return null;
    await configuration;
    if (generation != _generation) return null;
    final active = _active;
    if (active == null || !_supportsPlatform()) return null;
    active.acquire();
    var released = false;
    try {
      final value = await work(active);
      return generation == _generation && identical(active, _active)
          ? value
          : null;
    } on ClientStateWorkerQueueFull catch (error, stackTrace) {
      if (invalidateOnBackpressure) {
        if (identical(active, _active)) _active = null;
        active.release();
        released = true;
        await active.retire(clearScope: true);
      }
      debugPrint(
        '[ClientStateProjection] cache queue full: $error\n$stackTrace',
      );
      return null;
    } catch (error, stackTrace) {
      debugPrint(
        '[ClientStateProjection] cache miss after failure: $error\n$stackTrace',
      );
      return null;
    } finally {
      if (!released) active.release();
    }
  }

  static Future<String> _defaultDatabasePath() async {
    final directory = await getApplicationSupportDirectory();
    return '${directory.path}${Platform.pathSeparator}buzz-client-state-dart-v1.sqlite';
  }

  static bool _isHexPubkey(String value) =>
      value.length == 64 && RegExp(r'^[0-9a-f]+$').hasMatch(value);
}

class _ClientStatePair {
  _ClientStatePair(this.scope, this.writer, this.reader);

  final String scope;
  final ClientStateWorkerLane writer;
  final ClientStateWorkerLane reader;
  int _users = 0;
  bool _retired = false;
  Completer<void>? _drained;
  bool _clearScope = false;
  Future<void>? _retirement;

  void acquire() {
    if (_retired) throw StateError('client-state scope is retired');
    _users += 1;
  }

  void release() {
    _users -= 1;
    if (_users == 0) _drained?.complete();
  }

  Future<void> retire({bool clearScope = false}) {
    _retired = true;
    _clearScope = _clearScope || clearScope;
    return _retirement ??= _retire();
  }

  Future<void> _retire() async {
    if (_users > 0) {
      _drained ??= Completer<void>();
      await _drained!.future;
    }
    if (_clearScope) {
      try {
        await writer.request(const {'op': 'clear_scope'});
      } catch (error, stackTrace) {
        debugPrint(
          '[ClientStateProjection] failed to clear stale cache: '
          '$error\n$stackTrace',
        );
      }
    }
    await Future.wait([writer.close(), reader.close()]);
  }
}
