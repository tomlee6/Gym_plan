import 'dart:async';

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:room_scan/room_scan.dart';

import '../models/room_measurements.dart';
import '../models/scan.dart';
import '../services/capture_modes.dart';
import '../services/capture_service.dart';
import '../services/scan_library.dart';
import '../services/upload_queue.dart';
import '../theme/app_theme.dart';
import '../widgets/app_toast.dart';
import '../widgets/capture_fields.dart';
import '../widgets/detail_widgets.dart';
import '../widgets/hairline_container.dart';
import '../widgets/nav_bar.dart';
import '../widgets/pressable.dart';
import '../widgets/primary_button.dart';
import 'scan_viewer_screen.dart';
import 'uploading_screen.dart';

/// "3D Space", Polycam style: the whole room as a coloured LiDAR mesh.
///
/// The camera is live at once; the capture button starts meshing, and a
/// see-through purple mesh forms over everything the LiDAR sees as the
/// surveyor walks. Finishing colours the mesh from the camera and opens
/// [MeshReviewScreen].
class MeshScanScreen extends StatefulWidget {
  const MeshScanScreen({
    super.key,
    required this.config,
    this.facilities,
    this.scanning,
  });

  /// Facility and level to start with; confirmed on review.
  final ScanConfig config;
  final FacilityList? facilities;

  /// Drives the scan. Defaults to the native mesh scanner.
  final MeshScanning? scanning;

  @override
  State<MeshScanScreen> createState() => _MeshScanScreenState();
}

class _MeshScanScreenState extends State<MeshScanScreen> {
  late final MeshScanning _scan =
      widget.scanning ?? CaptureModes.meshScanning();

