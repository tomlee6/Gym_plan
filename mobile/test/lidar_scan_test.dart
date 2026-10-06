import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:room_scan/room_scan.dart';

import 'package:mobile/models/scan.dart';
import 'package:mobile/screens/scanning_screen.dart';
import 'package:mobile/services/lidar_scan_session.dart';
import 'package:mobile/services/capture_service.dart';
import 'package:mobile/services/scan_backend.dart';
import 'package:mobile/theme/app_theme.dart';

import 'phone_size.dart';
import 'support/fake_backend.dart';
import 'package:mobile/widgets/primary_button.dart';

const MethodChannel _methods = MethodChannel('flex/room_scan');
const EventChannel _events = EventChannel('flex/room_scan/events');

const ScanConfig _config = ScanConfig(
  facilityId: 'fac_northgate',
  facility: 'Northgate Fitness',
  level: 2,
  heightM: 3.2,
);

/// A 10 × 6 m room, as the native side would send it.
Map<String, Object?> _room({
  String eastConfidence = 'high',
  bool closed = true,
  String? instruction,
}) => <String, Object?>{
  'type': 'update',
  'elapsedMs': 65000,
  'walls': <Object?>[
    _wall(0, 0, 10, 0),
    _wall(10, 0, 10, 6, confidence: eastConfidence),
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
  ],
  'coverage': 0.93,
  'closed': closed,
  'areaM2': 60.0,
  'position': <double>[5, 3],
  'heading': 1.57,
  'instruction': ?instruction,
};

Map<String, Object?> _wall(
  double x1,
  double y1,
  double x2,
  double y2, {
  String confidence = 'high',
}) => <String, Object?>{
  'a': <double>[x1, y1],
  'b': <double>[x2, y2],
  'confidence': confidence,
};

/// Stands in for the Swift plugin: records calls and lets a test push
/// events down the stream.
class _FakeNative {
  _FakeNative(this.messenger, {this.supported = true}) {
    messenger.setMockMethodCallHandler(_methods, _handle);
    messenger.setMockStreamHandler(
      _events,
      MockStreamHandler.inline(
        // A block body: an arrow would return the sink as the reply.
        onListen: (Object? _, MockStreamHandlerEventSink sink) {
          _sink = sink;
        },
      ),
    );
  }

  final TestDefaultBinaryMessenger messenger;
  final bool supported;
  final List<String> calls = <String>[];
  MockStreamHandlerEventSink? _sink;

  Future<Object?> _handle(MethodCall call) async {
    calls.add(call.method);
    switch (call.method) {
      case 'deviceInfo':
        return <String, Object?>{
          'supported': supported,
          'model': 'iPhone',
          'systemVersion': '18.2',
          if (!supported) 'reason': 'This device has no LiDAR sensor.',
        };
      case 'capturePhoto':
        return '/scans/abc/photo-1.jpg';
      case 'finish':
        return <String, Object?>{
          'usdzPath': '/scans/abc/scan.usdz',
          'jsonPath': '/scans/abc/scan.json',
          'bytes': 12 * 1024 * 1024,
          'room': _room(),
        };
    }
    return null;
  }

  void send(Map<String, Object?> event) => _sink!.success(event);

