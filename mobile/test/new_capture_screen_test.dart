import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:mobile/screens/new_capture_screen.dart';
import 'package:mobile/screens/scanning_screen.dart';
import 'package:mobile/services/capture_service.dart';
import 'package:mobile/services/offline_cache.dart';
import 'package:mobile/theme/app_theme.dart';

import 'support/fake_backend.dart';

Widget _wrap({String? facility, String level = '2', CaptureService? service}) =>
    MaterialApp(
      theme: AppTheme.dark,
      home: NewCaptureScreen(
        initialFacility: facility,
        initialLevel: level,
        captureService: service,
      ),
    );

/// Lets the fake backend's answers arrive and the hand-off to the scan run.
/// The scan ticks forever, so time is stepped rather than settled.
Future<void> _settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(seconds: 1));
  await tester.pump(const Duration(milliseconds: 500));
}

ScanningScreen _scan(WidgetTester tester) =>
    tester.widget<ScanningScreen>(find.byType(ScanningScreen));

/// Removes the tree so the scan's timer is cancelled.
Future<void> _tearDown(WidgetTester tester) =>
    tester.pumpWidget(const SizedBox());

void main() {
  late ({FakeBackend backend, FakeUploadQueue uploads}) fakes;
  setUp(() => fakes = useFakeBackend());

  testWidgets('goes straight to the camera and starts scanning', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_wrap());
    expect(find.text('Starting camera…'), findsOneWidget);

    await _settle(tester);

    expect(find.byType(ScanningScreen), findsOneWidget);
    // Replaced, so leaving the scan returns home rather than to a spinner.
    expect(find.byType(NewCaptureScreen), findsNothing);

    await _tearDown(tester);
  });

  testWidgets('the scan starts with the facility, level and default height', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_wrap(facility: 'Riverside Gym', level: '3'));
    await _settle(tester);

    final ScanningScreen scan = _scan(tester);
    expect(scan.config.facilityId, 'fac_riverside');
    expect(scan.config.facility, 'Riverside Gym');
    expect(scan.config.level, 3);
    expect(scan.config.heightM, NewCaptureScreen.defaultHeightM);
    // The capture remembers its account, for the upload.
    expect(scan.config.accountId, 'acc_northgate');
    // The list travels on, for the picker on the review screen.
    expect(scan.facilities!.facilities, hasLength(greaterThan(1)));

    await _tearDown(tester);
  });

  testWidgets('falls back to the first facility when handed an unknown one', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_wrap(facility: 'A gym that closed'));
    await _settle(tester);

    expect(_scan(tester).config.facility, 'Northgate Fitness');

    await _tearDown(tester);
  });

  testWidgets('says so when the account has no gyms, instead of spinning', (
    WidgetTester tester,
  ) async {
    fakes.backend.noFacilities = true;
    await tester.pumpWidget(_wrap());
    await _settle(tester);

    expect(find.text('No facility available'), findsOneWidget);
    expect(find.textContaining('Ask your account admin'), findsOneWidget);
    expect(find.byType(ScanningScreen), findsNothing);

    // Once the admin adds a gym, Try again starts the scan.
    fakes.backend.noFacilities = false;
    await tester.tap(find.text('Try again'));
    await _settle(tester);
    expect(find.byType(ScanningScreen), findsOneWidget);

    await _tearDown(tester);
  });

  testWidgets('a phone without LiDAR is told so and never scans', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        service: CaptureService(
          deviceOverride: const DeviceCapability(
            supported: false,
            headline: 'No LiDAR sensor',
            detail: 'iPhone 11 · iOS 18.2',
          ),
        ),
      ),
    );
    await _settle(tester);

    expect(find.text('No LiDAR sensor'), findsOneWidget);
    expect(find.text('iPhone 11 · iOS 18.2'), findsOneWidget);
    expect(find.byType(ScanningScreen), findsNothing);
  });

  testWidgets('offline: says so, and starts on retry', (
    WidgetTester tester,
  ) async {
    fakes.backend.offline = true;
    await tester.pumpWidget(_wrap());
    await _settle(tester);

    expect(find.text('No connection. Check your signal.'), findsOneWidget);
    expect(find.byType(ScanningScreen), findsNothing);

    fakes.backend.offline = false;
    await tester.tap(find.text('Try again'));
    await _settle(tester);
    expect(find.byType(ScanningScreen), findsOneWidget);

    await _tearDown(tester);
  });

  testWidgets('offline after an online visit: starts from the saved list', (
    WidgetTester tester,
  ) async {
    // Online once: the list is saved for this account.
    await tester.pumpWidget(_wrap());
    await _settle(tester);
    expect(_scan(tester).facilities!.offline, isFalse);
    await _tearDown(tester);

    fakes.backend.offline = true;
    await tester.pumpWidget(_wrap());
    await _settle(tester);

    final ScanningScreen scan = _scan(tester);
    expect(scan.facilities!.offline, isTrue);
    expect(scan.config.facility, 'Northgate Fitness');

    await _tearDown(tester);
  });

  test('the facility list survives on disk, per account', () async {
    final Directory dir = await Directory.systemTemp.createTemp('fac_cache');
    addTearDown(() => dir.delete(recursive: true));
    final FacilityCache cache = FacilityCache(directory: () async => dir);

    await cache.save(
      'acc/1',
      const FacilityList(
        facilities: <Facility>[Facility(id: 'f1', name: 'One')],
        defaultId: 'f1',
      ),
    );
    final FacilityList? back = await FacilityCache(
      directory: () async => dir,
    ).load('acc/1');
    expect(back!.facilities.single.name, 'One');
    expect(back.defaultId, 'f1');
    expect(back.offline, isTrue);
    expect(await cache.load('acc_2'), isNull);

    await cache.clear();
    expect(await cache.load('acc/1'), isNull);
  });
}
