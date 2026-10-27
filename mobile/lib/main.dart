import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';

import 'screens/login_screen.dart';
import 'screens/startup_screen.dart';
import 'services/auth_session.dart';
import 'services/background_upload_queue.dart';
import 'services/gym_plan_api.dart';
import 'services/part_transport.dart';
import 'services/profile_service.dart';
import 'services/scan_backend.dart';
import 'services/upload_queue.dart';
import 'theme/app_theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // The session lives in the Keychain, so the app opens signed in. It is
  // restored before the upload queue starts, so an upload interrupted by
  // the app closing carries on at once, without a sign-in.
  AuthSession.instance = AuthSession(store: KeychainStore());
  await AuthSession.instance.restore();

  await _startUploads();

  // The app is dark throughout, so the status bar needs light content on both
  // platforms and the Android navigation bar needs to match the background.
  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarBrightness: Brightness.dark,
      statusBarIconBrightness: Brightness.light,
      systemNavigationBarColor: AppColors.background,
      systemNavigationBarIconBrightness: Brightness.light,
    ),
  );

  // Portrait only: the capture and sign-in flows are designed for it.
  SystemChrome.setPreferredOrientations(const <DeviceOrientation>[
    DeviceOrientation.portraitUp,
  ]);

  runApp(const FlexGymScanApp());
}

/// Starts the background upload queue before the first frame, so an upload
/// left over from the last run carries on straight away: background
/// transfers that finished while the app was closed are replayed into it.
Future<void> _startUploads() async {
  final BackgroundUploadQueue queue = BackgroundUploadQueue(
    api: GymPlanApi(),
    transport: BackgroundTransferTransport(),
    root: await getApplicationSupportDirectory(),
    uploadOnMobileData: CaptureSettings.instance.uploadOnMobileData,
  );
  UploadQueue.instance = queue;
  unawaited(queue.restore());
}

class FlexGymScanApp extends StatefulWidget {
  const FlexGymScanApp({super.key, this.session, this.deviceCheck});

  /// Defaults to [AuthSession.instance].
  final AuthSession? session;

  /// Whether this device can scan. Defaults to [ScanBackend.detect]; tests
  /// pass a canned answer to see the blocked screen.
  final DeviceCheck? deviceCheck;

  @override
  State<FlexGymScanApp> createState() => _FlexGymScanAppState();
}

class _FlexGymScanAppState extends State<FlexGymScanApp> {
  final GlobalKey<NavigatorState> _navigator = GlobalKey<NavigatorState>();
  late final AuthSession _session = widget.session ?? AuthSession.instance;
  bool _wasSignedIn = false;

  @override
  void initState() {
    super.initState();
    _wasSignedIn = _session.signedIn;
    _session.addListener(_onSessionChanged);
  }

  @override
  void dispose() {
    _session.removeListener(_onSessionChanged);
    super.dispose();
  }

  /// The session can end under the user's feet: the refresh token was
  /// revoked, or the Hub disabled the user. Wherever they are, back to
  /// sign-in.
  void _onSessionChanged() {
    final bool signedIn = _session.signedIn;
    if (_wasSignedIn && !signedIn) {
      _navigator.currentState?.pushAndRemoveUntil(
        MaterialPageRoute<void>(builder: (_) => const LoginScreen()),
        (Route<dynamic> _) => false,
      );
    }
    _wasSignedIn = signedIn;
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      navigatorKey: _navigator,
      title: 'Flex Gym Scan',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.dark,
      themeMode: ThemeMode.dark,
      darkTheme: AppTheme.dark,
      home: StartupScreen(
        session: _session,
        deviceCheck: widget.deviceCheck ?? ScanBackend.detect,
      ),
      builder: (BuildContext context, Widget? child) {
        // Keep the layout stable regardless of the device font-size setting.
        final MediaQueryData media = MediaQuery.of(context);
        return MediaQuery(
          data: media.copyWith(
            textScaler: media.textScaler.clamp(
              minScaleFactor: 0.9,
              maxScaleFactor: 1.2,
            ),
          ),
          child: child ?? const SizedBox.shrink(),
        );
      },
    );
  }
}
