import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'package:mobile/main.dart';
import 'package:mobile/screens/account_picker_screen.dart';
import 'package:mobile/screens/home_screen.dart';
import 'package:mobile/screens/login_screen.dart';
import 'package:mobile/screens/startup_screen.dart';
import 'package:mobile/services/auth_session.dart';
import 'package:mobile/services/capture_service.dart';
import 'package:mobile/services/hub_auth.dart';
import 'package:mobile/widgets/home_cards.dart';
import 'package:mobile/widgets/primary_button.dart';

import 'phone_size.dart';
import 'support/fake_backend.dart';

/// Lets the fake backend's answers arrive and the screen settle.
Future<void> _settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(seconds: 1));
  await tester.pumpAndSettle();
}

Future<void> _openApp(WidgetTester tester, {DeviceCheck? deviceCheck}) async {
  usePhoneSize(tester);
  await tester.pumpWidget(FlexGymScanApp(deviceCheck: deviceCheck));
  await _settle(tester);
}

Future<void> _signIn(WidgetTester tester) async {
  await tester.tap(find.widgetWithText(PrimaryButton, 'Sign in'));
  await _settle(tester);
}

/// A Keychain holding the session an earlier run saved.
Future<MemorySecureStore> _savedSession({
  void Function(FakeBackend backend)? configure,
}) async {
  final FakeBackend earlier = FakeBackend();
  configure?.call(earlier);
  final MemorySecureStore store = MemorySecureStore();
  final AuthSession session = AuthSession(store: store)
    ..signedInWith(earlier.tokens());
  await session.saved;
  return store;
}

Iterable<String> _paths(FakeBackend backend) =>
    backend.requests.map((http.Request r) => '${r.method} ${r.url.path}');

