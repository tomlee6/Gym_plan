import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../models/scan.dart';
import '../theme/app_theme.dart';

/// Top-down drawing of a [PlanGeometry]: walls coloured by capture quality,
/// equipment footprints, tags, and optionally the surveyor's live position.
///
/// The geometry is scaled to fit, so the same widget draws the demo outline
/// and a real scan in metres. Line widths are in screen pixels, scaled with
/// the widget's width to match the design.
class FloorPlanView extends StatelessWidget {
  const FloorPlanView({
    super.key,
    required this.geometry,
    required this.walls,
    this.wallProgress,
    this.tags = const <ScanTag>[],
    this.walker,
    this.showGrid = false,
    this.semanticLabel,
    this.measurements = const <(Offset, Offset?)>[],
    this.showDimensions = false,
    this.fit = false,
    this.viewRotation = 0,
  });

  /// How far the plan is turned on screen, in radians, by a
  /// [PlanNavigator] around it. Labels are drawn against it, so they read
  /// the right way up whichever way the plan faces.
  final double viewRotation;

  /// Control distances drawn over the plan (F-03): each a line from its
  /// first end to its second, or a lone end while the second is picked.
  final List<(Offset, Offset?)> measurements;

  /// Labels each captured wall with its length, e.g. "4.20 m", as a
  /// measured floor plan.
  final bool showDimensions;

  /// Fills whatever space it is given, rather than keeping the design's
  /// fixed shape. For a full-screen plan.
  final bool fit;

  /// The plan point under [local], for a widget of [size] drawing
  /// [geometry]. The inverse of what the painter does, so a tap can mark a
  /// point on the plan.
  static Offset planPointAt(Size size, PlanGeometry geometry, Offset local) {
    final Rect frame = geometry.frame;
    final double scale = math.min(
      size.width / frame.width,
      size.height / frame.height,
    );
    final Offset origin = Offset(
      (size.width - frame.width * scale) / 2,
      (size.height - frame.height * scale) / 2,
    );
    return geometry.fromDrawing(frame.topLeft + (local - origin) / scale);
  }

  /// How many plan units one logical pixel covers at [size].
  static double unitsPerPixel(Size size, PlanGeometry geometry) =>
      1 /
      math.min(
        size.width / geometry.frame.width,
        size.height / geometry.frame.height,
      );

  final PlanGeometry geometry;

  /// Quality of each wall in [geometry], in the same order.
  final List<WallQuality> walls;

  /// 0–1 per wall. When given, the wall being walked is drawn part captured.
  final List<double>? wallProgress;
  final List<ScanTag> tags;

  /// Position and heading in radians, for the live view.
  final (Offset, double)? walker;
  final bool showGrid;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final Widget paint = CustomPaint(
      painter: _FloorPlanPainter(
        geometry: geometry,
        walls: walls,
        wallProgress: wallProgress,
        tags: tags,
        walker: walker,
        showGrid: showGrid,
        measurements: measurements,
        showDimensions: showDimensions,
        viewRotation: viewRotation,
        // The painter has no context: labels take the app's font from here.
        fontFamily: DefaultTextStyle.of(context).style.fontFamily,
      ),
      child: fit ? const SizedBox.expand() : null,
    );
    return Semantics(
      image: true,
      label: semanticLabel,
      // A fixed shape, so the card does not jump as a live scan grows.
      child: fit
          ? paint
          : AspectRatio(
              aspectRatio: FloorOutline.canvas.aspectRatio,
              child: paint,
            ),
    );
  }
}

class _FloorPlanPainter extends CustomPainter {
  _FloorPlanPainter({
    required this.geometry,
    required this.walls,
    required this.wallProgress,
    required this.tags,
    required this.walker,
    required this.showGrid,
    required this.measurements,
    required this.showDimensions,
    this.viewRotation = 0,
    this.fontFamily,
  });

  final String? fontFamily;

  /// See [FloorPlanView.viewRotation].
  final double viewRotation;

  /// [angle], or [angle] turned half round, whichever reads the right way
  /// up once the plan is turned by [viewRotation].
  double _readable(double angle) {
    final double onScreen = math.atan2(
      math.sin(angle + viewRotation),
      math.cos(angle + viewRotation),
    );
    return onScreen.abs() > math.pi / 2 + 1e-6 ? angle + math.pi : angle;
  }

