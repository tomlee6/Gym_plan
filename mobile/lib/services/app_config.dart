/// Build-time configuration, passed with `--dart-define`.
///
/// ```sh
/// flutter run --dart-define=GYM_PLAN_API=https://api.gym.goal-cert.com
/// ```
class AppConfig {
  const AppConfig._();

  /// Base URL of the Gym Plan backend, without a trailing slash.
  ///
  /// Defaults to the deployed backend. `dev_config.json` names the same
  /// URL; Android Studio's "main.dart" run configuration passes it
  /// (`--dart-define-from-file=dev_config.json`).
  static const String apiBaseUrl = String.fromEnvironment(
    'GYM_PLAN_API',
    defaultValue: 'https://api.gym.goal-cert.com',
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
