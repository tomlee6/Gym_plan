import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../services/walk_coverage.dart';
import '../theme/app_theme.dart';

/// The walk-around guide over the viewfinder (I-06): a ring of 36 ticks,
/// one per 10° of the circle round the machine, lit as the camera's heading
/// passes through them, with the share walked in the middle and the
/// heights still to film underneath.
class CoverageRing extends StatelessWidget {
  const CoverageRing({super.key, required this.coverage, this.size = 180});

  final WalkCoverage coverage;
  final double size;

  @override
  Widget build(BuildContext context) {
    final List<HeightBand> missing = coverage.missingBands;
    return Semantics(
      label:
          '${coverage.percent} percent of the way around'
          '${missing.isEmpty ? '' : ', missing ${_list(missing)}'}',
      excludeSemantics: true,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          SizedBox.square(
            dimension: size,
            child: CustomPaint(
              painter: _RingPainter(sectors: coverage.sectors),
              child: Center(
                child: Text(
                  coverage.complete
                      ? 'All the way round'
                      : '${coverage.percent}% around',
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w700,
                    color: AppColors.accent,
                    shadows: <Shadow>[Shadow(blurRadius: 6)],
                  ),
                ),
              ),
            ),
          ),
          if (missing.isNotEmpty) ...<Widget>[
            const SizedBox(height: 8),
            Text(
              'Still to film: ${_list(missing)} of the machine',
              style: const TextStyle(
                fontSize: 12.5,
                color: AppColors.warning,
                shadows: <Shadow>[Shadow(blurRadius: 6)],
              ),
            ),
          ],
        ],
      ),
    );
  }

  static String _list(List<HeightBand> bands) {
    final List<String> names = <String>[for (final b in bands) b.label];
    return names.length == 1
        ? names.single
        : '${names.sublist(0, names.length - 1).join(', ')} and ${names.last}';
  }
}

class _RingPainter extends CustomPainter {
  _RingPainter({required this.sectors});

  final Set<int> sectors;

  @override
  void paint(Canvas canvas, Size size) {
    final Offset centre = size.center(Offset.zero);
    final double radius = size.shortestSide / 2 - 6;
    const double sweep = 2 * math.pi / WalkCoverage.sectorCount;
    const double gap = 0.04;

    for (int i = 0; i < WalkCoverage.sectorCount; i++) {
      final bool done = sectors.contains(i);
      canvas.drawArc(
        Rect.fromCircle(center: centre, radius: radius),
        // Sector 0 at the top, going clockwise.
        -math.pi / 2 + i * sweep + gap / 2,
        sweep - gap,
        false,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = done ? 7 : 5
          ..color = done
              ? AppColors.accent
              : AppColors.textPrimary.withValues(alpha: 0.25),
      );
    }
  }

  @override
  bool shouldRepaint(_RingPainter old) => !setEquals(old.sectors, sectors);
}
