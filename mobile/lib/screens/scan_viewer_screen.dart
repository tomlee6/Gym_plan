import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:room_scan/room_scan.dart';

import '../models/room_measurements.dart';
import '../models/scan.dart';
import '../theme/app_theme.dart';
import '../widgets/floor_plan.dart';
import '../widgets/plan_navigator.dart';
import '../widgets/pressable.dart';

/// Which way a finished scan is shown: the 3D model or the measured floor
/// plan. Both come from the same LiDAR scan.
enum ScanView { model, floorPlan }

/// A finished scan full screen, Polycam style: the room in 3D to turn and
/// zoom, or as a measured floor plan, with a toolbar down the right side
/// (reset, top view, measurements, 3D or plan) and the room's measurements
/// along the bottom.
class ScanViewerScreen extends StatefulWidget {
  const ScanViewerScreen({
    super.key,
    required this.title,
    required this.geometry,
    required this.walls,
    required this.measurements,
    this.subtitle,
    this.modelPath,
    this.dataPath,
    this.initialView = ScanView.model,
    this.controller,
  });

  /// Drives the 3D view. Made here when omitted; tests pass their own.
  final ScanModelController? controller;

  final String title;

  /// e.g. the date it was scanned.
  final String? subtitle;
  final PlanGeometry geometry;
  final List<WallQuality> walls;
  final RoomMeasurements measurements;

  /// RoomPlan's `scan.usdz` and `scan.json`. Without a model only the floor
  /// plan is shown.
  final String? modelPath;
  final String? dataPath;
  final ScanView initialView;

  @override
  State<ScanViewerScreen> createState() => _ScanViewerScreenState();
}

class _ScanViewerScreenState extends State<ScanViewerScreen> {
  late final ScanModelController _model =
      widget.controller ?? ScanModelController();
  late ScanView _view = widget.modelPath == null
      ? ScanView.floorPlan
      : widget.initialView;
  bool _measurements = true;

  /// Tap-to-tap measuring on the 3D model.
  bool _measuring = false;

  bool get _hasModel => widget.modelPath != null;

  /// A 3D Space mesh or a 3D Object has no floor plan.
  bool get _hasPlan => widget.geometry.walls.isNotEmpty;

  @override
  void dispose() {
    if (widget.controller == null) _model.dispose();
    super.dispose();
  }

  void _toggleMeasurements() {
    setState(() => _measurements = !_measurements);
    _model.showMeasurements(_measurements);
  }

  void _toggleMeasuring() {
    setState(() => _measuring = !_measuring);
    _model.setMeasuring(_measuring);
  }

