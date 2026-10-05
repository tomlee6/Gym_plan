import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

/// Wraps a tappable surface in the iOS-style press-and-shrink response used
/// across the app, with a haptic tick on tap.
class Pressable extends StatefulWidget {
  const Pressable({
    super.key,
    required this.child,
    required this.onTap,
    this.pressedScale = 0.97,
    this.disabledOpacity = 0.55,
    this.haptic = HapticImpact.light,
    this.semanticLabel,
  });

  final Widget child;
  final VoidCallback? onTap;
  final double pressedScale;
  final double disabledOpacity;
  final HapticImpact haptic;
  final String? semanticLabel;

  @override
  State<Pressable> createState() => _PressableState();
}

enum HapticImpact { none, selection, light, medium }

class _PressableState extends State<Pressable> {
  bool _pressed = false;

  bool get _enabled => widget.onTap != null;

  void _fireHaptic() {
    switch (widget.haptic) {
      case HapticImpact.none:
        break;
      case HapticImpact.selection:
        HapticFeedback.selectionClick();
      case HapticImpact.light:
        HapticFeedback.lightImpact();
      case HapticImpact.medium:
        HapticFeedback.mediumImpact();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      enabled: _enabled,
      label: widget.semanticLabel,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTapDown: _enabled ? (_) => setState(() => _pressed = true) : null,
        onTapCancel: _enabled ? () => setState(() => _pressed = false) : null,
        onTapUp: _enabled ? (_) => setState(() => _pressed = false) : null,
        onTap: _enabled
            ? () {
                _fireHaptic();
                widget.onTap!.call();
              }
            : null,
        child: AnimatedScale(
          scale: _pressed ? widget.pressedScale : 1,
          duration: const Duration(milliseconds: 120),
          curve: Curves.easeOut,
          child: AnimatedOpacity(
            opacity: _enabled ? 1 : widget.disabledOpacity,
            duration: const Duration(milliseconds: 150),
            child: widget.child,
          ),
        ),
      ),
    );
  }
}
