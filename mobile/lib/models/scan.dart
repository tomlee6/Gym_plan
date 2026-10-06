import 'package:flutter/material.dart';
import 'package:room_scan/room_scan.dart';

import '../theme/app_theme.dart';
import 'plan.dart';

/// What the surveyor chose on the setup screen.
@immutable
class ScanConfig {
  const ScanConfig({
    required this.facilityId,
    required this.facility,
    required this.level,
    required this.heightM,
  });

  /// The facility's id on the platform, sent when the capture is registered.
  final String facilityId;

  /// Its name, for display.
  final String facility;
  final int level;

  /// Floor-to-floor height the 3D model raises the walls to.
  final double heightM;

  /// "Northgate · Level 2", as shown in the scanning pill.
  String get shortTitle =>
      '${facility.split(' ').first} · ${levelLabel(level)}';

  /// "Northgate Fitness · Level 2".
  String get title => '$facility · ${levelLabel(level)}';
}

/// Features the surveyor can tag while walking the floor.
enum TagType {
  ceiling(
    label: 'Ceiling height',
    shortLabel: 'Ceiling',
    hint: 'Raises the walls in the model',
    color: AppColors.accent,
    icon: Icons.height_rounded,
  ),
  fireExit(
    label: 'Fire exit',
    shortLabel: 'Fire exit',
    hint: 'Cut as an opening, shown in the walkthrough',
    color: AppColors.danger,
    icon: Icons.door_front_door_outlined,
  ),
  mirror(
    label: 'Mirror wall',
    shortLabel: 'Mirror wall',
    hint: 'Rendered reflective',
    color: AppColors.violet,
    icon: Icons.crop_portrait_rounded,
  ),
  power(
    label: 'Power point',
    shortLabel: 'Power',
    hint: 'Recorded on the plan only',
    color: AppColors.info,
    icon: Icons.bolt_rounded,
  ),
  stair(
    label: 'Stair or lift opening',
    shortLabel: 'Stair',
    hint: 'Cut as a void with a rail',
    color: AppColors.warning,
    icon: Icons.stairs_outlined,
  );

  const TagType({
    required this.label,
    required this.shortLabel,
    required this.hint,
    required this.color,
    required this.icon,
  });

  final String label;

  /// Label on the compact chips under the coverage bar.
  final String shortLabel;
  final String hint;
  final Color color;
  final IconData icon;

  Color get tint => color.withValues(alpha: 0.15);
}

@immutable
class ScanTag {
  const ScanTag({required this.type, required this.position, this.heightM});

  final TagType type;

  /// Where on the outline it was dropped, in [PlanGeometry] units.
  final Offset position;

  /// Only set for [TagType.ceiling].
  final double? heightM;
}

/// How well a stretch of wall was captured.
enum WallQuality {
  captured(AppColors.accent),
  weak(AppColors.warning),
  missing(AppColors.notCaptured);

  const WallQuality(this.color);

  final Color color;
}

@immutable
class WallSegment {
  const WallSegment(
    this.start,
    this.end, {
    this.name,
    this.lowConfidence = false,
  });

  final Offset start;
  final Offset end;

  /// Plain-language name used in warnings, e.g. "East wall". Real scans do
  /// not name walls, so this is only set on the demo outline.
  final String? name;

  /// The mock sensor reads this stretch badly however it is walked.
  final bool lowConfidence;

  double get length => (end - start).distance;
}

/// A top-down floor plan: walls, equipment footprints, and the region of
/// the plane worth showing.
///
/// Units are arbitrary; [metresPerUnit] converts them. The demo outline uses
/// canvas units, a LiDAR scan uses metres directly.
@immutable
class PlanGeometry {
  const PlanGeometry({
    required this.walls,
    required this.frame,
    this.objects = const <List<Offset>>[],
    this.metresPerUnit = 1,
    this.areaM2,
  });

  /// Fits a frame around scanned walls and objects, in metres, with a margin.
  /// The frame never shrinks below [minSpanM] so an early scan with one wall
  /// is not drawn absurdly zoomed in.
  factory PlanGeometry.fitted({
    required List<WallSegment> walls,
    List<List<Offset>> objects = const <List<Offset>>[],
    double? areaM2,
    Offset? include,
    double marginM = 1.0,
    double minSpanM = 8.0,
  }) {
    final List<Offset> points = <Offset>[
      for (final WallSegment w in walls) ...<Offset>[w.start, w.end],
      for (final List<Offset> o in objects) ...o,
      ?include,
    ];

    Rect frame;
    if (points.isEmpty) {
      frame = Rect.fromCenter(
        center: Offset.zero,
        width: minSpanM,
        height: minSpanM,
      );
    } else {
      double left = points.first.dx, right = left;
      double top = points.first.dy, bottom = top;
      for (final Offset p in points) {
        if (p.dx < left) left = p.dx;
        if (p.dx > right) right = p.dx;
        if (p.dy < top) top = p.dy;
        if (p.dy > bottom) bottom = p.dy;
      }
      frame = Rect.fromLTRB(left, top, right, bottom).inflate(marginM);
      if (frame.width < minSpanM || frame.height < minSpanM) {
        frame = Rect.fromCenter(
          center: frame.center,
          width: frame.width < minSpanM ? minSpanM : frame.width,
          height: frame.height < minSpanM ? minSpanM : frame.height,
        );
      }
    }

    return PlanGeometry(
      walls: walls,
      objects: objects,
      frame: frame,
      areaM2: areaM2,
    );
  }

