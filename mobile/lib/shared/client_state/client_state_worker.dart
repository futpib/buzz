import 'dart:async';
import 'dart:isolate';

import 'package:sqlite3/sqlite3.dart';

import 'client_state_database.dart';
import 'client_state_projector.dart';
import 'client_state_queries.dart';

const _requestTimeout = Duration(seconds: 15);
const _defaultMaxPendingRequests = 128;

/// Raised before an isolate command can exceed its bounded pending queue.
class ClientStateWorkerQueueFull implements Exception {
  const ClientStateWorkerQueueFull(this.maximum);

  final int maximum;

  @override
  String toString() =>
      'client-state worker queue is full (maximum $maximum requests)';
}

/// One long-lived SQLite isolate lane with bounded asynchronous requests.
class ClientStateWorkerLane {
  ClientStateWorkerLane._(
    this._isolate,
    this._commands,
    this._responses,
    this._exits,
    this._responseSubscription,
    this._exitSubscription,
    this._maxPendingRequests,
  );

  /// Opens SQLite inside a new worker isolate and waits until it is ready.
  static Future<ClientStateWorkerLane> start({
    required String path,
    required String scope,
    required String viewerPubkey,
    required String name,
    int maxPendingRequests = _defaultMaxPendingRequests,
  }) async {
    if (maxPendingRequests < 1) {
      throw ArgumentError.value(
        maxPendingRequests,
        'maxPendingRequests',
        'must be positive',
      );
    }
    final responses = ReceivePort('$name-responses');
    final exits = ReceivePort('$name-exits');
    final bootstrap = Completer<Object?>();
    ClientStateWorkerLane? lane;
    final responseSubscription = responses.listen((message) {
      if (!bootstrap.isCompleted) {
        bootstrap.complete(message);
      } else {
        lane?._handleResponse(message);
      }
    });
    late final StreamSubscription<Object?> exitSubscription;
    exitSubscription = exits.listen((_) => lane?._handleExit());
    Isolate? isolate;
    final Object? ready;
    try {
      isolate = await Isolate.spawn<List<Object?>>(
        clientStateWorkerMain,
        [responses.sendPort, path, scope, viewerPubkey],
        debugName: name,
        errorsAreFatal: true,
        onExit: exits.sendPort,
      );
      ready = await bootstrap.future.timeout(_requestTimeout);
    } catch (_) {
      isolate?.kill(priority: Isolate.immediate);
      await responseSubscription.cancel();
      await exitSubscription.cancel();
      responses.close();
      exits.close();
      rethrow;
    }
    if (ready is! SendPort) {
      isolate.kill(priority: Isolate.immediate);
      await responseSubscription.cancel();
      await exitSubscription.cancel();
      responses.close();
      exits.close();
      throw StateError(
        ready is String ? ready : 'client-state worker failed to start',
      );
    }
    lane = ClientStateWorkerLane._(
      isolate,
      ready,
      responses,
      exits,
      responseSubscription,
      exitSubscription,
      maxPendingRequests,
    );
    return lane;
  }

  final Isolate _isolate;
  final SendPort _commands;
  final ReceivePort _responses;
  final ReceivePort _exits;
  final Map<int, Completer<Object?>> _pending = {};
  final StreamSubscription<Object?> _responseSubscription;
  final StreamSubscription<Object?> _exitSubscription;
  final int _maxPendingRequests;
  int _nextRequestId = 1;
  bool _closed = false;
  Future<void>? _cleanup;

  /// Queues a command without performing SQLite work on the caller isolate.
  Future<Object?> request(Map<String, Object?> command) {
    if (_closed) {
      return Future.error(StateError('client-state worker is closed'));
    }
    if (_pending.length >= _maxPendingRequests) {
      return Future.error(ClientStateWorkerQueueFull(_maxPendingRequests));
    }
    final requestId = _nextRequestId++;
    final completer = Completer<Object?>();
    _pending[requestId] = completer;
    _commands.send([requestId, command]);
    return completer.future.timeout(
      _requestTimeout,
      onTimeout: () {
        _pending.remove(requestId);
        throw TimeoutException('client-state worker request timed out');
      },
    );
  }

  /// Closes SQLite and stops this worker lane.
  Future<void> close() async {
    if (_closed) {
      await _cleanupPorts();
      return;
    }
    try {
      await request(const {'op': 'close'});
    } catch (_) {
      // The projection is disposable; forced isolate cleanup is sufficient.
    } finally {
      _closed = true;
      _failPending(StateError('client-state worker closed'));
      _isolate.kill(priority: Isolate.immediate);
      await _cleanupPorts();
    }
  }

