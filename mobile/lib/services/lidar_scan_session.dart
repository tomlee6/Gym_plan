import 'dart:async';
import 'dart:ui';

import 'package:room_scan/room_scan.dart';

import '../models/scan.dart';
import 'scan_session.dart';

/// A real scan: RoomPlan on a LiDAR iPhone or iPad, via the `room_scan`
/// plugin. Coordinates are metres.
class LidarScanSession extends ScanSession {
  LidarScanSession({required super.config});

  StreamSubscription<RoomScanUpdate>? _updates;
  RoomScanUpdate _latest = RoomScanUpdate.empty;
  PlanGeometry _geometry = PlanGeometry.fitted(walls: const <WallSegment>[]);
  List<WallQuality> _walls = const <WallQuality>[];

  bool _started = false;
  bool _running = false;
  bool _ended = false;
  String? _error;

  @override
  PlanGeometry get geometry => _geometry;

  @override
  List<WallQuality> get walls => _walls;

  @override
  (Offset, double)? get walker {
    final Offset? at = _latest.position;
    return at == null ? null : (at, _latest.heading ?? 0);
  }

  @override
  double get coverage => _latest.coverage;

  @override
  bool get closed => _latest.closed;

  @override
  Duration get elapsed => _latest.elapsed;

  @override
  bool get running => _running;

  @override
  String? get instruction => _latest.instruction;

  @override
  String? get error => _error;

  @override
  bool get supportsSections => true;

  @override
  int get section => _latest.section;

  @override
  Future<void> nextSection() async {
    if (_ended || _error != null) {
      throw StateError('The scan has ended.');
    }
    // A failure here leaves the current section scanning, so it is passed
    // back to the screen to say so rather than ending the scan.
    await RoomScan.nextSection();
  }

  @override
  Size? get sectionExtentM {
    final List<RoomScanWall> walls = _latest.walls;
    if (walls.every((RoomScanWall w) => w.section == _latest.section)) {
      return scannedExtentM;
    }
    final List<WallSegment> current = <WallSegment>[
      for (int i = 0; i < walls.length && i < _geometry.walls.length; i++)
        if (walls[i].section == _latest.section) _geometry.walls[i],
    ];
    if (current.isEmpty) return null;
    return PlanGeometry(
      walls: current,
      frame: _geometry.frame,
      metresPerUnit: _geometry.metresPerUnit,
      rotation: _geometry.rotation,
    ).wallExtentM;
  }

  @override
  void start() {
    if (_ended || _error != null) return;
    _running = true;
    if (!_started) {
      _started = true;
      // Listen first so the first update is not missed.
      _updates = RoomScan.updates().listen(_apply, onError: _fail);
      RoomScan.start().catchError(_fail);
    } else {
      RoomScan.resume().catchError(_fail);
    }
    notifyListeners();
  }

  @override
  void pause() {
    if (!_running) return;
    _running = false;
    RoomScan.pause().catchError(_fail);
  }

  void _apply(RoomScanUpdate update) {
    _latest = update;
    _walls = <WallQuality>[
      for (final RoomScanWall w in update.walls)
        w.confidence == RoomScanConfidence.low
            ? WallQuality.weak
            : WallQuality.captured,
    ];
    _geometry = PlanGeometry.fitted(
      walls: <WallSegment>[
        for (final RoomScanWall w in update.walls) WallSegment(w.start, w.end),
      ],
      objects: update.objects,
      areaM2: update.areaM2,
      // Keep the surveyor in view even before any wall is found.
      include: update.position,
      openings: <PlanOpening>[
        for (final RoomScanOpening o in update.openings)
          PlanOpening(
            OpeningKind.values.firstWhere(
              (OpeningKind k) => k.name == o.kind,
              orElse: () => OpeningKind.opening,
            ),
            o.start,
            o.end,
          ),
      ],
      // Detected objects come in the same order as the footprints.
      labels: <String?>[
        for (int i = 0; i < update.objects.length; i++)
          i < update.detected.length
              ? planLabel(update.detected[i].category)
              : null,
      ],
    );
    notifyListeners();
  }

  /// RoomPlan's category as a name on the plan, e.g. "Table"; null for
  /// "object", what it calls everything it has no name for.
  static String? planLabel(String category) => switch (category) {
    'object' || '' => null,
    'washerDryer' => 'Washer',
    'television' => 'TV',
    _ => category[0].toUpperCase() + category.substring(1),
  };

  void _fail(Object error) {
    _running = false;
    _error = RoomScanException.from(error).message;
    notifyListeners();
  }

  @override
  List<RoomScanObject> get detected => _latest.detected;

  @override
  Future<String?> takePhoto() => RoomScan.capturePhoto();

  @override
  Future<ScanExport> export() async {
    final RoomScanExport result = await RoomScan.finish();
    _ended = true;
    _running = false;
    return ScanExport(
      modelPath: result.usdzPath,
      dataPath: result.jsonPath,
      bytes: result.bytes,
      videoPath: result.videoPath,
    );
  }

  @override
  void dispose() {
    _updates?.cancel();
    // A scan that was exported has already ended natively.
    if (_started && !_ended) RoomScan.stop().catchError((Object _) {});
    super.dispose();
  }
}
