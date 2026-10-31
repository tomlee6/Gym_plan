// The dashboard's create panel and scan grid, the scans kept on the phone,
// the room's measurements, and the full-screen 3D / floor plan viewer.
//
// The 3D view itself is SceneKit and needs an iPhone; off iOS it stands in
// with a placeholder, so what is covered here is everything around it.
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:room_scan/room_scan.dart';

import 'package:mobile/models/room_measurements.dart';
import 'package:mobile/models/scan.dart';
import 'package:mobile/screens/home_screen.dart';
import 'package:mobile/screens/new_capture_screen.dart';
import 'package:mobile/screens/scan_viewer_screen.dart';
import 'package:mobile/services/scan_library.dart';
import 'package:mobile/theme/app_theme.dart';
import 'package:mobile/widgets/home_cards.dart';

import 'phone_size.dart';
import 'support/fake_backend.dart';

const ScanConfig _config = ScanConfig(
  facilityId: 'fac_northgate',
  facility: 'Northgate Fitness',
  level: 2,
  heightM: 3.2,
);

/// A 10 × 6 m room, in metres as a LiDAR scan reports it.
final PlanGeometry _room = PlanGeometry.fitted(
  walls: const <WallSegment>[
    WallSegment(Offset(0, 0), Offset(10, 0)),
    WallSegment(Offset(10, 0), Offset(10, 6)),
    WallSegment(Offset(10, 6), Offset(0, 6)),
    WallSegment(Offset(0, 6), Offset(0, 0)),
  ],
  areaM2: 60,
);

ScanResult _result() => ScanResult(
  config: _config,
  geometry: _room,
  coverage: 1,
  closed: true,
  walls: List<WallQuality>.filled(4, WallQuality.captured),
  tags: const <ScanTag>[],
  photos: 0,
  elapsed: const Duration(minutes: 3),
);

Future<void> _settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(seconds: 1));
  await tester.pumpAndSettle();
}

