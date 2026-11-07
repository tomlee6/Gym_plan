import 'dart:math' as math;

import 'package:flutter/cupertino.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import 'pressable.dart';

/// Where the plan sits on screen: how far it is zoomed, turned and moved.
@immutable
class PlanView {
  const PlanView({
    this.scale = 1,
    this.rotation = 0,
    this.offset = Offset.zero,
  });

  /// 1 is the plan fitted to its box.
  final double scale;

  /// Radians, clockwise on screen. Any angle: the plan turns a full 360°.
  final double rotation;

  /// How far the plan's middle has moved from the box's middle, in pixels.
  final Offset offset;

  static const PlanView fitted = PlanView();

  bool get isFitted =>
      (scale - 1).abs() < 1e-3 &&
      _wrap(rotation).abs() < 1e-3 &&
      offset.distance < 0.5;

  /// The rotation in whole degrees, 0–359, for the compass label.
  int get degrees => (_wrap(rotation) * 180 / math.pi).round() % 360;

  /// Where a point of the plan drawn at [local] (in an unturned, unzoomed
  /// box of [size]) shows on screen.
  Offset toScreen(Size size, Offset local) {
    final Offset c = size.center(Offset.zero);
    return c + offset + _turn(local - c, rotation) * scale;
  }

  /// The inverse of [toScreen].
  Offset toLocal(Size size, Offset screen) {
    final Offset c = size.center(Offset.zero);
    return c + _turn((screen - c - offset) / scale, -rotation);
  }

  /// This view with [scale] and [rotation] changed, keeping the plan point
  /// under [focus] (a screen point) where it is.
  PlanView about(Size size, Offset focus, {double? scale, double? rotation}) {
    final Offset p = toLocal(size, focus);
    final double s = scale ?? this.scale;
    final double r = rotation ?? this.rotation;
    final Offset c = size.center(Offset.zero);
    return PlanView(
      scale: s,
      rotation: r,
      offset: focus - c - _turn(p - c, r) * s,
    );
  }

  Matrix4 matrix(Size size) {
    final Offset c = size.center(Offset.zero);
    return Matrix4.identity()
      ..translateByDouble(c.dx + offset.dx, c.dy + offset.dy, 0, 1)
      ..rotateZ(rotation)
      ..scaleByDouble(scale, scale, 1, 1)
      ..translateByDouble(-c.dx, -c.dy, 0, 1);
  }

  static Offset _turn(Offset v, double a) {
    final double c = math.cos(a), s = math.sin(a);
    return Offset(v.dx * c - v.dy * s, v.dx * s + v.dy * c);
  }

  /// [a] in (-π, π].
  static double _wrap(double a) => math.atan2(math.sin(a), math.cos(a));
}

/// Zoom, pan and turn for a 2D floor plan, by touch and by buttons.
///
/// * Pinch to zoom, drag to move, and turn two fingers to rotate the plan
///   any way round (a full 360°).
/// * Buttons: zoom in, zoom out, turn 90° and back to fitted. The fitted
///   button also shows how far the plan is turned.
///
/// [builder] draws the plan fitted to the box; it is given the current
/// rotation so the plan's labels can stay the right way up.
///
/// In a scrolling page ([inScroll]) one finger scrolls the page, as it
/// should; only once the plan is zoomed or turned does one finger move the
/// plan instead. Pinch and the buttons work either way.
class PlanNavigator extends StatefulWidget {
  const PlanNavigator({
    super.key,
    required this.builder,
    this.inScroll = false,
    this.minScale = 0.5,
    this.maxScale = 8,
    this.controlsAlignment = Alignment.bottomRight,
    this.compact = false,
  });

  final Widget Function(BuildContext context, double rotation) builder;
  final bool inScroll;
  final double minScale;
  final double maxScale;
  final Alignment controlsAlignment;

  /// Smaller buttons, for a plan in a card.
  final bool compact;

  static const double zoomStep = 1.5;

  @override
  State<PlanNavigator> createState() => _PlanNavigatorState();
}

class _PlanNavigatorState extends State<PlanNavigator> {
  PlanView _view = PlanView.fitted;
  PlanView _start = PlanView.fitted;
  Offset _startFocus = Offset.zero;
  Size _size = Size.zero;

  void _set(PlanView v) => setState(() => _view = v);

  double _clamp(double s) => s.clamp(widget.minScale, widget.maxScale);

  void _zoom(double factor) => _set(
    _view.about(
      _size,
      _size.center(Offset.zero),
      scale: _clamp(_view.scale * factor),
    ),
  );

  void _turn90() => _set(
    _view.about(
      _size,
      _size.center(Offset.zero),
      rotation: _view.rotation + math.pi / 2,
    ),
  );

  void _onDoubleTap() => _set(
    _view.isFitted || _view.scale < 1
        ? _view.about(_size, _startFocus, scale: _clamp(_view.scale * 2))
        : PlanView.fitted,
  );

  void _onScaleStart(ScaleStartDetails d) {
    _start = _view;
    _startFocus = d.localFocalPoint;
  }