  void _handleResponse(Object? message) {
    if (message is! List || message.length < 3 || message.first is! int) return;
    final requestId = message[0] as int;
    final completer = _pending.remove(requestId);
    if (completer == null || completer.isCompleted) return;
    if (message[1] == true) {
      completer.complete(message[2]);
    } else {
      completer.completeError(
        StateError(message[2] as String? ?? 'client-state command failed'),
        message.length > 3
            ? StackTrace.fromString(message[3] as String)
            : StackTrace.current,
      );
    }
  }

  void _handleExit() {
    if (_closed) return;
    _closed = true;
    _failPending(StateError('client-state worker stopped unexpectedly'));
    unawaited(_cleanupPorts());
  }

  void _failPending(Object error) {
    for (final completer in _pending.values) {
      if (!completer.isCompleted) completer.completeError(error);
    }
    _pending.clear();
  }

  Future<void> _cleanupPorts() => _cleanup ??= _closePorts();

  Future<void> _closePorts() async {
    await _responseSubscription.cancel();
    await _exitSubscription.cancel();
    _responses.close();
    _exits.close();
  }
}

/// Entry point for a long-lived client-state SQLite worker isolate.
@pragma('vm:entry-point')
void clientStateWorkerMain(List<Object?> arguments) {
  final owner = arguments[0] as SendPort;
  final path = arguments[1] as String;
  final scope = arguments[2] as String;
  final viewerPubkey = arguments[3] as String;
  final Database database;
  try {
    database = initializeClientStateDatabase(path);
  } catch (error, stackTrace) {
    owner.send('$error\n$stackTrace');
    return;
  }
  final commands = ReceivePort('client-state-commands');
  owner.send(commands.sendPort);
  commands.listen((message) {
    if (message is! List || message.length != 2 || message.first is! int) {
      return;
    }
    final requestId = message[0] as int;
    final rawCommand = message[1];
    if (rawCommand is! Map) {
      owner.send([requestId, false, 'client-state command must be a map']);
      return;
    }
    final command = Map<String, Object?>.from(rawCommand);
    if (command['op'] == 'close') {
      database.close();
      owner.send([requestId, true, null]);
      commands.close();
      return;
    }
    try {
      owner.send([
        requestId,
        true,
        executeClientStateCommand(database, scope, viewerPubkey, command),
      ]);
    } catch (error, stackTrace) {
      owner.send([requestId, false, error.toString(), stackTrace.toString()]);
    }
  });
}

/// Dispatches one validated worker command against an open SQLite connection.
Object? executeClientStateCommand(
  Database database,
  String scope,
  String viewerPubkey,
  Map<String, Object?> command,
) {
  final op = command['op'];
  return switch (op) {
    'apply' => applyClientStateEvents(
      database,
      scope,
      viewerPubkey,
      _list(command, 'events'),
    ),
    'apply_read_markers' => applyClientStateReadMarkers(
      database,
      scope,
      viewerPubkey,
      _list(command, 'markers'),
    ),
    'clear_scope' => _clearScope(database, scope),
    'channels' => queryClientStateChannels(
      database,
      scope,
      command['members_only'] == true,
    ),
    'channel_events' => queryClientStateChannelEvents(
      database,
      scope,
      _string(command, 'channel_id'),
      _int(command, 'limit'),
    ),
    'thread_events' => queryClientStateThreadEvents(
      database,
      scope,
      _string(command, 'root_id'),
      _int(command, 'limit'),
    ),
    'activity' => queryClientStateActivity(
      database,
      scope,
      viewerPubkey,
      _int(command, 'limit'),
    ),
    'search' => queryClientStateSearch(
      database,
      scope,
      viewerPubkey,
      _string(command, 'text'),
      _int(command, 'limit'),
    ),
    _ => throw ArgumentError.value(op, 'op', 'unknown client-state command'),
  };
}

Object? _clearScope(Database database, String scope) {
  clearClientStateScope(database, scope);
  return null;
}

List<Object?> _list(Map<String, Object?> command, String key) {
  final value = command[key];
  if (value is! List) throw FormatException('$key must be a list');
  return value;
}

String _string(Map<String, Object?> command, String key) {
  final value = command[key];
  if (value is! String || value.isEmpty) {
    throw FormatException('$key must be a non-empty string');
  }
  return value;
}

int _int(Map<String, Object?> command, String key) {
  final value = command[key];
  if (value is! int) throw FormatException('$key must be an int');
  return value;
}
