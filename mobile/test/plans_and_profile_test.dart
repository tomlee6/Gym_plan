import 'dart:convert';

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:mobile/models/plan.dart';
import 'package:mobile/screens/login_screen.dart';
import 'package:mobile/screens/new_capture_screen.dart';
import 'package:mobile/screens/plan_ready_screen.dart';
import 'package:mobile/screens/plan_rejected_screen.dart';
import 'package:mobile/screens/plans_screen.dart';
import 'package:mobile/screens/profile_screen.dart';
import 'package:mobile/screens/uploading_screen.dart';
import 'package:mobile/services/profile_service.dart';
import 'package:mobile/services/upload_queue.dart';
import 'package:mobile/theme/app_theme.dart';
import 'package:mobile/utils/formatting.dart';
import 'package:mobile/widgets/gym_tab_bar.dart';
import 'package:mobile/widgets/home_cards.dart';

import 'phone_size.dart';
import 'support/fake_backend.dart';

Widget _wrap(Widget home) => MaterialApp(theme: AppTheme.dark, home: home);

/// Sizes the surface like a phone, then pumps [home].
Future<void> _pump(WidgetTester tester, Widget home) async {
  usePhoneSize(tester);
  await tester.pumpWidget(_wrap(home));
}

/// Lets the fake backend's answers arrive and the screen settle.
Future<void> _settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(seconds: 1));
  await tester.pumpAndSettle();
}

const Plan _riverside = Plan(
  id: 'plan_rv0',
  site: 'Riverside Gym',
  levelNumber: 0,
  status: PlanStatus.recapture,
);

const Plan _northgate = Plan(
  id: 'plan_ng1',
  site: 'Northgate Fitness',
  levelNumber: 1,
  status: PlanStatus.ready,
);

UploadJob _job({String? error}) => UploadJob(
  id: 'j1',
  title: 'Northgate · Level 2',
  facility: 'Northgate Fitness',
  level: 2,
  totalMb: 297,
  sentMb: 184,
  resumes: 3,
  status: UploadStatus.waitingForNetwork,
  error: error,
);

