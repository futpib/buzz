import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import '../relay/nostr_models.dart';

/// Android-local, disposable read model used as an instant startup cache.
///
/// Relay queries remain authoritative and continue in the background. Native
/// failures therefore degrade to the existing network path instead of making
/// the application unusable.
class ClientStateProjection {
  ClientStateProjection({
    MethodChannel channel = const MethodChannel('buzz/client_state'),
    bool Function()? supportsPlatform,
  }) : _channel = channel,
       _supportsPlatform = supportsPlatform ?? (() => Platform.isAndroid);

  static final instance = ClientStateProjection();

  static const _eventBatchSize = 512;
  final MethodChannel _channel;
  final bool Function() _supportsPlatform;
  Future<void> _tail = Future.value();
  String? _scope;
  bool _unavailable = false;

  Future<bool> configure(String relayUrl, String? viewerPubkey) async {
    final normalizedPubkey = viewerPubkey?.trim().toLowerCase();
    if (!_supportsPlatform()) {
      return false;
    }
    if (normalizedPubkey == null || normalizedPubkey.isEmpty) {
      await _schedule<void>(() async {
        if (_scope != null) await _channel.invokeMethod<void>('close');
        _scope = null;
        _unavailable = false;
      });
      return false;
    }
    final nextScope = '${relayUrl.trim()}/\u0000$normalizedPubkey';
    if (_scope == nextScope && !_unavailable) return true;

    final result = await _schedule<bool>(() async {
      final supported =
          await _channel.invokeMethod<bool>('isSupported') ?? false;
      if (!supported) return false;
      final opened = await _channel.invokeMethod<bool>('open', {
        'relayUrl': relayUrl.trim(),
        'viewerPubkey': normalizedPubkey,
      });
      if (opened != true) return false;
      _scope = nextScope;
      _unavailable = false;
      return true;
    });
    if (result != true) _unavailable = true;
    return result ?? false;
  }

  Future<void> applyEvents(Iterable<NostrEvent> events) async {
    final pending = events.toList(growable: false);
    for (var start = 0; start < pending.length; start += _eventBatchSize) {
      final end = (start + _eventBatchSize).clamp(0, pending.length);
      await _command({
        'op': 'apply',
        'events': [
          for (final event in pending.sublist(start, end)) event.toJson(),
        ],
      });
    }
  }

  Future<void> applyReadMarkers(Map<String, int> contexts) async {
    if (contexts.isEmpty) return;
    await _command({
      'op': 'apply_read_markers',
      'markers': [
        for (final entry in contexts.entries)
          {'context_id': entry.key, 'read_at': entry.value},
      ],
    });
  }

  Future<List<Map<String, dynamic>>?> channels() =>
      _mapListCommand({'op': 'channels', 'members_only': true});

  Future<List<NostrEvent>?> channelEvents(
    String channelId, {
    int limit = 5000,
  }) async {
    final rows = await _mapListCommand({
      'op': 'channel_events',
      'channel_id': channelId,
      'limit': limit,
    });
    if (rows == null) return null;
    return [for (final row in rows) NostrEvent.fromJson(row)];
  }

  Future<List<NostrEvent>?> threadEvents(
    String rootId, {
    int limit = 5000,
  }) async {
    final rows = await _mapListCommand({
      'op': 'thread_events',
      'root_id': rootId,
      'limit': limit,
    });
    if (rows == null) return null;
    return [for (final row in rows) NostrEvent.fromJson(row)];
  }

  Future<List<Map<String, dynamic>>?> activity({int limit = 100}) =>
      _mapListCommand({'op': 'activity', 'limit': limit});

  Future<List<Map<String, dynamic>>?> search(String text, {int limit = 20}) =>
      _mapListCommand({'op': 'search', 'text': text, 'limit': limit});

  Future<List<Map<String, dynamic>>?> _mapListCommand(
    Map<String, Object?> command,
  ) async {
    final value = await _command(command);
    if (value is! List) return null;
    return [
      for (final row in value)
        if (row is Map) Map<String, dynamic>.from(row),
    ];
  }

  Future<Object?> _command(Map<String, Object?> command) {
    if (!_supportsPlatform()) return Future.value();
    return _schedule<Object?>(() async {
      if (_scope == null || _unavailable) return null;
      final response = await _channel.invokeMethod<String>(
        'execute',
        jsonEncode(command),
      );
      if (response == null) {
        throw const FormatException('empty native response');
      }
      final envelope = jsonDecode(response);
      if (envelope is! Map<String, dynamic>) {
        throw const FormatException('malformed native response');
      }
      if (envelope['ok'] != true) {
        throw StateError(
          envelope['error'] as String? ?? 'client-state command failed',
        );
      }
      return envelope['value'];
    });
  }

  Future<T?> _schedule<T>(Future<T> Function() work) {
    final completer = Completer<T?>();
    _tail = _tail.then((_) async {
      try {
        completer.complete(await work());
      } on MissingPluginException catch (error) {
        _disable(error);
        completer.complete(null);
      } on PlatformException catch (error) {
        _disable(error);
        completer.complete(null);
      } catch (error, stackTrace) {
        debugPrint('[ClientStateProjection] $error\n$stackTrace');
        completer.complete(null);
      }
    });
    return completer.future;
  }

  void _disable(Object error) {
    _unavailable = true;
    _scope = null;
    debugPrint('[ClientStateProjection] native projection unavailable: $error');
  }
}
