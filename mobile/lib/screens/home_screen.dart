import 'dart:io';

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:room_scan/room_scan.dart';

import '../models/plan.dart';
import '../services/api_client.dart';
import '../services/auth_service.dart';
import '../services/auth_session.dart';
import '../services/capture_modes.dart';
import '../services/capture_service.dart';
import '../services/plans_service.dart';
import '../services/scan_backend.dart';
import '../services/object_uploads.dart';
import '../services/scan_library.dart';
import '../services/upload_queue.dart';
import '../theme/app_theme.dart';
import '../utils/formatting.dart';
import '../widgets/app_toast.dart';
import '../widgets/detail_widgets.dart';
import '../widgets/gym_tab_bar.dart';
import '../widgets/home_cards.dart';
import '../widgets/pressable.dart';
import 'login_screen.dart';
import 'new_capture_screen.dart';
import 'scan_viewer_screen.dart';
import 'tab_navigation.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.email});

  final String email;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  static const double _horizontalPadding = 20;

  final PlansService _plans = PlansService();

  GymTab _tab = GymTab.home;
  HomeData? _data;
  String? _error;

  /// Set while the home screen is built from the session cached on the
  /// phone because there is no signal (I-04): what the server would have
  /// said, and why it could not.
  String? _offline;

  /// Scans kept on this phone, newest first, for the dashboard grid.
  List<SavedScan> _scans = const <SavedScan>[];

  /// The "What do you want to create?" panel, until it is closed.
  bool _showCreate = true;

  @override
  void initState() {
    super.initState();
    _load();
    _loadScans();
    ScanLibrary.instance.addListener(_loadScans);
  }

  @override
  void dispose() {
    ScanLibrary.instance.removeListener(_loadScans);
    super.dispose();
  }

  Future<void> _loadScans() async {
    final List<SavedScan> scans = await ScanLibrary.instance.scans();
    if (mounted) setState(() => _scans = scans);
    _sendObjects(scans);
  }

  /// 3D Objects on their way to the platform, so a reload does not send one
  /// twice.
  static final Set<String> _sending = <String>{};

  /// Sends every 3D Object the platform does not have yet: one just made,
  /// or one kept while there was no signal. One that fails stays on the
  /// phone and is tried again the next time the dashboard loads.
  Future<void> _sendObjects(List<SavedScan> scans) async {
    for (final SavedScan scan in scans) {
      if (scan.kind != ScanKind.object ||
          scan.platformId != null ||
          scan.modelPath == null ||
          !_sending.add(scan.id)) {
        continue;
      }
      try {
        final String id = await ObjectUploads.instance.send(scan);
        await ScanLibrary.instance.markSent(scan, id);
      } catch (_) {
        // Kept on the phone; sent on a later load.
      } finally {
        _sending.remove(scan.id);
      }
    }
  }

  /// Opens a capture: the camera first, then review on the 3D model or the
  /// floor plan as chosen.
  void _startCapture(ScanView view, {String? level}) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => NewCaptureScreen(
          initialFacility: _data?.gymName,
          initialLevel: level ?? '2',
          opensIn: view,
        ),
      ),
    );
  }

  /// "3D Space": the LiDAR mesh of the whole room, after the same LiDAR
  /// check and gym loading as any capture.
  void _startSpace() {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) =>
            NewCaptureScreen(initialFacility: _data?.gymName, space: true),
      ),
    );
  }

  /// "3D Object": Apple's guided Object Capture, then a name, then it is
  /// kept and opened in the viewer.
  Future<void> _captureObject() async {
    final DeviceCapability device = await ScanBackend.detect();
    final bool supported =
        device.supported && await CaptureModes.objectCaptureSupported();
    if (!mounted) return;
    if (!supported) {
      await _sayCannot(
        'LiDAR required',
        '3D objects need an iPhone Pro (12 Pro or later) or an iPad Pro '
            'with LiDAR, on iOS 17 or later.',
      );
      return;
    }

    final ObjectCaptureResult? object;
    try {
      object = await CaptureModes.captureObject();
    } catch (e) {
      if (mounted) {
        await _sayCannot(
          'The 3D object could not be made',
          RoomScanException.from(e).message,
        );
      }
      return;
    }
    if (object == null || !mounted) return;

    final String name = await _askObjectName() ?? '3D object';
    final SavedScan? saved = await ScanLibrary.instance.saveObject(
      name,
      object,
    );
    if (saved != null && mounted) _openScan(saved);
  }

  Future<String?> _askObjectName() async {
    final TextEditingController name = TextEditingController(
      text:
          'Object ${_scans.where((SavedScan s) => s.kind == ScanKind.object).length + 1}',
    );
    final String? chosen = await showCupertinoDialog<String>(
      context: context,
      builder: (BuildContext dialogContext) => CupertinoAlertDialog(
        title: const Text('Name this object'),
        content: Padding(
          padding: const EdgeInsets.only(top: 12),
          child: CupertinoTextField(
            controller: name,
            autofocus: true,
            placeholder: 'e.g. Treadmill by the window',
            keyboardAppearance: Brightness.dark,
          ),
        ),
        actions: <Widget>[
          CupertinoDialogAction(
            isDefaultAction: true,
            onPressed: () {
              final String text = name.text.trim();
              Navigator.of(dialogContext).pop(text.isEmpty ? null : text);
            },
            child: const Text('Save'),
          ),
        ],
      ),
    );
    name.dispose();
    return chosen;
  }

  Future<void> _sayCannot(String title, String message) =>
      showCupertinoDialog<void>(
        context: context,
        builder: (BuildContext dialogContext) => CupertinoAlertDialog(
          title: Text(title),
          content: Text(message),
          actions: <Widget>[
            CupertinoDialogAction(
              isDefaultAction: true,
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: const Text('OK'),
            ),
          ],
        ),
      );

  /// The level above the highest one this gym has a plan for.
  String _nextLevel(HomeData data) {
    final Iterable<Plan> here = data.plans.where(
      (Plan p) => p.site == data.gymName,
    );
    final Iterable<Plan> plans = here.isEmpty ? data.plans : here;
    if (plans.isEmpty) return '1';
    final int top = plans
        .map((Plan p) => p.levelNumber)
        .reduce((int a, int b) => a > b ? a : b);
    return '${top + 1}';
  }

  void _openScan(SavedScan scan) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ScanViewerScreen(
          title: scan.title,
          subtitle: switch (scan) {
            SavedScan(kind: ScanKind.object, platformId: null) =>
              'Scanned ${Formatting.stamp(scan.createdAt)} · '
                  'on this phone, sent when online',
            SavedScan(kind: ScanKind.object) =>
              'Scanned ${Formatting.stamp(scan.createdAt)} · '
                  'sent to the platform',
            _ => 'Scanned ${Formatting.stamp(scan.createdAt)}',
          },
          geometry: scan.geometry,
          walls: scan.walls,
          measurements: scan.measurements,
          modelPath: scan.modelPath,
          dataPath: scan.dataPath,
        ),
      ),
    );
  }

  Future<void> _confirmRemoveScan(SavedScan scan) async {
    final bool? remove = await showCupertinoDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => CupertinoAlertDialog(
        title: const Text('Remove from this phone?'),
        content: Text(
          '${scan.title} is removed from this iPhone. The submitted plan is '
          'not affected.',
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
            child: const Text('Remove'),
          ),
        ],
      ),
    );
    if (remove == true) await ScanLibrary.instance.delete(scan);
  }

  Future<void> _load() async {
    try {
      final HomeData data = await _plans.load();
      if (!mounted) return;
      setState(() {
        _data = data;
        _error = null;
        _offline = null;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      final SignedInUser? user = AuthSession.instance.user;
      // No signal, but the session is on the phone: open anyway, so a
      // capture can still be started. The upload waits for signal.
      if (e.offline && user != null && (_data == null || _offline != null)) {
        setState(() {
          _offline = e.message;
          _data = HomeData(
            gymName: AuthSession.instance.currentAccount?.name ?? 'Gym Scan',
            userInitials: user.initials,
            plans: const [],
            pendingUploads: UploadQueue.instance.pendingCount,
          );
        });
        return;
      }
      // Keep showing what was loaded before; only an empty screen needs
      // the error in its place.
      if (_data == null) {
        setState(() => _error = e.message);
      } else {
        showAppToast(context, e.message);
      }
    }
  }

  Future<void> _retry() async {
    setState(() => _error = null);
    await _load();
  }

  void _openNewCapture() => _onSelectTab(GymTab.capture);

  void _onSelectTab(GymTab tab) {
    if (tab == GymTab.home) {
      setState(() => _tab = tab);
      return;
    }
    // The other tabs sit on top of home, so home stays on the home tab.
    openTab(context, tab, from: GymTab.home, facility: _data?.gymName);
  }

  Future<void> _openAccountSheet() async {
    final bool? signOut = await showCupertinoModalPopup<bool>(
      context: context,
      builder: (BuildContext sheetContext) => CupertinoActionSheet(
        title: Text(widget.email),
        actions: <Widget>[
          CupertinoActionSheetAction(
            onPressed: () => Navigator.of(sheetContext).pop(false),
            child: const Text('Profile'),
          ),
          CupertinoActionSheetAction(
            isDestructiveAction: true,
            onPressed: () => Navigator.of(sheetContext).pop(true),
            child: const Text('Sign out'),
          ),
        ],
        cancelButton: CupertinoActionSheetAction(
          onPressed: () => Navigator.of(sheetContext).pop(),
          child: const Text('Cancel'),
        ),
      ),
    );

    if (!mounted) return;
    if (signOut == true) {
      await AuthService().signOut();
      if (!mounted) return;
      Navigator.of(context).pushReplacement(
        MaterialPageRoute<void>(builder: (_) => const LoginScreen()),
      );
    } else if (signOut == false) {
      _onSelectTab(GymTab.profile);
    }
  }

  @override
  Widget build(BuildContext context) {
    final double bottomInset = MediaQuery.paddingOf(context).bottom;

    return Scaffold(
      backgroundColor: AppColors.background,
      body: Stack(
        children: <Widget>[
          SafeArea(
            bottom: false,
            child: _error != null
                ? ErrorView(message: _error!, onRetry: _retry)
                : _data == null
                ? _buildLoading()
                : _buildContent(bottomInset),
          ),
          Positioned(
            left: 16,
            right: 16,
            bottom: bottomInset > 0 ? bottomInset : 20,
            child: GymTabBar(current: _tab, onSelect: _onSelectTab),
          ),
        ],
      ),
    );
  }

  Widget _buildLoading() {
    return const Center(
      child: CupertinoActivityIndicator(color: AppColors.textMuted, radius: 12),
    );
  }

  Widget _buildContent(double bottomInset) {
    final HomeData data = _data!;

    return CustomScrollView(
      physics: const BouncingScrollPhysics(
        parent: AlwaysScrollableScrollPhysics(),
      ),
      slivers: <Widget>[
        CupertinoSliverRefreshControl(onRefresh: _load),
        SliverPadding(
          padding: EdgeInsets.fromLTRB(
            _horizontalPadding,
            16,
            _horizontalPadding,
            // Clear the floating tab bar plus the home indicator.
            bottomInset + 96,
          ),
          sliver: SliverList.list(
            children: <Widget>[
              _buildHeader(data),
              const SizedBox(height: 22),
              if (_showCreate) ...<Widget>[
                CreatePanel(
                  onClose: () => setState(() => _showCreate = false),
                  options: <CreateOption>[
                    CreateOption(
                      icon: Icons.grid_view_rounded,
                      label: 'Floorplan',
                      onTap: () => _startCapture(ScanView.floorPlan),
                    ),
                    CreateOption(
                      icon: Icons.view_in_ar_rounded,
                      label: '3D Space',
                      onTap: _startSpace,
                    ),
                    CreateOption(
                      icon: Icons.chair_alt_outlined,
                      label: '3D Object',
                      onTap: _captureObject,
                    ),
                    CreateOption(
                      icon: Icons.stairs_rounded,
                      label: 'Next level',
                      onTap: () => _startCapture(
                        ScanView.model,
                        level: _nextLevel(data),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 28),
              ] else ...<Widget>[
                CaptureCard(
                  subtitle: 'Walk the perimeter · about 12 min',
                  onTap: _openNewCapture,
                ),
                const SizedBox(height: 28),
              ],
              if (_scans.isNotEmpty) ...<Widget>[
                _buildScansHeader(),
                const SizedBox(height: 12),
                _buildScanGrid(),
                const SizedBox(height: 28),
              ],
              if (_offline != null)
                _OfflineNotice(message: _offline!, onRetry: _load)
              else ...<Widget>[
                _buildSectionHeader(),
                const SizedBox(height: 12),
                ..._buildPlanRows(data.plans),
              ],
              if (data.pendingUploads > 0) ...<Widget>[
                const SizedBox(height: 24),
                PendingUploadBanner(
                  count: data.pendingUploads,
                  onView: () => _onSelectTab(GymTab.uploads),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildScansHeader() {
    return const Row(
      children: <Widget>[
        Expanded(child: Text('Your scans', style: AppTheme.sectionTitle)),
        Text('Long-press to remove', style: AppTheme.caption),
      ],
    );
  }

  /// Two to a row, newest first.
  Widget _buildScanGrid() {
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints box) {
        const double gap = 14;
        final double tile = (box.maxWidth - gap) / 2;
        return Wrap(
          spacing: gap,
          runSpacing: 18,
          children: <Widget>[
            for (final SavedScan scan in _scans)
              SizedBox(
                width: tile,
                child: ScanTile(
                  title: scan.title,
                  tag: scan.kind.tag,
                  date: Formatting.day(scan.createdAt),
                  thumbnail: scan.thumbnailPath == null
                      ? null
                      : FileImage(File(scan.thumbnailPath!)),
                  onTap: () => _openScan(scan),
                  onLongPress: () => _confirmRemoveScan(scan),
                ),
              ),
          ],
        );
      },
    );
  }

  Widget _buildHeader(HomeData data) {
    return Row(
      children: <Widget>[
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                data.gymName,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: AppTheme.label,
              ),
              const SizedBox(height: 3),
              const Text('Gym Scan', style: AppTheme.screenTitle),
            ],
          ),
        ),
        const SizedBox(width: 12),
        Pressable(
          onTap: _openAccountSheet,
          haptic: HapticImpact.selection,
          semanticLabel: 'Your profile',
          child: Container(
            width: 44,
            height: 44,
            alignment: Alignment.center,
            decoration: const BoxDecoration(
              color: AppColors.avatarFill,
              shape: BoxShape.circle,
            ),
            child: Text(
              data.userInitials,
              style: const TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w600,
                color: AppColors.accent,
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildSectionHeader() {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.baseline,
      textBaseline: TextBaseline.alphabetic,
      children: <Widget>[
        const Expanded(
          child: Text('Recent plans', style: AppTheme.sectionTitle),
        ),
        Pressable(
          onTap: () => _onSelectTab(GymTab.plans),
          haptic: HapticImpact.selection,
          child: const Padding(
            padding: EdgeInsets.symmetric(vertical: 4, horizontal: 2),
            child: Text('View all', style: AppTheme.link),
          ),
        ),
      ],
    );
  }

  List<Widget> _buildPlanRows(List<Plan> plans) {
    final List<Widget> rows = <Widget>[];
    for (int i = 0; i < plans.length; i++) {
      if (i > 0) rows.add(const SizedBox(height: 10));
      rows.add(
        PlanRow(plan: plans[i], onTap: () => openPlan(context, plans[i])),
      );
    }
    return rows;
  }
}

/// Shown in place of the plan list when the app opened without signal.
class _OfflineNotice extends StatelessWidget {
  const _OfflineNotice({required this.message, required this.onRetry});

  final String message;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    return StatusCallout(
      color: AppColors.warning,
      icon: Icons.cloud_off_rounded,
      title: 'Offline',
      subtitle: message,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Text(
            'Your plans load when you are back online. You can still start '
            'a capture; it uploads once there is signal.',
            style: AppTheme.caption,
          ),
          const SizedBox(height: 10),
          Pressable(
            onTap: onRetry,
            haptic: HapticImpact.selection,
            semanticLabel: 'Try again',
            child: const Padding(
              padding: EdgeInsets.symmetric(vertical: 4),
              child: Text('Try again', style: AppTheme.link),
            ),
          ),
        ],
      ),
    );
  }
}
