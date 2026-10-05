import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:mobile/screens/new_capture_screen.dart';
import 'package:mobile/screens/scanning_screen.dart';
import 'package:mobile/services/capture_service.dart';
import 'package:mobile/theme/app_theme.dart';
import 'package:mobile/widgets/capture_fields.dart';
import 'package:mobile/widgets/primary_button.dart';

import 'support/fake_backend.dart';

Widget _wrap({String? facility}) => MaterialApp(
  theme: AppTheme.dark,
  home: NewCaptureScreen(initialFacility: facility),
);

/// Lets the fake backend's answers arrive and the screen settle.
Future<void> _settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(seconds: 1));
  await tester.pumpAndSettle();
}

Finder _fieldFor(String label) => find.ancestor(
  of: find.text(label.toUpperCase()),
  matching: find.byType(LabelledField),
);

void main() {
  late ({FakeBackend backend, FakeUploadQueue uploads}) fakes;
  setUp(() => fakes = useFakeBackend());

  testWidgets('renders every section of the capture form', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_wrap());
    await _settle(tester);

    expect(find.text('New capture'), findsOneWidget);
    expect(find.text('FACILITY'), findsOneWidget);
    expect(find.text('LEVEL'), findsOneWidget);
    expect(find.text('FLOOR TO FLOOR'), findsOneWidget);
    expect(find.text('DEVICE'), findsOneWidget);

    // Tests do not run on iOS, so debug builds fall back to the demo walk.
    expect(find.text('Simulated scan'), findsOneWidget);
    expect(find.text('No LiDAR here · runs a demo walk'), findsOneWidget);

    expect(find.byType(ChecklistCard), findsOneWidget);
    expect(find.text('Before you start'), findsOneWidget);
    expect(
      find.text('Walk the full perimeter without lifting the phone.'),
      findsOneWidget,
    );

    expect(find.text('Start scan'), findsOneWidget);
    expect(find.text('Home'), findsOneWidget);
    expect(find.text('Cancel'), findsOneWidget);
  });

  testWidgets('says so when the account has no gyms, instead of spinning', (
    WidgetTester tester,
  ) async {
    fakes.backend.noFacilities = true;
    await tester.pumpWidget(_wrap());
    await _settle(tester);

    expect(find.text('No facility available'), findsOneWidget);
    expect(find.textContaining('Ask your account admin'), findsOneWidget);
    expect(find.byType(CupertinoActivityIndicator), findsNothing);
    expect(find.text('Start scan'), findsNothing);

    // Once the admin adds a gym, Try again shows the form.
    fakes.backend.noFacilities = false;
    await tester.tap(find.text('Try again'));
    await _settle(tester);
    expect(find.text('No facility available'), findsNothing);
    expect(find.text('Start scan'), findsOneWidget);
  });

  testWidgets('defaults to the facility it was opened with', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_wrap(facility: 'Riverside Gym'));
    await _settle(tester);

    expect(find.text('Riverside Gym'), findsOneWidget);
  });

  testWidgets('falls back to the first facility when handed an unknown one', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_wrap(facility: 'A gym that closed'));
    await _settle(tester);

    expect(find.text('Northgate Fitness'), findsOneWidget);
    expect(find.text('A gym that closed'), findsNothing);
  });

  testWidgets('picker sheet changes the selected facility', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_wrap(facility: 'Northgate Fitness'));
    await _settle(tester);

    await tester.tap(find.byType(PickerField));
    await tester.pumpAndSettle();

    expect(find.byType(CupertinoPicker), findsOneWidget);

    await tester.drag(find.byType(CupertinoPicker), const Offset(0, -40));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Done'));
    await tester.pumpAndSettle();

    expect(find.text('Riverside Gym'), findsOneWidget);
  });

  testWidgets('cancelling the picker keeps the original facility', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_wrap(facility: 'Northgate Fitness'));
    await _settle(tester);

    await tester.tap(find.byType(PickerField));
    await tester.pumpAndSettle();
    await tester.drag(find.byType(CupertinoPicker), const Offset(0, -40));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cancel').last);
    await tester.pumpAndSettle();

    expect(find.text('Northgate Fitness'), findsOneWidget);
  });

  testWidgets('rejects an empty level', (WidgetTester tester) async {
    await tester.pumpWidget(_wrap());
    await _settle(tester);

    await tester.enterText(
      find.descendant(of: _fieldFor('Level'), matching: find.byType(TextField)),
      '',
    );
    await tester.tap(find.text('Start scan'));
    await tester.pump();

    expect(find.text('Enter the level.'), findsOneWidget);
  });

  testWidgets('rejects an implausible floor-to-floor height', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_wrap());
    await _settle(tester);

    await tester.enterText(
      find.descendant(
        of: _fieldFor('Floor to floor'),
        matching: find.byType(TextField),
      ),
      '0.5',
    );
    await tester.tap(find.text('Start scan'));
    await tester.pump();

    expect(find.text('Height must be between 2.0 and 12.0 m.'), findsOneWidget);
  });

  testWidgets('height field only accepts digits and a decimal point', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_wrap());
    await _settle(tester);

    final Finder heightField = find.descendant(
      of: _fieldFor('Floor to floor'),
      matching: find.byType(TextField),
    );
    await tester.enterText(heightField, '3.2abc-');
    await tester.pump();

    expect(tester.widget<TextField>(heightField).controller!.text, '3.2');
  });

  testWidgets('valid input starts the scan', (WidgetTester tester) async {
    await tester.pumpWidget(_wrap());
    await _settle(tester);

    await tester.tap(find.text('Start scan'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    expect(find.byType(ScanningScreen), findsOneWidget);
    expect(find.text('Northgate · Level 2'), findsOneWidget);

    // The scan ticks forever; tear it down so its timer is cancelled.
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('opens on the level it was handed', (WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: const NewCaptureScreen(initialLevel: '3'),
      ),
    );
    await _settle(tester);

    final Finder level = find.descendant(
      of: _fieldFor('Level'),
      matching: find.byType(TextField),
    );
    expect(tester.widget<TextField>(level).controller!.text, '3');
  });

  testWidgets('start is live on a LiDAR-capable phone', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_wrap());
    await _settle(tester);

    final PrimaryButton button = tester.widget<PrimaryButton>(
      find.byType(PrimaryButton),
    );
    expect(button.onPressed, isNotNull);
  });

  testWidgets('start is blocked when the phone has no LiDAR', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: NewCaptureScreen(
          captureService: CaptureService(
            deviceOverride: const DeviceCapability(
              supported: false,
              headline: 'No LiDAR sensor',
              detail: 'iPhone 11 · iOS 18.2',
            ),
          ),
        ),
      ),
    );
    await _settle(tester);

    expect(find.text('No LiDAR sensor'), findsOneWidget);

    final PrimaryButton button = tester.widget<PrimaryButton>(
      find.byType(PrimaryButton),
    );
    expect(button.onPressed, isNull);

    // Tapping it must not start anything.
    await tester.tap(find.text('Start scan'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byType(ScanningScreen), findsNothing);
  });

  testWidgets('the scan gets the facility id the backend gave', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_wrap(facility: 'Riverside Gym'));
    await _settle(tester);

    await tester.tap(find.text('Start scan'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    final ScanningScreen scan = tester.widget<ScanningScreen>(
      find.byType(ScanningScreen),
    );
    expect(scan.config.facilityId, 'fac_riverside');
    expect(scan.config.facility, 'Riverside Gym');

    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('offline: says so, and loads on retry', (
    WidgetTester tester,
  ) async {
    fakes.backend.offline = true;
    await tester.pumpWidget(_wrap());
    await _settle(tester);

    expect(find.text('No connection. Check your signal.'), findsOneWidget);
    expect(find.text('Start scan'), findsNothing);

    fakes.backend.offline = false;
    await tester.tap(find.text('Try again'));
    await _settle(tester);
    expect(find.text('Start scan'), findsOneWidget);
  });
}
