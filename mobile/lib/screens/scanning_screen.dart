import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:room_scan/room_scan.dart';

import '../models/scan.dart';
import '../services/app_config.dart';
import '../services/capture_service.dart';
import '../services/profile_service.dart';
import '../services/scan_backend.dart';
import '../services/scan_session.dart';
import '../theme/app_theme.dart';
import '../widgets/app_toast.dart';
import '../widgets/detail_widgets.dart';
import '../widgets/hairline_container.dart';
import '../widgets/pressable.dart';
import '../widgets/tag_sheet.dart';
import 'review_submit_screen.dart';

/// Live scan, Polycam style. The camera is live as soon as the screen
/// opens; the capture button starts the scan, and from then Apple's
/// RoomCaptureView outlines each wall, edge and opening in white as it is
/// found, with a small 3D model of the room so far. Over it sit only the
/// clock, the closure check, coverage, and the tag, finish and photo
/// buttons.
class ScanningScreen extends StatefulWidget {
  const ScanningScreen({
    super.key,
    required this.config,
    this.facilities,
    this.session,
    this.maxExtentM,
  });

  /// The scan's starting details. The surveyor confirms the facility, level
  /// and height on the review screen.
  final ScanConfig config;

  /// The account's facilities, for the picker on the review screen.
  final FacilityList? facilities;

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

  /// The surveyor has tapped the capture button. Until then the camera is
  /// live but nothing is scanned.
  bool _started = false;

  /// Finish was tapped and RoomPlan is building the final room.
  bool _processing = false;

  /// The walls of the current section already span more than one scan may
  /// hold (F-04). With sections (F-01) the limit is per section, so a big
  /// floor is finished by starting a new one rather than discarded.
  bool get _tooLarge {
    final Size? extent = _session.sectionExtentM;
    return extent != null &&
        (extent.width > _maxExtentM || extent.height > _maxExtentM);
  }

  /// The photo privacy warning is shown once per scan, not once per photo.
  bool _photoWarningAccepted = false;

  /// A new section is being started; RoomPlan takes a moment to close the
  /// last one.
  bool _startingSection = false;

  /// The capture button, first tap: RoomPlan starts and the white wall
  /// outlines begin to form.
  void _begin() {
    setState(() => _started = true);
    _session.start();
  }

  /// Carries on after a dialog, once the scan has been started.
  void _resume() {
    if (_started) _session.start();
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

  /// Closes the section scanned so far and starts the next (F-01).
  Future<void> _newSection() async {
    final bool? go = await showCupertinoDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => CupertinoAlertDialog(
        title: const Text('Start a new section?'),
        content: const Text(
          'What you have scanned is kept. Walk on to the next area, and '
          'start where you can still see a couple of metres of this '
          'section, so the two join up.',
        ),
        actions: <Widget>[
          CupertinoDialogAction(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Cancel'),
          ),
          CupertinoDialogAction(
            isDefaultAction: true,
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('New section'),
          ),
        ],
      ),
    );
    if (go != true || !mounted) return;

    setState(() => _startingSection = true);
    try {
      await _session.nextSection();
    } catch (_) {
      if (mounted) {
        showAppToast(
          context,
          'A new section could not be started. Keep scanning this one.',
        );
      }
      return;
    } finally {
      if (mounted) setState(() => _startingSection = false);
    }
    if (!mounted) return;
    showAppToast(
      context,
      'Section ${_session.section} started. Overlap the last one a little.',
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
        _resume();
        return;
      }
    }

    _session.pause();
    final ScanResult result = _session.finish(overrideReason: reason);

    // Polycam style: the scan is finalised now, so the review screen can
    // show the room in 3D before it is submitted. RoomPlan cannot carry on
    // a finalised scan, so the review screen replaces this one; a missed
    // wall means scanning again (or a New section before finishing).
    setState(() => _processing = true);
    final ScanExport? export;
    try {
      export = await _session.export();
    } catch (_) {
      if (!mounted) return;
      setState(() => _processing = false);
      await _sayNotProcessed();
      return;
    }
    if (!mounted) return;

