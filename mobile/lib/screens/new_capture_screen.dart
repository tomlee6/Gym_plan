import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import '../models/scan.dart';
import '../services/api_client.dart';
import '../services/auth_session.dart';
import '../services/capture_service.dart';
import '../theme/app_theme.dart';
import '../widgets/detail_widgets.dart';
import '../widgets/nav_bar.dart';
import 'scan_viewer_screen.dart';
import 'mesh_scan_screen.dart';
import 'scanning_screen.dart';

/// Opens the camera straight away, Polycam style; the scan starts when the
/// surveyor taps the capture button.
///
/// It checks for LiDAR first and, without it, says so and goes back. Then
/// it only waits for the account's facilities. The
/// facility, level and floor-to-floor height are confirmed on the review
/// screen after the walk; the scan starts with the gym the user was looking
/// at, [initialLevel] and [defaultHeightM] filled in.
class NewCaptureScreen extends StatefulWidget {
  const NewCaptureScreen({
    super.key,
    this.initialFacility,
    this.initialLevel = '2',
    this.captureService,
    this.opensIn = ScanView.model,
    this.space = false,
  });

  /// "3D Space": a LiDAR mesh of the whole room rather than the
  /// floor-plan scan. Same checks first; then the mesh scan opens.
  final bool space;

  /// Pre-selects the gym, by name, the user was last looking at.
  final String? initialFacility;

  /// Prefills the level, e.g. the next floor up or the level to recapture.
  final String initialLevel;

  /// Injectable so tests can drive the unsupported-device path.
  final CaptureService? captureService;

  /// Whether the finished floor-plan scan opens on its 3D model or its
  /// floor plan.
  final ScanView opensIn;

  /// The floor-to-floor height a scan starts with, until the surveyor sets
  /// it on the review screen.
  static const double defaultHeightM = 3.20;

  @override
  State<NewCaptureScreen> createState() => _NewCaptureScreenState();
}

class _NewCaptureScreenState extends State<NewCaptureScreen> {
  late final CaptureService _service =
      widget.captureService ?? CaptureService();

  DeviceCapability? _unsupported;
  String? _loadError;
  bool _noFacilities = false;

  @override
  void initState() {
    super.initState();
    _loadAndStart();
  }

  Future<void> _loadAndStart() async {
    setState(() {
      _loadError = null;
      _noFacilities = false;
      _unsupported = null;
    });

    // LiDAR first: without it nothing past this point can work, so the
    // surveyor is told at once and sent back, before anything is loaded.
    final DeviceCapability device;
    try {
      device = await _service.checkDevice();
    } catch (_) {
      if (mounted) {
        setState(() => _loadError = 'The LiDAR check could not run.');
      }
      return;
    }
    if (!mounted) return;
    if (!device.supported) {
      setState(() => _unsupported = device);
      await _sayNoLidar(device);
      return;
    }

    final FacilityList list;
    try {
      list = await _service.facilities();
    } on ApiException catch (e) {
      if (mounted) setState(() => _loadError = e.message);
      return;
    } catch (_) {
      // Anything unexpected still ends the spinner with a way to retry.
      if (mounted) {
        setState(() => _loadError = 'The capture could not be started.');
      }
      return;
    }
    if (!mounted) return;

    // A new account has no gyms until its admin adds one; there is nothing
    // to capture against, so say so rather than wait.
    if (list.facilities.isEmpty) {
      setState(() => _noFacilities = true);
      return;
    }

    Facility? named(String? name) =>
        list.facilities.where((Facility f) => f.name == name).firstOrNull;
    Facility? byId(String? id) =>
        list.facilities.where((Facility f) => f.id == id).firstOrNull;

    // The gym passed in if the user can pick it, else their default.
    final Facility facility =
        named(widget.initialFacility) ??
        byId(list.defaultId) ??
        list.facilities.first;

    Navigator.of(context).pushReplacement(
      PageRouteBuilder<void>(
        transitionDuration: const Duration(milliseconds: 250),
        pageBuilder: (_, _, _) {
          final ScanConfig config = ScanConfig(
            // The account the capture belongs to, kept with it so the
            // upload goes to the right account even after a switch.
            accountId: AuthSession.instance.currentAccountId,
            facilityId: facility.id,
            facility: facility.name,
            level: int.tryParse(widget.initialLevel) ?? 1,
            heightM: NewCaptureScreen.defaultHeightM,
          );
          return widget.space
              ? MeshScanScreen(config: config, facilities: list)
              : ScanningScreen(
                  config: config,
                  facilities: list,
                  opensIn: widget.opensIn,
                );
        },
        transitionsBuilder: (_, Animation<double> animation, _, Widget child) =>
            FadeTransition(opacity: animation, child: child),
      ),
    );
  }

  /// "This device doesn't have LiDAR": scanning cannot go on, so OK goes
  /// back to where New capture was opened from.
  Future<void> _sayNoLidar(DeviceCapability device) async {
    await showCupertinoDialog<void>(
      context: context,
      builder: (BuildContext dialogContext) => CupertinoAlertDialog(
        title: const Text('LiDAR required'),
        content: Text(
          'This device doesn\'t have a LiDAR sensor, so it can\'t scan a '
          'floor. Use an iPhone Pro (12 Pro or later) or an iPad Pro with '
          'LiDAR.\n\n${device.detail}',
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
    if (mounted) Navigator.of(context).maybePop();
  }

  @override
  Widget build(BuildContext context) {
    final bool waiting =
        _loadError == null && !_noFacilities && _unsupported == null;

    return Scaffold(
      // Black while the camera spins up, so the hand-off to the scan is
      // seamless.
      backgroundColor: waiting ? Colors.black : AppColors.background,
      body: SafeArea(
        child: Column(
          children: <Widget>[
            Padding(
              padding: const EdgeInsets.only(left: 8, right: 12),
              child: NavBar(
                backLabel: 'Home',
                onBack: () => Navigator.of(context).maybePop(),
              ),
            ),
            Expanded(
              child: _loadError != null
                  ? ErrorView(message: _loadError!, onRetry: _loadAndStart)
                  : _noFacilities
                  ? ErrorView(
                      icon: Icons.store_mall_directory_outlined,
                      title: 'No facility available',
                      message:
                          'Your account has no gyms to capture yet. Ask '
                          'your account admin to add one, then try again.',
                      onRetry: _loadAndStart,
                    )
                  : _unsupported != null
                  ? ErrorView(
                      icon: Icons.sensors_off_rounded,
                      title: _unsupported!.headline,
                      message: _unsupported!.detail,
                      onRetry: _loadAndStart,
                    )
                  : _buildStarting(),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildStarting() {
    return const Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          CupertinoActivityIndicator(color: Colors.white70, radius: 12),
          SizedBox(height: 14),
          Text('Starting camera…', style: AppTheme.caption),
        ],
      ),
    );
  }
}
