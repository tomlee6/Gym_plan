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
  });

  /// Control distances drawn over the plan (F-03): each a line from its
  /// first end to its second, or a lone end while the second is picked.
  final List<(Offset, Offset?)> measurements;

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
    return frame.topLeft + (local - origin) / scale;
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
    return Semantics(
      image: true,
      label: semanticLabel,
      // A fixed shape, so the card does not jump as a live scan grows.
      child: AspectRatio(
        aspectRatio: FloorOutline.canvas.aspectRatio,
        child: CustomPaint(
          painter: _FloorPlanPainter(
            geometry: geometry,
            walls: walls,
            wallProgress: wallProgress,
            tags: tags,
            walker: walker,
            showGrid: showGrid,
            measurements: measurements,
          ),
        ),
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
  });

  /// Grid spacing on the floor.
  static const double _gridM = 2.5;

  final PlanGeometry geometry;
  final List<WallQuality> walls;
  final List<double>? wallProgress;
  final List<ScanTag> tags;
  final (Offset, double)? walker;
  final bool showGrid;
  final List<(Offset, Offset?)> measurements;

  late double _scale;
  late Offset _origin;

  /// One design pixel: the design was drawn on a 325-wide canvas.
  late double _px;

  Offset _map(Offset p) => _origin + (p - geometry.frame.topLeft) * _scale;

  @override
  void paint(Canvas canvas, Size size) {
    final Rect frame = geometry.frame;
    _scale = math.min(size.width / frame.width, size.height / frame.height);
    _origin = Offset(
      (size.width - frame.width * _scale) / 2,
      (size.height - frame.height * _scale) / 2,
    );
    _px = size.width / FloorOutline.canvas.width;

    canvas.save();
    canvas.clipRect(Offset.zero & size);

    if (showGrid) _paintGrid(canvas, size);
    _paintFloor(canvas);
    _paintObjects(canvas);
    _paintWalls(canvas);
    for (final ScanTag tag in tags) {
      _paintMarker(canvas, _map(tag.position), tag.type.color);
    }
    if (walker != null) _paintWalker(canvas, _map(walker!.$1), walker!.$2);
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
    final Offset anchor = _map(geometry.frame.topLeft);
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

  void _stroke(Canvas canvas, Offset a, Offset b, WallQuality quality) {
    if ((b - a).distance < 0.5) return;
    final Paint paint = Paint()
      ..color = quality.color
      ..strokeCap = StrokeCap.round
      ..strokeWidth = (quality == WallQuality.missing ? 3 : 3.5) * _px;

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
      old.measurements != measurements;
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
