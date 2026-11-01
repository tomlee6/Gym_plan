// 3D Space (the whole room as a coloured LiDAR mesh) and 3D Object (Apple's
// Object Capture). The capture itself is ARKit and RealityKit and needs an
// iPhone; what is covered here is everything the app does around it.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:room_scan/room_scan.dart';

import 'package:mobile/models/scan.dart';
import 'package:mobile/screens/home_screen.dart';
import 'package:mobile/screens/mesh_scan_screen.dart';
import 'package:mobile/screens/scan_viewer_screen.dart';
import 'package:mobile/screens/uploading_screen.dart';
import 'package:mobile/services/capture_modes.dart';
import 'package:mobile/services/object_uploads.dart';
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

const MeshScanExport _mesh = MeshScanExport(
  objPath: '/spaces/a/mesh.obj',
  scenePath: '/spaces/a/space.scn',
  bytes: 40 * 1024 * 1024,
  vertexCount: 412000,
  widthM: 18.2,
  lengthM: 11.5,
  heightM: 3.1,
  duration: Duration(minutes: 4),
);

/// Stands in for the native mesh scanner.
class _FakeMeshScanning implements MeshScanning {
  _FakeMeshScanning({this.fails = false});

  final bool fails;
  final List<String> calls = <String>[];
  int vertices = 0;

  @override
  Future<void> prepare() async => calls.add('prepare');

  @override
  Future<void> start() async => calls.add('start');

  @override
  Future<MeshScanStatus> status() async => MeshScanStatus(
    elapsed: const Duration(seconds: 42),
    vertices: vertices,
    limitedTracking: false,
  );

  @override
  Future<MeshScanExport> finish() async {
    calls.add('finish');
    if (fails) {
      throw const RoomScanException('mesh_failed', 'Nothing was scanned.');
    }
    return _mesh;
  }

  @override
  Future<void> cancel() async => calls.add('cancel');
}

