import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart';
import 'package:room_scan/room_scan.dart';

import '../models/scan.dart';

/// A scan in progress, as the scanning screen sees it.
///
/// Two implementations: `SimulatedScanSession` walks a fixed demo outline, and
/// `LidarScanSession` streams a real RoomPlan capture. Tags and photos are
/// handled here, so both behave the same.
abstract class ScanSession extends ChangeNotifier {
  ScanSession({required this.config});

  final ScanConfig config;

  final List<ScanTag> _tags = <ScanTag>[];
  final List<String> _photoPaths = <String>[];
  int _photos = 0;

  /// The floor plan captured so far.
  PlanGeometry get geometry;

  /// Quality of each wall in [geometry], in the same order.
  List<WallQuality> get walls;

  /// Objects the scanner recognised, with their measurements. Only a real
  /// LiDAR scan finds any.
  List<RoomScanObject> get detected => const <RoomScanObject>[];

  /// 0–1 per wall, when the scanner knows how far along each wall the
  /// surveyor is. The live LiDAR scan only reports whole walls.
  List<double>? get wallProgress => null;

  /// Where the surveyor is and which way they face, once known.
  (Offset, double)? get walker;

  double get coverage;
  bool get closed;
  Duration get elapsed;
  bool get running;

  /// Coaching from the scanner, e.g. "Slow down".
  String? get instruction => null;

  /// Set when the scan has failed and cannot continue.
  String? get error => null;

  List<ScanTag> get tags => List<ScanTag>.unmodifiable(_tags);
  int get photos => _photos;

  void start();
  void pause();

  /// Captures a reference photo and returns where it was saved, or null
  /// when the scan is simulated and there is no camera frame to keep.
  @protected
  Future<String?> takePhoto();

  Future<void> addPhoto() async {
    final String? path = await takePhoto();
    if (path != null) _photoPaths.add(path);
    _photos++;
    notifyListeners();
  }

  /// Drops a tag where the surveyor is standing.
  ScanTag addTag(TagType type, {double? heightM}) {
    final ScanTag tag = ScanTag(
      type: type,
      position: walker?.$1 ?? geometry.frame.center,
      heightM: type == TagType.ceiling ? heightM : null,
    );
    _tags.add(tag);
    notifyListeners();
    return tag;
  }

  /// Walls that were captured but read at low confidence.
  List<WallSegment> get weakWalls {
    final List<WallQuality> qualities = walls;
    final List<WallSegment> segments = geometry.walls;
    return <WallSegment>[
      for (int i = 0; i < qualities.length && i < segments.length; i++)
        if (qualities[i] == WallQuality.weak) segments[i],
    ];
  }

  /// Freezes the walk into a [ScanResult] for the review screen. The scan
  /// is paused, not ended, so the surveyor can go back and keep scanning.
  ScanResult finish({String? overrideReason}) {
    return ScanResult(
      detected: detected,
      config: config,
      geometry: geometry,
      coverage: coverage,
      closed: closed,
      walls: walls,
      tags: tags,
      photos: _photos,
      photoPaths: List<String>.unmodifiable(_photoPaths),
      elapsed: elapsed,
      overrideReason: closed ? null : overrideReason,
    );
  }

  /// Ends the scan and writes its files for upload. Null for a simulated
  /// scan, which has nothing to export.
  Future<ScanExport?> export() async => null;
}
