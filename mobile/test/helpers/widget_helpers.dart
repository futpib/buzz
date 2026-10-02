import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:hooks_riverpod/misc.dart';
import 'package:buzz/shared/theme/theme.dart';

class WidgetHelpers {
  static Widget testable({
    required Widget child,
    List<Override> overrides = const [],
    List<NavigatorObserver> navigatorObservers = const [],
    bool disableAnimations = false,
  }) {
    return ProviderScope(
      overrides: overrides,
      child: MaterialApp(
        theme: AppTheme.light(),
        navigatorObservers: navigatorObservers,
        home: Builder(
          builder: (context) => MediaQuery(
            data: MediaQuery.of(
              context,
            ).copyWith(disableAnimations: disableAnimations),
            child: Scaffold(body: child),
          ),
        ),
      ),
    );
  }
}