Future<void> _openMeshScan(WidgetTester tester, _FakeMeshScanning scan) async {
  usePhoneSize(tester);
  await tester.pumpWidget(
    MaterialApp(
      theme: AppTheme.dark,
      home: Builder(
        builder: (BuildContext context) => Center(
          child: TextButton(
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => MeshScanScreen(config: _config, scanning: scan),
              ),
            ),
            child: const Text('launch'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('launch'));
  await tester.pumpAndSettle();
}

final Finder _start = find.byKey(const ValueKey<String>('start-space'));
final Finder _finish = find.byKey(const ValueKey<String>('finish-space'));

void main() {
  late ({FakeBackend backend, FakeUploadQueue uploads}) fakes;
  setUp(() => fakes = useFakeBackend());

  group('3D Space', () {
    testWidgets('camera first; the button starts the mesh, points count up', (
      WidgetTester tester,
    ) async {
      final _FakeMeshScanning scan = _FakeMeshScanning();
      await _openMeshScan(tester, scan);

      expect(scan.calls, <String>['prepare']);
      expect(find.byType(MeshScanPreview), findsOneWidget);
      expect(find.textContaining('tap the button to start'), findsOneWidget);

      await tester.tap(_start);
      await tester.pump();
      expect(scan.calls, contains('start'));

      scan.vertices = 128400;
      await tester.pump(const Duration(milliseconds: 600));
      expect(find.text('128k points'), findsOneWidget);
      expect(find.text('00:42'), findsOneWidget);
      expect(find.textContaining('purple mesh'), findsOneWidget);
      expect(_finish, findsOneWidget);

      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('finishing builds the mesh, review shows it, submit uploads', (
      WidgetTester tester,
    ) async {
      final _FakeMeshScanning scan = _FakeMeshScanning();
      await _openMeshScan(tester, scan);
      await tester.tap(_start);
      await tester.pump();
      await tester.tap(_finish);
      await tester.pumpAndSettle();

      expect(find.byType(MeshReviewScreen), findsOneWidget);
      expect(find.text('Your 3D space'), findsOneWidget);
      final ScanModelPreview preview = tester.widget<ScanModelPreview>(
        find.byType(ScanModelPreview),
      );
      expect(preview.modelPath, '/spaces/a/space.scn');
      expect(find.text('18.2 × 11.5 m'), findsOneWidget);
      expect(find.text('3.10 m high'), findsOneWidget);
      // A mesh has no walls to count.
      expect(find.textContaining('walls'), findsNothing);

      await tester.tap(find.text('Submit 3D space'));
      await tester.pumpAndSettle();

      expect(find.byType(UploadingScreen), findsOneWidget);
      // Uploaded as a capture carrying the mesh, at the chosen level.
      expect(fakes.uploads.meshes.single, '/spaces/a/mesh.obj');
      expect(fakes.uploads.exports.single, isNull);
      expect(fakes.uploads.enqueued.single.config.level, 2);
      // And kept on the phone as a 3D Space.
      final SavedScan kept = (await ScanLibrary.instance.scans()).single;
      expect(kept.kind, ScanKind.space);
      expect(kept.modelPath, '/spaces/a/space.scn');
      expect(kept.measurements.widthM, 18.2);
    });

    testWidgets('a mesh that cannot be built is said so, then closed', (
      WidgetTester tester,
    ) async {
      final _FakeMeshScanning scan = _FakeMeshScanning(fails: true);
      await _openMeshScan(tester, scan);
      await tester.tap(_start);
      await tester.pump();
      await tester.tap(_finish);
      await tester.pumpAndSettle();

      expect(find.text('The 3D space could not be built'), findsOneWidget);
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();
      expect(find.byType(MeshScanScreen), findsNothing);
      expect(fakes.uploads.enqueued, isEmpty);
    });

    testWidgets('closing asks only once something has been scanned', (
      WidgetTester tester,
    ) async {
      final _FakeMeshScanning scan = _FakeMeshScanning();
      await _openMeshScan(tester, scan);

      await tester.tap(find.bySemanticsLabel('Close'));
      await tester.pumpAndSettle();
      expect(find.byType(MeshScanScreen), findsNothing);
      expect(scan.calls, contains('cancel'));

      await tester.tap(find.text('launch'));
      await tester.pumpAndSettle();
      await tester.tap(_start);
      await tester.pump();
      await tester.tap(find.bySemanticsLabel('Close'));
      await tester.pumpAndSettle();
      expect(find.text('Discard this 3D space?'), findsOneWidget);
      await tester.tap(find.text('Keep scanning'));
      await tester.pumpAndSettle();
      expect(find.byType(MeshScanScreen), findsOneWidget);

      await tester.pumpWidget(const SizedBox());
    });
  });

  group('3D Object', () {
    Widget home() => MaterialApp(
      theme: AppTheme.dark,
      home: const HomeScreen(email: 'sam.okafor@northgatefitness.com'),
    );

    Future<void> openHome(WidgetTester tester) async {
      tester.view.physicalSize = const Size(393, 1400) * 3;
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(home());
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      await tester.pumpAndSettle();
    }

    testWidgets('the dashboard offers four things to create', (
      WidgetTester tester,
    ) async {
      await openHome(tester);
      for (final String label in <String>[
        'Floorplan',
        '3D Space',
        '3D Object',
        'Next level',
      ]) {
        expect(find.text(label), findsOneWidget);
      }
    });

    testWidgets('captures, names and keeps an object, then opens it', (
      WidgetTester tester,
    ) async {
      CaptureModes.objectCaptureSupported = () async => true;
      CaptureModes.captureObject = () async => const ObjectCaptureResult(
        modelPath: '/objects/a/object.usdz',
        photos: 84,
        bytes: 9 * 1024 * 1024,
      );
      await openHome(tester);

      await tester.tap(find.text('3D Object'));
      await tester.pumpAndSettle();
      expect(find.text('Name this object'), findsOneWidget);
      await tester.enterText(find.byType(EditableText), 'Leg press');
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      // Opened in the viewer: 3D only, measurable, no floor plan.
      expect(find.byType(ScanViewerScreen), findsOneWidget);
      expect(find.text('Leg press'), findsOneWidget);
      expect(find.bySemanticsLabel('Measure'), findsOneWidget);
      expect(find.bySemanticsLabel('Show floor plan'), findsNothing);

      final SavedScan kept = (await ScanLibrary.instance.scans()).single;
      expect(kept.kind, ScanKind.object);
      expect(kept.modelPath, '/objects/a/object.usdz');

      // Back on the dashboard, tagged as an object.
      await tester.tap(find.bySemanticsLabel('Close'));
      await tester.pumpAndSettle();
      final ScanTile tile = tester.widget<ScanTile>(find.byType(ScanTile));
      expect(tile.tag, 'Object');
    });

    testWidgets('without Object Capture support it says so', (
      WidgetTester tester,
    ) async {
      CaptureModes.objectCaptureSupported = () async => false;
      bool captured = false;
      CaptureModes.captureObject = () async {
        captured = true;
        return null;
      };
      await openHome(tester);

      await tester.tap(find.text('3D Object'));
      await tester.pumpAndSettle();
      expect(find.text('LiDAR required'), findsOneWidget);
      expect(captured, isFalse);
    });

    testWidgets('cancelling the capture keeps nothing', (
      WidgetTester tester,
    ) async {
      CaptureModes.objectCaptureSupported = () async => true;
      CaptureModes.captureObject = () async => null;
      await openHome(tester);

      await tester.tap(find.text('3D Object'));
      await tester.pumpAndSettle();
      expect(find.text('Name this object'), findsNothing);
      expect(await ScanLibrary.instance.scans(), isEmpty);
    });

    testWidgets('a new object is sent to the platform, once', (
      WidgetTester tester,
    ) async {
      CaptureModes.objectCaptureSupported = () async => true;
      CaptureModes.captureObject = () async => const ObjectCaptureResult(
        modelPath: '/objects/a/object.usdz',
        photos: 84,
        bytes: 9 * 1024 * 1024,
      );
      await openHome(tester);
      await tester.tap(find.text('3D Object'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(EditableText), 'Leg press');
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      final FakeObjectUploads uploads =
          ObjectUploads.instance as FakeObjectUploads;
      expect(uploads.sent.single.title, 'Leg press');
      expect(uploads.sent.single.photos, 84);
      final SavedScan kept = (await ScanLibrary.instance.scans()).single;
      expect(kept.platformId, 'obj_${kept.id}');

      // Reloading the dashboard does not send it again.
      await tester.tap(find.bySemanticsLabel('Close'));
      await tester.pumpAndSettle();
      ScanLibrary.instance.notifyListeners();
      await tester.pumpAndSettle();
      expect(uploads.sent, hasLength(1));
    });

    testWidgets('with no signal it stays on the phone, then goes later', (
      WidgetTester tester,
    ) async {
      final FakeObjectUploads uploads =
          ObjectUploads.instance as FakeObjectUploads..offline = true;
      await ScanLibrary.instance.saveObject(
        'Rower',
        const ObjectCaptureResult(
          modelPath: '/objects/b/object.usdz',
          photos: 60,
          bytes: 1,
        ),
      );
      await openHome(tester);
      expect(uploads.sent, isEmpty);
      expect((await ScanLibrary.instance.scans()).single.platformId, isNull);

      await tester.tap(find.byType(ScanTile));
      await tester.pumpAndSettle();
      expect(
        find.textContaining('on this phone, sent when online'),
        findsOneWidget,
      );
      await tester.tap(find.bySemanticsLabel('Close'));
      await tester.pumpAndSettle();

      // Back online: the next load sends it.
      uploads.offline = false;
      ScanLibrary.instance.notifyListeners();
      await tester.pumpAndSettle();
      expect(uploads.sent.single.title, 'Rower');
      expect((await ScanLibrary.instance.scans()).single.platformId, isNotNull);
    });
  });

  test('spaces and objects are kept on disk with their kind', () async {
    final Directory dir = await Directory.systemTemp.createTemp('kinds');
    addTearDown(() => dir.delete(recursive: true));
    final File scene = File('${dir.path}/in/space.scn')
      ..createSync(recursive: true)
      ..writeAsStringSync('scn');
    final File usdz = File('${dir.path}/in/object.usdz')
      ..writeAsStringSync('usdz');
    final ScanLibrary library = ScanLibrary(
      directory: () async => dir,
      thumbnailer: (_, String out) async {
        File(out).writeAsStringSync('png');
        return out;
      },
    );

    await library.saveSpace(
      _config,
      MeshScanExport(
        objPath: '${dir.path}/in/mesh.obj',
        scenePath: scene.path,
        bytes: 3,
        vertexCount: 10,
        widthM: 5,
        lengthM: 4,
        heightM: 2.5,
      ),
    );
    await library.saveObject(
      'Rower',
      ObjectCaptureResult(modelPath: usdz.path, photos: 60, bytes: 4),
    );

    final List<SavedScan> kept = await ScanLibrary(
      directory: () async => dir,
    ).scans();
    expect(kept.map((SavedScan s) => s.kind).toSet(), <ScanKind>{
      ScanKind.space,
      ScanKind.object,
    });
    final SavedScan space = kept.firstWhere(
      (SavedScan s) => s.kind == ScanKind.space,
    );
    expect(space.title, 'Northgate · Level 2 · 3D Space');
    expect(File(space.modelPath!).readAsStringSync(), 'scn');
    expect(space.thumbnailPath, isNotNull);
    expect(space.measurements.heightM, 2.5);
    expect(space.geometry.walls, isEmpty);
    final SavedScan object = kept.firstWhere(
      (SavedScan s) => s.kind == ScanKind.object,
    );
    expect(object.title, 'Rower');
    expect(File(object.modelPath!).readAsStringSync(), 'usdz');
    expect(object.photos, 60);
    expect(object.platformId, isNull);

    // Once sent, it is remembered as sent.
    await library.markSent(object, 'obj_1');
    final SavedScan sent = (await ScanLibrary(
      directory: () async => dir,
    ).scans()).firstWhere((SavedScan s) => s.kind == ScanKind.object);
    expect(sent.platformId, 'obj_1');
  });
}
