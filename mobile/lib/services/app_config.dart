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
}
