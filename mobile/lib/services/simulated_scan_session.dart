import 'dart:async';
import 'dart:ui';

import '../models/scan.dart';
import 'scan_session.dart';

/// Simulates a walk round [FloorOutline] so the flow can be demonstrated and
/// tested without a LiDAR device.
class SimulatedScanSession extends ScanSession {
  SimulatedScanSession({
    required super.config,
    this.tickInterval = const Duration(milliseconds: 200),
    this.unitsPerTick = 4,
  });

  final Duration tickInterval;

  /// How far the surveyor walks per tick, in canvas units (about 0.4 m).
  final double unitsPerTick;

  Timer? _timer;

  /// Counted in ticks rather than read from a stopwatch, so the clock stops
  /// while paused and tests can drive it with fake time.
  Duration _elapsed = Duration.zero;

  double _walked = 0;

  @override
  PlanGeometry get geometry => FloorOutline.geometry;

  @override
  bool get running => _timer != null;

  @override
  Duration get elapsed => _elapsed;

  /// True once the walk has come back round to where it started.
  @override
  bool get closed => _walked >= FloorOutline.perimeter;

  @override
  (Offset, double) get walker => FloorOutline.pointAt(_walked);

  @override
  List<WallQuality> get walls {
    final List<WallQuality> result = <WallQuality>[];
    double start = 0;
    for (final WallSegment w in FloorOutline.walls) {
      // A wall counts once the surveyor is past it, not while walking it.
      final bool walked = _walked >= start + w.length;
      result.add(
        !walked
            ? WallQuality.missing
            : (w.lowConfidence ? WallQuality.weak : WallQuality.captured),
      );
      start += w.length;
    }
    return result;
  }

  @override
  List<double> get wallProgress {
    final List<double> result = <double>[];
    double start = 0;
    for (final WallSegment w in FloorOutline.walls) {
      result.add(((_walked - start) / w.length).clamp(0, 1).toDouble());
      start += w.length;
    }
    return result;
  }

  /// Share of the perimeter captured. Weak walls count for less, because the
  /// reviewer cannot trust them.
  @override
  double get coverage {
    double good = 0;
    double start = 0;
    for (final WallSegment w in FloorOutline.walls) {
      final double done = (_walked - start).clamp(0, w.length).toDouble();
      good += w.lowConfidence ? done * 0.4 : done;
      start += w.length;
    }
    return good / FloorOutline.perimeter;
  }

  @override
  void start() {
    if (_timer != null) return;
    _timer = Timer.periodic(tickInterval, (_) => _tick());
    notifyListeners();
  }

  @override
  void pause() {
    _timer?.cancel();
    _timer = null;
  }

  void _tick() {
    if (!closed) {
      _walked = (_walked + unitsPerTick).clamp(0, FloorOutline.perimeter);
    }
    _elapsed += tickInterval;
    notifyListeners();
  }

  @override
  Future<String?> takePhoto() async => null;

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }
}
