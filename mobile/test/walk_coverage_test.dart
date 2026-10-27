import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:mobile/models/equipment.dart';
import 'package:mobile/models/scan.dart';
import 'package:mobile/screens/equipment_capture_screen.dart';
import 'package:mobile/services/equipment_recording.dart';
import 'package:mobile/services/walk_coverage.dart';
import 'package:mobile/theme/app_theme.dart';
import 'package:mobile/widgets/primary_button.dart';
import 'package:room_scan/room_scan.dart';
import 'package:mobile/widgets/coverage_ring.dart';

import 'phone_size.dart';

/// The demo recorder, but with heading samples the test feeds in, as the
/// plugin's motion stream would on an iPhone.
class _MotionRecording extends SimulatedRecording {
  final StreamController<RecorderMotion> samples =
      StreamController<RecorderMotion>.broadcast();

  @override
  Stream<RecorderMotion> motion() => samples.stream;
}

void main() {
  group('WalkCoverage', () {
    test('starts empty', () {
      final WalkCoverage c = WalkCoverage();
      expect(c.hasData, isFalse);
      expect(c.fraction, 0);
      expect(c.missingBands, isEmpty);
    });

    test('a sample marks its 10° sector', () {
      final WalkCoverage c = WalkCoverage()..add(37);
      expect(c.sectors, <int>{3});
      expect(c.percent, 3);
    });

    test('a full lap in small steps covers everything', () {
      final WalkCoverage c = WalkCoverage();
      for (double h = 0; h < 360; h += 7) {
        c.add(h);
      }
      expect(c.complete, isTrue);
      expect(c.fraction, 1);
    });

    test('a quick turn fills the sectors it skipped', () {
      final WalkCoverage c = WalkCoverage()
        ..add(5)
        ..add(42);
      expect(c.sectors, <int>{0, 1, 2, 3, 4});
    });

    test('a jump too big to be walking fills nothing in between', () {
      final WalkCoverage c = WalkCoverage()
        ..add(10)
        ..add(150);
      expect(c.sectors, <int>{1, 15});
    });

    test('turning back over 0° counts the short way round', () {
      final WalkCoverage c = WalkCoverage()
        ..add(355)
        ..add(15);
      expect(c.sectors, <int>{35, 0, 1});
      final WalkCoverage back = WalkCoverage()
        ..add(15)
        ..add(-10);
      expect(back.sectors, <int>{1, 0, 35});
    });

    test('walking the same arc twice does not count twice', () {
      final WalkCoverage c = WalkCoverage();
      for (int lap = 0; lap < 2; lap++) {
        for (double h = 0; h <= 90; h += 5) {
          c.add(h);
        }
      }
      expect(c.sectors.length, 10);
      expect(c.percent, 28);
    });

    test('ignores nonsense samples', () {
      final WalkCoverage c = WalkCoverage()
        ..add(double.nan)
        ..add(double.infinity);
      expect(c.hasData, isFalse);
    });

    test('pitch says which heights are still missing', () {
      final WalkCoverage c = WalkCoverage()..add(0, pitchDeg: -5);
      expect(c.missingBands, <HeightBand>[HeightBand.low, HeightBand.high]);
      c.add(5, pitchDeg: -40);
      c.add(10, pitchDeg: 35);
      expect(c.missingBands, isEmpty);
      expect(c.bands, HeightBand.values.toSet());
    });

    test('reset starts a retake from nothing', () {
      final WalkCoverage c = WalkCoverage()
        ..add(0, pitchDeg: 0)
        ..add(20);
      c.reset();
      expect(c.sectors, isEmpty);
      expect(c.bands, isEmpty);
      expect(c.hasData, isFalse);
      // The first sample after a reset fills nothing behind it.
      c.add(30);
      expect(c.sectors, <int>{3});
    });

    test('angle helpers wrap', () {
      expect(WalkCoverage.normalise(-90), 270);
      expect(WalkCoverage.normalise(720), 0);
      expect(WalkCoverage.signedDelta(350, 10), 20);
      expect(WalkCoverage.signedDelta(10, 350), -20);
      expect(WalkCoverage.sectorOf(359.99), 35);
    });
  });

  testWidgets('the ring shows the share walked and what is missing', (
    WidgetTester tester,
  ) async {
    final WalkCoverage c = WalkCoverage();
    for (double h = 0; h < 180; h += 5) {
      c.add(h, pitchDeg: 0);
    }
    await tester.pumpWidget(
      MaterialApp(
        home: Center(child: CoverageRing(coverage: c)),
      ),
    );
    expect(find.text('50% around'), findsOneWidget);
    expect(
      find.text('Still to film: low and top of the machine'),
      findsOneWidget,
    );
  });

  testWidgets('the record screen fills the ring from real heading samples', (
    WidgetTester tester,
  ) async {
    usePhoneSize(tester);
    final _MotionRecording recorder = _MotionRecording();
    EquipmentCaptureBackend.debugCreate = () => recorder;
    addTearDown(() => EquipmentCaptureBackend.debugCreate = null);

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: EquipmentCaptureScreen(
          result: ScanResult(
            config: const ScanConfig(
              facilityId: 'fac_northgate',
              facility: 'Northgate Fitness',
              level: 2,
              heightM: 3.2,
            ),
            geometry: FloorOutline.geometry,
            coverage: 1,
            closed: true,
            walls: const <WallQuality>[],
            tags: const <ScanTag>[],
            photos: 0,
            elapsed: Duration.zero,
          ),
          equipment: const <Equipment>[
            Equipment(
              equipmentId: 'EQ-001',
              type: 'treadmill',
              name: 'Treadmill',
            ),
          ],
        ),
      ),
    );
    await tester.tap(find.text('Start 360° capture'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(PrimaryButton, 'Start 360° capture'));
    await tester.pump();

    // No heading data yet, so no ring.
    expect(find.byType(CoverageRing), findsNothing);

    // A quarter of the way round, filmed at middle height only.
    for (double h = 0; h < 90; h += 5) {
      recorder.samples.add(RecorderMotion(headingDeg: h, pitchDeg: 0));
      await tester.pump(const Duration(milliseconds: 20));
    }
    expect(find.byType(CoverageRing), findsOneWidget);
    expect(find.text('25% around'), findsOneWidget);
    expect(find.textContaining('low and top'), findsOneWidget);

    await tester.tap(find.widgetWithText(PrimaryButton, 'Stop capture'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text("0 s recorded"), findsOneWidget);
    expect(find.byType(CoverageRing), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });
}
