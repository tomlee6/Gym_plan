import 'dart:math' as math;

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
    this.accountId,
  });

  /// The gym account the capture is made in. The upload names it on every
  /// call, even if the surveyor switches account before it finishes.
  final String? accountId;

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

/// A laser-measured distance between two points of the scanned outline
/// (F-03), so the reviewer can check the scan's scale against a tape.
///
/// [a] and [b] are in the same plan frame (and units) as tags: metres on
/// the floor plane for a LiDAR scan. Two or more long distances, ideally
/// across the floor in both directions, catch a scan that drifted.
@immutable
class ControlDistance {
  const ControlDistance({
    required this.a,
    required this.b,
    required this.measuredM,
  });

  /// Shorter than this, a laser check says little about the scan's scale.
  static const double shortM = 3;

  /// Fewer than this, a single bad reading cannot be spotted.
  static const int recommended = 2;

  final Offset a;
  final Offset b;

  /// What the laser measure read, in metres.
  final double measuredM;

  /// The same distance on the scan, in metres.
  double scannedM(PlanGeometry geometry) =>
      (b - a).distance * geometry.metresPerUnit;

  Map<String, Object?> toJson() => <String, Object?>{
    'a': <double>[a.dx, a.dy],
    'b': <double>[b.dx, b.dy],
    'measuredM': measuredM,
  };
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

/// What fills a gap in a wall.
enum OpeningKind { door, window, opening }

/// A door, window or open doorway: the stretch of wall it takes up, seen
/// from above.
@immutable
class PlanOpening {
  const PlanOpening(this.kind, this.start, this.end);

  final OpeningKind kind;
  final Offset start;
  final Offset end;

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
    this.openings = const <PlanOpening>[],
    this.labels = const <String?>[],
    this.rotation = 0,
  });

  /// Fits a frame around scanned walls and objects, in metres, with a margin.
  /// The frame never shrinks below [minSpanM] so an early scan with one wall
  /// is not drawn absurdly zoomed in.
  ///
  /// RoomPlan's axes follow wherever the phone pointed when the scan began,
  /// so the plan is turned to put its main walls square to the screen, and
  /// the frame is fitted in that turned drawing.
  factory PlanGeometry.fitted({
    required List<WallSegment> walls,
    List<List<Offset>> objects = const <List<Offset>>[],
    double? areaM2,
    Offset? include,
    double marginM = 1.0,
    double minSpanM = 8.0,
    List<PlanOpening> openings = const <PlanOpening>[],
    List<String?> labels = const <String?>[],
  }) {
    final double rotation = mainWallAngle(walls);
    final List<Offset> points = <Offset>[
      for (final WallSegment w in walls) ...<Offset>[w.start, w.end],
      for (final List<Offset> o in objects) ...o,
      ?include,
    ].map((Offset p) => _turn(p, -rotation)).toList();

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
      openings: openings,
      labels: labels,
      rotation: rotation,
    );
  }

  /// The direction most of the wall length runs in, folded into a quarter
  /// turn (−45° to 45°), in radians. Walls at right angles agree, so a
  /// rectangular room gives the angle of its sides.
  static double mainWallAngle(List<WallSegment> walls) {
    double x = 0, y = 0;
    for (final WallSegment w in walls) {
      final Offset d = w.end - w.start;
      final double angle = 4 * math.atan2(d.dy, d.dx);
      x += w.length * math.cos(angle);
      y += w.length * math.sin(angle);
    }
    if (x.abs() < 1e-9 && y.abs() < 1e-9) return 0;
    final double turn = math.atan2(y, x) / 4;
    // Square already, to rounding: left exactly as it is.
    return turn.abs() < 1e-6 ? 0 : turn;
  }

  static Offset _turn(Offset p, double radians) {
    if (radians == 0) return p;
    final double c = math.cos(radians), s = math.sin(radians);
    return Offset(p.dx * c - p.dy * s, p.dx * s + p.dy * c);
  }

  final List<WallSegment> walls;

  /// Equipment footprints as closed polygons.
  final List<List<Offset>> objects;

  /// What RoomPlan recognised each of [objects] as, e.g. "Table", in the
  /// same order; null where it has no name for it, as for most machines.
  final List<String?> labels;

  /// Doors, windows and open doorways in the walls.
  final List<PlanOpening> openings;

  /// The angle of the main walls, in radians. The plan is drawn turned back
  /// by it ([toDrawing]); every point stays in the scan's own frame.
  final double rotation;

  /// A plan point in the squared-up drawing that [frame] is fitted to.
  Offset toDrawing(Offset p) => _turn(p, -rotation);

  /// The inverse of [toDrawing].
  Offset fromDrawing(Offset p) => _turn(p, rotation);

  int countOf(OpeningKind kind) =>
      openings.where((PlanOpening o) => o.kind == kind).length;

  /// The part of the squared-up drawing the plan should show.
  final Rect frame;
  final double metresPerUnit;

  /// Floor area, when it is known. A scan only reports it once the floor
  /// polygon is recognised.
  final double? areaM2;

  double get perimeter =>
      walls.fold(0, (double sum, WallSegment w) => sum + w.length);

  /// Width × length in metres of the box around the scanned walls (F-04),
  /// or null before any wall is found. Objects and the surveyor's position
  /// are left out: it is the floor being scanned that has to stay within
  /// what one scan can hold.
  Size? get wallExtentM {
    final Rect? box = wallBox;
    if (box == null) return null;
    return Size(box.width * metresPerUnit, box.height * metresPerUnit);
  }

  /// The box round the walls in the squared-up drawing, in plan units.
  Rect? get wallBox {
    if (walls.isEmpty) return null;
    final Offset first = toDrawing(walls.first.start);
    double left = first.dx, right = left;
    double top = first.dy, bottom = top;
    for (final WallSegment w in walls) {
      for (final Offset p in <Offset>[toDrawing(w.start), toDrawing(w.end)]) {
        if (p.dx < left) left = p.dx;
        if (p.dx > right) right = p.dx;
        if (p.dy < top) top = p.dy;
        if (p.dy > bottom) bottom = p.dy;
      }
    }
    return Rect.fromLTRB(left, top, right, bottom);
  }
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
    this.controlDistances = const <ControlDistance>[],
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

  /// Laser checks of the scan's scale added on the review screen (F-03).
  final List<ControlDistance> controlDistances;

  double? get areaM2 => geometry.areaM2;

  ScanResult copyWith({
    ScanConfig? config,
    List<ControlDistance>? controlDistances,
  }) => ScanResult(
    config: config ?? this.config,
    geometry: geometry,
    coverage: coverage,
    closed: closed,
    walls: walls,
    tags: tags,
    photos: photos,
    elapsed: elapsed,
    photoPaths: photoPaths,
    overrideReason: overrideReason,
    detected: detected,
    controlDistances: controlDistances ?? this.controlDistances,
  );

  int get coveragePercent => (coverage * 100).round();
}

/// The files a LiDAR scan leaves on the device for upload.
@immutable
class ScanExport {
  const ScanExport({
    required this.modelPath,
    required this.dataPath,
    required this.bytes,
    this.videoPath,
  });

  /// The 3D model (USDZ) the walkthrough is generated from.
  final String modelPath;

  /// The room video recorded in the background of the LiDAR scan (MP4),
  /// which the reviewer watches beside the 3D model. Null when the phone
  /// could not write one; the scan is submitted without it.
  final String? videoPath;

  /// RoomPlan's structured description of the room (JSON): walls, doors,
  /// openings and objects with their dimensions.
  final String dataPath;
  final int bytes;
}
