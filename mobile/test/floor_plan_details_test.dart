// The measured floor plan's drawing details: doors, windows and open
// doorways from RoomPlan, names for the objects it recognises, door and
// window counts, and a plan squared up however the scan began.
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:room_scan/room_scan.dart';

import 'package:mobile/models/room_measurements.dart';
import 'package:mobile/models/scan.dart';
import 'package:mobile/screens/scan_viewer_screen.dart';
import 'package:mobile/services/lidar_scan_session.dart';
import 'package:mobile/services/scan_library.dart';
import 'package:mobile/theme/app_theme.dart';
import 'package:mobile/widgets/floor_plan.dart';

import 'support/fake_backend.dart';

const MethodChannel _methods = MethodChannel('flex/room_scan');
const EventChannel _events = EventChannel('flex/room_scan/events');

const ScanConfig _config = ScanConfig(
  facilityId: 'fac_northgate',
  facility: 'Northgate Fitness',
  level: 2,
  heightM: 3.2,
);

Map<String, Object?> _wall(double x1, double y1, double x2, double y2) =>
    <String, Object?>{
      'a': <double>[x1, y1],
      'b': <double>[x2, y2],
      'confidence': 'high',
    };

Map<String, Object?> _detected(int index, String category) => <String, Object?>{
  'index': index,
  'x': 3.0,
  'z': 2.5,
  'elevationM': 0.0,
  'widthM': 2.0,
  'depthM': 1.0,
  'heightM': 0.8,
  'rotationDeg': 0.0,
  'category': category,
  'confidence': 'high',
};

/// A 10 × 6 m room with a door, two windows and an open doorway, a table
/// RoomPlan knows and a machine it does not.
Map<String, Object?> _room() => <String, Object?>{
  'type': 'update',
  'walls': <Object?>[
    _wall(0, 0, 10, 0),
    _wall(10, 0, 10, 6),
    _wall(10, 6, 0, 6),
    _wall(0, 6, 0, 0),
  ],
  'objects': <Object?>[
    <Object?>[
      <double>[2, 2],
      <double>[4, 2],
      <double>[4, 3],
      <double>[2, 3],
    ],
    <Object?>[
      <double>[6, 2],
      <double>[8, 2],
      <double>[8, 4],
      <double>[6, 4],
    ],
  ],
  'detected': <Object?>[_detected(0, 'table'), _detected(1, 'object')],
  'openings': <Object?>[
    <String, Object?>{
      'kind': 'door',
      'a': <double>[4, 6],
      'b': <double>[5, 6],
    },
    <String, Object?>{
      'kind': 'window',
      'a': <double>[2, 0],
      'b': <double>[4, 0],
    },
    <String, Object?>{
      'kind': 'window',
      'a': <double>[6, 0],
      'b': <double>[8, 0],
    },
    <String, Object?>{
      'kind': 'opening',
      'a': <double>[10, 2],
      'b': <double>[10, 3.5],
    },
  ],
  'coverage': 1.0,
  'closed': true,
  'areaM2': 60.0,
};

Offset _turn(Offset p, double r) => Offset(
  p.dx * math.cos(r) - p.dy * math.sin(r),
  p.dx * math.sin(r) + p.dy * math.cos(r),
);

final List<WallSegment> _square = <WallSegment>[
  const WallSegment(Offset(0, 0), Offset(10, 0)),
  const WallSegment(Offset(10, 0), Offset(10, 6)),
  const WallSegment(Offset(10, 6), Offset(0, 6)),
  const WallSegment(Offset(0, 6), Offset(0, 0)),
];