    Navigator.of(context).pushReplacement(
      MaterialPageRoute<void>(
        builder: (_) => ReviewSubmitScreen(
          result: result,
          facilities: widget.facilities,
          export: export,
        ),
      ),
    );
  }

  /// RoomPlan could not build the room. The scan has ended, so the only
  /// way on is to scan again.
  Future<void> _sayNotProcessed() async {
    await showCupertinoDialog<void>(
      context: context,
      builder: (BuildContext dialogContext) => CupertinoAlertDialog(
        title: const Text('The scan could not be processed'),
        content: const Text(
          'The room could not be built from this scan. Please scan it again.',
        ),
        actions: <Widget>[
          CupertinoDialogAction(
            isDefaultAction: true,
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('OK'),
          ),
        ],
      ),
    );
    if (mounted) Navigator.of(context).pop();
  }

  Future<void> _confirmDiscard() async {
    // Nothing scanned yet, so nothing to lose: just close.
    if (!_started) {
      Navigator.of(context).pop();
      return;
    }
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
      _resume();
    }
  }

  @override
  Widget build(BuildContext context) {
    // A swipe or back press must not throw away a half-walked floor.
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (bool didPop, Object? _) {
        if (!didPop && !_processing) _confirmDiscard();
      },
      child: Scaffold(
        backgroundColor: Colors.black,
        body: Stack(
          children: <Widget>[
            // The camera, with RoomPlan's white wall outlines and 3D model
            // drawn natively on a LiDAR device.
            const Positioned.fill(child: RoomCapturePreview()),

            SafeArea(
              child: ListenableBuilder(
                listenable: _session,
                builder: (BuildContext context, Widget? _) => Padding(
                  padding: const EdgeInsets.fromLTRB(16, 6, 16, 12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: !_started
                        ? <Widget>[
                            // Camera live, nothing scanned yet: only the
                            // way out, a hint and the capture button.
                            _buildTopBar(),
                            const Spacer(),
                            const _StartHint(),
                            const SizedBox(height: 16),
                            Center(child: _RecordButton.start(onTap: _begin)),
                          ]
                        : <Widget>[
                            _buildTopBar(),
                            const SizedBox(height: 12),
                            _buildClosureCallout(),
                            if (_tooLarge) ...<Widget>[
                              const SizedBox(height: 8),
                              _TooLargeCallout(
                                maxM: _maxExtentM,
                                canSection: _session.supportsSections,
                              ),
                            ],
                            const Spacer(),
                            if (_session.tags.isNotEmpty) ...<Widget>[
                              _TagChips(tags: _session.tags),
                              const SizedBox(height: 10),
                            ],
                            _buildProgress(),
                            if (_canStartSection) ...<Widget>[
                              const SizedBox(height: 10),
                              Center(child: _buildSectionButton()),
                            ],
                            const SizedBox(height: 16),
                            _buildActions(),
                          ],
                  ),
                ),
              ),
            ),

            if (_processing) const Positioned.fill(child: _Processing()),
          ],
        ),
      ),
    );
  }

  /// The recording clock on the left, close on the right.
  Widget _buildTopBar() {
    final Duration t = _session.elapsed;
    final String clock =
        '${t.inMinutes.toString().padLeft(2, '0')}:'
        '${(t.inSeconds % 60).toString().padLeft(2, '0')}';
    final bool recording = _session.running && _session.error == null;

    return Row(
      children: <Widget>[
        _Glass(
          radius: 18,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
          child: Semantics(
            label: 'Elapsed $clock',
            excludeSemantics: true,
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                StatusDot(
                  color: recording ? AppColors.danger : AppColors.textMuted,
                  size: 8,
                ),
                const SizedBox(width: 8),
                Text(
                  clock,
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                    fontFeatures: <FontFeature>[FontFeature.tabularFigures()],
                    color: AppColors.textPrimary,
                  ),
                ),
              ],
            ),
          ),
        ),
        if (_session.section > 1) ...<Widget>[
          const SizedBox(width: 8),
          _Glass(
            radius: 18,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
            child: Text(
              'Section ${_session.section}',
              style: const TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w600,
                color: AppColors.textPrimary,
              ),
            ),
          ),
        ],
        const Spacer(),
        Pressable(
          onTap: _confirmDiscard,
          haptic: HapticImpact.selection,
          semanticLabel: 'Discard scan',
          child: const _Glass(
            radius: 18,
            child: SizedBox(
              width: 36,
              height: 36,
              child: Icon(
                CupertinoIcons.xmark,
                size: 16,
                color: AppColors.textPrimary,
              ),
            ),
          ),
        ),
      ],
    );
  }

  /// Coverage and scanned extent, kept to one slim card.
  Widget _buildProgress() {
    return _Glass(
      radius: 16,
      padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          _CoverageBar(coverage: _session.coverage),
          const SizedBox(height: 8),
          _ExtentRow(
            label: _session.section > 1 ? 'Section extent' : 'Scanned extent',
            extent: _session.sectionExtentM,
            maxM: _maxExtentM,
          ),
        ],
      ),
    );
  }

  /// A section can be closed once something has been scanned in it, while
  /// the scan is live.
  bool get _canStartSection =>
      _session.supportsSections &&
      _session.error == null &&
      _session.geometry.walls.isNotEmpty &&
      _session.sectionExtentM != null;

  Widget _buildSectionButton() {
    return Pressable(
      onTap: _startingSection ? null : _newSection,
      haptic: HapticImpact.selection,
      child: _Glass(
        radius: 18,
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            if (_startingSection)
              const CupertinoActivityIndicator(radius: 7, color: Colors.white)
            else
              const Icon(
                Icons.add_rounded,
                size: 16,
                color: AppColors.textPrimary,
              ),
            const SizedBox(width: 6),
            Text(
              _startingSection ? 'Starting section…' : 'New section',
              style: const TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w600,
                color: AppColors.textPrimary,
              ),
            ),
          ],
        ),
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

    return _Glass(
      radius: 15,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
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
                Text(
                  body,
                  style: AppTheme.caption.copyWith(color: Colors.white70),
                ),
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

    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceEvenly,
      children: <Widget>[
        _RoundAction(
          icon: Icons.sell_outlined,
          semanticLabel: 'Add a tag',
          onTap: live ? _addTag : null,
        ),
        _RecordButton(
          // Past the size limit the scan cannot be finished: one scan of a
          // floor that size would not be reliable. The callout says why.
          onTap: live && !_tooLarge ? _finish : null,
        ),
        _RoundAction(
          icon: Icons.photo_camera_outlined,
          semanticLabel: 'Take a reference photo',
          onTap: live ? _takePhoto : null,
        ),
      ],
    );
  }
}