  void _onScaleUpdate(ScaleUpdateDetails d) {
    // Where the fingers first touched, moved by the fingers, zoomed and
    // turned about them.
    final PlanView moved = PlanView(
      scale: _start.scale,
      rotation: _start.rotation,
      offset: _start.offset + (d.localFocalPoint - _startFocus),
    );
    _set(
      moved.about(
        _size,
        d.localFocalPoint,
        scale: _clamp(_start.scale * d.scale),
        rotation: _start.rotation + d.rotation,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    // In a page that scrolls, a drag is the page's until the plan is zoomed
    // or turned; after that the plan takes every touch on it.
    final bool eager = widget.inScroll && !_view.isFitted;
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        _size = constraints.biggest;
        final Widget plan = Transform(
          transform: _view.matrix(_size),
          child: widget.builder(context, _view.rotation),
        );
        return Stack(
          children: <Widget>[
            Positioned.fill(
              child: ClipRect(
                child: RawGestureDetector(
                  behavior: HitTestBehavior.opaque,
                  gestures: <Type, GestureRecognizerFactory>{
                    _PlanScaleRecognizer:
                        GestureRecognizerFactoryWithHandlers<
                          _PlanScaleRecognizer
                        >(
                          () => _PlanScaleRecognizer(debugOwner: this),
                          (_PlanScaleRecognizer r) => r
                            ..eager = eager
                            ..onStart = _onScaleStart
                            ..onUpdate = _onScaleUpdate,
                        ),
                    // A double tap zooms in on the spot, or back to fitted.
                    DoubleTapGestureRecognizer:
                        GestureRecognizerFactoryWithHandlers<
                          DoubleTapGestureRecognizer
                        >(
                          () => DoubleTapGestureRecognizer(debugOwner: this),
                          (DoubleTapGestureRecognizer r) => r
                            ..onDoubleTapDown = (TapDownDetails d) {
                              _startFocus = d.localPosition;
                            }
                            ..onDoubleTap = _onDoubleTap,
                        ),
                  },
                  child: plan,
                ),
              ),
            ),
            Align(
              alignment: widget.controlsAlignment,
              child: Padding(
                padding: const EdgeInsets.all(8),
                child: _Controls(
                  compact: widget.compact,
                  view: _view,
                  canZoomIn: _view.scale < widget.maxScale - 1e-3,
                  canZoomOut: _view.scale > widget.minScale + 1e-3,
                  onZoomIn: () => _zoom(PlanNavigator.zoomStep),
                  onZoomOut: () => _zoom(1 / PlanNavigator.zoomStep),
                  onTurn: _turn90,
                  onReset: () => _set(PlanView.fitted),
                ),
              ),
            ),
          ],
        );
      },
    );
  }
}

/// Pinch, drag and twist. With [eager] set it claims a touch the moment it
/// lands, so a scrolling page around the plan cannot take it: used once
/// the plan is zoomed or turned. Otherwise it waits, and a page scroll
/// (which needs less movement to start) wins a one-finger drag.
class _PlanScaleRecognizer extends ScaleGestureRecognizer {
  _PlanScaleRecognizer({super.debugOwner});

  bool eager = false;

  @override
  void addAllowedPointer(PointerDownEvent event) {
    super.addAllowedPointer(event);
    if (eager) resolvePointer(event.pointer, GestureDisposition.accepted);
  }
}

class _Controls extends StatelessWidget {
  const _Controls({
    required this.compact,
    required this.view,
    required this.canZoomIn,
    required this.canZoomOut,
    required this.onZoomIn,
    required this.onZoomOut,
    required this.onTurn,
    required this.onReset,
  });

  final bool compact;
  final PlanView view;
  final bool canZoomIn;
  final bool canZoomOut;
  final VoidCallback onZoomIn;
  final VoidCallback onZoomOut;
  final VoidCallback onTurn;
  final VoidCallback onReset;

  @override
  Widget build(BuildContext context) {
    final double gap = compact ? 6 : 8;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        _NavButton(
          icon: CupertinoIcons.plus,
          label: 'Zoom in',
          compact: compact,
          onTap: canZoomIn ? onZoomIn : null,
        ),
        SizedBox(height: gap),
        _NavButton(
          icon: CupertinoIcons.minus,
          label: 'Zoom out',
          compact: compact,
          onTap: canZoomOut ? onZoomOut : null,
        ),
        SizedBox(height: gap),
        _NavButton(
          icon: Icons.rotate_90_degrees_cw_outlined,
          label: 'Rotate 90 degrees',
          compact: compact,
          onTap: onTurn,
        ),
        SizedBox(height: gap),
        _NavButton(
          // Points the way the plan's north now faces.
          icon: Icons.navigation_rounded,
          iconTurns: view.rotation,
          label: view.isFitted
              ? 'Plan fitted'
              : 'Reset plan view, turned ${view.degrees} degrees',
          caption: view.degrees == 0 ? null : '${view.degrees}°',
          compact: compact,
          onTap: view.isFitted ? null : onReset,
        ),
      ],
    );
  }
}

class _NavButton extends StatelessWidget {
  const _NavButton({
    required this.icon,
    required this.label,
    required this.onTap,
    required this.compact,
    this.iconTurns = 0,
    this.caption,
  });

  final IconData icon;
  final String label;
  final VoidCallback? onTap;
  final bool compact;
  final double iconTurns;
  final String? caption;

  @override
  Widget build(BuildContext context) {
    final double side = compact ? 36 : 44;
    return Pressable(
      onTap: onTap,
      semanticLabel: label,
      haptic: HapticImpact.selection,
      pressedScale: 0.92,
      child: Container(
        width: side,
        height: side,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: Colors.black.withValues(alpha: 0.55),
          border: Border.all(
            color: Colors.white.withValues(alpha: 0.25),
            width: 1.2,
          ),
        ),
        child: Stack(
          alignment: Alignment.center,
          children: <Widget>[
            Transform.rotate(
              angle: iconTurns,
              child: Icon(
                icon,
                size: compact ? 17 : 20,
                color: AppColors.textPrimary,
              ),
            ),
            if (caption != null)
              Positioned(
                bottom: compact ? 1 : 3,
                child: Text(
                  caption!,
                  style: TextStyle(
                    fontSize: compact ? 8 : 9,
                    fontWeight: FontWeight.w700,
                    color: AppColors.accent,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
