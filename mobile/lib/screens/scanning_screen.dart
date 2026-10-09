import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import '../models/scan.dart';
import '../services/app_config.dart';
import '../services/profile_service.dart';
import '../services/scan_backend.dart';
import '../services/scan_session.dart';
import '../theme/app_theme.dart';
import '../widgets/app_toast.dart';
import '../widgets/detail_widgets.dart';
import '../widgets/floor_plan.dart';
import '../widgets/hairline_container.dart';
import '../widgets/pressable.dart';
import '../widgets/primary_button.dart';
import '../widgets/tag_sheet.dart';
import 'review_submit_screen.dart';

/// Live scan: the outline fills in as the surveyor walks, with coverage, the
/// closure check, and actions to tag features and take reference photos.
class ScanningScreen extends StatefulWidget {
  const ScanningScreen({
    super.key,
    required this.config,
    this.session,
    this.maxExtentM,
  });

  final ScanConfig config;

  /// The largest floor one scan may cover, in metres along either side
  /// (F-04). Defaults to [AppConfig.maxScanExtentM].
  final double? maxExtentM;

  /// Injectable so tests can control the walk. When omitted the screen uses
  /// the LiDAR scanner if this device has one (see [ScanBackend]), and
  /// disposes of it afterwards.
  final ScanSession? session;

  @override
  State<ScanningScreen> createState() => _ScanningScreenState();
}

class _ScanningScreenState extends State<ScanningScreen> {
  late final ScanSession _session =
      widget.session ?? ScanBackend.createSession(widget.config);

  late final double _maxExtentM = widget.maxExtentM ?? AppConfig.maxScanExtentM;

  /// The scanned walls already span more than one scan may hold.
  bool get _tooLarge {
    final Size? extent = _session.scannedExtentM;
    return extent != null &&
        (extent.width > _maxExtentM || extent.height > _maxExtentM);
  }

  /// The photo privacy warning is shown once per scan, not once per photo.
  bool _photoWarningAccepted = false;

  @override
  void initState() {
    super.initState();
    _session.start();
  }

  @override
  void dispose() {
    _session.pause();
    if (widget.session == null) _session.dispose();
    super.dispose();
  }

  Future<void> _addTag() async {
    final TagChoice? choice = await showTagSheet(
      context,
      defaultHeightM: widget.config.heightM,
    );
    if (choice == null || !mounted) return;
    _session.addTag(choice.type, heightM: choice.heightM);
    showAppToast(context, '${choice.type.label} tagged.');
  }

  Future<void> _takePhoto() async {
    if (_session.photos >= ScanResult.photoTarget) {
      showAppToast(
        context,
        'All ${ScanResult.photoTarget} reference photos taken.',
      );
      return;
    }

    if (CaptureSettings.instance.warnBeforePhotos && !_photoWarningAccepted) {
      final bool? ok = await showCupertinoDialog<bool>(
        context: context,
        builder: (BuildContext dialogContext) => CupertinoAlertDialog(
          title: const Text('Photos may include people'),
          content: const Text(
            'Only the reviewer sees reference photos. They never appear in '
            'the walkthrough. Frame walls and corners, not members.',
          ),
          actions: <Widget>[
            CupertinoDialogAction(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('Cancel'),
            ),
            CupertinoDialogAction(
              isDefaultAction: true,
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: const Text('Take photo'),
            ),
          ],
        ),
      );
      if (ok != true || !mounted) return;
      _photoWarningAccepted = true;
    }

    try {
      await _session.addPhoto();
    } catch (_) {
      if (mounted) showAppToast(context, 'Photo not saved. Try again.');
      return;
    }
    if (!mounted) return;
    showAppToast(
      context,
      'Reference photo ${_session.photos} of ${ScanResult.photoTarget} saved.',
    );
  }