/// A dark, see-through panel that stays readable over the camera.
class _Glass extends StatelessWidget {
  const _Glass({
    required this.child,
    required this.radius,
    this.padding = EdgeInsets.zero,
  });

  final Widget child;
  final double radius;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: padding,
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(radius),
        border: Border.all(
          color: Colors.white.withValues(alpha: 0.14),
          width: 0.8,
        ),
      ),
      child: child,
    );
  }
}

/// The big finish button: a white ring round a red square, as on a camera.
class _RecordButton extends StatelessWidget {
  /// While scanning: a red square, which finishes the scan.
  const _RecordButton({required this.onTap}) : starting = false;

  /// Before the scan: a red circle, which starts it.
  const _RecordButton.start({required this.onTap}) : starting = true;

  final VoidCallback? onTap;
  final bool starting;

  @override
  Widget build(BuildContext context) {
    return Pressable(
      key: ValueKey<String>(starting ? 'start-scan' : 'finish-scan'),
      onTap: onTap,
      semanticLabel: starting ? 'Start scan' : 'Finish scan',
      haptic: HapticImpact.medium,
      pressedScale: 0.92,
      disabledOpacity: 0.4,
      child: Container(
        width: 78,
        height: 78,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          border: Border.all(color: Colors.white, width: 4),
          color: Colors.black.withValues(alpha: 0.25),
        ),
        child: Center(
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 200),
            width: starting ? 58 : 32,
            height: starting ? 58 : 32,
            decoration: BoxDecoration(
              color: AppColors.danger,
              borderRadius: BorderRadius.circular(starting ? 29 : 8),
            ),
          ),
        ),
      ),
    );
  }
}

/// While RoomPlan builds the final room after Finish. It takes a few
/// seconds and nothing can be tapped meanwhile.
class _Processing extends StatelessWidget {
  const _Processing();

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: Colors.black.withValues(alpha: 0.75),
      child: const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            CupertinoActivityIndicator(radius: 14, color: Colors.white),
            SizedBox(height: 16),
            Text(
              'Processing your scan…',
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w600,
                color: AppColors.textPrimary,
              ),
            ),
            SizedBox(height: 6),
            Text('Building the 3D model of the room', style: AppTheme.caption),
          ],
        ),
      ),
    );
  }
}

/// Before the scan starts: what to do, Polycam style.
class _StartHint extends StatelessWidget {
  const _StartHint();

