import 'package:flutter/material.dart';

import '../models/scan.dart';
import '../services/upload_queue.dart';
import '../theme/app_theme.dart';
import '../widgets/app_toast.dart';
import '../widgets/detail_widgets.dart';
import '../widgets/floor_plan.dart';
import '../widgets/hairline_container.dart';
import '../widgets/nav_bar.dart';
import '../widgets/primary_button.dart';
import 'uploading_screen.dart';
import 'package:room_scan/room_scan.dart';
import '../models/equipment.dart';
import 'equipment_capture_screen.dart';

/// Last look before the scan leaves the phone: the captured outline, any
/// coverage warnings, and what was tagged and photographed.
class ReviewSubmitScreen extends StatefulWidget {
  const ReviewSubmitScreen({super.key, required this.result, this.exportModel});

  final ScanResult result;

  /// Ends the scan and writes the 3D model for upload. Omitted, or returning
  /// null, for a simulated scan.
  final Future<ScanExport?> Function()? exportModel;

  @override
  State<ReviewSubmitScreen> createState() => _ReviewSubmitScreenState();
}

class _ReviewSubmitScreenState extends State<ReviewSubmitScreen> {
  bool _submitting = false;

  /// Machines marked and walkarounds recorded in the equipment step
  /// (CHANGE 3). They travel with the capture when it is submitted.
  List<Equipment> _equipment = const <Equipment>[];
  Map<String, EquipmentVideo> _videos = const <String, EquipmentVideo>{};

  /// The equipment step has been finished. Submit stays disabled until it
  /// is: a scan without equipment leaves the reviewer naming machines from
  /// nothing but an unlabelled block on the plan.
  bool _equipmentDone = false;

  ScanResult get _result => widget.result;

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
    setState(() => _submitting = true);

    // A LiDAR scan is finalised and written to disk here, which can take a
    // few seconds. A simulated scan has nothing to write, so it just pauses
    // as a stand-in.
    ScanExport? export;
    try {
      export = await widget.exportModel?.call();
      if (export == null) {
        await Future<void>.delayed(const Duration(milliseconds: 600));
      }
    } catch (_) {
      if (!mounted) return;
      setState(() => _submitting = false);
      showAppToast(context, 'The scan could not be saved. Scan again.');
      return;
    }
    if (!mounted) return;

    try {
      // Writes the upload's manifest to disk before anything leaves the
      // phone, so the capture survives the app closing from here on.
      await UploadQueue.instance.enqueue(
        _result,
        export: export,
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: Column(
          children: <Widget>[
            Padding(
              padding: const EdgeInsets.only(left: 8, right: 12),
              child: NavBar(
                backLabel: 'Scan',
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
                    DetailHeader(
                      title: 'Review before submit',
                      // Area is only known once the floor is recognised.
                      subtitle: _result.areaM2 == null
                          ? _result.config.title
                          : '${_result.config.title} · '
                                '${_result.areaM2!.round()} m²',
                    ),
                    const SizedBox(height: 18),
                    HairlineContainer(
                      radius: 19,
                      fillColor: AppColors.planCanvas,
                      padding: const EdgeInsets.all(12),
                      child: FloorPlanView(
                        geometry: _result.geometry,
                        walls: _result.walls,
                        tags: _result.tags,
                        semanticLabel: 'Captured outline with tags marked',
                      ),
                    ),
                    const SizedBox(height: 16),
                    _buildWarnings(),
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
                    // The equipment step comes before submitting: a scan
                    // without it leaves the reviewer naming machines from
                    // nothing but a block on the plan.
                    onPressed: _equipmentDone ? _submit : null,
                  ),
                  const SizedBox(height: 8),
                  SecondaryAction(
                    label: 'Keep scanning',
                    onTap: () => Navigator.of(context).maybePop(),
                  ),
                ],
              ),
            ),
          ],
        ),
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

  /// The step has been finished, which is what unlocks Submit.
  final bool done;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    final String summary = switch ((done, marked)) {
      (true, 0) => 'No equipment on this level',
      (true, _) =>
        '$marked machine${marked == 1 ? '' : 's'} · '
            '$recorded walkaround${recorded == 1 ? '' : 's'}',
      (false, 0) => 'Required before submitting. Name each machine and walk once around it.',
      (false, _) =>
        '$marked marked, $recorded recorded · finish this step to submit',
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
                style: TextStyle(color: Colors.white, fontWeight: FontWeight.w600),
              ),
            ),
            const SizedBox(width: 8),
            if (done)
              const Icon(Icons.check_circle, size: 16, color: AppColors.accent)
            else
              const Icon(Icons.circle_outlined, size: 16, color: AppColors.warning),
          ],
        ),
        subtitle: Text(
          summary,
          style: done
              ? AppTheme.footnote
              : AppTheme.footnote.copyWith(color: AppColors.warning),
        ),
        trailing: const Icon(Icons.chevron_right, color: AppColors.textMuted),
        onTap: onOpen,
      ),
    );
  }
}