  void _toggleView() => setState(() {
    _view = _view == ScanView.model ? ScanView.floorPlan : ScanView.model;
    // Measuring is on the 3D model; the plan has its wall lengths.
    _measuring = false;
  });

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF0A1217),
      body: Stack(
        children: <Widget>[
          Positioned.fill(
            child: _view == ScanView.model && _hasModel
                ? ScanModelPreview(
                    // Rebuilt with the labels as they are when switching back.
                    key: const ValueKey<String>('model'),
                    modelPath: widget.modelPath!,
                    dataPath: widget.dataPath,
                    showMeasurements: _measurements,
                    controller: _model,
                  )
                : SafeArea(
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(16, 64, 72, 150),
                      // Pinch, drag and twist; buttons to zoom, turn and fit.
                      child: PlanNavigator(
                        controlsAlignment: Alignment.bottomLeft,
                        builder: (_, double rotation) => FloorPlanView(
                          geometry: widget.geometry,
                          walls: widget.walls,
                          showGrid: true,
                          showDimensions: _measurements,
                          fit: true,
                          viewRotation: rotation,
                          semanticLabel: 'Measured floor plan of the room',
                        ),
                      ),
                    ),
                  ),
          ),
          SafeArea(
            child: Stack(
              children: <Widget>[
                Positioned(
                  top: 8,
                  left: 16,
                  child: _RoundButton(
                    icon: CupertinoIcons.xmark,
                    label: 'Close',
                    onTap: () => Navigator.of(context).maybePop(),
                  ),
                ),
                Positioned(top: 8, right: 16, child: _buildToolbar()),
                if (_measuring)
                  const Positioned(
                    top: 14,
                    left: 76,
                    right: 76,
                    child: Center(child: _MeasureHint()),
                  ),
                Positioned(
                  left: 16,
                  right: 16,
                  bottom: 12,
                  child: _measuring
                      ? ValueListenableBuilder<List<double>>(
                          valueListenable: _model.measured,
                          builder: (_, List<double> lengths, _) => _MeasureBar(
                            lengths: lengths,
                            onUndo: _model.undoMeasurement,
                            onClear: _model.clearMeasurements,
                            onDone: _toggleMeasuring,
                          ),
                        )
                      : _InfoPanel(
                          title: widget.title,
                          subtitle: widget.subtitle,
                          view: _view,
                          measurements: widget.measurements,
                        ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildToolbar() {
    final bool model = _view == ScanView.model && _hasModel;
    return Column(
      children: <Widget>[
        if (model) ...<Widget>[
          _RoundButton(
            icon: Icons.threed_rotation_rounded,
            label: 'Reset view',
            onTap: _model.resetView,
          ),
          const SizedBox(height: 12),
          _RoundButton(
            icon: Icons.crop_free_rounded,
            label: 'Top view',
            onTap: _model.topView,
          ),
          const SizedBox(height: 12),
          _RoundButton(
            icon: Icons.timeline_rounded,
            label: _measuring ? 'Stop measuring' : 'Measure',
            selected: _measuring,
            onTap: _toggleMeasuring,
          ),
          const SizedBox(height: 12),
        ],
        // Wall lengths: a room scan has walls to label; a mesh or an
        // object is measured with the Measure tool instead.
        if (_hasPlan || widget.dataPath != null)
          _RoundButton(
            icon: Icons.straighten_rounded,
            label: _measurements ? 'Hide measurements' : 'Show measurements',
            selected: _measurements,
            onTap: _toggleMeasurements,
          ),
        if (_hasModel && _hasPlan) ...<Widget>[
          const SizedBox(height: 12),
          _RoundButton(
            icon: model ? Icons.grid_view_rounded : Icons.view_in_ar_rounded,
            label: model ? 'Show floor plan' : 'Show 3D model',
            onTap: _toggleView,
          ),
        ],
      ],
    );
  }
}

/// "Tap two points to measure", while measuring.
class _MeasureHint extends StatelessWidget {
  const _MeasureHint();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.65),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: Colors.white.withValues(alpha: 0.14)),
      ),
      child: const Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(Icons.circle, size: 9, color: AppColors.success),
          SizedBox(width: 8),
          Flexible(
            child: Text(
              'Tap two points on the model to measure',
              style: TextStyle(fontSize: 13, color: AppColors.textPrimary),
            ),
          ),
        ],
      ),
    );
  }
}

/// The measurements taken so far: the last one, the total, and undo /
/// clear / done.
class _MeasureBar extends StatelessWidget {
  const _MeasureBar({
    required this.lengths,
    required this.onUndo,
    required this.onClear,
    required this.onDone,
  });

  final List<double> lengths;
  final VoidCallback onUndo;
  final VoidCallback onClear;
  final VoidCallback onDone;

  @override
  Widget build(BuildContext context) {
    final double total = lengths.fold(0, (double a, double b) => a + b);
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 13, 10, 13),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.7),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: const Color(0xFF7361FF).withValues(alpha: 0.6),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text(
            lengths.isEmpty
                ? 'No measurements yet'
                : 'Last ${lengths.last.toStringAsFixed(2)} m',
            style: const TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.w700,
              color: AppColors.textPrimary,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            lengths.isEmpty
                ? 'Tap a point, then another: the line shows the distance.'
                : 'Total ${total.toStringAsFixed(2)} m · '
                      '${lengths.length} '
                      '${lengths.length == 1 ? 'measurement' : 'measurements'}',
            style: AppTheme.caption,
          ),
          const SizedBox(height: 8),
          Row(
            children: <Widget>[
              TextButton.icon(
                onPressed: onUndo,
                icon: const Icon(Icons.undo_rounded, size: 18),
                label: const Text('Undo'),
              ),
              TextButton.icon(
                onPressed: lengths.isEmpty ? null : onClear,
                icon: const Icon(Icons.delete_outline_rounded, size: 18),
                label: const Text('Clear'),
              ),
              const Spacer(),
              TextButton(onPressed: onDone, child: const Text('Done')),
            ],
          ),
        ],
      ),
    );
  }
}

