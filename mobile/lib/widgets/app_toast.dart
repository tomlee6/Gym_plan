import 'dart:async';

import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import 'hairline_container.dart';

const Duration _fade = Duration(milliseconds: 220);
const Duration _hold = Duration(milliseconds: 1500);

/// Brief message floating above the tab bar. Used while the rest of the flow
/// is still being built, so a tap never silently does nothing.
void showAppToast(BuildContext context, String message) {
  final OverlayState overlay = Overlay.of(context);

  late final OverlayEntry entry;
  entry = OverlayEntry(
    builder: (BuildContext context) => _ToastBody(
      message: message,
      onDismissed: () {
        // The overlay may already be gone if the route was popped.
        if (entry.mounted) entry.remove();
      },
    ),
  );

  overlay.insert(entry);
}

class _ToastBody extends StatefulWidget {
  const _ToastBody({required this.message, required this.onDismissed});

  final String message;
  final VoidCallback onDismissed;

  @override
  State<_ToastBody> createState() => _ToastBodyState();
}

class _ToastBodyState extends State<_ToastBody> {
  bool _visible = false;
  Timer? _hideTimer;
  Timer? _removeTimer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) setState(() => _visible = true);
    });

    _hideTimer = Timer(_hold, () {
      if (mounted) setState(() => _visible = false);
    });
    _removeTimer = Timer(_hold + _fade, widget.onDismissed);
  }

  @override
  void dispose() {
    // Without this the timers outlive the tree and fire on a dead overlay.
    _hideTimer?.cancel();
    _removeTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Positioned(
      left: 24,
      right: 24,
      bottom: MediaQuery.paddingOf(context).bottom + 104,
      child: IgnorePointer(
        child: AnimatedOpacity(
          opacity: _visible ? 1 : 0,
          duration: _fade,
          curve: Curves.easeOut,
          child: AnimatedSlide(
            offset: _visible ? Offset.zero : const Offset(0, 0.25),
            duration: _fade,
            curve: Curves.easeOut,
            child: Center(
              child: HairlineContainer(
                radius: 16,
                fillColor: AppColors.tabBarFill,
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 11,
                ),
                child: Text(
                  widget.message,
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    fontSize: 13,
                    color: AppColors.textPrimary,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