  final List<WallSegment> walls;

  /// Equipment footprints as closed polygons.
  final List<List<Offset>> objects;

  /// The part of the plane the drawing should show.
  final Rect frame;
  final double metresPerUnit;

  /// Floor area, when it is known. A scan only reports it once the floor
  /// polygon is recognised.
  final double? areaM2;

  double get perimeter =>
      walls.fold(0, (double sum, WallSegment w) => sum + w.length);
}

/// The demo outline the simulated scan walks, in a 325 × 290 canvas.
///
/// Matches the prototype's drawing so the simulated walk looks like the
/// design. The LiDAR scan builds its own [PlanGeometry] from RoomPlan.
class FloorOutline {
  const FloorOutline._();

  static const Size canvas = Size(325, 290);

  /// Converts canvas units to metres. Chosen so the outline is 412 m².
  static const double metresPerUnit = 0.0968;

  /// Walked clockwise from the north-west corner.
  static const List<WallSegment> walls = <WallSegment>[
    WallSegment(Offset(36, 44), Offset(288, 44), name: 'North wall'),
    WallSegment(Offset(288, 44), Offset(288, 132), name: 'East wall'),
    WallSegment(Offset(288, 132), Offset(238, 132)),
    WallSegment(Offset(238, 132), Offset(238, 150)),
    WallSegment(
      Offset(238, 150),
      Offset(238, 185),
      name: 'Inner east wall',
      lowConfidence: true,
    ),
    WallSegment(Offset(238, 185), Offset(238, 240)),
    WallSegment(Offset(238, 240), Offset(36, 240), name: 'South wall'),
    WallSegment(Offset(36, 240), Offset(36, 44), name: 'West wall'),
  ];

  /// Racks, benches and machines the scan picks up inside the room.
  static const List<Rect> equipment = <Rect>[
    Rect.fromLTWH(70, 72, 54, 22),
    Rect.fromLTWH(140, 72, 54, 22),
    Rect.fromLTWH(210, 72, 54, 22),
    Rect.fromLTWH(70, 160, 34, 58),
    Rect.fromLTWH(120, 160, 34, 58),
    Rect.fromLTWH(176, 176, 44, 44),
  ];

  static double get perimeter =>
      walls.fold(0, (double sum, WallSegment w) => sum + w.length);

  static final PlanGeometry geometry = PlanGeometry(
    walls: walls,
    objects: <List<Offset>>[
      for (final Rect r in equipment)
        <Offset>[r.topLeft, r.topRight, r.bottomRight, r.bottomLeft],
    ],
    frame: Offset.zero & canvas,
    metresPerUnit: metresPerUnit,
    areaM2: areaM2,
  );

  /// Floor area enclosed by the outline, via the shoelace formula.
  static double get areaM2 {
    double twiceArea = 0;
    for (final WallSegment w in walls) {
      twiceArea += w.start.dx * w.end.dy - w.end.dx * w.start.dy;
    }
    return twiceArea.abs() / 2 * metresPerUnit * metresPerUnit;
  }

  /// The point [distance] units along the perimeter, plus the direction of
  /// travel there in radians.
  static (Offset, double) pointAt(double distance) {
    double remaining = distance.clamp(0, perimeter);
    for (final WallSegment w in walls) {
      if (remaining <= w.length) {
        final Offset along = w.end - w.start;
        return (w.start + along * (remaining / w.length), along.direction);
      }
      remaining -= w.length;
    }
    final WallSegment last = walls.last;
    return (last.end, (last.end - last.start).direction);
  }
}

/// A finished walk, handed from the scanning screen to review and upload.
@immutable
class ScanResult {
  const ScanResult({
    required this.config,
    required this.geometry,
    required this.coverage,
    required this.closed,
    required this.walls,
    required this.tags,
    required this.photos,
    required this.elapsed,
    this.photoPaths = const <String>[],
    this.overrideReason,
    this.detected = const <RoomScanObject>[],
  });

  /// Photos the reviewer asks for: one per corner of the room.
  static const int photoTarget = 4;

  final ScanConfig config;
  final PlanGeometry geometry;

  /// 0–1 share of the perimeter captured with good confidence.
  final double coverage;
  final bool closed;

  /// Quality of each wall in [geometry], in the same order.
  final List<WallQuality> walls;
  final List<ScanTag> tags;
  final int photos;

  /// Where the reference photos were saved. Empty for a simulated scan.
  final List<String> photoPaths;
  final Duration elapsed;

  /// Why the surveyor finished before the outline closed.
  final String? overrideReason;

  /// The objects RoomPlan recognised, for marking gym machines on them
  /// (CHANGE 2.1). Empty for a simulated scan, which has no real objects.
  final List<RoomScanObject> detected;

  double? get areaM2 => geometry.areaM2;

  int get coveragePercent => (coverage * 100).round();
}

/// The files a LiDAR scan leaves on the device for upload.
@immutable
class ScanExport {
  const ScanExport({
    required this.modelPath,
    required this.dataPath,
    required this.bytes,
  });

  /// The 3D model (USDZ) the walkthrough is generated from.
  final String modelPath;

  /// RoomPlan's structured description of the room (JSON): walls, doors,
  /// openings and objects with their dimensions.
  final String dataPath;
  final int bytes;
}
