import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:mobile/models/scan.dart';
import 'package:mobile/screens/control_distance_screen.dart';
import 'package:mobile/screens/review_submit_screen.dart';
import 'package:mobile/screens/scanning_screen.dart';
import 'package:mobile/screens/uploading_screen.dart';
import 'package:mobile/services/simulated_scan_session.dart';
import 'support/fake_backend.dart';
import 'package:mobile/services/upload_queue.dart';
import 'package:mobile/theme/app_theme.dart';
import 'package:mobile/widgets/floor_plan.dart';
import 'package:mobile/widgets/tag_sheet.dart';

import 'phone_size.dart';
import 'package:mobile/widgets/primary_button.dart';

const ScanConfig _config = ScanConfig(
  facilityId: 'fac_northgate',
  facility: 'Northgate Fitness',
  level: 2,
  heightM: 3.2,
);

/// Opens the scan from a launcher route, as it would be opened from the
/// setup screen, so "Submit" has a home route to return to.
Future<void> _openScan(
  WidgetTester tester,
  SimulatedScanSession session, {
  double? maxExtentM,
}) async {
  usePhoneSize(tester);
  await tester.pumpWidget(
    MaterialApp(
      theme: AppTheme.dark,
      home: Builder(
        builder: (BuildContext context) => Center(
          child: TextButton(
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => ScanningScreen(
                  config: _config,
                  session: session,
                  maxExtentM: maxExtentM,
                ),
              ),
            ),
            child: const Text('launch'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('launch'));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 500));
}

/// Scanning never settles (it ticks), so step time forward explicitly.
Future<void> _advance(WidgetTester tester, Duration by) async {
  const Duration step = Duration(milliseconds: 100);
  for (Duration t = Duration.zero; t < by; t += step) {
    await tester.pump(step);
  }
}

/// Lets any toast run out, then removes the tree so timers are cancelled.
Future<void> _tearDown(WidgetTester tester) async {
  await tester.pump(const Duration(seconds: 2));
  await tester.pumpWidget(const SizedBox());
}

void main() {
  late ({FakeBackend backend, FakeUploadQueue uploads}) fakes;
  setUp(() => fakes = useFakeBackend());

  group('outline geometry', () {
    test('encloses the prototype floor area', () {
      expect(FloorOutline.areaM2.round(), 412);
    });

    test('walks back to its start', () {
      final (Offset end, _) = FloorOutline.pointAt(FloorOutline.perimeter);
      expect(end, FloorOutline.walls.first.start);
    });
  });

  testWidgets('shows the facility, a clock and rising coverage', (
    WidgetTester tester,
  ) async {
    final SimulatedScanSession session = SimulatedScanSession(config: _config);
    addTearDown(session.dispose);
    await _openScan(tester, session);

    expect(find.text('Northgate · Level 2'), findsOneWidget);
    expect(find.text('Coverage'), findsOneWidget);
    expect(find.text('Outline is not closed'), findsOneWidget);

    await _advance(tester, const Duration(seconds: 3));

    expect(session.coverage, greaterThan(0));
    expect(find.text('00:03'), findsOneWidget);

    await _tearDown(tester);
  });

  testWidgets('a full lap closes the outline and flags the weak wall', (
    WidgetTester tester,
  ) async {
    final SimulatedScanSession session = SimulatedScanSession(
      config: _config,
      unitsPerTick: 200,
    );
    addTearDown(session.dispose);
    await _openScan(tester, session);

    await _advance(tester, const Duration(seconds: 2));

    expect(session.closed, isTrue);
    expect(session.weakWalls, hasLength(1));
    // The weak wall still counts for some of its length.
    expect(session.coverage, allOf(greaterThan(0.9), lessThan(1)));
    expect(find.text('One wall reads weak'), findsOneWidget);

    await _tearDown(tester);
  });

  testWidgets('tag sheet: pick a type, ceiling asks for a height, drop it', (
    WidgetTester tester,
  ) async {
    final SimulatedScanSession session = SimulatedScanSession(config: _config);
    addTearDown(session.dispose);
    await _openScan(tester, session);

    await tester.tap(find.bySemanticsLabel('Add a tag'));
    await _advance(tester, const Duration(milliseconds: 600));

    expect(find.byType(TagSheet), findsOneWidget);
    expect(find.text('Add a tag'), findsOneWidget);
    for (final TagType type in TagType.values) {
      expect(find.text(type.label), findsOneWidget);
    }
    // Mirror wall is preselected, which needs no height.
    expect(find.text('MEASURED HEIGHT'), findsNothing);

    await tester.tap(find.text('Ceiling height'));
    await tester.pump();
    expect(find.text('MEASURED HEIGHT'), findsOneWidget);
    expect(find.text('3.20'), findsOneWidget);

    // Implausible heights are refused.
    await tester.enterText(find.text('3.20'), '40');
    await tester.tap(find.text('Drop tag here'));
    await tester.pump();
    expect(find.text('Height must be between 2.0 and 12.0 m.'), findsOneWidget);

    await tester.enterText(find.text('40'), '3.18');
    await tester.tap(find.text('Drop tag here'));
    await _advance(tester, const Duration(milliseconds: 600));

    expect(find.byType(TagSheet), findsNothing);
    expect(session.tags, hasLength(1));
    expect(session.tags.single.type, TagType.ceiling);
    expect(session.tags.single.heightM, 3.18);
    expect(find.text('Ceiling'), findsOneWidget);

    await _tearDown(tester);
  });

  testWidgets('cancelling the tag sheet drops nothing', (
    WidgetTester tester,
  ) async {
    final SimulatedScanSession session = SimulatedScanSession(config: _config);
    addTearDown(session.dispose);
    await _openScan(tester, session);

    await tester.tap(find.bySemanticsLabel('Add a tag'));
    await _advance(tester, const Duration(milliseconds: 600));
    await tester.tap(find.text('Cancel').first);
    await _advance(tester, const Duration(milliseconds: 600));

    expect(find.byType(TagSheet), findsNothing);
    expect(session.tags, isEmpty);

    await _tearDown(tester);
  });

  testWidgets('first photo warns about people, later ones do not', (
    WidgetTester tester,
  ) async {
    final SimulatedScanSession session = SimulatedScanSession(config: _config);
    addTearDown(session.dispose);
    await _openScan(tester, session);

    await tester.tap(find.bySemanticsLabel('Take a reference photo'));
    await _advance(tester, const Duration(milliseconds: 400));
    expect(find.text('Photos may include people'), findsOneWidget);

    await tester.tap(find.text('Take photo'));
    await _advance(tester, const Duration(milliseconds: 400));
    expect(session.photos, 1);
    expect(find.text('Reference photo 1 of 4 saved.'), findsOneWidget);

    await _advance(tester, const Duration(seconds: 2));
    await tester.tap(find.bySemanticsLabel('Take a reference photo'));
    await _advance(tester, const Duration(milliseconds: 400));
    expect(find.text('Photos may include people'), findsNothing);
    expect(session.photos, 2);

    await _tearDown(tester);
  });

  testWidgets('finishing early needs a reason, which reaches the review', (
    WidgetTester tester,
  ) async {
    final SimulatedScanSession session = SimulatedScanSession(config: _config);
    addTearDown(session.dispose);
    await _openScan(tester, session);

    await tester.tap(find.text('Finish scan'));
    await _advance(tester, const Duration(milliseconds: 400));

    expect(find.text('Finish without closing?'), findsOneWidget);
    final Finder finishAnyway = find.widgetWithText(
      CupertinoDialogAction,
      'Finish anyway',
    );
    expect(
      tester.widget<CupertinoDialogAction>(finishAnyway).onPressed,
      isNull,
    );

    await tester.enterText(
      find.byType(CupertinoTextField),
      'Wall behind fixed rig, cannot pass',
    );
    await tester.pump();
    await tester.tap(finishAnyway);
    await _advance(tester, const Duration(milliseconds: 600));

    expect(find.byType(ReviewSubmitScreen), findsOneWidget);
    expect(find.text('Review before submit'), findsOneWidget);
    expect(find.text('Northgate Fitness · Level 2 · 412 m²'), findsOneWidget);
    expect(find.textContaining('Outline closed on override.'), findsOneWidget);
    expect(
      find.textContaining('Wall behind fixed rig, cannot pass'),
      findsOneWidget,
    );

    await _tearDown(tester);
  });

  testWidgets('keep scanning returns to the live scan and resumes it', (
    WidgetTester tester,
  ) async {
    final SimulatedScanSession session = SimulatedScanSession(
      config: _config,
      unitsPerTick: 200,
    );
    addTearDown(session.dispose);
    await _openScan(tester, session);
    await _advance(tester, const Duration(seconds: 2));

    await tester.tap(find.text('Finish scan'));
    await _advance(tester, const Duration(milliseconds: 600));
    expect(find.byType(ReviewSubmitScreen), findsOneWidget);
    expect(session.running, isFalse);

    await tester.tap(find.text('Keep scanning'));
    await _advance(tester, const Duration(milliseconds: 600));
    expect(find.byType(ScanningScreen), findsOneWidget);
    expect(session.running, isTrue);

    await _tearDown(tester);
  });

  testWidgets('the equipment step gates Submit, and says so', (
    WidgetTester tester,
  ) async {
    final SimulatedScanSession session = SimulatedScanSession(
      config: _config,
      unitsPerTick: 200,
    );
    addTearDown(session.dispose);
    await _openScan(tester, session);
    await _advance(tester, const Duration(seconds: 2));
    await tester.tap(find.text('Finish scan'));
    await _advance(tester, const Duration(milliseconds: 600));

    PrimaryButton submit() => tester.widget<PrimaryButton>(
      find.widgetWithText(PrimaryButton, 'Submit scan'),
    );

    // Before the step: Submit is dead, and the card says why.
    expect(submit().onPressed, isNull);
    expect(find.textContaining('Required before submitting'), findsOneWidget);

    // Stepping back out of the equipment screen does not finish it.
    await tester.tap(find.text('Capture Equipment 360°'));
    await tester.pumpAndSettle();
    // The app's own nav bar, which labels its back button.
    await tester.tap(find.text('Review'));
    await tester.pumpAndSettle();
    expect(
      submit().onPressed,
      isNull,
      reason: 'backing out does not finish the step',
    );

    // Finishing it does.
    await _finishEquipmentStep(tester);
    expect(submit().onPressed, isNotNull);
    expect(find.text('No equipment on this level'), findsOneWidget);

    await _tearDown(tester);
  });

  testWidgets('submitting queues the upload and leaves the capture flow', (
    WidgetTester tester,
  ) async {
    final SimulatedScanSession session = SimulatedScanSession(
      config: _config,
      unitsPerTick: 200,
    );
    addTearDown(session.dispose);
    await _openScan(tester, session);
    await _advance(tester, const Duration(seconds: 2));

    await tester.tap(find.text('Finish scan'));
    await _advance(tester, const Duration(milliseconds: 600));

    // A closed lap with one weak wall: one warning, no override.
    expect(find.text('1 coverage warning'), findsOneWidget);
    expect(find.textContaining('Inner east wall reads weak.'), findsOneWidget);

    // The equipment step comes first: Submit is dead until it is done.
    expect(
      tester
          .widget<PrimaryButton>(
            find.widgetWithText(PrimaryButton, 'Submit scan'),
          )
          .onPressed,
      isNull,
    );
    await _finishEquipmentStep(tester);

    await tester.tap(find.text('Submit scan'));
    // The save, then the push; the removed routes leave once the new one
    // has finished animating in.
    await _advance(tester, const Duration(seconds: 2));

    expect(find.byType(UploadingScreen), findsOneWidget);
    expect(find.byType(ScanningScreen), findsNothing);
    expect(find.byType(ReviewSubmitScreen), findsNothing);

    // Handed to the upload queue with the facility's platform id.
    final ScanResult queued = fakes.uploads.enqueued.single;
    expect(queued.config.facilityId, 'fac_northgate');
    expect(queued.closed, isTrue);
    // A simulated scan has no model file to send.
    expect(fakes.uploads.exports.single, isNull);
    expect(UploadQueue.instance.active!.title, 'Northgate · Level 2');

    await _tearDown(tester);
  });

  testWidgets('back from the scan asks before discarding', (
    WidgetTester tester,
  ) async {
    final SimulatedScanSession session = SimulatedScanSession(config: _config);
    addTearDown(session.dispose);
    await _openScan(tester, session);

    await tester.tap(find.bySemanticsLabel('Discard scan'));
    await _advance(tester, const Duration(milliseconds: 400));
    expect(find.text('Discard this scan?'), findsOneWidget);

    await tester.tap(find.text('Discard'));
    await _advance(tester, const Duration(milliseconds: 1500));
    expect(find.byType(ScanningScreen), findsNothing);
    expect(find.text('launch'), findsOneWidget);

    await _tearDown(tester);
  });

  group('scan size limit (F-04)', () {
    testWidgets('shows the live extent of the scanned walls', (
      WidgetTester tester,
    ) async {
      final SimulatedScanSession session = SimulatedScanSession(
        config: _config,
        unitsPerTick: 200,
      );
      addTearDown(session.dispose);
      await _openScan(tester, session);

      expect(find.text('Scanned extent'), findsOneWidget);

      await _advance(tester, const Duration(seconds: 2));
      // The demo outline, in metres.
      expect(find.text('24.4 × 19.0 m'), findsOneWidget);
      expect(find.text(' / max 40 m'), findsOneWidget);
      expect(find.text('Too large for one scan'), findsNothing);
      expect(
        tester
            .widget<PrimaryButton>(
              find.widgetWithText(PrimaryButton, 'Finish scan'),
            )
            .onPressed,
        isNotNull,
      );

      await _tearDown(tester);
    });

    testWidgets('past the limit it warns and Finish is off', (
      WidgetTester tester,
    ) async {
      final SimulatedScanSession session = SimulatedScanSession(
        config: _config,
        unitsPerTick: 200,
      );
      addTearDown(session.dispose);
      await _openScan(tester, session, maxExtentM: 20);
      await _advance(tester, const Duration(seconds: 2));

      expect(find.text('Too large for one scan'), findsOneWidget);
      expect(find.textContaining('scanned in sections'), findsOneWidget);
      expect(
        tester
            .widget<PrimaryButton>(
              find.widgetWithText(PrimaryButton, 'Finish scan'),
            )
            .onPressed,
        isNull,
      );

      await _tearDown(tester);
    });
  });

  testWidgets('control distances are marked on the plan and submitted', (
    WidgetTester tester,
  ) async {
    final SimulatedScanSession session = SimulatedScanSession(
      config: _config,
      unitsPerTick: 200,
    );
    addTearDown(session.dispose);
    await _openScan(tester, session);
    await _advance(tester, const Duration(seconds: 2));
    await tester.tap(find.text('Finish scan'));
    await _advance(tester, const Duration(milliseconds: 600));

    // None yet: encouraged, not required.
    expect(
      find.textContaining('Add at least 2 long distances'),
      findsOneWidget,
    );

    await tester.ensureVisible(find.widgetWithText(TextButton, 'Add distance'));
    await tester.tap(find.widgetWithText(TextButton, 'Add distance'));
    await tester.pumpAndSettle();
    expect(find.byType(ControlDistanceScreen), findsOneWidget);

    // Tap near the north-west and north-east corners; taps snap to them.
    final Rect plan = tester.getRect(find.byType(FloorPlanView));
    final double scale = plan.width / FloorOutline.canvas.width;
    Offset at(double x, double y) => plan.topLeft + Offset(x, y) * scale;
    await tester.tapAt(at(36, 44) + const Offset(4, 3));
    await tester.pump();
    await tester.tapAt(at(288, 44) + const Offset(-3, 4));
    await tester.pump();
    // The plan does not move between taps (the instructions sit under it).
    expect(tester.getRect(find.byType(FloorPlanView)), plan);
    expect(find.text('On the scan: 24.39 m'), findsOneWidget);

    await tester.enterText(find.byType(TextField), '24.42');
    await tester.pump();
    await tester.tap(find.widgetWithText(PrimaryButton, 'Add distance'));
    await tester.pumpAndSettle();

    expect(find.byType(ReviewSubmitScreen), findsOneWidget);
    expect(find.text('Control distances · 1'), findsOneWidget);
    expect(find.text('Laser 24.42 m · scan 24.39 m'), findsOneWidget);
    // Still fewer than two.
    expect(
      find.textContaining('Add at least 2 long distances'),
      findsOneWidget,
    );

    await _finishEquipmentStep(tester);
    await tester.tap(find.text('Submit scan'));
    await _advance(tester, const Duration(seconds: 2));

    final ControlDistance sent =
        fakes.uploads.enqueued.single.controlDistances.single;
    expect(sent.a, const Offset(36, 44));
    expect(sent.b, const Offset(288, 44));
    expect(sent.measuredM, 24.42);
    expect(sent.toJson(), <String, Object?>{
      'a': <double>[36, 44],
      'b': <double>[288, 44],
      'measuredM': 24.42,
    });

    await _tearDown(tester);
  });
}

/// Finishes the equipment step, which is what unlocks Submit. These scans
/// carry no equipment, so the step is finished by confirming there is none.
Future<void> _finishEquipmentStep(WidgetTester tester) async {
  await tester.tap(find.text('Capture Equipment 360°'));
  await tester.pumpAndSettle();
  await tester.tap(find.widgetWithText(PrimaryButton, 'Done'));
  await tester.pumpAndSettle();
  await tester.tap(find.text('No equipment'));
  await tester.pumpAndSettle();
}