void main() {
  group('sign-in through the sign-in page', () {
    late ({FakeBackend backend, FakeUploadQueue uploads}) fakes;
    late MemorySecureStore keychain;
    setUp(() {
      keychain = MemorySecureStore();
      fakes = useFakeBackend(signedIn: false, store: keychain);
    });

    testWidgets('shows the brand and one sign-in button, no password', (
      WidgetTester tester,
    ) async {
      await _openApp(tester);

      expect(find.byType(LoginScreen), findsOneWidget);
      expect(find.text('GYM SCAN'), findsOneWidget);
      expect(find.widgetWithText(PrimaryButton, 'Sign in'), findsOneWidget);
      expect(find.byType(TextField), findsNothing);
      expect(find.textContaining('Password'), findsNothing);

      // The logo is an asset image, not a text placeholder.
      final Image logo = tester.widget<Image>(find.byType(Image).first);
      expect(
        (logo.image as AssetImage).assetName,
        'assets/images/flex_motion_logo.png',
      );
    });

    testWidgets('runs the PKCE flow and lands on home', (
      WidgetTester tester,
    ) async {
      await _openApp(tester);
      await _signIn(tester);

      expect(find.byType(HomeScreen), findsOneWidget);
      expect(find.text('Gym Scan'), findsOneWidget);

      // The Hub page was opened with a fresh state, nonce and S256
      // challenge, and the sheet waits for the app's scheme.
      final Uri opened = fakes.backend.webAuth.opened.single;
      expect(opened.host, 'hub.test');
      expect(fakes.backend.webAuth.callbackScheme, 'flexgymscan');
      final Map<String, String> q = opened.queryParameters;
      expect(q['response_type'], 'code');
      expect(q['client_id'], 'flex-gym-web');
      expect(q['redirect_uri'], FakeBackend.redirectUri);
      expect(q['code_challenge_method'], 'S256');
      expect(q['state'], hasLength(32));
      expect(q['nonce'], hasLength(32));
      expect(q['code_challenge'], isNot(contains('=')));

      // The code went to the backend with the matching verifier (the fake
      // backend refuses a mismatch) and the same nonce.
      final Map<String, Object?> sent = fakes.backend.hubRequest!;
      expect(sent['client'], 'ios');
      expect(sent['nonce'], q['nonce']);
      expect(sent['codeVerifier'], hasLength(64));
      expect(
        PkceAttempt.challengeFor(sent['codeVerifier']! as String),
        q['code_challenge'],
      );
      expect(sent['deviceLabel'], isNotEmpty);

      // One account: chosen without asking, and named on every call.
      expect(AuthSession.instance.currentAccountId, 'acc_northgate');
      final http.Request plans = fakes.backend.requests.firstWhere(
        (http.Request r) => r.url.path == '/v1/plans',
      );
      expect(plans.headers['X-Account-Id'], 'acc_northgate');
    });

    testWidgets('closing the sheet is not an error', (
      WidgetTester tester,
    ) async {
      fakes.backend.webAuth.cancel = true;
      await _openApp(tester);
      await _signIn(tester);

      expect(find.byType(LoginScreen), findsOneWidget);
      expect(find.byIcon(Icons.error_outline), findsNothing);
      expect(_paths(fakes.backend), isNot(contains('POST /v1/auth/hub')));
    });

    testWidgets('a callback with the wrong state is never exchanged', (
      WidgetTester tester,
    ) async {
      fakes.backend.webAuth.tamperState = true;
      await _openApp(tester);
      await _signIn(tester);

      expect(find.byType(LoginScreen), findsOneWidget);
      expect(find.textContaining('could not be confirmed'), findsOneWidget);
      expect(_paths(fakes.backend), isNot(contains('POST /v1/auth/hub')));
      expect(AuthSession.instance.signedIn, isFalse);
    });

    testWidgets('no membership at all says so', (WidgetTester tester) async {
      fakes.backend.noAccess = true;
      await _openApp(tester);
      await _signIn(tester);

      expect(find.byType(LoginScreen), findsOneWidget);
      expect(find.textContaining('no access to Flex Gym Scan'), findsOneWidget);
    });

    testWidgets('an account list with nothing in it shows "no access"', (
      WidgetTester tester,
    ) async {
      fakes.backend.accounts.clear();
      await _openApp(tester);
      await _signIn(tester);

      expect(find.byType(NoAccessScreen), findsOneWidget);
      expect(find.text('No gym access yet'), findsOneWidget);
      expect(find.text('Sign out'), findsOneWidget);
    });

    testWidgets('several accounts: pick one, and it is sent and kept', (
      WidgetTester tester,
    ) async {
      fakes.backend.accounts.add(FakeBackend.riverside);
      await _openApp(tester);
      await _signIn(tester);

      expect(find.byType(AccountPickerScreen), findsOneWidget);
      expect(find.text('Northgate Group'), findsOneWidget);
      expect(find.text('Riverside Leisure'), findsOneWidget);
      expect(_paths(fakes.backend), isNot(contains('GET /v1/plans')));

      await tester.tap(find.text('Riverside Leisure'));
      await _settle(tester);

      expect(find.byType(HomeScreen), findsOneWidget);
      expect(find.text('Riverside Gym'), findsOneWidget);
      for (final http.Request r in fakes.backend.requests.where(
        (http.Request r) => r.url.path.startsWith('/v1/plans'),
      )) {
        expect(r.headers['X-Account-Id'], 'acc_riverside');
      }
      await AuthSession.instance.saved;
      final AuthSession relaunched = AuthSession(store: keychain);
      await relaunched.restore();
      expect(relaunched.currentAccountId, 'acc_riverside');
    });
  });

  group('session in the Keychain', () {
    testWidgets('a relaunch opens signed in, without the Hub', (
      WidgetTester tester,
    ) async {
      final MemorySecureStore store = await _savedSession();
      final fakes = useFakeBackend(signedIn: false, store: store);

      await _openApp(tester);

      expect(find.byType(HomeScreen), findsOneWidget);
      expect(fakes.backend.webAuth.opened, isEmpty);
      expect(AuthSession.instance.user!.name, 'Sam Okafor');
    });

    testWidgets('an expired token is refreshed and the new one kept', (
      WidgetTester tester,
    ) async {
      final MemorySecureStore store = await _savedSession();
      final fakes = useFakeBackend(
        signedIn: false,
        store: store,
        configure: (FakeBackend b) => b.accessToken = 'access-token-2',
      );

      await _openApp(tester);

      expect(find.byType(HomeScreen), findsOneWidget);
      expect(_paths(fakes.backend), contains('POST /v1/auth/refresh'));
      await AuthSession.instance.saved;
      // The rotated pair replaced the old one, so the next launch does not
      // reuse a spent refresh token.
      expect(store.values['flex.refreshToken'], 'refresh-token-1');
      expect(store.values['flex.accessToken'], 'access-token-2');
    });

    testWidgets('a revoked session signs the phone out', (
      WidgetTester tester,
    ) async {
      final MemorySecureStore store = await _savedSession();
      useFakeBackend(
        signedIn: false,
        store: store,
        configure: (FakeBackend b) {
          b.accessToken = 'access-token-2';
          b.refreshRevoked = true;
        },
      );

      await _openApp(tester);
      await _settle(tester);

      expect(find.byType(LoginScreen), findsOneWidget);
      expect(AuthSession.instance.signedIn, isFalse);
      await AuthSession.instance.saved;
      expect(store.values, isEmpty);
    });

    testWidgets('with no signal it still opens, ready to capture', (
      WidgetTester tester,
    ) async {
      final MemorySecureStore store = await _savedSession();
      final fakes = useFakeBackend(signedIn: false, store: store);
      fakes.backend.offline = true;

      await _openApp(tester);

      expect(find.byType(HomeScreen), findsOneWidget);
      expect(find.text('Offline'), findsOneWidget);
      expect(find.byType(CaptureCard), findsOneWidget);
      // The header comes from the cached session.
      expect(find.text('Northgate Group'), findsOneWidget);
      expect(find.text('SO'), findsOneWidget);
      expect(AuthSession.instance.signedIn, isTrue);
    });
  });

  group('device check at launch', () {
    setUp(() => useFakeBackend(signedIn: false));

    testWidgets('a phone without LiDAR is stopped on the first screen', (
      WidgetTester tester,
    ) async {
      await _openApp(
        tester,
        deviceCheck: () async => const DeviceCapability(
          supported: false,
          headline: 'Cannot scan on this device',
          detail: 'iPhone · This device has no LiDAR sensor.',
        ),
      );

      expect(find.byType(LidarRequiredScreen), findsOneWidget);
      expect(find.text('This app needs an iPhone with LiDAR'), findsOneWidget);
      expect(find.byType(LoginScreen), findsNothing);

      // Debug builds may carry on with the simulated scan.
      await tester.tap(find.text('Continue with the simulated scan (debug)'));
      await _settle(tester);
      expect(find.byType(LoginScreen), findsOneWidget);
    });
  });
}
