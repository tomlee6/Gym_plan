import 'dart:math' as math;

/// How high the camera was pointing, from its pitch.
enum HeightBand {
  low('low'),
  mid('middle'),
  high('top');

  const HeightBand(this.label);

  /// "low", "middle", "top", for "Missing: low and top".
  final String label;

  /// Pointing down more than [_tilt] degrees is low, up more is high.
  static const double _tilt = 25;

  static HeightBand of(double pitchDeg) => pitchDeg < -_tilt
      ? low
      : pitchDeg > _tilt
      ? high
      : mid;
}

/// How far round a machine the surveyor has walked, from the camera's
/// heading (I-06).
///
/// Walking a circle round a machine with the camera on it turns the camera
/// through a full 360°, so the headings seen tell how much of the circle
/// is done. The circle is cut into 36 sectors of 10°; each heading sample
/// marks its sector. Samples arrive about ten times a second, so a quick
/// turn can jump a sector: a step of up to [maxFillDeg] between two samples
/// marks the sectors in between too. A bigger jump is treated as a glitch
/// (or the phone swung away) and fills nothing.
///
/// The camera's pitch says which heights were filmed (low, middle, top),
/// so the screen can say which are still missing.
class WalkCoverage {
  WalkCoverage({this.maxFillDeg = 45});

  static const int sectorDeg = 10;
  static const int sectorCount = 360 ~/ sectorDeg;

  /// Largest step between two samples that still counts as walked.
  final double maxFillDeg;

  final Set<int> _sectors = <int>{};
  final Set<HeightBand> _bands = <HeightBand>{};
  double? _last;

  /// Indices 0–35 of the 10° sectors seen, sector 0 being 0–10°.
  Set<int> get sectors => Set<int>.unmodifiable(_sectors);

  /// The heights seen so far.
  Set<HeightBand> get bands => Set<HeightBand>.unmodifiable(_bands);

  /// Heights not filmed yet, low to high. Empty before any pitch sample, so
  /// nothing is flagged as missing until there is data.
  List<HeightBand> get missingBands => _bands.isEmpty
      ? const <HeightBand>[]
      : <HeightBand>[
          for (final HeightBand b in HeightBand.values)
            if (!_bands.contains(b)) b,
        ];

  /// 0–1 of the way round.
  double get fraction => _sectors.length / sectorCount;
  int get percent => (fraction * 100).round();
  bool get complete => _sectors.length == sectorCount;

  /// Whether any heading has been seen yet.
  bool get hasData => _last != null;

  /// Records one sample. [headingDeg] may be any angle; it is wrapped.
  void add(double headingDeg, {double? pitchDeg}) {
    if (headingDeg.isNaN || headingDeg.isInfinite) return;
    final double h = normalise(headingDeg);
    final double? last = _last;
    if (last != null) {
      final double step = signedDelta(last, h);
      if (step.abs() <= maxFillDeg) {
        // Walk from the last heading to this one in sector-sized steps,
        // marking each sector passed through.
        final int steps = (step.abs() / sectorDeg).floor();
        for (int i = 1; i <= steps; i++) {
          _sectors.add(sectorOf(last + step.sign * i * sectorDeg));
        }
      }
    }
    _sectors.add(sectorOf(h));
    _last = h;
    if (pitchDeg != null && !pitchDeg.isNaN) {
      _bands.add(HeightBand.of(pitchDeg));
    }
  }

  /// Starts again, for a retake.
  void reset() {
    _sectors.clear();
    _bands.clear();
    _last = null;
  }

  /// [deg] wrapped into [0, 360).
  static double normalise(double deg) {
    final double d = deg % 360;
    return d < 0 ? d + 360 : d;
  }

  /// The shorter way from [from] to [to], in (-180, 180].
  static double signedDelta(double from, double to) {
    double d = normalise(to) - normalise(from);
    if (d > 180) d -= 360;
    if (d <= -180) d += 360;
    return d;
  }

  static int sectorOf(double deg) =>
      math.min(sectorCount - 1, normalise(deg) ~/ sectorDeg);
}