final PlanGeometry _plan = PlanGeometry.fitted(
  walls: _square,
  objects: const <List<Offset>>[
    <Offset>[Offset(2, 2), Offset(4, 2), Offset(4, 3), Offset(2, 3)],
  ],
  labels: const <String?>['Table'],
  openings: const <PlanOpening>[
    PlanOpening(OpeningKind.door, Offset(4, 6), Offset(5, 6)),
    PlanOpening(OpeningKind.window, Offset(2, 0), Offset(4, 0)),
    PlanOpening(OpeningKind.opening, Offset(10, 2), Offset(10, 3.5)),
  ],
  areaM2: 60,
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(useFakeBackend);

  test('an update carries its doors, windows and openings', () {
    final RoomScanUpdate u = RoomScanUpdate.fromMap(_room());
    expect(u.openings.map((RoomScanOpening o) => o.kind), <String>[
      'door',
      'window',
      'window',
      'opening',
    ]);
    expect(u.openings.first.start, const Offset(4, 6));
    expect(u.openings.first.end, const Offset(5, 6));
    // Older updates have none.
    expect(
      RoomScanUpdate.fromMap(<Object?, Object?>{'type': 'update'}).openings,
      isEmpty,
    );
  });

  test('the LiDAR session puts them, and object names, on the plan', () async {
    final TestDefaultBinaryMessenger messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    MockStreamHandlerEventSink? sink;
    messenger.setMockMethodCallHandler(_methods, (_) async => null);
    messenger.setMockStreamHandler(
      _events,
      MockStreamHandler.inline(
        onListen: (Object? _, MockStreamHandlerEventSink s) {
          sink = s;
        },
      ),
    );
    addTearDown(() {
      messenger.setMockMethodCallHandler(_methods, null);
      messenger.setMockStreamHandler(_events, null);
    });

    final LidarScanSession session = LidarScanSession(config: _config);
    addTearDown(session.dispose);
    session.start();
    await pumpEventQueue();
    sink!.success(_room());
    await pumpEventQueue();

    final PlanGeometry g = session.geometry;
    expect(g.countOf(OpeningKind.door), 1);
    expect(g.countOf(OpeningKind.window), 2);
    expect(g.countOf(OpeningKind.opening), 1);
    // RoomPlan's "object" is no name at all: most machines.
    expect(g.labels, <String?>['Table', null]);
    expect(LidarScanSession.planLabel('washerDryer'), 'Washer');
    expect(LidarScanSession.planLabel('object'), isNull);
  });

  group('squaring up', () {
    test('a square plan is left as it is', () {
      expect(PlanGeometry.fitted(walls: _square).rotation, 0);
    });

    test('a room scanned at an angle is drawn square, measured true', () {
      const double angle = 0.52; // About 30°.
      final PlanGeometry g = PlanGeometry.fitted(
        walls: <WallSegment>[
          for (final WallSegment w in _square)
            WallSegment(_turn(w.start, angle), _turn(w.end, angle)),
        ],
      );
      expect(g.rotation, closeTo(angle, 1e-9));
      // Width × length along the walls, not of the tilted box round them.
      final Size extent = g.wallExtentM!;
      expect(extent.width, closeTo(10, 1e-9));
      expect(extent.height, closeTo(6, 1e-9));
      expect(
        g.toDrawing(_turn(const Offset(10, 0), angle)).dx,
        closeTo(10, 1e-9),
      );
      expect(
        g.fromDrawing(g.toDrawing(const Offset(3, 4))).dx,
        closeTo(3, 1e-9),
      );

      // A tap on the drawing still finds the plan point under it.
      const Size size = Size(325, 290);
      final Offset p = _turn(const Offset(7, 2), angle);
      final double scale = math.min(
        size.width / g.frame.width,
        size.height / g.frame.height,
      );
      final Offset origin = Offset(
        (size.width - g.frame.width * scale) / 2,
        (size.height - g.frame.height * scale) / 2,
      );
      final Offset local = origin + (g.toDrawing(p) - g.frame.topLeft) * scale;
      final Offset back = FloorPlanView.planPointAt(size, g, local);
      expect((back - p).distance, lessThan(1e-9));
    });
  });

  test('measurements count doors and windows, and keep them', () {
    final RoomMeasurements m = RoomMeasurements.of(_plan);
    expect(m.doorCount, 1);
    expect(m.windowCount, 1);
    final RoomMeasurements again = RoomMeasurements.fromJson(m.toJson());
    expect(again.doorCount, 1);
    expect(again.windowCount, 1);
    // Kept before there were counts: none.
    expect(RoomMeasurements.fromJson(const <String, Object?>{}).doorCount, 0);
  });

  testWidgets('the chips say how many doors and windows', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: const Scaffold(
          body: MeasurementChips(
            measurements: RoomMeasurements(
              wallCount: 4,
              doorCount: 1,
              windowCount: 3,
            ),
          ),
        ),
      ),
    );
    expect(find.text('1 door'), findsOneWidget);
    expect(find.text('3 windows'), findsOneWidget);
  });

  testWidgets('the measured plan draws them', (WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: Center(
            child: SizedBox(
              width: 325,
              child: FloorPlanView(
                geometry: _plan,
                walls: List<WallQuality>.filled(4, WallQuality.captured),
                showDimensions: true,
              ),
            ),
          ),
        ),
      ),
    );
    expect(tester.takeException(), isNull);
    expect(find.byType(FloorPlanView), findsOneWidget);
  });

  test('kept scans keep their doors, windows and names', () async {
    final Directory dir = await Directory.systemTemp.createTemp('details');
    addTearDown(() => dir.delete(recursive: true));
    final ScanLibrary library = ScanLibrary(
      directory: () async => dir,
      thumbnailer: (_, _) async => null,
    );
    await library.save(
      ScanResult(
        config: _config,
        geometry: _plan,
        coverage: 1,
        closed: true,
        walls: List<WallQuality>.filled(4, WallQuality.captured),
        tags: const <ScanTag>[],
        photos: 0,
        elapsed: const Duration(minutes: 3),
      ),
      null,
    );

    final SavedScan kept = (await ScanLibrary(
      directory: () async => dir,
    ).scans()).single;
    expect(kept.geometry.openings.map((PlanOpening o) => o.kind), <OpeningKind>[
      OpeningKind.door,
      OpeningKind.window,
      OpeningKind.opening,
    ]);
    expect(kept.geometry.openings.first.end, const Offset(5, 6));
    expect(kept.geometry.labels, <String?>['Table']);
    expect(kept.measurements.doorCount, 1);
  });
}
