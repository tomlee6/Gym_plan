import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import '../models/plan.dart';
import '../models/scan.dart';
import '../services/capture_service.dart';
import '../services/upload_queue.dart';
import '../theme/app_theme.dart';
import '../widgets/app_toast.dart';
import '../widgets/capture_fields.dart';
import '../widgets/detail_widgets.dart';
import '../widgets/floor_plan.dart';
import '../widgets/hairline_container.dart';
import '../widgets/nav_bar.dart';
import '../widgets/primary_button.dart';
import 'uploading_screen.dart';
import 'package:room_scan/room_scan.dart';
import '../models/equipment.dart';
import 'control_distance_screen.dart';
import 'equipment_capture_screen.dart';
import 'new_capture_screen.dart';

/// Last look before the scan leaves the phone, Polycam style: the finished
/// room in 3D, then which facility and level it is, the captured outline,
/// any coverage warnings, and what was tagged and photographed.
///
/// The scan is already finalised when this opens, so it cannot be carried
/// on: "Scan again" discards it and starts a new one.
class ReviewSubmitScreen extends StatefulWidget {
  const ReviewSubmitScreen({
    super.key,
    required this.result,
    this.facilities,
    this.export,
  });

  final ScanResult result;

  /// The account's facilities to pick from. The scan starts before they are
  /// chosen, so this is where the surveyor confirms them. Omitted, only the
  /// scan's own facility is offered.
  final FacilityList? facilities;

  /// The finished scan's files: the 3D model shown here and uploaded on
  /// submit, and RoomPlan's room data. Null only in tests, where there is
  /// no LiDAR scan behind the result.
  final ScanExport? export;

  @override
  State<ReviewSubmitScreen> createState() => _ReviewSubmitScreenState();
}

class _ReviewSubmitScreenState extends State<ReviewSubmitScreen> {
  /// The 3D model extrudes walls to this height, so keep it plausible for a
  /// gym floor rather than accepting any number.
  static const double _minHeightM = 2.0;
  static const double _maxHeightM = 12.0;

  bool _submitting = false;

  late Facility _facility = Facility(
    id: widget.result.config.facilityId,
    name: widget.result.config.facility,
  );
  late final TextEditingController _levelController = TextEditingController(
    text: '${widget.result.config.level}',
  );
  late final TextEditingController _heightController = TextEditingController(
    text: widget.result.config.heightM.toStringAsFixed(2),
  );
  final FocusNode _levelFocus = FocusNode();
  final FocusNode _heightFocus = FocusNode();
  String? _levelError;
  String? _heightError;

  /// Machines marked and walkarounds recorded in the equipment step
  /// (CHANGE 3). They travel with the capture when it is submitted.
  List<Equipment> _equipment = const <Equipment>[];
  Map<String, EquipmentVideo> _videos = const <String, EquipmentVideo>{};

  /// The equipment step has been finished. It is optional: a scan can be
  /// submitted without it, and the reviewer names the machines instead.
  bool _equipmentDone = false;

  /// Laser checks of the scan's scale (F-03). Optional, but two or more
  /// long ones are encouraged.
  List<ControlDistance> _controls = const <ControlDistance>[];

  ScanResult get _result => widget.result;

  List<Facility> get _facilities {
    final List<Facility> all =
        widget.facilities?.facilities ?? const <Facility>[];
    return all.contains(_facility) ? all : <Facility>[_facility, ...all];
  }

  @override
  void initState() {
    super.initState();
    // The header names the level as it is typed.
    _levelController.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _levelController.dispose();
    _heightController.dispose();
    _levelFocus.dispose();
    _heightFocus.dispose();
    super.dispose();
  }

  /// The details as entered, or null (with the errors shown) when they do
  /// not check out.
  ScanConfig? _validatedConfig() {
    final int? level = int.tryParse(_levelController.text.trim());
    final double? height = double.tryParse(_heightController.text.trim());

    setState(() {
      _levelError = level == null ? 'Enter the level.' : null;
      if (height == null) {
        _heightError = 'Enter the floor-to-floor height.';
      } else if (height < _minHeightM || height > _maxHeightM) {
        _heightError =
            'Height must be between ${_minHeightM.toStringAsFixed(1)} and '
            '${_maxHeightM.toStringAsFixed(1)} m.';
      } else {
        _heightError = null;
      }
    });
    if (_levelError != null || _heightError != null) return null;

    return ScanConfig(
      accountId: _result.config.accountId,
      facilityId: _facility.id,
      facility: _facility.name,
      level: level!,
      heightM: height!,
    );
  }