void main() {
  setUp(useFakeBackend);

  group('room measurements', () {
    test('size and area from the outline, as labels', () {
      final RoomMeasurements m = RoomMeasurements.of(_room, heightM: 2.7);
      expect(m.wallCount, 4);
      expect(m.sizeLabel, '10.0 × 6.0 m');
      expect(m.areaLabel, '60 m²');
      expect(m.heightLabel, '2.70 m high');
    });

    test('wall height is the tallest wall in RoomPlan\'s scan.json', () async {
      final Directory dir = await Directory.systemTemp.createTemp('scanjson');
      addTearDown(() => dir.delete(recursive: true));
      final File room = File('${dir.path}/room.json')
        ..writeAsStringSync(
          jsonEncode(<String, Object?>{
            'walls': <Object?>[
              <String, Object?>{
                'dimensions': <double>[4, 2.6, 0.1],
              },
              <String, Object?>{
                'dimensions': <double>[6, 2.8, 0.1],
              },
            ],
          }),
        );
      expect(await RoomMeasurements.wallHeightFromScanJson(room.path), 2.8);

      // A merged structure that only carries its sections' rooms.
      final File structure = File('${dir.path}/structure.json')
        ..writeAsStringSync(
          jsonEncode(<String, Object?>{
            'rooms': <Object?>[
              <String, Object?>{
                'walls': <Object?>[
                  <String, Object?>{
                    'dimensions': <double>[5, 3.1, 0.1],
                  },
                ],
              },
            ],
          }),
        );
      expect(
        await RoomMeasurements.wallHeightFromScanJson(structure.path),
        3.1,
      );
      expect(
        await RoomMeasurements.wallHeightFromScanJson('${dir.path}/none'),
        isNull,
      );
    });
  });

  group('the scan library on the phone', () {
    test('keeps copies of the files, a thumbnail and the plan', () async {
      final Directory dir = await Directory.systemTemp.createTemp('library');
      addTearDown(() => dir.delete(recursive: true));
      final File model = File('${dir.path}/export/scan.usdz')
        ..createSync(recursive: true)
        ..writeAsStringSync('usdz');
      final File data = File('${dir.path}/export/scan.json')
        ..writeAsStringSync(
          jsonEncode(<String, Object?>{
            'walls': <Object?>[
              <String, Object?>{
                'dimensions': <double>[10, 2.7, 0.1],
              },
            ],
          }),
        );

      final List<String> rendered = <String>[];
      final ScanLibrary library = ScanLibrary(
        directory: () async => dir,
        thumbnailer: (String modelPath, String out) async {
          rendered.add(modelPath);
          File(out).writeAsStringSync('png');
          return out;
        },
      );
      final SavedScan? saved = await library.save(
        _result(),
        ScanExport(modelPath: model.path, dataPath: data.path, bytes: 10),
      );

      expect(saved, isNotNull);
      // Copies: the upload deletes its own files once they are sent.
      model.deleteSync();
      data.deleteSync();

      final List<SavedScan> kept = await ScanLibrary(
        directory: () async => dir,
      ).scans();
      final SavedScan scan = kept.single;
      expect(scan.title, 'Northgate · Level 2');
      expect(File(scan.modelPath!).readAsStringSync(), 'usdz');
      expect(File(scan.thumbnailPath!).existsSync(), isTrue);
      // The thumbnail is made from the kept copy (separators differ on Windows).
      String norm(String p) => p.replaceAll(r'\', '/');
      expect(norm(rendered.single), norm(scan.modelPath!));
      expect(scan.geometry.walls, hasLength(4));
      expect(scan.measurements.heightM, 2.7);
      expect(scan.measurements.areaM2, 60);

      await library.delete(scan);
      expect(await library.scans(), isEmpty);
    });

    test('a scan with no model file is still kept, as a floor plan', () async {
      final Directory dir = await Directory.systemTemp.createTemp('library');
      addTearDown(() => dir.delete(recursive: true));
      final ScanLibrary library = ScanLibrary(
        directory: () async => dir,
        thumbnailer: (_, _) async => null,
      );
      final SavedScan? saved = await library.save(_result(), null);
      expect(saved!.modelPath, isNull);
      expect(saved.thumbnailPath, isNull);
      expect((await library.scans()).single.geometry.walls, hasLength(4));
    });
  });

  group('the dashboard', () {
    Widget home() => MaterialApp(
      theme: AppTheme.dark,
      home: const HomeScreen(email: 'sam.okafor@northgatefitness.com'),
    );

    testWidgets('Floorplan opens a capture that reviews on the plan', (
      WidgetTester tester,
    ) async {
      usePhoneSize(tester);
      await tester.pumpWidget(home());
      await _settle(tester);

      await tester.tap(find.text('Floorplan'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      final NewCaptureScreen capture = tester.widget<NewCaptureScreen>(
        find.byType(NewCaptureScreen),
      );
      expect(capture.opensIn, ScanView.floorPlan);

      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('3D Space and Next level open captures too', (
      WidgetTester tester,
    ) async {
      usePhoneSize(tester);
      await tester.pumpWidget(home());
      await _settle(tester);

      await tester.tap(find.text('3D Space'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(
        tester.widget<NewCaptureScreen>(find.byType(NewCaptureScreen)).opensIn,
        ScanView.model,
      );
      await tester.pumpWidget(const SizedBox());

      await tester.pumpWidget(home());
      await _settle(tester);
      await tester.tap(find.text('Next level'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      // The fake account's highest Northgate plan is level 3.
      expect(
        tester
            .widget<NewCaptureScreen>(find.byType(NewCaptureScreen))
            .initialLevel,
        '4',
      );
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('closing the panel leaves the plain capture card', (
      WidgetTester tester,
    ) async {
      usePhoneSize(tester);
      await tester.pumpWidget(home());
      await _settle(tester);

      await tester.tap(find.bySemanticsLabel('Hide'));
      await tester.pump();
      expect(find.byType(CreatePanel), findsNothing);
      expect(find.byType(CaptureCard), findsOneWidget);
    });

    testWidgets('kept scans show in a grid and open in the viewer', (
      WidgetTester tester,
    ) async {
      usePhoneSize(tester);
      await ScanLibrary.instance.save(_result(), null);
      await tester.pumpWidget(home());
      await _settle(tester);

      expect(find.text('Your scans'), findsOneWidget);
      expect(find.byType(ScanTile), findsOneWidget);

      await tester.tap(find.byType(ScanTile));
      await _settle(tester);
      expect(find.byType(ScanViewerScreen), findsOneWidget);
      expect(find.text('Northgate · Level 2'), findsOneWidget);
    });

    testWidgets('a long press removes a scan from the phone', (
      WidgetTester tester,
    ) async {
      usePhoneSize(tester);
      await ScanLibrary.instance.save(_result(), null);
      await tester.pumpWidget(home());
      await _settle(tester);

      await tester.longPress(find.byType(ScanTile));
      await tester.pumpAndSettle();
      expect(find.text('Remove from this phone?'), findsOneWidget);
      await tester.tap(find.text('Remove'));
      await _settle(tester);

      expect(find.byType(ScanTile), findsNothing);
      expect(await ScanLibrary.instance.scans(), isEmpty);
    });
  });

  group('the full-screen viewer', () {
    Widget viewer({String? model}) => MaterialApp(
      theme: AppTheme.dark,
      home: ScanViewerScreen(
        title: 'Northgate · Level 2',
        subtitle: 'Scanned 31 Oct',
        geometry: _room,
        walls: List<WallQuality>.filled(4, WallQuality.captured),
        measurements: RoomMeasurements.of(_room, heightM: 2.7),
        modelPath: model,
      ),
    );

    testWidgets('opens on the 3D model with its measurements', (
      WidgetTester tester,
    ) async {
      usePhoneSize(tester);
      await tester.pumpWidget(viewer(model: '/scan.usdz'));
      await tester.pump();

      expect(find.byType(ScanModelPreview), findsOneWidget);
      expect(find.text('3D model'), findsOneWidget);
      expect(find.text('10.0 × 6.0 m'), findsOneWidget);
      expect(find.text('60 m²'), findsOneWidget);
      expect(find.text('2.70 m high'), findsOneWidget);
      expect(find.bySemanticsLabel('Reset view'), findsOneWidget);
      expect(find.bySemanticsLabel('Top view'), findsOneWidget);
    });

    testWidgets('switches to the measured floor plan and back', (
      WidgetTester tester,
    ) async {
      usePhoneSize(tester);
      await tester.pumpWidget(viewer(model: '/scan.usdz'));
      await tester.pump();

      await tester.tap(find.bySemanticsLabel('Show floor plan'));
      await tester.pump();
      expect(find.byType(ScanModelPreview), findsNothing);
      expect(find.text('Floor plan'), findsOneWidget);
      // The plan's own controls only.
      expect(find.bySemanticsLabel('Top view'), findsNothing);

      await tester.tap(find.bySemanticsLabel('Hide measurements'));
      await tester.pump();
      expect(find.bySemanticsLabel('Show measurements'), findsOneWidget);

      await tester.tap(find.bySemanticsLabel('Show 3D model'));
      await tester.pump();
      expect(find.byType(ScanModelPreview), findsOneWidget);
    });

    testWidgets('measure mode: tap-to-tap lengths, total, undo and done', (
      WidgetTester tester,
    ) async {
      usePhoneSize(tester);
      final ScanModelController controller = ScanModelController();
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: ScanViewerScreen(
            title: 'Northgate · Level 2',
            geometry: _room,
            walls: List<WallQuality>.filled(4, WallQuality.captured),
            measurements: RoomMeasurements.of(_room),
            modelPath: '/scan.usdz',
            controller: controller,
          ),
        ),
      );
      await tester.pump();

      await tester.tap(find.bySemanticsLabel('Measure'));
      await tester.pump();
      expect(
        find.text('Tap two points on the model to measure'),
        findsOneWidget,
      );
      expect(find.text('No measurements yet'), findsOneWidget);
      // The measure bar takes the info panel's place.
      expect(find.text('10.0 × 6.0 m'), findsNothing);

      // The native view reports each finished measurement.
      controller.measured.value = <double>[4.2];
      await tester.pump();
      expect(find.text('Last 4.20 m'), findsOneWidget);
      expect(find.text('Total 4.20 m · 1 measurement'), findsOneWidget);

      controller.measured.value = <double>[4.2, 2.65];
      await tester.pump();
      expect(find.text('Last 2.65 m'), findsOneWidget);
      expect(find.text('Total 6.85 m · 2 measurements'), findsOneWidget);
      expect(find.text('Undo'), findsOneWidget);
      expect(find.text('Clear'), findsOneWidget);

      await tester.tap(find.text('Done'));
      await tester.pump();
      expect(find.text('Tap two points on the model to measure'), findsNothing);
      expect(find.text('10.0 × 6.0 m'), findsOneWidget);
      expect(find.bySemanticsLabel('Measure'), findsOneWidget);
    });

    testWidgets('switching to the plan ends measuring', (
      WidgetTester tester,
    ) async {
      usePhoneSize(tester);
      await tester.pumpWidget(viewer(model: '/scan.usdz'));
      await tester.pump();

      await tester.tap(find.bySemanticsLabel('Measure'));
      await tester.pump();
      await tester.tap(find.bySemanticsLabel('Show floor plan'));
      await tester.pump();

      expect(find.text('Tap two points on the model to measure'), findsNothing);
      expect(find.bySemanticsLabel('Measure'), findsNothing);
    });

    testWidgets('with no model, only the floor plan', (
      WidgetTester tester,
    ) async {
      usePhoneSize(tester);
      await tester.pumpWidget(viewer());
      await tester.pump();

      expect(find.byType(ScanModelPreview), findsNothing);
      expect(find.text('Floor plan'), findsOneWidget);
      expect(find.bySemanticsLabel('Show 3D model'), findsNothing);
    });
  });

  test('wall extent stays in metres for the summary', () {
    expect(_room.wallExtentM, const Size(10, 6));
  });
}