/// One round toolbar button, as in Polycam's viewer.
class _RoundButton extends StatelessWidget {
  const _RoundButton({
    required this.icon,
    required this.label,
    required this.onTap,
    this.selected = false,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    return Pressable(
      onTap: onTap,
      semanticLabel: label,
      haptic: HapticImpact.selection,
      pressedScale: 0.92,
      child: Container(
        width: 48,
        height: 48,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: selected
              ? AppColors.accent.withValues(alpha: 0.18)
              : Colors.black.withValues(alpha: 0.55),
          border: Border.all(
            color: selected
                ? AppColors.accent
                : Colors.white.withValues(alpha: 0.25),
            width: 1.2,
          ),
        ),
        child: Icon(
          icon,
          size: 21,
          color: selected ? AppColors.accent : AppColors.textPrimary,
        ),
      ),
    );
  }
}

/// The scan's name and its measurements, along the bottom.
class _InfoPanel extends StatelessWidget {
  const _InfoPanel({
    required this.title,
    required this.view,
    required this.measurements,
    this.subtitle,
  });

  final String title;
  final String? subtitle;
  final ScanView view;
  final RoomMeasurements measurements;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 13, 16, 14),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.6),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: Colors.white.withValues(alpha: 0.14)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Row(
            children: <Widget>[
              Expanded(
                child: Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w700,
                    color: AppColors.textPrimary,
                  ),
                ),
              ),
              Text(
                view == ScanView.model ? '3D model' : 'Floor plan',
                style: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: AppColors.accent,
                ),
              ),
            ],
          ),
          if (subtitle != null) ...<Widget>[
            const SizedBox(height: 2),
            Text(subtitle!, style: AppTheme.caption),
          ],
          const SizedBox(height: 10),
          MeasurementChips(measurements: measurements),
        ],
      ),
    );
  }
}

/// "12.4 × 8.1 m · 98 m² · 2.70 m high · 6 walls", as chips.
class MeasurementChips extends StatelessWidget {
  const MeasurementChips({super.key, required this.measurements});

  final RoomMeasurements measurements;

  @override
  Widget build(BuildContext context) {
    final List<(IconData, String)> items = <(IconData, String)>[
      if (measurements.sizeLabel case final String size)
        (Icons.straighten_rounded, size),
      if (measurements.areaLabel case final String area)
        (Icons.square_foot_rounded, area),
      if (measurements.heightLabel case final String height)
        (Icons.height_rounded, height),
      // Only a room scan has walls; a mesh or an object has none to count.
      if (measurements.wallCount > 0)
        (
          Icons.border_outer_rounded,
          '${measurements.wallCount} '
              '${measurements.wallCount == 1 ? 'wall' : 'walls'}',
        ),
      if (measurements.doorCount > 0)
        (
          Icons.door_front_door_outlined,
          '${measurements.doorCount} '
              '${measurements.doorCount == 1 ? 'door' : 'doors'}',
        ),
      if (measurements.windowCount > 0)
        (
          Icons.window_outlined,
          '${measurements.windowCount} '
              '${measurements.windowCount == 1 ? 'window' : 'windows'}',
        ),
    ];
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: <Widget>[
        for (final (IconData icon, String text) in items)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            decoration: BoxDecoration(
              color: AppColors.chipFill,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AppColors.chipEdge),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Icon(icon, size: 14, color: AppColors.accent),
                const SizedBox(width: 6),
                Text(
                  text,
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: AppColors.textPrimary,
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}