  /// The title as the details stand, e.g. "Northgate Fitness · Level 2".
  String get _title {
    final int? level = int.tryParse(_levelController.text.trim());
    return level == null
        ? _facility.name
        : '${_facility.name} · ${levelLabel(level)}';
  }

  /// (lead, detail) pairs, e.g. ("Inner east wall reads weak.", "3.4 m …").
  List<(String, String)> get _warnings {
    final List<(String, String)> warnings = <(String, String)>[];
    final PlanGeometry geometry = _result.geometry;
    for (int i = 0; i < _result.walls.length; i++) {
      if (_result.walls[i] != WallQuality.weak) continue;
      if (i >= geometry.walls.length) break;
      final WallSegment wall = geometry.walls[i];
      final String metres = (wall.length * geometry.metresPerUnit)
          .toStringAsFixed(1);
      warnings.add((
        '${wall.name ?? 'One wall'} reads weak.',
        '$metres m captured at low confidence.',
      ));
    }
    if (_result.overrideReason != null) {
      warnings.add((
        'Outline closed on override.',
        'You recorded: "${_result.overrideReason}"',
      ));
    }
    return warnings;
  }

  Future<void> _submit() async {
    FocusScope.of(context).unfocus();
    final ScanConfig? config = _validatedConfig();
    if (config == null) {
      showAppToast(context, 'Check the capture details.');
      return;
    }
    setState(() => _submitting = true);

    try {
      // Writes the upload's manifest to disk before anything leaves the
      // phone, so the capture survives the app closing from here on. The
      // model was built when the scan finished, so nothing waits for it.
      await UploadQueue.instance.enqueue(
        _result.copyWith(config: config, controlDistances: _controls),
        export: widget.export,
        equipment: _equipment,
        videos: _videos,
      );
    } catch (_) {
      if (!mounted) return;
      setState(() => _submitting = false);
      showAppToast(context, 'The scan could not be queued. Try again.');
      return;
    }
    if (!mounted) return;
    // The capture flow is finished; leave only home under the upload screen
    // so "back" does not return to a submitted scan.
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute<void>(builder: (_) => const UploadingScreen()),
      (Route<dynamic> route) => route.isFirst,
    );
  }

  Future<void> _addControlDistance() async {
    final ControlDistance? added = await Navigator.of(context)
        .push<ControlDistance>(
          MaterialPageRoute<ControlDistance>(
            builder: (_) => ControlDistanceScreen(
              geometry: _result.geometry,
              walls: _result.walls,
              existing: _controls,
            ),
          ),
        );
    if (added == null || !mounted) return;
    setState(() => _controls = <ControlDistance>[..._controls, added]);
  }

  void _removeControlDistance(ControlDistance c) => setState(
    () => _controls = _controls.where((ControlDistance x) => x != c).toList(),
  );

  /// Step 3 of the capture: name the machines and walk round each one.
  Future<void> _captureEquipment() async {
    final EquipmentCaptureOutcome? outcome = await Navigator.of(context)
        .push<EquipmentCaptureOutcome>(
          MaterialPageRoute<EquipmentCaptureOutcome>(
            builder: (_) => EquipmentCaptureScreen(
              result: _result,
              equipment: _equipment,
              videos: _videos,
            ),
          ),
        );
    if (outcome == null || !mounted) return;
    setState(() {
      _equipment = outcome.equipment;
      _videos = outcome.videos;
      // Stepping back out keeps the work but does not finish the step.
      _equipmentDone = outcome.complete;
    });
  }

  /// Leaving throws the finished scan away, so it asks first. Returns
  /// whether the surveyor chose to discard it.
  Future<bool> _confirmDiscard({required bool scanAgain}) async {
    final bool? discard = await showCupertinoDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => CupertinoAlertDialog(
        title: Text(scanAgain ? 'Scan again?' : 'Discard this scan?'),
        content: const Text(
          'This scan, its tags and photos will be lost. It has not been '
          'submitted.',
        ),
        actions: <Widget>[
          CupertinoDialogAction(
            isDefaultAction: true,
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Cancel'),
          ),
          CupertinoDialogAction(
            isDestructiveAction: true,
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text(scanAgain ? 'Scan again' : 'Discard'),
          ),
        ],
      ),
    );
    return discard == true && mounted;
  }

  Future<void> _leave() async {
    final bool discard = await _confirmDiscard(scanAgain: false);
    if (!discard || !mounted) return;
    Navigator.of(context).pop();
  }

  /// Discards this scan and opens a new one for the same gym and level.
  Future<void> _scanAgain() async {
    final bool discard = await _confirmDiscard(scanAgain: true);
    if (!discard || !mounted) return;
    Navigator.of(context).pushReplacement(
      MaterialPageRoute<void>(
        builder: (_) => NewCaptureScreen(
          initialFacility: _facility.name,
          initialLevel: _levelController.text.trim().isEmpty
              ? '${_result.config.level}'
              : _levelController.text.trim(),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    // A back swipe must not silently throw away a finished scan.
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (bool didPop, Object? _) {
        if (!didPop && !_submitting) _leave();
      },
      child: _buildPage(context),
    );
  }

  Widget _buildPage(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: Column(
          children: <Widget>[
            Padding(
              padding: const EdgeInsets.only(left: 8, right: 12),
              child: NavBar(backLabel: 'Discard', onBack: _leave),
            ),
            Expanded(
              child: SingleChildScrollView(
                physics: const BouncingScrollPhysics(),
                padding: const EdgeInsets.fromLTRB(20, 6, 20, 16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    DetailHeader(
                      title: 'Review before submit',
                      // Area is only known once the floor is recognised.
                      subtitle: _result.areaM2 == null
                          ? _title
                          : '$_title · ${_result.areaM2!.round()} m²',
                    ),
                    const SizedBox(height: 18),
                    if (widget.export
                        case final ScanExport export?) ...<Widget>[
                      _ModelPreview(modelPath: export.modelPath),
                      const SizedBox(height: 16),
                    ],
                    _buildDetails(),
                    const SizedBox(height: 16),
                    HairlineContainer(
                      radius: 19,
                      fillColor: AppColors.planCanvas,
                      padding: const EdgeInsets.all(12),
                      child: FloorPlanView(
                        geometry: _result.geometry,
                        walls: _result.walls,
                        tags: _result.tags,
                        measurements: <(Offset, Offset?)>[
                          for (final ControlDistance c in _controls) (c.a, c.b),
                        ],
                        semanticLabel: 'Captured outline with tags marked',
                      ),
                    ),
                    const SizedBox(height: 16),
                    _buildWarnings(),
                    const SizedBox(height: 16),
                    _ControlDistances(
                      controls: _controls,
                      geometry: _result.geometry,
                      onAdd: _addControlDistance,
                      onRemove: _removeControlDistance,
                    ),
                    const SizedBox(height: 16),
                    _buildStats(),
                    const SizedBox(height: 14),
                    const Text(
                      'Photos may include people. They are shown to the '
                      'reviewer only and never appear in the walkthrough.',
                      style: AppTheme.footnote,
                    ),
                  ],
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 4, 20, 20),
              child: Column(
                children: <Widget>[
                  _EquipmentStep(
                    marked: _equipment.length,
                    recorded: _videos.length,
                    done: _equipmentDone,
                    onOpen: _captureEquipment,
                  ),
                  const SizedBox(height: 12),
                  PrimaryButton(
                    label: 'Submit scan',
                    busy: _submitting,
                    onPressed: _submit,
                  ),
                  const SizedBox(height: 8),
                  SecondaryAction(label: 'Scan again', onTap: _scanAgain),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// Facility, level and height: chosen here rather than before the scan,
  /// so tapping New capture goes straight to the camera.
  Widget _buildDetails() {
    return HairlineContainer(
      radius: 17,
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          const Text(
            'Capture details',
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w600,
              color: AppColors.textPrimary,
            ),
          ),
          if (widget.facilities?.offline ?? false) ...<Widget>[
            const SizedBox(height: 4),
            const Text(
              'Offline · facilities from the list saved on this iPhone. The '
              'scan uploads once you are back online.',
              style: AppTheme.footnote,
            ),
          ],
          const SizedBox(height: 12),
          LabelledField(
            label: 'Facility',
            child: PickerField(
              icon: Icons.home_work_outlined,
              value: _facility.name,
              options: <String>[for (final Facility f in _facilities) f.name],
              onChanged: (String name) => setState(
                () => _facility = _facilities.firstWhere(
                  (Facility f) => f.name == name,
                ),
              ),
            ),
          ),
          const SizedBox(height: 14),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Expanded(
                child: LabelledField(
                  label: 'Level',
                  errorText: _levelError,
                  child: NumericField(
                    controller: _levelController,
                    focusNode: _levelFocus,
                    hasError: _levelError != null,
                    semanticLabel: 'Level',
                    onSubmitted: (_) => _heightFocus.requestFocus(),
                  ),
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: LabelledField(
                  label: 'Floor to floor',
                  errorText: _heightError,
                  child: NumericField(
                    controller: _heightController,
                    focusNode: _heightFocus,
                    unit: 'm',
                    decimal: true,
                    hasError: _heightError != null,
                    semanticLabel: 'Floor to floor height in metres',
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildWarnings() {
    final List<(String, String)> warnings = _warnings;

    if (warnings.isEmpty) {
      return StatusCallout(
        color: AppColors.success,
        icon: Icons.check_rounded,
        title: 'Coverage check is clear',
        subtitle: '${_result.coveragePercent}% captured · outline closed',
      );
    }

    return HairlineContainer(
      radius: 17,
      borderColors: AppColors.edgeInto(AppColors.warning),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 15),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              const Icon(
                Icons.warning_amber_rounded,
                size: 18,
                color: AppColors.warning,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  '${warnings.length} coverage '
                  '${warnings.length == 1 ? 'warning' : 'warnings'}',
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                    color: AppColors.textPrimary,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          for (int i = 0; i < warnings.length; i++) ...<Widget>[
            if (i > 0) const SizedBox(height: 10),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                const Padding(
                  padding: EdgeInsets.only(top: 7),
                  child: StatusDot(color: AppColors.warning, size: 5),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text.rich(
                    TextSpan(
                      children: <InlineSpan>[
                        TextSpan(
                          text: warnings[i].$1,
                          style: const TextStyle(
                            fontWeight: FontWeight.w500,
                            color: AppColors.textPrimary,
                          ),
                        ),
                        TextSpan(text: ' ${warnings[i].$2}'),
                      ],
                    ),
                    style: AppTheme.caption,
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildStats() {
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Expanded(
            child: _StatCard(
              label: 'Tags',
              value: '${_result.tags.length}',
              footer: _result.tags.isEmpty
                  ? const Text('None dropped', style: AppTheme.label)
                  : Wrap(
                      spacing: 5,
                      runSpacing: 5,
                      children: <Widget>[
                        for (final ScanTag tag in _result.tags)
                          StatusDot(color: tag.type.color, size: 9),
                      ],
                    ),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: _StatCard(
              label: 'Photos',
              value: '${_result.photos}',
              suffix: 'of ${ScanResult.photoTarget}',
              // Wraps on narrow phones rather than overflowing the card.
              footer: Wrap(
                spacing: 5,
                runSpacing: 5,
                children: <Widget>[
                  for (int i = 0; i < ScanResult.photoTarget; i++)
                    Container(
                      width: 26,
                      height: 20,
                      decoration: BoxDecoration(
                        // Empty slots show what is still missing.
                        color: i < _result.photos
                            ? AppColors.planBlock
                            : Colors.transparent,
                        borderRadius: BorderRadius.circular(4),
                        border: Border.all(
                          color: i < _result.photos
                              ? AppColors.planBlockEdge
                              : AppColors.divider,
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The finished room in 3D (Polycam style), to turn and zoom before
/// submitting: RoomPlan's own model of the walls, doors, windows and
/// objects it found.
class _ModelPreview extends StatelessWidget {
  const _ModelPreview({required this.modelPath});

  final String modelPath;

  @override
  Widget build(BuildContext context) {
    return HairlineContainer(
      radius: 19,
      fillColor: AppColors.planCanvas,
      padding: const EdgeInsets.all(6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          ClipRRect(
            borderRadius: BorderRadius.circular(14),
            child: SizedBox(
              height: 300,
              child: ScanModelPreview(modelPath: modelPath),
            ),
          ),
          const Padding(
            padding: EdgeInsets.fromLTRB(8, 9, 8, 4),
            child: Row(
              children: <Widget>[
                Icon(
                  Icons.view_in_ar_rounded,
                  size: 15,
                  color: AppColors.accent,
                ),
                SizedBox(width: 7),
                Expanded(
                  child: Text(
                    '3D model · drag to turn, pinch to zoom',
                    style: AppTheme.caption,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _StatCard extends StatelessWidget {
  const _StatCard({
    required this.label,
    required this.value,
    required this.footer,
    this.suffix,
  });

  final String label;
  final String value;
  final String? suffix;
  final Widget footer;

  @override
  Widget build(BuildContext context) {
    return HairlineContainer(
      radius: 17,
      padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            label.toUpperCase(),
            style: AppTheme.fieldLabel.copyWith(fontSize: 12),
          ),
          const SizedBox(height: 9),
          Text.rich(
            TextSpan(
              text: value,
              children: <InlineSpan>[
                if (suffix != null)
                  TextSpan(
                    text: ' $suffix',
                    style: const TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w500,
                      color: AppColors.textMuted,
                    ),
                  ),
              ],
            ),
            style: const TextStyle(
              fontSize: 24,
              height: 1,
              fontWeight: FontWeight.w700,
              color: AppColors.textPrimary,
            ),
          ),
          const SizedBox(height: 11),
          footer,
        ],
      ),
    );
  }
}

/// The laser control distances (F-03): what was added, how each compares
/// with the scan, and a nudge towards two or more long ones. Never blocks
/// submitting.
class _ControlDistances extends StatelessWidget {
  const _ControlDistances({
    required this.controls,
    required this.geometry,
    required this.onAdd,
    required this.onRemove,
  });

  final List<ControlDistance> controls;
  final PlanGeometry geometry;
  final VoidCallback onAdd;
  final ValueChanged<ControlDistance> onRemove;

  @override
  Widget build(BuildContext context) {
    final int short = controls
        .where((ControlDistance c) => c.measuredM < ControlDistance.shortM)
        .length;
    final String? advice = controls.length < ControlDistance.recommended
        ? 'Add at least ${ControlDistance.recommended} long distances, '
              'measured with a laser across the floor, so the reviewer can '
              "check the scan's scale."
        : short > 0
        ? '$short of these ${short == 1 ? 'is' : 'are'} under '
              '${ControlDistance.shortM.toStringAsFixed(0)} m. Longer '
              'distances are a better check.'
        : null;

    return HairlineContainer(
      radius: 17,
      padding: const EdgeInsets.fromLTRB(16, 14, 8, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              const Icon(
                Icons.straighten_rounded,
                size: 18,
                color: AppColors.accent,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  controls.isEmpty
                      ? 'Control distances'
                      : 'Control distances · ${controls.length}',
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                    color: AppColors.textPrimary,
                  ),
                ),
              ),
              TextButton(onPressed: onAdd, child: const Text('Add distance')),
            ],
          ),
          for (final ControlDistance c in controls)
            Row(
              children: <Widget>[
                Expanded(
                  child: Text(
                    'Laser ${c.measuredM.toStringAsFixed(2)} m · scan '
                    '${c.scannedM(geometry).toStringAsFixed(2)} m',
                    style: AppTheme.caption,
                  ),
                ),
                IconButton(
                  onPressed: () => onRemove(c),
                  tooltip: 'Remove distance',
                  icon: const Icon(
                    Icons.close_rounded,
                    size: 18,
                    color: AppColors.textMuted,
                  ),
                ),
              ],
            ),
          if (advice != null)
            Padding(
              padding: const EdgeInsets.only(right: 8, bottom: 6, top: 2),
              child: Text(
                advice,
                style: AppTheme.footnote.copyWith(color: AppColors.warning),
              ),
            ),
        ],
      ),
    );
  }
}

/// CHANGE 3.1 step 3: the option to walk round the gym equipment, offered
/// once the scan has been reviewed and before it is submitted.
class _EquipmentStep extends StatelessWidget {
  const _EquipmentStep({
    required this.marked,
    required this.recorded,
    required this.done,
    required this.onOpen,
  });

  final int marked;
  final int recorded;

  /// The step has been finished. Optional: Submit works either way.
  final bool done;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    final String summary = switch ((done, marked)) {
      (true, 0) => 'No equipment on this level',
      (true, _) =>
        '$marked machine${marked == 1 ? '' : 's'} · '
            '$recorded walkaround${recorded == 1 ? '' : 's'}',
      (false, 0) =>
        'Optional. Name each machine and walk once around it, so the '
            'reviewer does not have to.',
      (false, _) => '$marked marked, $recorded recorded',
    };
    return HairlineContainer(
      radius: 12,
      child: ListTile(
        title: Row(
          children: <Widget>[
            // Flexible so a narrow phone shortens the label rather than
            // pushing the status dot off the edge.
            const Flexible(
              child: Text(
                'Capture Equipment 360°',
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: Colors.white,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            const SizedBox(width: 8),
            if (done)
              const Icon(Icons.check_circle, size: 16, color: AppColors.accent)
            else
              const Icon(
                Icons.circle_outlined,
                size: 16,
                color: AppColors.textMuted,
              ),
          ],
        ),
        subtitle: Text(summary, style: AppTheme.footnote),
        trailing: const Icon(Icons.chevron_right, color: AppColors.textMuted),
        onTap: onOpen,
      ),
    );
  }
}