  Future<void> _finish() async {
    String? reason;
    if (!_session.closed) {
      _session.pause();
      reason = await showCupertinoDialog<String>(
        context: context,
        builder: (_) => const _OverrideDialog(),
      );
      if (!mounted) return;
      if (reason == null) {
        _session.start();
        return;
      }
    }

    _session.pause();
    final ScanResult result = _session.finish(overrideReason: reason);

    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) =>
            ReviewSubmitScreen(result: result, exportModel: _session.export),
      ),
    );

    // Back from review via "Keep scanning". If the scan was submitted this
    // screen has already been removed.
    if (mounted) _session.start();
  }

  Future<void> _confirmDiscard() async {
    _session.pause();
    final bool? discard = await showCupertinoDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => CupertinoAlertDialog(
        title: const Text('Discard this scan?'),
        content: const Text('The walk so far and its tags will be lost.'),
        actions: <Widget>[
          CupertinoDialogAction(
            isDefaultAction: true,
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Keep scanning'),
          ),
          CupertinoDialogAction(
            isDestructiveAction: true,
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Discard'),
          ),
        ],
      ),
    );
    if (!mounted) return;
    if (discard == true) {
      Navigator.of(context).pop();
    } else {
      _session.start();
    }
  }

  @override
  Widget build(BuildContext context) {
    // A swipe or back press must not throw away a half-walked floor.
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (bool didPop, Object? _) {
        if (!didPop) _confirmDiscard();
      },
      child: Scaffold(
        backgroundColor: AppColors.background,
        body: SafeArea(
          child: ListenableBuilder(
            listenable: _session,
            builder: (BuildContext context, Widget? _) => Column(
              children: <Widget>[
                _buildTopBar(),
                Expanded(
                  child: SingleChildScrollView(
                    physics: const BouncingScrollPhysics(),
                    padding: const EdgeInsets.fromLTRB(20, 8, 20, 16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: <Widget>[
                        _buildPlan(),
                        if (_session.instruction != null &&
                            _session.error == null) ...<Widget>[
                          const SizedBox(height: 10),
                          _Coaching(text: _session.instruction!),
                        ],
                        const SizedBox(height: 14),
                        _CoverageBar(coverage: _session.coverage),
                        const SizedBox(height: 10),
                        _ExtentRow(
                          extent: _session.scannedExtentM,
                          maxM: _maxExtentM,
                        ),
                        const SizedBox(height: 12),
                        if (_tooLarge) ...<Widget>[
                          _TooLargeCallout(maxM: _maxExtentM),
                          const SizedBox(height: 12),
                        ],
                        _buildClosureCallout(),
                        const SizedBox(height: 14),
                        _TagChips(tags: _session.tags),
                      ],
                    ),
                  ),
                ),
                _buildActions(),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildTopBar() {
    final Duration t = _session.elapsed;
    final String clock =
        '${t.inMinutes.toString().padLeft(2, '0')}:'
        '${(t.inSeconds % 60).toString().padLeft(2, '0')}';

    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 0, 20, 0),
      child: SizedBox(
        height: 44,
        child: Row(
          children: <Widget>[
            Pressable(
              onTap: _confirmDiscard,
              haptic: HapticImpact.selection,
              semanticLabel: 'Discard scan',
              child: const SizedBox(
                width: 36,
                height: 44,
                child: Icon(
                  CupertinoIcons.xmark,
                  size: 18,
                  color: AppColors.textMuted,
                ),
              ),
            ),
            const SizedBox(width: 4),
            Flexible(
              child: _Chip(
                height: 30,
                dot: AppColors.danger,
                label: widget.config.shortTitle,
                fontSize: 12.5,
                weight: FontWeight.w600,
              ),
            ),
            const Spacer(),
            Semantics(
              label: 'Elapsed $clock',
              child: Text(
                clock,
                style: const TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                  fontFeatures: <FontFeature>[FontFeature.tabularFigures()],
                  color: AppColors.textPrimary,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildPlan() {
    return HairlineContainer(
      radius: 21,
      fillColor: AppColors.planCanvas,
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          FloorPlanView(
            geometry: _session.geometry,
            walls: _session.walls,
            wallProgress: _session.wallProgress,
            tags: _session.tags,
            walker: _session.walker,
            showGrid: true,
            semanticLabel: 'Live top-down outline of the level being scanned',
          ),
          const SizedBox(height: 6),
          const FloorPlanLegend(),
        ],
      ),
    );
  }

  /// "The inner east wall was", "One wall was" or "3 walls were". Only the
  /// demo outline names its walls.
  String _describeWeak(List<WallSegment> weakWalls) {
    if (weakWalls.length > 1) return '${weakWalls.length} walls were';
    final String? name = weakWalls.single.name;
    return name == null ? 'One wall was' : 'The ${name.toLowerCase()} was';
  }

  Widget _buildClosureCallout() {
    final int missing = _session.walls
        .where((WallQuality q) => q == WallQuality.missing)
        .length;
    final List<WallSegment> weakWalls = _session.weakWalls;
    final bool weak = weakWalls.isNotEmpty;

    final (IconData icon, Color color, String title, String body) = switch ((
      _session.error,
      _session.closed,
      weak,
    )) {
      (final String error, _, _) => (
        Icons.error_outline_rounded,
        AppColors.danger,
        'Scanning stopped',
        error,
      ),
      (null, true, false) => (
        Icons.check_circle_outline_rounded,
        AppColors.success,
        'Coverage check is clear',
        'Every wall is captured. Finish when you are ready.',
      ),
      (null, true, true) => (
        Icons.warning_amber_rounded,
        AppColors.warning,
        weakWalls.length == 1
            ? 'One wall reads weak'
            : '${weakWalls.length} walls read weak',
        '${_describeWeak(weakWalls)} captured at low confidence. Rewalk '
            '${weakWalls.length == 1 ? 'it' : 'them'}, or finish and the '
            'reviewer will see a warning.',
      ),
      (null, false, _) when _session.geometry.walls.isEmpty => (
        Icons.directions_walk_rounded,
        AppColors.accent,
        'Start at a corner',
        'Walk the perimeter slowly with the phone at waist height, pointed '
            'at the walls.',
      ),
      (null, false, _) when missing > 0 => (
        Icons.warning_amber_rounded,
        AppColors.warning,
        'Outline is not closed',
        '$missing ${missing == 1 ? 'wall' : 'walls'} still to walk'
            '${weak ? ' and one reads weak' : ''}. Walk '
            '${missing == 1 && !weak ? 'it' : 'those'} before you finish.',
      ),
      (null, false, _) => (
        Icons.warning_amber_rounded,
        AppColors.warning,
        'Outline is not closed',
        'Some walls do not meet yet. Keep walking the perimeter until the '
            'outline joins up.',
      ),
    };

    return HairlineContainer(
      radius: 15,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.only(top: 1),
            child: Icon(icon, size: 17, color: color),
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  title,
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: AppColors.textPrimary,
                  ),
                ),
                const SizedBox(height: 3),
                Text(body, style: AppTheme.caption),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildActions() {
    // A failed scan has nothing left to tag or finish; only discarding it
    // (the × in the top bar) makes sense.
    final bool live = _session.error == null;

    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
      child: Row(
        children: <Widget>[
          _RoundAction(
            icon: Icons.sell_outlined,
            semanticLabel: 'Add a tag',
            onTap: live ? _addTag : null,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: PrimaryButton(
              label: 'Finish scan',
              // Past the size limit the scan cannot be finished: one scan
              // of a floor that size would not be reliable. The callout
              // above says why.
              onPressed: live && !_tooLarge ? _finish : null,
            ),
          ),
          const SizedBox(width: 12),
          _RoundAction(
            icon: Icons.photo_camera_outlined,
            semanticLabel: 'Take a reference photo',
            onTap: live ? _takePhoto : null,
          ),
        ],
      ),
    );
  }
}

/// "Scanned extent 24.4 × 19.0 m", live as the outline grows (F-04).
class _ExtentRow extends StatelessWidget {
  const _ExtentRow({required this.extent, required this.maxM});

  final Size? extent;
  final double maxM;

  @override
  Widget build(BuildContext context) {
    final Size? e = extent;
    final bool over = e != null && (e.width > maxM || e.height > maxM);
    final String value = e == null
        ? '—'
        : '${e.width.toStringAsFixed(1)} × ${e.height.toStringAsFixed(1)} m';
    return Semantics(
      label: 'Scanned extent $value, limit ${maxM.round()} metres',
      excludeSemantics: true,
      child: Row(
        children: <Widget>[
          const Icon(
            Icons.straighten_rounded,
            size: 16,
            color: AppColors.textMuted,
          ),
          const SizedBox(width: 8),
          const Expanded(
            child: Text('Scanned extent', style: AppTheme.caption),
          ),
          Text(
            value,
            style: TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w600,
              fontFeatures: const <FontFeature>[FontFeature.tabularFigures()],
              color: over ? AppColors.warning : AppColors.textPrimary,
            ),
          ),
          Text(' / max ${maxM.round()} m', style: AppTheme.caption),
        ],
      ),
    );
  }
}

/// Stays on screen while the scanned walls are past the limit, and
/// explains why Finish is off.
class _TooLargeCallout extends StatelessWidget {
  const _TooLargeCallout({required this.maxM});

  final double maxM;

  @override
  Widget build(BuildContext context) {
    return HairlineContainer(
      radius: 15,
      borderColors: AppColors.edgeInto(AppColors.warning),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Padding(
            padding: EdgeInsets.only(top: 1),
            child: Icon(
              Icons.crop_free_rounded,
              size: 17,
              color: AppColors.warning,
            ),
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                const Text(
                  'Too large for one scan',
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: AppColors.textPrimary,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  'This floor is over ${maxM.round()} m across, more than one '
                  'scan can hold accurately. It must be scanned in sections, '
                  'so Finish is off for this scan. Discard it and scan the '
                  'floor one section at a time.',
                  style: AppTheme.caption,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// RoomPlan's live coaching, e.g. "Slow down".
class _Coaching extends StatelessWidget {
  const _Coaching({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      liveRegion: true,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
        decoration: BoxDecoration(
          color: AppColors.info.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Row(
          children: <Widget>[
            const Icon(
              Icons.info_outline_rounded,
              size: 16,
              color: AppColors.info,
            ),
            const SizedBox(width: 9),
            Expanded(
              child: Text(
                text,
                style: const TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w500,
                  color: AppColors.textPrimary,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _CoverageBar extends StatelessWidget {
  const _CoverageBar({required this.coverage});

  final double coverage;

  @override
  Widget build(BuildContext context) {
    final int percent = (coverage * 100).round();

    return Semantics(
      label: 'Coverage $percent percent',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: <Widget>[
              const Expanded(
                child: Text(
                  'Coverage',
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: AppColors.textPrimary,
                  ),
                ),
              ),
              Text(
                '$percent%',
                style: const TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w700,
                  fontFeatures: <FontFeature>[FontFeature.tabularFigures()],
                  color: AppColors.accent,
                ),
              ),
            ],
          ),
          const SizedBox(height: 9),
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: SizedBox(
              height: 7,
              child: Stack(
                children: <Widget>[
                  const Positioned.fill(
                    child: ColoredBox(color: AppColors.track),
                  ),
                  AnimatedFractionallySizedBox(
                    duration: const Duration(milliseconds: 200),
                    widthFactor: coverage.clamp(0, 1),
                    heightFactor: 1,
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(4),
                        gradient: const LinearGradient(
                          colors: <Color>[AppColors.deepTeal, AppColors.accent],
                        ),
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

/// Tags dropped so far, one chip per type, most recent types first.
class _TagChips extends StatelessWidget {
  const _TagChips({required this.tags});

  static const int _maxChips = 3;

  final List<ScanTag> tags;

  @override
  Widget build(BuildContext context) {
    if (tags.isEmpty) {
      return const Text(
        'No tags yet. Tag fire exits, mirror walls and ceiling height as you '
        'pass them.',
        style: AppTheme.caption,
      );
    }

    final Map<TagType, int> counts = <TagType, int>{};
    for (final ScanTag tag in tags.reversed) {
      counts[tag.type] = (counts[tag.type] ?? 0) + 1;
    }
    final List<MapEntry<TagType, int>> entries = counts.entries.toList();
    final int overflow = entries.length - _maxChips;

    return Wrap(
      spacing: 10,
      runSpacing: 8,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: <Widget>[
        for (final MapEntry<TagType, int> e in entries.take(_maxChips))
          _Chip(
            dot: e.key.color,
            label: e.value > 1
                ? '${e.key.shortLabel} ×${e.value}'
                : e.key.shortLabel,
          ),
        if (overflow > 0)
          SizedBox(
            height: 30,
            child: Center(
              child: Text(
                '+$overflow',
                style: const TextStyle(
                  fontSize: 12,
                  color: AppColors.textMuted,
                ),
              ),
            ),
          ),
      ],
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({
    required this.dot,
    required this.label,
    this.height = 30,
    this.fontSize = 12,
    this.weight = FontWeight.w500,
  });

  final Color dot;
  final String label;
  final double height;
  final double fontSize;
  final FontWeight weight;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: height,
      padding: const EdgeInsets.symmetric(horizontal: 11),
      decoration: BoxDecoration(
        color: AppColors.chipFill,
        borderRadius: BorderRadius.circular(height / 2),
        border: Border.all(color: AppColors.chipEdge),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          StatusDot(color: dot, size: 6.5),
          const SizedBox(width: 7),
          Flexible(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: fontSize,
                fontWeight: weight,
                color: AppColors.textPrimary,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _RoundAction extends StatelessWidget {
  const _RoundAction({
    required this.icon,
    required this.semanticLabel,
    required this.onTap,
  });

  final IconData icon;
  final String semanticLabel;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Pressable(
      onTap: onTap,
      semanticLabel: semanticLabel,
      pressedScale: 0.92,
      child: Container(
        width: 52,
        height: 52,
        decoration: BoxDecoration(
          color: AppColors.chipFill,
          shape: BoxShape.circle,
          border: Border.all(color: AppColors.chipEdge),
        ),
        child: Icon(icon, size: 23, color: AppColors.accent),
      ),
    );
  }
}

/// Asks why the surveyor is finishing before the outline closes. The reason
/// goes to the reviewer with the scan.
class _OverrideDialog extends StatefulWidget {
  const _OverrideDialog();

  @override
  State<_OverrideDialog> createState() => _OverrideDialogState();
}

class _OverrideDialogState extends State<_OverrideDialog> {
  final TextEditingController _reason = TextEditingController();

  @override
  void initState() {
    super.initState();
    _reason.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final String reason = _reason.text.trim();

    return CupertinoAlertDialog(
      title: const Text('Finish without closing?'),
      content: Column(
        children: <Widget>[
          const SizedBox(height: 4),
          const Text(
            'The outline has gaps. Say why you cannot walk them, and the '
            'reviewer will see it with the scan.',
          ),
          const SizedBox(height: 12),
          CupertinoTextField(
            controller: _reason,
            autofocus: true,
            placeholder: 'e.g. Wall behind fixed rig, cannot pass',
            keyboardAppearance: Brightness.dark,
            maxLines: 2,
            minLines: 1,
            textCapitalization: TextCapitalization.sentences,
          ),
        ],
      ),
      actions: <Widget>[
        CupertinoDialogAction(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Keep scanning'),
        ),
        CupertinoDialogAction(
          isDestructiveAction: true,
          onPressed: reason.isEmpty
              ? null
              : () => Navigator.of(context).pop(reason),
          child: const Text('Finish anyway'),
        ),
      ],
    );
  }
}