void main() {
  late ({FakeBackend backend, FakeUploadQueue uploads}) fakes;
  setUp(() => fakes = useFakeBackend());

  group('My plans', () {
    testWidgets('lists every plan with the plans tab selected', (
      WidgetTester tester,
    ) async {
      await _pump(tester, const PlansScreen());
      await _settle(tester);

      expect(find.text('My plans'), findsOneWidget);
      expect(find.byType(PlanRow), findsNWidgets(6));
      expect(find.text('6 plans across 3 facilities'), findsOneWidget);
      expect(find.text('Incomplete coverage · read the note'), findsOneWidget);
      expect(
        find.text(
          'Approved ${Formatting.ago(fakes.backend.readyReviewed)} · version 2',
        ),
        findsOneWidget,
      );

      final GymTabBar bar = tester.widget<GymTabBar>(find.byType(GymTabBar));
      expect(bar.current, GymTab.plans);
    });

    testWidgets('filters by in progress and ready', (
      WidgetTester tester,
    ) async {
      await _pump(tester, const PlansScreen());
      await _settle(tester);

      await tester.tap(find.text('In progress'));
      await tester.pumpAndSettle();
      expect(find.byType(PlanRow), findsNWidgets(3));
      expect(find.text('Riverside Gym · Ground'), findsNothing);
      expect(find.text('3 plans across 2 facilities'), findsOneWidget);

      // "Ready" is also each row's pill; the segment comes first.
      await tester.tap(find.text('Ready').first);
      await tester.pumpAndSettle();
      expect(find.byType(PlanRow), findsNWidgets(2));
      expect(find.text('Eastbrook Athletic Club · Ground'), findsOneWidget);

      await tester.tap(find.text('All'));
      await tester.pumpAndSettle();
      expect(find.byType(PlanRow), findsNWidgets(6));
    });

    testWidgets('each plan opens the screen for its status', (
      WidgetTester tester,
    ) async {
      await _pump(tester, const PlansScreen());
      await _settle(tester);

      await tester.tap(find.text('Riverside Gym · Ground'));
      await _settle(tester);
      expect(find.byType(PlanRejectedScreen), findsOneWidget);

      await tester.tap(find.text('Back to plans'));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Northgate Fitness · Level 1'));
      await _settle(tester);
      expect(find.byType(PlanReadyScreen), findsOneWidget);

      await tester.tap(find.text('Plans'));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Northgate Fitness · Level 3'));
      await _settle(tester);
      expect(find.byType(UploadingScreen), findsOneWidget);
    });

    testWidgets('offline: says so, and loads on retry', (
      WidgetTester tester,
    ) async {
      fakes.backend.offline = true;
      await _pump(tester, const PlansScreen());
      await _settle(tester);
      expect(find.text('No connection. Check your signal.'), findsOneWidget);

      fakes.backend.offline = false;
      await tester.tap(find.text('Try again'));
      await _settle(tester);
      expect(find.byType(PlanRow), findsNWidgets(6));
    });
  });

  group('Needs recapture', () {
    testWidgets('shows the reason, the note and who wrote it', (
      WidgetTester tester,
    ) async {
      await _pump(tester, const PlanRejectedScreen(plan: _riverside));
      await _settle(tester);

      expect(find.text('Riverside Gym'), findsOneWidget);
      expect(
        find.text(
          'Ground floor · submitted '
          '${Formatting.stamp(fakes.backend.rejectedSubmitted)}',
        ),
        findsOneWidget,
      );
      expect(find.text('Needs recapture'), findsOneWidget);
      expect(find.text('Incomplete coverage'), findsOneWidget);
      expect(find.textContaining('north-east corner'), findsOneWidget);
      expect(
        find.text(
          'Maya Restrepo · ${Formatting.stamp(fakes.backend.rejectedReviewed)}',
        ),
        findsOneWidget,
      );
      expect(find.text('71 per cent'), findsOneWidget);
      expect(find.text('Recorded'), findsOneWidget);
    });

    testWidgets('recapture opens setup on the same facility and level', (
      WidgetTester tester,
    ) async {
      await _pump(tester, const PlanRejectedScreen(plan: _riverside));
      await _settle(tester);

      await tester.tap(find.text('Start recapture'));
      await _settle(tester);

      final NewCaptureScreen setup = tester.widget<NewCaptureScreen>(
        find.byType(NewCaptureScreen),
      );
      expect(setup.initialFacility, 'Riverside Gym');
      expect(setup.initialLevel, '0');
      expect(find.text('Riverside Gym'), findsOneWidget);
    });

    testWidgets('a plan that no longer exists says so', (
      WidgetTester tester,
    ) async {
      await _pump(
        tester,
        const PlanRejectedScreen(
          plan: Plan(
            id: 'plan_gone',
            site: 'Gone Gym',
            levelNumber: 0,
            status: PlanStatus.recapture,
          ),
        ),
      );
      await _settle(tester);
      expect(find.text('This plan does not exist.'), findsOneWidget);
    });
  });

  group('Walkthrough ready', () {
    testWidgets('shows approval, version and the disclaimer', (
      WidgetTester tester,
    ) async {
      await _pump(tester, const PlanReadyScreen(plan: _northgate));
      await _settle(tester);

      expect(find.text('Northgate Fitness'), findsOneWidget);
      expect(find.text('Level 1 · 486 m² · version 2'), findsOneWidget);
      expect(find.text('Approved and generated'), findsOneWidget);
      expect(
        find.text(
          'Maya Restrepo · ${Formatting.stamp(fakes.backend.readyReviewed)}',
        ),
        findsOneWidget,
      );
      expect(find.text('2 · supersedes v1'), findsOneWidget);
      expect(find.text('11 min 20 s'), findsOneWidget);
      expect(
        find.text('Indicative only. This is not a certified drawing.'),
        findsOneWidget,
      );
      expect(find.text('Not created'), findsOneWidget);
    });

    testWidgets('share creates a link on the server and copies it', (
      WidgetTester tester,
    ) async {
      final List<MethodCall> clipboard = <MethodCall>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (MethodCall call) async {
          if (call.method == 'Clipboard.setData') clipboard.add(call);
          return null;
        },
      );

      await _pump(tester, const PlanReadyScreen(plan: _northgate));
      await _settle(tester);

      await tester.tap(find.bySemanticsLabel('Share this walkthrough'));
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));

      expect(
        (clipboard.single.arguments as Map<Object?, Object?>)['text'],
        'https://walkthrough.test/s/abc123',
      );
      expect(
        fakes.backend.requests.map((r) => '${r.method} ${r.url.path}'),
        contains('POST /v1/plans/plan_ng1/share-links'),
      );
      expect(find.text('Copied'), findsOneWidget);
      expect(find.text('Share link copied.'), findsOneWidget);

      await tester.pump(const Duration(seconds: 2));
      await tester.pumpAndSettle();
    });
  });

  group('Background upload', () {
    testWidgets('shows the queue’s progress as it changes', (
      WidgetTester tester,
    ) async {
      fakes.uploads.job = _job();
      await _pump(tester, const UploadingScreen());
      await tester.pump();

      expect(find.text('Uploading in the background'), findsOneWidget);
      expect(find.text('Northgate · Level 2'), findsOneWidget);
      expect(find.text('184 MB of 297 MB'), findsOneWidget);
      expect(find.text('Waiting for signal'), findsOneWidget);
      expect(find.text('3 times'), findsOneWidget);

      fakes.uploads.update((UploadJob j) {
        j
          ..sentMb = 297
          ..resumes = 4
          ..received = true
          ..status = UploadStatus.done;
      });
      await tester.pump();

      expect(find.text('Upload complete'), findsOneWidget);
      expect(find.text('297 MB'), findsOneWidget);
      expect(find.text('4 times'), findsOneWidget);
    });

    testWidgets('a stopped upload says why and can be retried', (
      WidgetTester tester,
    ) async {
      fakes.uploads.job = _job(error: 'Sign in again to finish uploading.');
      await _pump(tester, const UploadingScreen());
      await tester.pump();

      expect(find.text('Upload stopped'), findsNWidgets(1));
      expect(find.text('Sign in again to finish uploading.'), findsOneWidget);

      await tester.tap(find.text('Try again'));
      await tester.pump();
      expect(fakes.uploads.retries, 1);
      expect(find.text('Try again'), findsNothing);
    });

    testWidgets('says so when nothing is queued', (WidgetTester tester) async {
      await _pump(tester, const UploadingScreen());
      await tester.pump();

      expect(find.text('Nothing waiting to upload'), findsOneWidget);
    });

    testWidgets('"Start the next level" prefills the level above', (
      WidgetTester tester,
    ) async {
      fakes.uploads.job = _job();
      await _pump(tester, const UploadingScreen());
      await tester.pump();

      await tester.tap(find.text('Start the next level'));
      await _settle(tester);

      final NewCaptureScreen setup = tester.widget<NewCaptureScreen>(
        find.byType(NewCaptureScreen),
      );
      expect(setup.initialFacility, 'Northgate Fitness');
      expect(setup.initialLevel, '3');
    });
  });

  group('Profile', () {
    testWidgets('shows the account, quota and pending uploads', (
      WidgetTester tester,
    ) async {
      fakes.uploads.job = _job();
      await _pump(tester, const ProfileScreen());
      await _settle(tester);

      expect(find.text('Sam Okafor'), findsOneWidget);
      expect(find.text('Owner & Surveyor'), findsOneWidget);
      expect(find.text('Northgate Group'), findsOneWidget);
      expect(find.text('6 of 10'), findsOneWidget);
      expect(find.text('Captures waiting to upload'), findsOneWidget);
      // Badge for the one queued capture.
      expect(find.text('1'), findsOneWidget);

      final GymTabBar bar = tester.widget<GymTabBar>(find.byType(GymTabBar));
      expect(bar.current, GymTab.profile);
    });

    testWidgets('settings come from the server', (WidgetTester tester) async {
      fakes.backend.settings['warnBeforePhotos'] = false;
      await _pump(tester, const ProfileScreen());
      await _settle(tester);

      expect(CaptureSettings.instance.warnBeforePhotos, isFalse);
      final CupertinoSwitch warn = tester.widget<CupertinoSwitch>(
        find.byType(CupertinoSwitch).last,
      );
      expect(warn.value, isFalse);
    });

    testWidgets('toggles save to the server and reach the upload queue', (
      WidgetTester tester,
    ) async {
      await _pump(tester, const ProfileScreen());
      await _settle(tester);

      await tester.tap(find.byType(CupertinoSwitch).last);
      await _settle(tester);
      expect(CaptureSettings.instance.warnBeforePhotos, isFalse);
      expect(fakes.backend.settings['warnBeforePhotos'], isFalse);

      await tester.tap(find.byType(CupertinoSwitch).first);
      await _settle(tester);
      expect(fakes.backend.settings['uploadOnMobileData'], isFalse);
      expect(fakes.uploads.mobileData, isFalse);

      final List<Object?> patches = <Object?>[
        for (final r in fakes.backend.requests)
          if (r.method == 'PATCH') jsonDecode(r.body),
      ];
      expect(patches, <Object?>[
        <String, Object?>{'warnBeforePhotos': false},
        <String, Object?>{'uploadOnMobileData': false},
      ]);
    });

    testWidgets('a failed save puts the switch back', (
      WidgetTester tester,
    ) async {
      fakes.backend.failSettings = true;
      await _pump(tester, const ProfileScreen());
      await _settle(tester);

      await tester.tap(find.byType(CupertinoSwitch).last);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(CaptureSettings.instance.warnBeforePhotos, isTrue);
      expect(find.text('Could not save.'), findsOneWidget);

      await tester.pump(const Duration(seconds: 2));
      await tester.pumpAndSettle();
    });

    testWidgets('sign out confirms, then returns to login', (
      WidgetTester tester,
    ) async {
      fakes.uploads.job = _job();
      await _pump(tester, const ProfileScreen());
      await _settle(tester);

      await tester.tap(find.text('Sign out'));
      await tester.pumpAndSettle();
      // The sheet warns that an upload is still pending.
      expect(find.textContaining('still uploading'), findsOneWidget);

      await tester.tap(find.text('Sign out').last);
      await tester.pumpAndSettle();

      expect(find.byType(LoginScreen), findsOneWidget);
      expect(
        fakes.backend.requests.map((r) => r.url.path),
        contains('/v1/auth/logout'),
      );
    });
  });
}