  bool _ready = false;
  bool _started = false;
  bool _processing = false;
  bool _done = false;
  String? _error;
  MeshScanStatus _status = MeshScanStatus.empty;
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    _prepare();
  }

  @override
  void dispose() {
    _poll?.cancel();
    if (!_done) unawaited(_scan.cancel().catchError((Object _) {}));
    super.dispose();
  }

  Future<void> _prepare() async {
    try {
      await _scan.prepare();
      if (mounted) setState(() => _ready = true);
    } catch (e) {
      if (mounted) setState(() => _error = RoomScanException.from(e).message);
    }
  }

  Future<void> _begin() async {
    try {
      await _scan.start();
    } catch (e) {
      if (mounted) setState(() => _error = RoomScanException.from(e).message);
      return;
    }
    if (!mounted) return;
    setState(() => _started = true);
    _poll = Timer.periodic(const Duration(milliseconds: 500), (_) async {
      final MeshScanStatus status = await _scan.status();
      if (mounted) setState(() => _status = status);
    });
  }

  Future<void> _finish() async {
    _poll?.cancel();
    setState(() => _processing = true);
    final MeshScanExport export;
    try {
      export = await _scan.finish();
    } catch (e) {
      if (!mounted) return;
      setState(() => _processing = false);
      await showCupertinoDialog<void>(
        context: context,
        builder: (BuildContext dialogContext) => CupertinoAlertDialog(
          title: const Text('The 3D space could not be built'),
          content: Text(RoomScanException.from(e).message),
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
      return;
    }
    _done = true;
    if (!mounted) return;
    Navigator.of(context).pushReplacement(
      MaterialPageRoute<void>(
        builder: (_) => MeshReviewScreen(
          config: widget.config,
          facilities: widget.facilities,
          export: export,
        ),
      ),
    );
  }

  Future<void> _close() async {
    if (!_started) {
      Navigator.of(context).pop();
      return;
    }
    final bool? discard = await showCupertinoDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => CupertinoAlertDialog(
        title: const Text('Discard this 3D space?'),
        content: const Text('What has been scanned so far will be lost.'),
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
    if (discard == true && mounted) Navigator.of(context).pop();
  }

  String get _hint {
    if (_error != null) return _error!;
    if (!_ready) return 'Starting the camera…';
    if (!_started) {
      return 'Point the camera at the room and tap the button to start. '
          'Then walk slowly, covering floor, walls and objects.';
    }
    if (_status.limitedTracking) {
      return 'Slow down: the camera is losing track. Point at something '
          'with more detail.';
    }
    return 'Walk slowly round the room. The purple mesh shows what is '
        'captured; fill in the gaps.';
  }

  @override
  Widget build(BuildContext context) {
    final Duration t = _status.elapsed;
    final String clock =
        '${t.inMinutes.toString().padLeft(2, '0')}:'
        '${(t.inSeconds % 60).toString().padLeft(2, '0')}';

    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (bool didPop, Object? _) {
        if (!didPop && !_processing) _close();
      },
      child: Scaffold(
        backgroundColor: Colors.black,
        body: Stack(
          children: <Widget>[
            const Positioned.fill(child: MeshScanPreview()),
            SafeArea(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 6, 16, 12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    Row(
                      children: <Widget>[
                        _Pill(
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: <Widget>[
                              StatusDot(
                                color: _started
                                    ? AppColors.danger
                                    : AppColors.textMuted,
                                size: 8,
                              ),
                              const SizedBox(width: 8),
                              Text(clock, style: _pillText),
                            ],
                          ),
                        ),
                        if (_started) ...<Widget>[
                          const SizedBox(width: 8),
                          _Pill(
                            child: Text(
                              '${_formatPoints(_status.vertices)} points',
                              style: _pillText,
                            ),
                          ),
                        ],
                        const Spacer(),
                        Pressable(
                          onTap: _close,
                          semanticLabel: 'Close',
                          haptic: HapticImpact.selection,
                          child: const _Pill(
                            padding: EdgeInsets.all(10),
                            child: Icon(
                              CupertinoIcons.xmark,
                              size: 16,
                              color: AppColors.textPrimary,
                            ),
                          ),
                        ),
                      ],
                    ),
                    const Spacer(),
                    _Pill(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 14,
                        vertical: 11,
                      ),
                      child: Row(
                        children: <Widget>[
                          const Icon(
                            Icons.view_in_ar_rounded,
                            size: 18,
                            color: AppColors.accent,
                          ),
                          const SizedBox(width: 11),
                          Expanded(
                            child: Text(
                              _hint,
                              style: AppTheme.caption.copyWith(
                                color: Colors.white70,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 16),
                    Center(
                      child: _CaptureButton(
                        started: _started,
                        onTap: !_ready || _error != null
                            ? null
                            : (_started ? _finish : _begin),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            if (_processing)
              Positioned.fill(
                child: ColoredBox(
                  color: Colors.black.withValues(alpha: 0.8),
                  child: const Center(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        CupertinoActivityIndicator(
                          radius: 14,
                          color: Colors.white,
                        ),
                        SizedBox(height: 16),
                        Text(
                          'Building your 3D space…',
                          style: TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w600,
                            color: AppColors.textPrimary,
                          ),
                        ),
                        SizedBox(height: 6),
                        Text(
                          'Colouring the mesh from the camera',
                          style: AppTheme.caption,
                        ),
                      ],
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  static String _formatPoints(int n) => n >= 1000000
      ? '${(n / 1000000).toStringAsFixed(1)}M'
      : n >= 1000
      ? '${(n / 1000).round()}k'
      : '$n';
}

const TextStyle _pillText = TextStyle(
  fontSize: 14,
  fontWeight: FontWeight.w600,
  fontFeatures: <FontFeature>[FontFeature.tabularFigures()],
  color: AppColors.textPrimary,
);

class _Pill extends StatelessWidget {
  const _Pill({
    required this.child,
    this.padding = const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
  });

  final Widget child;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: padding,
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: Colors.white.withValues(alpha: 0.14)),
      ),
      child: child,
    );
  }
}

/// A red circle to start, a red square to finish.
class _CaptureButton extends StatelessWidget {
  const _CaptureButton({required this.started, required this.onTap});

  final bool started;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Pressable(
      key: ValueKey<String>(started ? 'finish-space' : 'start-space'),
      onTap: onTap,
      semanticLabel: started ? 'Finish 3D space' : 'Start 3D space',
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
            width: started ? 32 : 58,
            height: started ? 32 : 58,
            decoration: BoxDecoration(
              color: AppColors.danger,
              borderRadius: BorderRadius.circular(started ? 8 : 29),
            ),
          ),
        ),
      ),
    );
  }
}

/// A finished 3D Space before it is submitted: the coloured mesh to turn,
/// zoom and measure, its size, and the facility and level it belongs to.
/// Submitting sends the mesh with a capture (the reviewer traces the plan
/// over it) and keeps it in "Your scans".
class MeshReviewScreen extends StatefulWidget {
  const MeshReviewScreen({
    super.key,
    required this.config,
    required this.export,
    this.facilities,
  });

  final ScanConfig config;
  final MeshScanExport export;
  final FacilityList? facilities;

  @override
  State<MeshReviewScreen> createState() => _MeshReviewScreenState();
}

class _MeshReviewScreenState extends State<MeshReviewScreen> {
  late Facility _facility = Facility(
    id: widget.config.facilityId,
    name: widget.config.facility,
  );
  late final TextEditingController _level = TextEditingController(
    text: '${widget.config.level}',
  );
  String? _levelError;
  bool _submitting = false;

  @override
  void dispose() {
    _level.dispose();
    super.dispose();
  }

  List<Facility> get _facilities {
    final List<Facility> all =
        widget.facilities?.facilities ?? const <Facility>[];
    return all.contains(_facility) ? all : <Facility>[_facility, ...all];
  }

  RoomMeasurements get _measurements => RoomMeasurements(
    wallCount: 0,
    widthM: widget.export.widthM,
    lengthM: widget.export.lengthM,
    heightM: widget.export.heightM,
  );

  void _openFullScreen() {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ScanViewerScreen(
          title: '${widget.config.shortTitle} · 3D Space',
          subtitle: 'Not submitted yet',
          geometry: PlanGeometry.fitted(walls: const <WallSegment>[]),
          walls: const <WallQuality>[],
          measurements: _measurements,
          modelPath: widget.export.scenePath,
        ),
      ),
    );
  }

  Future<void> _submit() async {
    FocusScope.of(context).unfocus();
    final int? level = int.tryParse(_level.text.trim());
    setState(() => _levelError = level == null ? 'Enter the level.' : null);
    if (level == null) return;
    setState(() => _submitting = true);

    final ScanConfig config = ScanConfig(
      accountId: widget.config.accountId,
      facilityId: _facility.id,
      facility: _facility.name,
      level: level,
      heightM: widget.config.heightM,
    );
    // Kept on the phone for the dashboard, whatever happens to the upload.
    await ScanLibrary.instance.saveSpace(config, widget.export);

    try {
      // A capture with the mesh and no RoomPlan room. The platform takes a
      // mesh in place of the room model; the reviewer traces the walls over
      // it, and the server finds machines in it (backend reading.js).
      await UploadQueue.instance.enqueue(
        ScanResult(
          config: config,
          geometry: PlanGeometry.fitted(walls: const <WallSegment>[]),
          coverage: 0,
          closed: false,
          walls: const <WallQuality>[],
          tags: const <ScanTag>[],
          photos: 0,
          elapsed: widget.export.duration,
        ),
        meshPath: widget.export.objPath,
      );
    } catch (_) {
      if (!mounted) return;
      setState(() => _submitting = false);
      showAppToast(context, 'The 3D space could not be queued. Try again.');
      return;
    }
    if (!mounted) return;
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute<void>(builder: (_) => const UploadingScreen()),
      (Route<dynamic> route) => route.isFirst,
    );
  }

  Future<void> _discard() async {
    final bool? discard = await showCupertinoDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => CupertinoAlertDialog(
        title: const Text('Discard this 3D space?'),
        content: const Text('It has not been submitted and will be lost.'),
        actions: <Widget>[
          CupertinoDialogAction(
            isDefaultAction: true,
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Cancel'),
          ),
          CupertinoDialogAction(
            isDestructiveAction: true,
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Discard'),
          ),
        ],
      ),
    );
    if (discard == true && mounted) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (bool didPop, Object? _) {
        if (!didPop && !_submitting) _discard();
      },
      child: Scaffold(
        backgroundColor: AppColors.background,
        body: SafeArea(
          child: Column(
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.only(left: 8, right: 12),
                child: NavBar(backLabel: 'Discard', onBack: _discard),
              ),
              Expanded(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(20, 6, 20, 16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                      DetailHeader(
                        title: 'Your 3D space',
                        subtitle:
                            '${_facility.name} · '
                            '${_MeshScanScreenState._formatPoints(widget.export.vertexCount)} mesh points',
                      ),
                      const SizedBox(height: 18),
                      HairlineContainer(
                        radius: 19,
                        fillColor: AppColors.planCanvas,
                        padding: const EdgeInsets.all(6),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: <Widget>[
                            Align(
                              alignment: Alignment.centerRight,
                              child: IconButton(
                                onPressed: _openFullScreen,
                                tooltip: 'Open full screen',
                                icon: const Icon(
                                  Icons.open_in_full_rounded,
                                  size: 19,
                                  color: AppColors.textMuted,
                                ),
                              ),
                            ),
                            ClipRRect(
                              borderRadius: BorderRadius.circular(14),
                              child: SizedBox(
                                height: 340,
                                child: ScanModelPreview(
                                  modelPath: widget.export.scenePath,
                                ),
                              ),
                            ),
                            Padding(
                              padding: const EdgeInsets.fromLTRB(6, 10, 6, 6),
                              child: MeasurementChips(
                                measurements: _measurements,
                              ),
                            ),
                            const Padding(
                              padding: EdgeInsets.fromLTRB(8, 2, 8, 4),
                              child: Text(
                                'Drag to turn, pinch to zoom. Open it full '
                                'screen to measure between any two points.',
                                style: AppTheme.caption,
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 16),
                      HairlineContainer(
                        radius: 17,
                        padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: <Widget>[
                            LabelledField(
                              label: 'Facility',
                              child: PickerField(
                                icon: Icons.home_work_outlined,
                                value: _facility.name,
                                options: <String>[
                                  for (final Facility f in _facilities) f.name,
                                ],
                                onChanged: (String name) => setState(
                                  () => _facility = _facilities.firstWhere(
                                    (Facility f) => f.name == name,
                                  ),
                                ),
                              ),
                            ),
                            const SizedBox(height: 14),
                            LabelledField(
                              label: 'Level',
                              errorText: _levelError,
                              child: NumericField(
                                controller: _level,
                                hasError: _levelError != null,
                                semanticLabel: 'Level',
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 12),
                      const Text(
                        'Submitted with the level, the mesh goes to a reviewer, '
                        'who traces the floor plan over it.',
                        style: AppTheme.footnote,
                      ),
                    ],
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 20),
                child: PrimaryButton(
                  label: 'Submit 3D space',
                  busy: _submitting,
                  onPressed: _submit,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
