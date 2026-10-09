import 'package:flutter/material.dart';

import '../models/scan.dart';
import '../theme/app_theme.dart';
import '../widgets/capture_fields.dart';
import '../widgets/floor_plan.dart';
import '../widgets/hairline_container.dart';
import '../widgets/nav_bar.dart';
import '../widgets/primary_button.dart';

/// Adds one control distance (F-03): two points on the scanned outline and
/// what a laser measure read between them.
///
/// The reviewer compares each one with the same distance on the scan. A
/// scan that drifted or was scaled wrong shows up as a mismatch, which is
/// otherwise invisible on a plan that looks perfectly tidy. Long distances
/// across the floor in both directions catch the most, so short ones are
/// warned about (on the review screen) but never refused.
class ControlDistanceScreen extends StatefulWidget {
  const ControlDistanceScreen({
    super.key,
    required this.geometry,
    required this.walls,
    this.existing = const <ControlDistance>[],
  });

  final PlanGeometry geometry;
  final List<WallQuality> walls;

  /// Distances already added, drawn faintly for reference.
  final List<ControlDistance> existing;

  @override
  State<ControlDistanceScreen> createState() => _ControlDistanceScreenState();
}

class _ControlDistanceScreenState extends State<ControlDistanceScreen> {
  /// A tap this close to a wall corner, in logical pixels, lands on it:
  /// laser distances are almost always taken corner to corner.
  static const double _snapPx = 18;

  final TextEditingController _measured = TextEditingController();
  Offset? _a;
  Offset? _b;
  String? _error;

  @override
  void initState() {
    super.initState();
    _measured.addListener(() => setState(() => _error = null));
  }

  @override
  void dispose() {
    _measured.dispose();
    super.dispose();
  }

  PlanGeometry get _geometry => widget.geometry;

  void _onTap(Offset local, Size size) {
    Offset p = FloorPlanView.planPointAt(size, _geometry, local);
    final double reach = _snapPx * FloorPlanView.unitsPerPixel(size, _geometry);
    Offset? nearest;
    for (final WallSegment w in _geometry.walls) {
      for (final Offset corner in <Offset>[w.start, w.end]) {
        if ((corner - p).distance <= reach &&
            (nearest == null ||
                (corner - p).distance < (nearest - p).distance)) {
          nearest = corner;
        }
      }
    }
    p = nearest ?? p;
    setState(() {
      // A third tap starts the line again from the new point.
      if (_a == null || _b != null) {
        _a = p;
        _b = null;
      } else {
        _b = p;
      }
    });
  }

  double? get _scannedM => _a == null || _b == null
      ? null
      : (_b! - _a!).distance * _geometry.metresPerUnit;

  void _save() {
    final double? measured = double.tryParse(_measured.text.trim());
    if (measured == null || measured <= 0 || measured > 500) {
      setState(() => _error = 'Enter the laser reading in metres.');
      return;
    }
    Navigator.of(
      context,
    ).pop(ControlDistance(a: _a!, b: _b!, measuredM: measured));
  }

  @override
  Widget build(BuildContext context) {
    final double? scanned = _scannedM;
    final bool picked = _a != null && _b != null;

    return Scaffold(
      backgroundColor: AppColors.background,
      body: GestureDetector(
        onTap: () => FocusScope.of(context).unfocus(),
        behavior: HitTestBehavior.translucent,
        child: SafeArea(
          child: Column(
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.only(left: 8, right: 12),
                child: NavBar(
                  backLabel: 'Review',
                  onBack: () => Navigator.of(context).maybePop(),
                ),
              ),
              Expanded(
                child: SingleChildScrollView(
                  physics: const BouncingScrollPhysics(),
                  padding: const EdgeInsets.fromLTRB(20, 6, 20, 16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                      const Text(
                        'Control distance',
                        style: AppTheme.largeTitle,
                      ),
                      const SizedBox(height: 8),
                      const Text(
                        'Two or more long distances measured with a laser let '
                        "the reviewer check the scan's scale.",
                        style: AppTheme.body,
                      ),
                      const SizedBox(height: 16),
                      HairlineContainer(
                        radius: 19,
                        fillColor: AppColors.planCanvas,
                        padding: const EdgeInsets.all(12),
                        child: LayoutBuilder(
                          builder: (BuildContext context, BoxConstraints c) {
                            final Size size = Size(
                              c.maxWidth,
                              c.maxWidth / FloorOutline.canvas.aspectRatio,
                            );
                            return GestureDetector(
                              behavior: HitTestBehavior.opaque,
                              onTapUp: (TapUpDetails d) =>
                                  _onTap(d.localPosition, size),
                              child: FloorPlanView(
                                geometry: _geometry,
                                walls: widget.walls,
                                measurements: <(Offset, Offset?)>[
                                  for (final ControlDistance c
                                      in widget.existing)
                                    (c.a, c.b),
                                  if (_a != null) (_a!, _b),
                                ],
                                semanticLabel:
                                    'Scanned outline. Tap two points to mark '
                                    'a measured distance.',
                              ),
                            );
                          },
                        ),
                      ),
                      // Under the plan, so the plan stays put as it changes.
                      const SizedBox(height: 12),
                      Text(
                        _a == null
                            ? 'Tap one end of a distance you measured with the '
                                  'laser. Corner to corner, across the floor, '
                                  'works best; taps snap to corners.'
                            : _b == null
                            ? 'Now tap the other end.'
                            : 'Type what the laser read. Tap the plan again to '
                                  'start the line over.',
                        style: AppTheme.body,
                      ),
                      if (picked) ...<Widget>[
                        const SizedBox(height: 16),
                        Text(
                          'On the scan: ${scanned!.toStringAsFixed(2)} m',
                          style: AppTheme.label,
                        ),
                        const SizedBox(height: 12),
                        LabelledField(
                          label: 'Laser measurement',
                          errorText: _error,
                          child: NumericField(
                            controller: _measured,
                            unit: 'm',
                            decimal: true,
                            hasError: _error != null,
                            semanticLabel: 'Laser measurement in metres',
                            onSubmitted: (_) => _save(),
                          ),
                        ),
                        if (scanned < ControlDistance.shortM) ...<Widget>[
                          const SizedBox(height: 10),
                          Text(
                            'Under ${ControlDistance.shortM.toStringAsFixed(0)} m '
                            'says little about the scan\'s scale. A longer '
                            'distance is a better check.',
                            style: AppTheme.footnote.copyWith(
                              color: AppColors.warning,
                            ),
                          ),
                        ],
                      ],
                    ],
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 20),
                child: PrimaryButton(
                  label: 'Add distance',
                  onPressed: picked && _measured.text.trim().isNotEmpty
                      ? _save
                      : null,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
