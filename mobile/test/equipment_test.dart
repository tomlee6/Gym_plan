// CHANGE 2 and CHANGE 3: marking gym machines, and sending them and their
// 360 walkarounds with the capture.
//
// The recorder and the viewfinder need a camera, so they are exercised on
// a device rather than here. What is covered here is everything that runs
// in Dart: how a machine is built from a scanned object, how references
// are handed out, and that the machines and videos actually reach the
// platform when a capture is submitted.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/models/equipment.dart';
import 'package:mobile/services/api_client.dart';
import 'package:mobile/services/auth_session.dart';
import 'package:mobile/services/equipment_service.dart';
import 'package:room_scan/room_scan.dart';
import 'package:mobile/services/equipment_recording.dart';

RoomScanObject object({
  int index = 0,
  Offset centre = const Offset(4, 3),
  double width = 0.85,
  double depth = 2.1,
  String category = 'storage',
  RoomScanConfidence confidence = RoomScanConfidence.high,
}) => RoomScanObject(
  index: index,
  centre: centre,
  widthM: width,
  depthM: depth,
  heightM: 1.5,
  elevationM: 0,
  rotationDeg: 90,
  category: category,
  confidence: confidence,
);

void main() {
  simulatedRecordingTests();

  group('naming a machine', () {
    test('keeps the measurements of the object the scan found', () {
      final Equipment e = Equipment.fromDetected(
        equipmentId: 'EQ-001',
        type: 'treadmill',
        name: 'Treadmill 1',
        object: object(),
      );

      expect(e.x, 4);
      expect(e.z, 3);
      expect(e.widthM, 0.85);
      expect(e.depthM, 2.1);
      expect(e.rotationDeg, 90);
      // The shape was measured; only the name was typed.
      expect(e.source, 'roomplan');
      expect(e.confidence, 0.95);
      expect(e.detectedIndex, 0);
      expect(e.placed, isTrue);
    });

    test('a machine added by hand has no position until it is placed', () {
      const Equipment e = Equipment(
        equipmentId: 'EQ-002',
        type: 'legPress',
        name: 'Leg Press',
      );
      expect(e.placed, isFalse);
      expect(e.source, 'surveyor');
      // Nothing is invented: the reviewer places and sizes it.
      expect(e.toJson()['x'], isNull);
      expect(e.toJson()['widthM'], isNull);
    });

    test('hands out references that do not collide', () {
      expect(nextEquipmentId(const <Equipment>[]), 'EQ-001');
      expect(
        nextEquipmentId(const <Equipment>[
          Equipment(equipmentId: 'EQ-001', type: 'bench', name: 'Bench'),
        ]),
        'EQ-002',
      );
    });

    test('labels a type the catalogue has never heard of', () {
      expect(equipmentLabel('treadmill'), 'Treadmill');
      expect(equipmentLabel('latPulldown'), 'Lat Pulldown');
      expect(equipmentLabel('plateLoadedHipThrust'), 'Plate Loaded Hip Thrust');
    });

    test('the catalogue is a starting point, not a closed set', () {
      const Equipment odd = Equipment(
        equipmentId: 'EQ-009',
        type: 'plateLoadedHipThrust',
        name: 'Hip thrust',
      );
      expect(kEquipmentTypes, isNot(contains(odd.type)));
      expect(odd.toJson()['type'], 'plateLoadedHipThrust');
    });
  });

  group('sending equipment and its video', () {
    late List<http.Request> requests;
    late List<List<int>> partBodies;
    late EquipmentService service;
    late Directory dir;
    late File videoFile;
    late File thumbnailFile;

    setUp(() async {
      requests = <http.Request>[];
      partBodies = <List<int>>[];
      dir = await Directory.systemTemp.createTemp('gym_equipment_test');
      videoFile = await File('${dir.path}/360.mov')
          .writeAsBytes(List<int>.generate(2048, (int i) => i % 251));
      thumbnailFile = await File('${dir.path}/360.jpg')
          .writeAsBytes(List<int>.filled(256, 9));

      final MockClient client = MockClient((http.Request req) async {
        requests.add(req);
        final String path = req.url.path;
        if (path.endsWith('/video')) {
          // The platform opens a thumbnail upload only when one was offered,
          // as the real one does.
          final bool withThumbnail =
              (jsonDecode(req.body) as Map<String, Object?>)['thumbnail'] != null;
          return http.Response(
            jsonEncode(<String, Object?>{
              'videoId': 'vid-1',
              'status': 'uploading',
              'files': <Object?>[
                <String, Object?>{
                  'kind': 'video',
                  'fileId': 'f-video',
                  'name': 'equipment/EQ-001/video/360.mov',
                  'parts': <Object?>[
                    <String, Object?>{'number': 1, 'url': 'https://storage.test/v1'},
                  ],
                },
                if (withThumbnail)
                  <String, Object?>{
                    'kind': 'thumbnail',
                    'fileId': 'f-thumb',
                    'name': 'equipment/EQ-001/thumbnail/thumbnail.jpg',
                    'parts': <Object?>[
                      <String, Object?>{'number': 1, 'url': 'https://storage.test/t1'},
                    ],
                  },
              ],
            }),
            200,
            headers: <String, String>{'content-type': 'application/json'},
          );
        }
        if (path.endsWith('/video/complete')) {
          return http.Response(
            jsonEncode(<String, Object?>{'videoId': 'vid-1', 'status': 'ready'}),
            200,
            headers: <String, String>{'content-type': 'application/json'},
          );
        }
        return http.Response(
          jsonEncode(<String, Object?>{}),
          200,
          headers: <String, String>{'content-type': 'application/json'},
        );
      });

      service = EquipmentService(
        client: ApiClient(
          baseUrl: 'https://api.test',
          session: AuthSession()
            ..signedInWith(<String, Object?>{
              'accessToken': 'test-token',
              'refreshToken': 'test-refresh',
            }),
          client: client,
        ),
        http: _RecordingHttpClient(partBodies),
      );
    });

    tearDown(() async {
      if (await dir.exists()) await dir.delete(recursive: true);
    });

    test('registers the machines against the capture', () async {
      await service.saveEquipment('cap-1', <Equipment>[
        Equipment.fromDetected(
          equipmentId: 'EQ-001',
          type: 'treadmill',
          name: 'Treadmill 1',
          object: object(),
        ),
      ]);

      final http.Request req = requests.single;
      expect(req.url.path, '/v1/captures/cap-1/equipment');
      final Map<String, Object?> body =
          jsonDecode(req.body) as Map<String, Object?>;
      final Map<String, Object?> sent =
          (body['equipment']! as List<Object?>).single! as Map<String, Object?>;
      expect(sent['equipmentId'], 'EQ-001');
      expect(sent['type'], 'treadmill');
      expect(sent['x'], 4);
    });

    test('sends nothing when no machine was marked', () async {
      await service.saveEquipment('cap-1', const <Equipment>[]);
      expect(requests, isEmpty);
    });

    test('uploads the video and its poster frame, then confirms', () async {
      final List<VideoUploadProgress> progress = <VideoUploadProgress>[];
      await service.uploadVideo(
        'cap-1',
        EquipmentVideo(
          equipmentId: 'EQ-001',
          path: videoFile.path,
          thumbnailPath: thumbnailFile.path,
          bytes: 2048,
          duration: const Duration(seconds: 24),
          contentType: 'video/quicktime',
        ),
        onProgress: progress.add,
      );

      // Opened, then confirmed: the bytes never went through the API.
      expect(requests.map((http.Request r) => r.url.path), <String>[
        '/v1/captures/cap-1/equipment/EQ-001/video',
        '/v1/captures/cap-1/equipment/EQ-001/video/complete',
      ]);

      final Map<String, Object?> opened =
          jsonDecode(requests.first.body) as Map<String, Object?>;
      expect(opened['bytes'], 2048);
      expect(opened['contentType'], 'video/quicktime');
      expect(opened['durationSeconds'], 24);
      // The poster frame was taken on the phone, so one is offered.
      expect((opened['thumbnail']! as Map<String, Object?>)['bytes'], 256);

      // Both files went to their signed URLs, part by part.
      expect(partBodies.length, 2);
      expect(partBodies.first.length, 2048);
      expect(partBodies.last.length, 256);
      expect(progress.last.fraction, 1.0);
    });

    test('skips a poster frame whose file has gone, keeping the video', () async {
      await thumbnailFile.delete();
      await service.uploadVideo(
        'cap-1',
        EquipmentVideo(
          equipmentId: 'EQ-001',
          path: videoFile.path,
          thumbnailPath: thumbnailFile.path,
          bytes: 2048,
          duration: const Duration(seconds: 9),
          contentType: 'video/quicktime',
        ),
      );
      // The walkaround still went up, and was confirmed.
      expect(partBodies.single.length, 2048);
      expect(requests.last.url.path, endsWith('/video/complete'));
    });

    test('a take with no poster frame still uploads', () async {
      await service.uploadVideo(
        'cap-1',
        EquipmentVideo(
          equipmentId: 'EQ-001',
          path: videoFile.path,
          thumbnailPath: null,
          bytes: 2048,
          duration: const Duration(seconds: 11),
          contentType: 'video/quicktime',
        ),
      );
      final Map<String, Object?> opened =
          jsonDecode(requests.first.body) as Map<String, Object?>;
      expect(opened.containsKey('thumbnail'), isFalse);
    });
  });
}

