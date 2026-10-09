/// Build-time configuration, passed with `--dart-define`.
///
/// ```sh
/// flutter run --dart-define=GYM_PLAN_API=https://api.gymplan.example
/// ```
class AppConfig {
  const AppConfig._();

  /// Base URL of the Gym Plan backend, without a trailing slash.
  ///
  /// Defaults to a backend on this computer (`npm run dev` in `backend/`).
  /// On a real phone `localhost` is the phone itself, so set the computer's
  /// LAN address in `dev_config.json`; Android Studio's "main.dart" run
  /// configuration passes it (`--dart-define-from-file=dev_config.json`).
  /// On the Android emulator use `http://10.0.2.2:8080`.
  static const String apiBaseUrl = String.fromEnvironment(
    'GYM_PLAN_API',
    defaultValue: 'http://localhost:8080',
  );

  /// The largest floor, in metres along either side of the scanned walls'
  /// bounding box, that one scan may cover (F-04). RoomPlan drifts and
  /// slows down on very large single rooms, so past this the floor has to
  /// be scanned in sections. `--dart-define=MAX_SCAN_EXTENT_M=60`.
  static final double maxScanExtentM =
      double.tryParse(
        const String.fromEnvironment('MAX_SCAN_EXTENT_M', defaultValue: '40'),
      ) ??
      40;
}
