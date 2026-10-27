import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:mobile/screens/home_screen.dart';
import 'package:mobile/screens/login_screen.dart';
import 'package:mobile/screens/uploading_screen.dart';
import 'package:mobile/services/auth_session.dart';
import 'package:mobile/services/upload_queue.dart';
import 'package:mobile/utils/formatting.dart';
import 'package:mobile/screens/plans_screen.dart';
import 'package:mobile/screens/profile_screen.dart';
import 'package:mobile/theme/app_theme.dart';
import 'package:mobile/widgets/gym_tab_bar.dart';
import 'package:mobile/widgets/home_cards.dart';

import 'support/fake_backend.dart';

Widget _wrap() => MaterialApp(
  theme: AppTheme.dark,
  home: const HomeScreen(email: 'sam.okafor@northgatefitness.com'),
);

/// Lets the fake backend's answers arrive and the screen settle.
Future<void> _settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(seconds: 1));
  await tester.pumpAndSettle();
}

void main() {
  late ({FakeBackend backend, FakeUploadQueue uploads}) fakes;
  setUp(() => fakes = useFakeBackend());

  testWidgets('shows a loading indicator, then the gym header', (
    WidgetTester tester,
  ) async {
    // The first frame, before the backend has answered.
    await tester.pumpWidget(_wrap());

    expect(find.text('Gym Scan'), findsNothing);

    await _settle(tester);

    expect(find.text('Northgate Fitness'), findsOneWidget);
    expect(find.text('Gym Scan'), findsOneWidget);
    expect(find.text('SO'), findsOneWidget);
  });

  testWidgets('renders the capture card and every plan row', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_wrap());
    await _settle(tester);

    expect(find.byType(CaptureCard), findsOneWidget);
    expect(find.text('New capture'), findsOneWidget);

    // The three most recently changed plans, as the API orders them.
    expect(find.byType(PlanRow), findsNWidgets(3));
    expect(find.text('Riverside Gym · Level 1'), findsOneWidget);
    expect(find.text('Northgate Fitness · Level 3'), findsOneWidget);
    expect(find.text('Northgate Fitness · Level 2'), findsOneWidget);

    // One pill per status, and a detail line built from the timestamps.
    expect(find.text('Processing'), findsOneWidget);
    expect(find.text('Uploading'), findsOneWidget);
    expect(find.text('In review'), findsOneWidget);
    expect(
      find.text(
        'With a reviewer since '
        '${Formatting.time(fakes.backend.reviewStartedNg2)}',
      ),
      findsOneWidget,
    );
    // Asked for with a limit, not the whole list.
    expect(
      fakes.backend.requests.map((r) => r.url.toString()),
      contains('https://api.test/v1/plans?limit=3'),
    );
  });

  testWidgets('pending uploads banner reflects the queue on this phone', (
    WidgetTester tester,
  ) async {
    fakes.uploads.job = UploadJob(
      id: 'j1',
      title: 'Northgate · Level 3',
      facility: 'Northgate Fitness',
      level: 3,
      totalMb: 12,
    );
    await tester.pumpWidget(_wrap());
    await _settle(tester);

    expect(find.byType(PendingUploadBanner), findsOneWidget);
    expect(find.text('1 capture waiting to upload'), findsOneWidget);
  });

  testWidgets('no banner when nothing is waiting', (WidgetTester tester) async {
    await tester.pumpWidget(_wrap());
    await _settle(tester);
    expect(find.byType(PendingUploadBanner), findsNothing);
  });

  testWidgets('offline: says so, and loads on retry', (
    WidgetTester tester,
  ) async {
    fakes.backend.offline = true;
    await tester.pumpWidget(_wrap());
    await _settle(tester);

    expect(find.text('No connection. Check your signal.'), findsOneWidget);
    expect(find.byType(PlanRow), findsNothing);
    // Signed in from the phone's copy of the session, so a capture can
    // still be started (I-04).
    expect(find.byType(CaptureCard), findsOneWidget);
    expect(find.text('Northgate Group'), findsOneWidget);

    fakes.backend.offline = false;
    await tester.tap(find.text('Try again'));
    await _settle(tester);
    expect(find.byType(PlanRow), findsNWidgets(3));
  });

  testWidgets('tab bar renders five destinations with home selected', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_wrap());
    await _settle(tester);

    expect(find.byType(GymTabBar), findsOneWidget);
    final GymTabBar bar = tester.widget<GymTabBar>(find.byType(GymTabBar));
    expect(bar.current, GymTab.home);
    expect(GymTab.values.length, 5);
  });

  testWidgets('"View all" opens my plans', (WidgetTester tester) async {
    await tester.pumpWidget(_wrap());
    await _settle(tester);

    await tester.tap(find.text('View all'));
    await _settle(tester);

    expect(find.byType(PlansScreen), findsOneWidget);
    expect(find.text('My plans'), findsOneWidget);
  });

  testWidgets('a plan that is in review explains itself instead of no-op', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_wrap());
    await _settle(tester);

    await tester.tap(find.text('Northgate Fitness · Level 2'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('A reviewer is checking this plan.'), findsOneWidget);

    // Let the toast time out so it tears itself down.
    await tester.pump(const Duration(seconds: 2));
    await tester.pumpAndSettle();
    expect(find.text('A reviewer is checking this plan.'), findsNothing);
  });

  testWidgets('an uploading plan opens the upload screen', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_wrap());
    await _settle(tester);

    await tester.tap(find.text('Northgate Fitness · Level 3'));
    await _settle(tester);

    expect(find.byType(UploadingScreen), findsOneWidget);
  });

  testWidgets('profile tab opens the profile', (WidgetTester tester) async {
    await tester.pumpWidget(_wrap());
    await _settle(tester);

    await tester.tap(find.bySemanticsLabel('Profile'));
    await _settle(tester);

    expect(find.byType(ProfileScreen), findsOneWidget);
    expect(find.text('Sam Okafor'), findsOneWidget);
  });

  testWidgets('account sheet signs out back to login', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_wrap());
    await _settle(tester);

    await tester.tap(find.text('SO'));
    await tester.pumpAndSettle();

    expect(find.text('Sign out'), findsOneWidget);

    await tester.tap(find.text('Sign out'));
    await tester.pumpAndSettle();

    expect(find.byType(LoginScreen), findsOneWidget);
    // The refresh token is revoked on the server, and forgotten here.
    expect(
      fakes.backend.requests.map((r) => r.url.path),
      contains('/v1/auth/logout'),
    );
    expect(AuthSession.instance.signedIn, isFalse);
  });

  testWidgets('pull to refresh reloads without losing content', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_wrap());
    await _settle(tester);

    await tester.fling(
      find.byType(CustomScrollView),
      const Offset(0, 320),
      900,
    );
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();

    expect(find.byType(PlanRow), findsNWidgets(3));
  });
}