  @override
  Widget build(BuildContext context) {
    return _Glass(
      radius: 15,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
      child: Row(
        children: <Widget>[
          const Icon(
            Icons.crop_free_rounded,
            size: 18,
            color: AppColors.accent,
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Text(
              'Point the camera at a wall and tap the button to start '
              'scanning. Then walk slowly round the edge of the room.',
              style: AppTheme.caption.copyWith(color: Colors.white70),
            ),
          ),
        ],
      ),
    );
  }
}

/// "Scanned extent 24.4 × 19.0 m", live as the outline grows (F-04). In a
/// sectioned scan, the current section's.
class _ExtentRow extends StatelessWidget {
  const _ExtentRow({
    required this.label,
    required this.extent,
    required this.maxM,
  });

  final String label;
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
      label: '$label $value, limit ${maxM.round()} metres',
      excludeSemantics: true,
      child: Row(
        children: <Widget>[
          const Icon(
            Icons.straighten_rounded,
            size: 14,
            color: AppColors.textMuted,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              label,
              style: AppTheme.caption,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          Text(
            value,
            style: TextStyle(
              fontSize: 12,
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

/// Stays on screen while the current section is past the limit, and
/// explains why Finish is off and what to do instead.
class _TooLargeCallout extends StatelessWidget {
  const _TooLargeCallout({required this.maxM, required this.canSection});

  final double maxM;

  /// A new section can be started (F-01), so the floor is finished that
  /// way rather than discarded.
  final bool canSection;

  @override
  Widget build(BuildContext context) {
    return HairlineContainer(
      radius: 15,
      borderColors: AppColors.edgeInto(AppColors.warning),
      fillColor: Colors.black.withValues(alpha: 0.7),
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
                  canSection
                      ? 'This section is over ${maxM.round()} m across, more '
                            'than one scan can hold accurately. The floor must '
                            'be scanned in sections: tap New section and carry '
                            'on. Finish is off until you do.'
                      : 'This floor is over ${maxM.round()} m across, more '
                            'than one scan can hold accurately. It must be '
                            'scanned in sections, so Finish is off for this '
                            'scan. Discard it and scan the floor one section '
                            'at a time.',
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

class _CoverageBar extends StatelessWidget {
  const _CoverageBar({required this.coverage});

  final double coverage;

  @override
  Widget build(BuildContext context) {
    final int percent = (coverage * 100).round();

    return Semantics(
      label: 'Coverage $percent percent',
      child: Row(
        children: <Widget>[
          const Text(
            'Coverage',
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: AppColors.textPrimary,
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: ClipRRect(
              borderRadius: BorderRadius.circular(3),
              child: SizedBox(
                height: 5,
                child: Stack(
                  children: <Widget>[
                    const Positioned.fill(
                      child: ColoredBox(color: AppColors.track),
                    ),
                    AnimatedFractionallySizedBox(
                      duration: const Duration(milliseconds: 200),
                      widthFactor: coverage.clamp(0, 1),
                      heightFactor: 1,
                      child: const DecoratedBox(
                        decoration: BoxDecoration(
                          gradient: LinearGradient(
                            colors: <Color>[
                              AppColors.deepTeal,
                              AppColors.accent,
                            ],
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
          const SizedBox(width: 10),
          Text(
            '$percent%',
            style: const TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w700,
              fontFeatures: <FontFeature>[FontFeature.tabularFigures()],
              color: AppColors.accent,
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
    final Map<TagType, int> counts = <TagType, int>{};
    for (final ScanTag tag in tags.reversed) {
      counts[tag.type] = (counts[tag.type] ?? 0) + 1;
    }
    final List<MapEntry<TagType, int>> entries = counts.entries.toList();
    final int overflow = entries.length - _maxChips;

    return Wrap(
      spacing: 8,
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
          Text(
            '+$overflow',
            style: const TextStyle(fontSize: 12, color: Colors.white70),
          ),
      ],
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({required this.dot, required this.label});

  final Color dot;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 28,
      padding: const EdgeInsets.symmetric(horizontal: 11),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: Colors.white.withValues(alpha: 0.14)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          StatusDot(color: dot, size: 6.5),
          const SizedBox(width: 7),
          Text(
            label,
            maxLines: 1,
            style: const TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w500,
              color: AppColors.textPrimary,
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
          color: Colors.black.withValues(alpha: 0.55),
          shape: BoxShape.circle,
          border: Border.all(color: Colors.white.withValues(alpha: 0.2)),
        ),
        child: Icon(icon, size: 22, color: AppColors.textPrimary),
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