  /// Grid spacing on the floor.
  static const double _gridM = 2.5;

  /// Walls shorter than this are left unlabelled: the label would cover
  /// them.
  static const double _minLabelledM = 0.5;

  /// How far from a wall an opening can be and still be in it: RoomPlan
  /// puts a door a little in front of its wall.
  static const double _inWallM = 0.35;

  static const Color _windowColor = Color(0xFF8AD4FF);

  final PlanGeometry geometry;
  final List<WallQuality> walls;
  final List<double>? wallProgress;
  final List<ScanTag> tags;
  final (Offset, double)? walker;
  final bool showGrid;
  final List<(Offset, Offset?)> measurements;
  final bool showDimensions;

  late double _scale;
  late Offset _origin;

  /// One design pixel: the design was drawn on a 325-wide canvas.
  late double _px;

  Offset _map(Offset p) =>
      _origin + (geometry.toDrawing(p) - geometry.frame.topLeft) * _scale;

  /// The middle of the plan on screen.
  Offset get _middle =>
      _origin + geometry.frame.size.center(Offset.zero) * _scale;

  /// Room round a measured plan for the overall dimension lines.
  double get _inset =>
      showDimensions && geometry.walls.isNotEmpty ? 30 * _px : 0;

  /// How thick a wall is drawn: heavier on a measured plan, like a drawing.
  double get _wallWidth => (showDimensions ? 5 : 3.5) * _px;

  @override
  void paint(Canvas canvas, Size size) {
    final Rect frame = geometry.frame;
    _px = size.width / FloorOutline.canvas.width;
    final double inset = _inset;
    _scale = math.max(
      0.0001,
      math.min(
        (size.width - 2 * inset) / frame.width,
        (size.height - 2 * inset) / frame.height,
      ),
    );
    _origin = Offset(
      (size.width - frame.width * _scale) / 2,
      (size.height - frame.height * _scale) / 2,
    );

    canvas.save();
    canvas.clipRect(Offset.zero & size);

    if (showGrid) _paintGrid(canvas, size);
    _paintFloor(canvas);
    _paintObjects(canvas);
    _paintWalls(canvas);
    _paintOpenings(canvas);
    _paintLabels(canvas);
    if (showDimensions) {
      _paintDimensions(canvas, size);
      _paintOverall(canvas, size);
    }
    for (final ScanTag tag in tags) {
      _paintMarker(canvas, _map(tag.position), tag.type.color);
    }
    if (walker != null) {
      _paintWalker(canvas, _map(walker!.$1), walker!.$2 - geometry.rotation);
    }
    for (final (Offset a, Offset? b) in measurements) {
      _paintMeasurement(canvas, _map(a), b == null ? null : _map(b));
    }

    canvas.restore();
  }

  void _paintGrid(Canvas canvas, Size size) {
    final double step = _gridM / geometry.metresPerUnit * _scale;
    if (step < 4) return;
    final Paint line = Paint()
      ..color = AppColors.planBlock
      ..strokeWidth = 1;
    // Anchor the grid to the plan, so it moves with it.
    final Offset anchor = _origin;
    for (double x = anchor.dx % step; x <= size.width; x += step) {
      canvas.drawLine(Offset(x, 0), Offset(x, size.height), line);
    }
    for (double y = anchor.dy % step; y <= size.height; y += step) {
      canvas.drawLine(Offset(0, y), Offset(size.width, y), line);
    }
  }

  /// Shades the floor when the walls run end to end, as in the demo. A live
  /// scan reports walls in no particular order, so it is left unshaded.
  void _paintFloor(Canvas canvas) {
    final List<WallSegment> ws = geometry.walls;
    if (ws.length < 3) return;
    for (int i = 1; i < ws.length; i++) {
      if ((ws[i].start - ws[i - 1].end).distance > 0.001) return;
    }

    final Offset first = _map(ws.first.start);
    final Path floor = Path()..moveTo(first.dx, first.dy);
    for (final WallSegment w in ws) {
      final Offset p = _map(w.end);
      floor.lineTo(p.dx, p.dy);
    }
    floor.close();
    canvas.drawPath(
      floor,
      Paint()..color = AppColors.accent.withValues(alpha: 0.05),
    );
  }