/// Catches the bytes PUT to each signed URL, standing in for storage.
class _RecordingHttpClient implements HttpClient {
  _RecordingHttpClient(this.bodies);

  final List<List<int>> bodies;

  @override
  Future<HttpClientRequest> putUrl(Uri url) async => _Request(bodies);

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _Request implements HttpClientRequest {
  _Request(this.bodies);

  final List<List<int>> bodies;
  final List<int> _buffer = <int>[];

  @override
  final HttpHeaders headers = _Headers();

  @override
  int contentLength = 0;

  @override
  void add(List<int> data) => _buffer.addAll(data);

  @override
  Future<HttpClientResponse> close() async {
    bodies.add(_buffer);
    return _Response();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _Headers implements HttpHeaders {
  @override
  void set(String name, Object value, {bool preserveHeaderCase = false}) {}

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _Response implements HttpClientResponse {
  @override
  int get statusCode => 200;

  @override
  Future<E> drain<E>([E? futureValue]) async => futureValue as E;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void simulatedRecordingTests() {
  group('a device that cannot record', () {
    test('falls back to a demo walk rather than failing', () async {
      // Tests run on the host, which has no camera for this.
      expect(await EquipmentCaptureBackend.detect(), isNull);
      expect(EquipmentCaptureBackend.usesCamera, isFalse);
      expect(EquipmentCaptureBackend.create(), isA<SimulatedRecording>());
    });

    test('produces a take marked simulated, carrying no file', () async {
      final EquipmentRecording recorder = SimulatedRecording();
      await recorder.prepare();
      await recorder.start('EQ-001');
      final EquipmentVideo take = await recorder.stop();

      expect(take.simulated, isTrue);
      expect(take.path, isEmpty);
      expect(take.bytes, 0);
      expect(take.thumbnailPath, isNull);
    });

    test('the walk animation follows how far round the machine it is', () {
      final SimulatedRecording recorder = SimulatedRecording(
        walk: const Duration(seconds: 10),
      );
      final EquipmentWalkAnimation half =
          recorder.preview(
                recording: true,
                elapsed: const Duration(seconds: 5),
              )
              as EquipmentWalkAnimation;
      expect(half.progress, closeTo(0.5, 1e-9));

      // It stops at a full lap rather than running past it.
      final EquipmentWalkAnimation over =
          recorder.preview(
                recording: true,
                elapsed: const Duration(seconds: 30),
              )
              as EquipmentWalkAnimation;
      expect(over.progress, 1.0);
    });
  });
}