  void dispose() {
    messenger.setMockMethodCallHandler(_methods, null);
    messenger.setMockStreamHandler(_events, null);
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final TestDefaultBinaryMessenger messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  setUp(() => useFakeBackend());

  group('RoomScanUpdate', () {
    test('parses walls, objects, pose and coaching', () {
      final RoomScanUpdate u = RoomScanUpdate.fromMap(
        _room(eastConfidence: 'low', instruction: 'Slow down'),
      );
      expect(u.walls, hasLength(4));
      expect(u.walls[1].start, const Offset(10, 0));
      expect(u.walls[1].confidence, RoomScanConfidence.low);
      expect(u.objects.single, hasLength(4));
      expect(u.position, const Offset(5, 3));
      expect(u.elapsed, const Duration(seconds: 65));
      expect(u.areaM2, 60);
      expect(u.instruction, 'Slow down');
    });

    test('tolerates a bare update with nothing found yet', () {
      final RoomScanUpdate u = RoomScanUpdate.fromMap(<Object?, Object?>{
        'type': 'update',
      });
      expect(u.walls, isEmpty);
      expect(u.position, isNull);
      expect(u.closed, isFalse);
    });
  });

  group('LidarScanSession', () {
    late _FakeNative native;
    setUp(() => native = _FakeNative(messenger));
    tearDown(() => native.dispose());

    test('streams RoomPlan updates into the plan', () async {
      final LidarScanSession session = LidarScanSession(config: _config);
      addTearDown(session.dispose);

      session.start();
      await pumpEventQueue();
      expect(native.calls, contains('start'));
      expect(session.geometry.walls, isEmpty);

      native.send(_room(eastConfidence: 'low', instruction: 'Slow down'));
      await pumpEventQueue();

      expect(session.geometry.walls, hasLength(4));
      expect(session.walls, <WallQuality>[
        WallQuality.captured,
        WallQuality.weak,
        WallQuality.captured,
        WallQuality.captured,
      ]);
      expect(session.weakWalls.single.length, 6);
      expect(session.coverage, 0.93);
      expect(session.closed, isTrue);
      expect(session.elapsed, const Duration(seconds: 65));
      expect(session.walker!.$1, const Offset(5, 3));
      expect(session.instruction, 'Slow down');
      expect(session.geometry.areaM2, 60);
      // The frame covers the room plus a margin.
      expect(session.geometry.frame.contains(Offset.zero), isTrue);
      expect(session.geometry.frame.contains(const Offset(10, 6)), isTrue);
    });

    test('pause and resume reach the native scan', () async {
      final LidarScanSession session = LidarScanSession(config: _config);
      addTearDown(session.dispose);

      session.start();
      session.pause();
      session.start();
      await pumpEventQueue();

      expect(
        native.calls,
        containsAllInOrder(<String>['start', 'pause', 'resume']),
      );
      expect(session.running, isTrue);
    });

    test('photos are saved by the scan and kept for upload', () async {
      final LidarScanSession session = LidarScanSession(config: _config);
      addTearDown(session.dispose);
      session.start();

      await session.addPhoto();

      expect(session.photos, 1);
      expect(session.finish().photoPaths, <String>['/scans/abc/photo-1.jpg']);
    });

    test('tags land where the phone is', () async {
      final LidarScanSession session = LidarScanSession(config: _config);
      addTearDown(session.dispose);
      session.start();
      native.send(_room());
      await pumpEventQueue();

      final ScanTag tag = session.addTag(TagType.fireExit);
      expect(tag.position, const Offset(5, 3));
    });

    test('export returns the model files and ends the scan', () async {
      final LidarScanSession session = LidarScanSession(config: _config);
      session.start();

      final ScanExport export = await session.export();

      expect(export.modelPath, '/scans/abc/scan.usdz');
      expect(export.dataPath, '/scans/abc/scan.json');
      expect(export.bytes, 12 * 1024 * 1024);

      // An exported scan has already ended natively; disposing must not
      // try to stop it again.
      session.dispose();
      await pumpEventQueue();
      expect(native.calls.where((String c) => c == 'stop'), isEmpty);
    });

    test('discarding stops the native scan', () async {
      final LidarScanSession session = LidarScanSession(config: _config);
      session.start();
      session.dispose();
      await pumpEventQueue();
      expect(native.calls, contains('stop'));
    });

    test('a native failure is surfaced, not swallowed', () async {
      final LidarScanSession session = LidarScanSession(config: _config);
      addTearDown(session.dispose);
      session.start();
      await pumpEventQueue();

      native.send(<String, Object?>{
        'type': 'error',
        'code': 'scan_failed',
        'message': 'Camera access is off.',
      });
      await pumpEventQueue();

      expect(session.error, 'Camera access is off.');
      expect(session.running, isFalse);
    });
  });

  group('ScanBackend', () {
    tearDown(() => debugDefaultTargetPlatformOverride = null);

    test('a LiDAR iPhone scans for real', () async {
      final _FakeNative native = _FakeNative(messenger);
      addTearDown(native.dispose);
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;

      final DeviceCapability device = await ScanBackend.detect();

      expect(device.supported, isTrue);
      expect(device.headline, 'LiDAR ready');
      expect(device.detail, 'iPhone · iOS 18.2');
      expect(ScanBackend.usesLidar, isTrue);
      expect(ScanBackend.createSession(_config), isA<LidarScanSession>());
    });

    test('an iPhone without LiDAR falls back to the demo in debug', () async {
      final _FakeNative native = _FakeNative(messenger, supported: false);
      addTearDown(native.dispose);
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;

      final DeviceCapability device = await ScanBackend.detect();

      expect(device, same(ScanBackend.simulated));
      expect(ScanBackend.usesLidar, isFalse);
    });

    test('other platforms never touch the native scanner', () async {
      final _FakeNative native = _FakeNative(messenger);
      addTearDown(native.dispose);
      debugDefaultTargetPlatformOverride = TargetPlatform.android;

      await ScanBackend.detect();

      expect(native.calls, isEmpty);
      expect(ScanBackend.usesLidar, isFalse);
    });
  });

  group('Scanning screen on a LiDAR scan', () {
    late _FakeNative native;

    /// Native events land after the current frame; one more shows them.
    Future<void> settle(WidgetTester tester) async {
      await tester.pump();
      await tester.pump();
    }

    Future<LidarScanSession> open(WidgetTester tester) async {
      // Registered here rather than in setUp: setUp runs outside the widget
      // test's fake-time zone, and events sent from there never arrive.
      native = _FakeNative(tester.binding.defaultBinaryMessenger);
      addTearDown(native.dispose);
      usePhoneSize(tester);
      final LidarScanSession session = LidarScanSession(config: _config);
      addTearDown(session.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: ScanningScreen(config: _config, session: session),
        ),
      );
      await tester.pump();
      return session;
    }

    testWidgets('guides the start, then draws the room as it arrives', (
      WidgetTester tester,
    ) async {
      await open(tester);

      expect(find.text('Start at a corner'), findsOneWidget);
      expect(find.text('00:00'), findsOneWidget);

      native.send(_room(eastConfidence: 'low', instruction: 'Slow down'));
      await settle(tester);

      expect(find.text('Slow down'), findsOneWidget);
      expect(find.text('93%'), findsOneWidget);
      expect(find.text('01:05'), findsOneWidget);
      expect(find.text('One wall reads weak'), findsOneWidget);
      expect(find.textContaining('One wall was captured'), findsOneWidget);
    });

    testWidgets('a failed scan says why and blocks finishing', (
      WidgetTester tester,
    ) async {
      await open(tester);

      native.send(<String, Object?>{
        'type': 'error',
        'message': 'Camera access is off.',
      });
      await settle(tester);

      expect(find.text('Scanning stopped'), findsOneWidget);
      expect(find.text('Camera access is off.'), findsOneWidget);
      await tester.tap(find.text('Finish scan'));
      await settle(tester);
      expect(find.text('Finish without closing?'), findsNothing);
    });

    testWidgets('submitting exports the model before uploading', (
      WidgetTester tester,
    ) async {
      await open(tester);
      native.send(_room());
      await settle(tester);

      await tester.tap(find.text('Finish scan'));
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('Review before submit'), findsOneWidget);
      expect(find.text('Northgate Fitness · Level 2 · 60 m²'), findsOneWidget);

      await _finishEquipmentStep(tester);
      await tester.tap(find.text('Submit scan'));
      await tester.pump();
      await tester.pump(const Duration(seconds: 2));

      expect(native.calls, contains('finish'));
      expect(find.text('Uploading in the background'), findsOneWidget);
      // Sized from the exported files, not the simulated estimate.
      expect(find.textContaining('MB of 12 MB'), findsOneWidget);

      await tester.pumpWidget(const SizedBox());
    });
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
