import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../services/auth_session.dart';
import '../services/capture_service.dart';
import '../theme/app_theme.dart';
import '../widgets/brand_header.dart';
import '../widgets/detail_widgets.dart';
import 'session_routes.dart';

/// Asks whether this handset can scan. The app passes `ScanBackend.detect`.
typedef DeviceCheck = Future<DeviceCapability> Function();

/// What the app shows first: it restores the Keychain session and checks
/// the device, then hands over to sign-in, the account picker or home.
///
/// Neither step needs the network, so with no signal at all the app still
/// opens signed in (I-04). A device that cannot scan is stopped here,
/// before anyone signs in (I-03, APP-01): without LiDAR a capture would be
/// worthless, so it is better to say so on the first screen than at the
/// end of the setup form.
class StartupScreen extends StatefulWidget {
  const StartupScreen({
    super.key,
    required this.session,
    required this.deviceCheck,
  });

  final AuthSession session;
  final DeviceCheck deviceCheck;

  @override
  State<StartupScreen> createState() => _StartupScreenState();
}

class _StartupScreenState extends State<StartupScreen> {
  DeviceCapability? _blocked;
  Widget? _next;

  @override
  void initState() {
    super.initState();
    _start();
  }

  Future<void> _start() async {
    DeviceCapability device;
    try {
      final (_, DeviceCapability d) = await (
        widget.session.restore(),
        widget.deviceCheck(),
      ).wait;
      device = d;
    } catch (_) {
      // A check that fails outright is treated as "cannot scan" in release
      // builds, the same as a device without the sensor.
      device = const DeviceCapability(
        supported: false,
        headline: 'Cannot scan on this device',
        detail: 'The LiDAR check could not run.',
      );
      await widget.session.restore();
    }
    if (!mounted) return;
    setState(() {
      if (device.supported) {
        _next = screenForSession(widget.session);
      } else {
        _blocked = device;
      }
    });
  }

  /// Debug builds only: carry on with the simulated scan, so the flow can
  /// still be worked through on a simulator.
  void _continueAnyway() =>
      setState(() => _next = screenForSession(widget.session));

  @override
  Widget build(BuildContext context) {
    if (_next != null) return _next!;
    if (_blocked != null) {
      return LidarRequiredScreen(
        detail: _blocked!.detail,
        onContinueAnyway: kDebugMode ? _continueAnyway : null,
      );
    }
    // Restoring takes a moment at most; match the launch screen meanwhile.
    return const Scaffold(
      backgroundColor: AppColors.background,
      body: Center(child: BrandHeader()),
    );
  }
}

/// "This app needs an iPhone with LiDAR" (APP-01). Nothing past it works
/// without the sensor, so there is no way on in a release build.
class LidarRequiredScreen extends StatelessWidget {
  const LidarRequiredScreen({
    super.key,
    required this.detail,
    this.onContinueAnyway,
  });

  /// What the check found, e.g. "iPhone · This device has no LiDAR sensor."
  final String detail;

  /// Debug builds only.
  final VoidCallback? onContinueAnyway;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(32, 48, 32, 32),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              const Center(child: BrandHeader()),
              const Spacer(),
              const Icon(
                Icons.sensors_off_rounded,
                size: 44,
                color: AppColors.warning,
              ),
              const SizedBox(height: 16),
              const Text(
                'This app needs an iPhone with LiDAR',
                textAlign: TextAlign.center,
                style: AppTheme.title,
              ),
              const SizedBox(height: 10),
              const Text(
                'Gym Scan maps the floor with the LiDAR sensor, found on '
                'iPhone 12 Pro and later Pro models and on iPad Pro, running '
                'iOS 17 or later. Open the app on one of those to scan.',
                textAlign: TextAlign.center,
                style: AppTheme.body,
              ),
              const SizedBox(height: 14),
              Text(
                detail,
                textAlign: TextAlign.center,
                style: AppTheme.caption,
              ),
              const Spacer(),
              if (onContinueAnyway != null)
                SecondaryAction(
                  label: 'Continue with the simulated scan (debug)',
                  onTap: onContinueAnyway!,
                ),
            ],
          ),
        ),
      ),
    );
  }
}