  void _paintObjects(Canvas canvas) {
    final Paint fill = Paint()..color = AppColors.planBlock;
    final Paint edge = Paint()
      ..color = AppColors.planBlockEdge
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1;
    for (final List<Offset> shape in geometry.objects) {
      if (shape.length < 3) continue;
      final Path path = Path()..addPolygon(shape.map(_map).toList(), true);
      canvas.drawPath(path, fill);
      canvas.drawPath(path, edge);
    }
  }

  void _paintWalls(Canvas canvas) {
    final int count = math.min(geometry.walls.length, walls.length);
    for (int i = 0; i < count; i++) {
      final WallSegment w = geometry.walls[i];
      final WallQuality quality = walls[i];
      final double progress =
          wallProgress?[i] ?? (quality == WallQuality.missing ? 0 : 1);

      final Offset a = _map(w.start);
      final Offset b = _map(w.end);
      final Offset split = Offset.lerp(a, b, progress)!;

      if (progress >= 1 && quality != WallQuality.missing) {
        // A finished wall is drawn round its doors and windows, which are
        // drawn into the gaps afterwards.
        double from = 0;
        for (final (double t0, double t1) in _gapsIn(w)) {
          _stroke(
            canvas,
            Offset.lerp(a, b, from)!,
            Offset.lerp(a, b, t0)!,
            quality,
          );
          from = math.max(from, t1);
        }
        _stroke(canvas, Offset.lerp(a, b, from)!, b, quality);
        continue;
      }
      if (progress > 0) {
        // The wall being walked has not been judged yet, so draw it as
        // captured until the surveyor is past it.
        final WallQuality shown = progress < 1 || quality == WallQuality.missing
            ? WallQuality.captured
            : quality;
        _stroke(canvas, a, split, shown);
      }
      if (progress < 1) {
        _stroke(canvas, split, b, WallQuality.missing);
      }
    }
  }

  /// The stretches of [wall] its openings fill, as fractions along it,
  /// in order. An opening counts as in the wall when its middle is within
  /// [_inWallM] of it.
  List<(double, double)> _gapsIn(WallSegment wall) {
    final Offset d = wall.end - wall.start;
    final double lengthSq = d.dx * d.dx + d.dy * d.dy;
    if (lengthSq == 0 || geometry.openings.isEmpty) return const [];
    double along(Offset p) {
      final Offset v = p - wall.start;
      return (v.dx * d.dx + v.dy * d.dy) / lengthSq;
    }

    final double reach = _inWallM / geometry.metresPerUnit;
    final List<(double, double)> gaps = <(double, double)>[];
    for (final PlanOpening o in geometry.openings) {
      final Offset mid = (o.start + o.end) / 2;
      final double t = along(mid);
      if (t < 0 || t > 1) continue;
      if ((wall.start + d * t - mid).distance > reach) continue;
      final double t0 = along(o.start), t1 = along(o.end);
      gaps.add((math.max(0, math.min(t0, t1)), math.min(1, math.max(t0, t1))));
    }
    gaps.sort(((double, double) x, (double, double) y) => x.$1.compareTo(y.$1));
    return gaps;
  }

  /// Doors with their leaf and swing, windows as the thin triple line of a
  /// drawing, and open doorways as a dashed line between two jambs. The
  /// door swings into the room, hinged at its first end: RoomPlan does not
  /// say which way a door opens.
  void _paintOpenings(Canvas canvas) {
    final double w = _wallWidth;
    final Offset middle = _middle;
    final Paint jamb = Paint()
      ..color = AppColors.textPrimary
      ..strokeWidth = 1.6 * _px;
    for (final PlanOpening o in geometry.openings) {
      final Offset a = _map(o.start);
      final Offset b = _map(o.end);
      final double length = (b - a).distance;
      if (length < 3) continue;
      final Offset u = (b - a) / length;
      Offset n = Offset(-u.dy, u.dx);
      final Offset mid = (a + b) / 2;
      if ((mid + n - middle).distance > (mid - middle).distance) n = -n;

      for (final Offset end in <Offset>[a, b]) {
        canvas.drawLine(end - n * (w * 0.7), end + n * (w * 0.7), jamb);
      }
      switch (o.kind) {
        case OpeningKind.door:
          final Offset open = a + n * length;
          final double start = math.atan2(u.dy, u.dx);
          final double cross = u.dx * n.dy - u.dy * n.dx;
          final double sweep = cross > 0 ? math.pi / 2 : -math.pi / 2;
          final Rect circle = Rect.fromCircle(center: a, radius: length);
          canvas
            ..drawArc(
              circle,
              start,
              sweep,
              true,
              Paint()..color = AppColors.textPrimary.withValues(alpha: 0.05),
            )
            ..drawArc(
              circle,
              start,
              sweep,
              false,
              Paint()
                ..color = AppColors.textPrimary.withValues(alpha: 0.7)
                ..style = PaintingStyle.stroke
                ..strokeWidth = 1.1 * _px,
            )
            ..drawLine(
              a,
              open,
              Paint()
                ..color = AppColors.textPrimary
                ..strokeCap = StrokeCap.round
                ..strokeWidth = 2 * _px,
            );
        case OpeningKind.window:
          final Paint glass = Paint()
            ..color = _windowColor
            ..strokeWidth = 1.2 * _px;
          for (final double side in <double>[-0.5, 0, 0.5]) {
            canvas.drawLine(a + n * (w * side), b + n * (w * side), glass);
          }
        case OpeningKind.opening:
          _dashed(
            canvas,
            a,
            b,
            Paint()
              ..color = AppColors.textMuted
              ..strokeWidth = 1.2 * _px,
            dash: 3 * _px,
            gap: 3 * _px,
          );
      }
    }
  }

  /// What RoomPlan recognised an object as, e.g. "Table", in the middle of
  /// its footprint when there is room for it.
  void _paintLabels(Canvas canvas) {
    final int count = math.min(geometry.objects.length, geometry.labels.length);
    for (int i = 0; i < count; i++) {
      final String? label = geometry.labels[i];
      final List<Offset> shape = geometry.objects[i];
      if (label == null || shape.length < 3) continue;
      final List<Offset> corners = shape.map(_map).toList();
      Rect bounds = Rect.fromPoints(corners.first, corners.first);
      for (final Offset p in corners) {
        bounds = bounds.expandToInclude(Rect.fromPoints(p, p));
      }
      final TextPainter text = _text(
        label,
        math.max(8, 8.5 * _px),
        AppColors.textMuted,
        FontWeight.w500,
      );
      if (text.width > bounds.width + 6 || text.height > bounds.height + 2) {
        continue;
      }
      canvas
        ..save()
        ..translate(bounds.center.dx, bounds.center.dy)
        // Level on screen, however the plan is turned.
        ..rotate(-viewRotation);
      text.paint(canvas, Offset(-text.width / 2, -text.height / 2));
      canvas.restore();
    }
  }

  /// The plan's overall width above it and depth to its left, as dimension
  /// lines with end ticks, like an architect's drawing.
  void _paintOverall(Canvas canvas, Size size) {
    final Rect? box = geometry.wallBox;
    if (box == null) return;
    final Offset tl = _origin + (box.topLeft - geometry.frame.topLeft) * _scale;
    final Offset br =
        _origin + (box.bottomRight - geometry.frame.topLeft) * _scale;
    final double gap = 26 * _px;
    final double tick = 4 * _px;
    final Paint ink = Paint()
      ..color = AppColors.textPrimary.withValues(alpha: 0.8)
      ..strokeWidth = 1.1 * _px;
    final Paint faint = Paint()
      ..color = AppColors.textPrimary.withValues(alpha: 0.25)
      ..strokeWidth = 0.8 * _px;

    void dimension(Offset a, Offset b, Offset out, double metres) {
      if ((b - a).distance < 40) return;
      final Offset la = a + out * gap, lb = b + out * gap;
      // Extension lines from the plan out to the dimension line.
      canvas
        ..drawLine(a + out * (6 * _px), la + out * tick, faint)
        ..drawLine(b + out * (6 * _px), lb + out * tick, faint)
        ..drawLine(la, lb, ink);
      final Offset u = (lb - la) / (lb - la).distance;
      for (final Offset end in <Offset>[la, lb]) {
        // A short slash across each end, as drawings mark them.
        final Offset slash = (u + out) * (tick * 0.75);
        canvas.drawLine(end - slash, end + slash, ink..strokeWidth = 1.5 * _px);
      }
      ink.strokeWidth = 1.1 * _px;
      final TextPainter text = _text(
        '${metres.toStringAsFixed(1)} m',
        math.max(9, 10 * _px),
        AppColors.textPrimary,
        FontWeight.w700,
      );
      final Offset at = (la + lb) / 2;
      final bool upright = u.dx.abs() < 0.5;
      canvas
        ..save()
        ..translate(at.dx, at.dy);
      canvas.rotate(_readable(upright ? -math.pi / 2 : 0));
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          Rect.fromCenter(
            center: Offset.zero,
            width: text.width + 10,
            height: text.height + 4,
          ),
          const Radius.circular(4),
        ),
        Paint()..color = AppColors.background,
      );
      text.paint(canvas, Offset(-text.width / 2, -text.height / 2));
      canvas.restore();
    }

    dimension(
      Offset(tl.dx, tl.dy),
      Offset(br.dx, tl.dy),
      const Offset(0, -1),
      box.width * geometry.metresPerUnit,
    );
    dimension(
      Offset(tl.dx, br.dy),
      Offset(tl.dx, tl.dy),
      const Offset(-1, 0),
      box.height * geometry.metresPerUnit,
    );
  }

  TextPainter _text(String s, double size, Color color, FontWeight weight) =>
      TextPainter(
        text: TextSpan(
          text: s,
          style: TextStyle(
            fontFamily: fontFamily,
            fontSize: size,
            fontWeight: weight,
            color: color,
          ),
        ),
        textDirection: TextDirection.ltr,
      )..layout();

  /// Each captured wall's length, in a small label just outside the wall
  /// (on the side away from the middle of the plan), turned to run along it.
  void _paintDimensions(Canvas canvas, Size size) {
    final Offset middle = _middle;
    final Rect? box = geometry.wallBox;
    final int count = math.min(geometry.walls.length, walls.length);
    for (int i = 0; i < count; i++) {
      if (walls[i] == WallQuality.missing) continue;
      final WallSegment w = geometry.walls[i];
      final double metres = w.length * geometry.metresPerUnit;
      if (metres < _minLabelledM) continue;

      final Offset a = _map(w.start);
      final Offset b = _map(w.end);
      final Offset along = b - a;
      if (along.distance < 34) continue;
      // A wall that is the whole side is measured by the overall line.
      if (box != null) {
        final Offset d =
            geometry.toDrawing(w.end) - geometry.toDrawing(w.start);
        if (d.dx.abs() >= box.width * 0.98 || d.dy.abs() >= box.height * 0.98) {
          continue;
        }
      }

      // Outward: the normal pointing away from the plan's middle.
      Offset normal = Offset(-along.dy, along.dx) / along.distance;
      final Offset mid = (a + b) / 2;
      if ((mid + normal - middle).distance < (mid - middle).distance) {
        normal = -normal;
      }

      final TextPainter text = TextPainter(
        text: TextSpan(
          text: '${metres.toStringAsFixed(2)} m',
          style: TextStyle(
            fontFamily: fontFamily,
            fontSize: math.max(9, 9.5 * _px),
            fontWeight: FontWeight.w600,
            color: AppColors.textPrimary,
          ),
        ),
        textDirection: TextDirection.ltr,
      )..layout();

      // Kept upright: a wall drawn right to left reads the same way round.
      final double angle = _readable(math.atan2(along.dy, along.dx));

      final Rect pill = Rect.fromCenter(
        center: Offset.zero,
        width: text.width + 8,
        height: text.height + 3,
      );
      // Pulled in from the edges, so a wall drawn along one is not cut off.
      final double c = math.cos(angle).abs(), s = math.sin(angle).abs();
      final double halfX = (c * pill.width + s * pill.height) / 2 + 2;
      final double halfY = (s * pill.width + c * pill.height) / 2 + 2;
      final Offset out = mid + normal * (text.height / 2 + 7 * _px);
      final Offset at = Offset(
        out.dx.clamp(halfX, math.max(halfX, size.width - halfX)),
        out.dy.clamp(halfY, math.max(halfY, size.height - halfY)),
      );
      canvas
        ..save()
        ..translate(at.dx, at.dy)
        ..rotate(angle)
        ..drawRRect(
          RRect.fromRectAndRadius(pill, const Radius.circular(4)),
          Paint()..color = AppColors.background.withValues(alpha: 0.85),
        );
      text.paint(canvas, Offset(-text.width / 2, -text.height / 2));
      canvas.restore();
    }
  }

  void _stroke(Canvas canvas, Offset a, Offset b, WallQuality quality) {
    if ((b - a).distance < 0.5) return;
    final Paint paint = Paint()
      ..color = quality.color
      ..strokeCap = StrokeCap.round
      ..strokeWidth = quality == WallQuality.missing ? 3 * _px : _wallWidth;

    switch (quality) {
      case WallQuality.captured:
        canvas.drawLine(a, b, paint);
      case WallQuality.weak:
        _dashed(canvas, a, b, paint, dash: 9 * _px, gap: 7 * _px);
      case WallQuality.missing:
        _dashed(canvas, a, b, paint, dash: 4 * _px, gap: 9 * _px);
    }
  }

  void _dashed(
    Canvas canvas,
    Offset a,
    Offset b,
    Paint paint, {
    required double dash,
    required double gap,
  }) {
    final double length = (b - a).distance;
    final Offset unit = (b - a) / length;
    for (double d = 0; d < length; d += dash + gap) {
      final double end = math.min(d + dash, length);
      canvas.drawLine(a + unit * d, a + unit * end, paint);
    }
  }

  void _paintMarker(Canvas canvas, Offset at, Color color) {
    final double r = 5.5 * _px;
    canvas.drawCircle(at, r, Paint()..color = AppColors.background);
    canvas.drawCircle(
      at,
      r,
      Paint()
        ..color = color
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2.5 * _px,
    );
  }

  /// A control distance: a white line with a dot at each end.
  void _paintMeasurement(Canvas canvas, Offset a, Offset? b) {
    final Paint ink = Paint()
      ..color = AppColors.textPrimary
      ..strokeCap = StrokeCap.round
      ..strokeWidth = 2 * _px;
    if (b != null) canvas.drawLine(a, b, ink);
    for (final Offset p in <Offset>[a, ?b]) {
      canvas.drawCircle(p, 5 * _px, Paint()..color = AppColors.background);
      canvas.drawCircle(p, 3.5 * _px, ink);
    }
  }

  void _paintWalker(Canvas canvas, Offset at, double heading) {
    // Field-of-view wedge ahead of the surveyor.
    final double reach = 30 * _px;
    const double spread = 0.55;
    final Path wedge = Path()
      ..moveTo(at.dx, at.dy)
      ..lineTo(
        at.dx + reach * math.cos(heading - spread),
        at.dy + reach * math.sin(heading - spread),
      )
      ..lineTo(
        at.dx + reach * math.cos(heading + spread),
        at.dy + reach * math.sin(heading + spread),
      )
      ..close();
    canvas.drawPath(
      wedge,
      Paint()..color = AppColors.accent.withValues(alpha: 0.18),
    );

    canvas.drawCircle(
      at,
      14 * _px,
      Paint()
        ..color = AppColors.accent.withValues(alpha: 0.4)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.5 * _px,
    );
    canvas.drawCircle(at, 8 * _px, Paint()..color = AppColors.accent);
  }

  @override
  bool shouldRepaint(_FloorPlanPainter old) =>
      old.geometry != geometry ||
      old.walls != walls ||
      old.wallProgress != wallProgress ||
      old.tags != tags ||
      old.walker != walker ||
      old.showGrid != showGrid ||
      old.measurements != measurements ||
      old.showDimensions != showDimensions ||
      old.viewRotation != viewRotation ||
      old.fontFamily != fontFamily;
}

/// "Captured / Weak / Not captured" key under the live plan.
class FloorPlanLegend extends StatelessWidget {
  const FloorPlanLegend({super.key});

  @override
  Widget build(BuildContext context) {
    return const Wrap(
      spacing: 16,
      runSpacing: 6,
      children: <Widget>[
        _LegendItem(color: AppColors.accent, label: 'Captured'),
        _LegendItem(color: AppColors.warning, label: 'Weak'),
        _LegendItem(color: AppColors.notCaptured, label: 'Not captured'),
      ],
    );
  }
}

class _LegendItem extends StatelessWidget {
  const _LegendItem({required this.color, required this.label});

  final Color color;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Container(
          width: 14,
          height: 3,
          decoration: BoxDecoration(
            color: color,
            borderRadius: BorderRadius.circular(2),
          ),
        ),
        const SizedBox(width: 6),
        Text(
          label,
          style: const TextStyle(fontSize: 11.5, color: AppColors.textMuted),
        ),
      ],
    );
  }
}
