import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:mobile/models/scan.dart';
import 'package:mobile/services/api_client.dart';
import 'package:mobile/services/auth_session.dart';
import 'package:mobile/services/background_upload_queue.dart';
import 'package:mobile/services/gym_plan_api.dart';
import 'package:mobile/services/part_transport.dart';
import 'package:mobile/services/upload_queue.dart';

/// Tiny parts, so a few KB of test data spans several of them.
const int _partSize = 1024;

const ScanConfig _config = ScanConfig(
  facilityId: 'fac_northgate',
  facility: 'Northgate Fitness',
  level: 2,
  heightM: 3.2,
);

/// Stands in for the Gym Plan backend.
class _FakeBackend {
  final List<http.Request> requests = <http.Request>[];
  int urlVersion = 1;

  /// Knobs for failure cases.
  int offlineCalls = 0;
  bool unauthorised = false;
  String completeStatus = 'received';

  /// Answered once to /complete, as `{fileId, parts}` never received.
  Map<String, Object?>? missingOnce;

  late final MockClient client = MockClient((http.Request req) async {
    requests.add(req);
    if (offlineCalls > 0) {
      offlineCalls--;
      throw http.ClientException('Network is unreachable');
    }
    if (unauthorised) return http.Response('{"message":"Token expired"}', 401);

    final String path = req.url.path;
    final Map<String, Object?> body =
        jsonDecode(req.body) as Map<String, Object?>;

    if (path == '/v1/captures') {
      return _json(<String, Object?>{'captureId': 'cap-1'});
    }
    if (path == '/v1/captures/cap-1/uploads') {
      final int partSize = body['partSize']! as int;
      return _json(<String, Object?>{
        'files': <Object?>[
          for (final Object? raw in body['files']! as List<Object?>)
            () {
              final Map<String, Object?> f = raw! as Map<String, Object?>;
              final int bytes = f['bytes']! as int;
              final int count = bytes == 0 ? 1 : (bytes / partSize).ceil();
              return <String, Object?>{
                'name': f['name'],
                'fileId': 'file-${f['name']}',
                'parts': <Object?>[
                  for (int n = 1; n <= count; n++)
                    <String, Object?>{'number': n, 'url': _url(f['name'], n)},
                ],
              };
            }(),
        ],
      });
    }
    if (path == '/v1/captures/cap-1/uploads/refresh') {
      urlVersion++;
      return _json(<String, Object?>{
        'files': <Object?>[
          for (final Object? raw in body['files']! as List<Object?>)
            () {
              final Map<String, Object?> f = raw! as Map<String, Object?>;
              final String name = (f['fileId']! as String).substring(5);
              return <String, Object?>{
                'name': name,
                'fileId': f['fileId'],
                'parts': <Object?>[
                  for (final Object? n in f['parts']! as List<Object?>)
                    <String, Object?>{'number': n, 'url': _url(name, n)},
                ],
              };
            }(),
        ],
      });
    }
    if (path == '/v1/captures/cap-1/complete') {
      final Map<String, Object?>? missing = missingOnce;
      if (missing != null) {
        missingOnce = null;
        return _json(<String, Object?>{
          'status': 'incomplete',
          'missing': <Object?>[missing],
        });
      }
      return _json(<String, Object?>{'status': completeStatus});
    }
    return http.Response('not found', 404);
  });

  String _url(Object? name, Object? n) =>
      'https://storage.test/$name/$n?v=$urlVersion';

  http.Response _json(Object body) => http.Response(
    jsonEncode(body),
    200,
    headers: <String, String>{'content-type': 'application/json'},
  );

  Iterable<String> get paths => requests.map((http.Request r) => r.url.path);
}

/// Stands in for background transfers: records what it is given, and lets
/// a test play the system's part.
class _FakeTransport implements PartTransport {
  final StreamController<PartEvent> _events =
      StreamController<PartEvent>.broadcast();
  final List<PartUpload> enqueued = <PartUpload>[];
  final Set<String> active = <String>{};
  bool wifiOnly = false;
  int starts = 0;

  @override
  Stream<PartEvent> get events => _events.stream;

  @override
  Future<void> start() async => starts++;

  @override
  Future<void> enqueue(List<PartUpload> parts) async {
    enqueued.addAll(parts);
    active.addAll(parts.map((PartUpload p) => p.taskId));
  }

  @override
  Future<Set<String>> activeTaskIds(String group) async =>
      active.where((String id) => id.startsWith('$group~')).toSet();

  @override
  Future<void> cancelGroup(String group) async {}

  @override
  Future<void> setWifiOnly(bool value) async => wifiOnly = value;

  void emit(String taskId, PartState state, {int? httpStatus}) {
    if (state == PartState.done || state == PartState.failed) {
      active.remove(taskId);
    }
    _events.add(PartStatusChange(taskId, state, httpStatus: httpStatus));
  }

  void progress(String taskId, double fraction) =>
      _events.add(PartProgress(taskId, fraction));

  /// The system finishing every part it has been handed.
  void finishAll() {
    for (final String id in active.toList()) {
      emit(id, PartState.done);
    }
  }

  PartUpload latest(String taskId) =>
      enqueued.lastWhere((PartUpload p) => p.taskId == taskId);
}

/// Waits for background work: file IO and chained futures.
Future<void> _until(bool Function() condition, {String? reason}) async {
  final DateTime deadline = DateTime.now().add(const Duration(seconds: 5));
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) {
      fail('Timed out waiting${reason == null ? '' : ' for $reason'}');
    }
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
}

void main() {
  late Directory root;
  late Directory scanDir;
  late File model;
  late File room;
  late File photo;
  late _FakeBackend backend;
  late _FakeTransport transport;
  late AuthSession session;

  Map<String, Object?> tokens() => <String, Object?>{
    'accessToken': 'dev-token',
    'refreshToken': 'dev-refresh',
  };

  setUp(() async {
    root = await Directory.systemTemp.createTemp('gym_upload_test');
    scanDir = await Directory('${root.path}/Scans/abc').create(recursive: true);
    // 2.5 parts, 1 part, and a photo just under 1 part.
    model = await File(
      '${scanDir.path}/scan.usdz',
    ).writeAsBytes(List<int>.generate(2560, (int i) => i % 251));
    room = await File('${scanDir.path}/scan.json').writeAsString('{"walls":4}');
    photo = await File(
      '${scanDir.path}/photo-x.jpg',
    ).writeAsBytes(List<int>.filled(1000, 7));
    backend = _FakeBackend();
    transport = _FakeTransport();
    session = AuthSession()..signedInWith(tokens());
  });

  final List<BackgroundUploadQueue> queues = <BackgroundUploadQueue>[];

  tearDown(() async {
    // Let in-flight manifest writes land before removing their folder.
    for (final BackgroundUploadQueue q in queues) {
      await q.settle();
    }
    queues.clear();
    await Future<void>.delayed(const Duration(milliseconds: 50));
    if (await root.exists()) await root.delete(recursive: true);
  });

  BackgroundUploadQueue newQueue({bool mobileData = true}) {
    final BackgroundUploadQueue queue = BackgroundUploadQueue(
      api: GymPlanApi(
        client: ApiClient(
          baseUrl: 'https://api.test',
          session: session,
          client: backend.client,
        ),
      ),
      transport: transport,
      root: root,
      partSize: _partSize,
      retryDelay: const Duration(milliseconds: 20),
      uploadOnMobileData: mobileData,
    );
    queues.add(queue);
    return queue;
  }

  ScanResult result() => ScanResult(
    config: _config,
    geometry: FloorOutline.geometry,
    coverage: 0.94,
    closed: true,
    walls: List<WallQuality>.filled(8, WallQuality.captured),
    tags: const <ScanTag>[
      ScanTag(type: TagType.fireExit, position: Offset(1, 2)),
    ],
    photos: 1,
    photoPaths: <String>[photo.path],
    elapsed: const Duration(minutes: 9),
  );

  ScanExport export() =>
      ScanExport(modelPath: model.path, dataPath: room.path, bytes: 0);

  int parts() => 3 + 1 + 1;

  test('registers, opens, splits and sends every part', () async {
    final BackgroundUploadQueue queue = newQueue();
    addTearDown(queue.dispose);

    await queue.enqueue(result(), export: export());
    await _until(() => transport.enqueued.length == parts(), reason: 'parts');

    // Registered once, with metadata and an idempotency key.
    final http.Request create = backend.requests.first;
    expect(create.url.path, '/v1/captures');
    expect(create.headers['Authorization'], 'Bearer dev-token');
    expect(create.headers['Idempotency-Key'], isNotEmpty);
    final Map<String, Object?> meta =
        jsonDecode(create.body) as Map<String, Object?>;
    expect(meta['facilityName'], 'Northgate Fitness');
    expect(meta['source'], 'lidar');
    expect(meta['tags'], hasLength(1));

    // Each part is exactly its byte range of the original.
    final List<int> original = await model.readAsBytes();
    for (int n = 1; n <= 3; n++) {
      final PartUpload p = transport.enqueued.firstWhere(
        (PartUpload p) => p.url == 'https://storage.test/scan.usdz/$n?v=1',
      );
      final List<int> chunk = await File(
        '${root.path}/${p.directory}/${p.filename}',
      ).readAsBytes();
      final int start = (n - 1) * _partSize;
      expect(
        chunk,
        original.sublist(start, (start + _partSize).clamp(0, 2560)),
      );
      expect(p.wifiOnly, isFalse);
    }

    expect(queue.pendingCount, 1);
    expect(queue.active!.status, UploadStatus.uploading);
  });

  test('confirms receipt, then deletes the local copy', () async {
    final BackgroundUploadQueue queue = newQueue();
    addTearDown(queue.dispose);

    await queue.enqueue(result(), export: export());
    await _until(() => transport.enqueued.length == parts());
    transport.finishAll();

    await _until(() => queue.active!.complete, reason: 'receipt');
    expect(backend.paths.last, '/v1/captures/cap-1/complete');
    expect(queue.pendingCount, 0);
    expect(queue.active!.progress, 1);

    // Receipt is saved first, then the local copy goes.
    await _until(() => !scanDir.existsSync(), reason: 'the local copy');
    // Originals and parts are gone; the manifest stays for the screen.
    expect(await model.exists(), isFalse);
    expect(await photo.exists(), isFalse);
    expect(await scanDir.exists(), isFalse);
    final Directory jobDir = Directory(
      '${root.path}/Uploads/${queue.active!.id}',
    );
    expect(
      jobDir.listSync().map((FileSystemEntity e) => e.uri.pathSegments.last),
      <String>['manifest.json'],
    );
  });

  test('keeps the capture if the platform does not confirm it', () async {
    backend.completeStatus = 'assembling';
    final BackgroundUploadQueue queue = newQueue();
    addTearDown(queue.dispose);

    await queue.enqueue(result(), export: export());
    await _until(() => transport.enqueued.length == parts());
    transport.finishAll();

    await _until(
      () =>
          backend.paths.where((String p) => p.endsWith('/complete')).length >=
          2,
      reason: 'a retried confirmation',
    );
    expect(queue.active!.complete, isFalse);
    expect(await model.exists(), isTrue);
  });

  test('resends exactly the parts the platform says are missing', () async {
    backend.missingOnce = <String, Object?>{
      'fileId': 'file-scan.usdz',
      'parts': <int>[2],
    };
    final BackgroundUploadQueue queue = newQueue();
    addTearDown(queue.dispose);

    await queue.enqueue(result(), export: export());
    await _until(() => transport.enqueued.length == parts());
    transport.finishAll();

    // Part 2 of the model goes again, with a fresh URL, and nothing else.
    await _until(
      () => transport.enqueued.length == parts() + 1,
      reason: 'the missing part to be re-sent',
    );
    expect(transport.enqueued.last.url, 'https://storage.test/scan.usdz/2?v=2');
    expect(queue.active!.complete, isFalse);

    transport.finishAll();
    await _until(() => queue.active!.complete, reason: 'receipt');
  });

  test('reports progress, signal loss and resumes', () async {
    final BackgroundUploadQueue queue = newQueue();
    addTearDown(queue.dispose);

    await queue.enqueue(result(), export: export());
    await _until(() => transport.enqueued.length == parts());
    final String first = transport.enqueued.first.taskId;

    transport.emit(first, PartState.running);
    transport.progress(first, 0.5);
    await _until(() => queue.active!.sentMb > 0);
    expect(queue.active!.status, UploadStatus.uploading);

    transport.emit(first, PartState.retrying);
    await _until(() => queue.active!.status == UploadStatus.waitingForNetwork);

    transport.emit(first, PartState.running);
    await _until(() => queue.active!.resumes == 1);
  });

  test('a failed part gets a fresh URL and is sent again', () async {
    final BackgroundUploadQueue queue = newQueue();
    addTearDown(queue.dispose);

    await queue.enqueue(result(), export: export());
    await _until(() => transport.enqueued.length == parts());
    final String first = transport.enqueued.first.taskId;

    // An expired signature: S3 answers 403.
    transport.emit(first, PartState.failed, httpStatus: 403);

    await _until(
      () =>
          transport.enqueued
              .where((PartUpload p) => p.taskId == first)
              .length ==
          2,
      reason: 'the part to be re-sent',
    );
    expect(backend.paths, contains('/v1/captures/cap-1/uploads/refresh'));
    expect(transport.latest(first).url, endsWith('?v=2'));
    // Only the failed part is re-sent, not the whole file.
    expect(transport.enqueued, hasLength(parts() + 1));
  });

  test('waits for signal when the API cannot be reached', () async {
    backend.offlineCalls = 2;
    final BackgroundUploadQueue queue = newQueue();
    addTearDown(queue.dispose);

    await queue.enqueue(result(), export: export());
    await _until(() => queue.active!.status == UploadStatus.waitingForNetwork);

    await _until(() => transport.enqueued.length == parts(), reason: 'retry');
    // The retried registration reuses the key, so no duplicate capture.
    final Iterable<http.Request> creates = backend.requests.where(
      (http.Request r) => r.url.path == '/v1/captures',
    );
    expect(
      creates.map((http.Request r) => r.headers['Idempotency-Key']).toSet(),
      hasLength(1),
    );
  });

  test('carries on after the app restarts', () async {
    final BackgroundUploadQueue first = newQueue();
    await first.enqueue(result(), export: export());
    await _until(() => transport.enqueued.length == parts());

    // Two parts land, then the app is killed.
    final List<String> ids = transport.enqueued
        .map((PartUpload p) => p.taskId)
        .toList();
    transport.emit(ids[0], PartState.done);
    transport.emit(ids[1], PartState.done);
    await _until(() => first.active!.sentMb > 0);
    await Future<void>.delayed(const Duration(milliseconds: 50));
    first.dispose();
    // The system dropped the transfers it had not started.
    transport.active.clear();
    transport.enqueued.clear();
    final int callsBefore = backend.requests.length;

    final BackgroundUploadQueue second = newQueue();
    addTearDown(second.dispose);
    await second.restore();

    await _until(() => transport.enqueued.length == parts() - 2);
    expect(transport.starts, greaterThan(0));
    expect(second.pendingCount, 1);
    // Picked up from the manifest: nothing registered or opened again.
    expect(backend.requests.length, callsBefore);
    expect(
      transport.enqueued.map((PartUpload p) => p.taskId),
      isNot(contains(anyOf(ids[0], ids[1]))),
    );

    transport.finishAll();
    await _until(() => second.active!.complete);
  });

  test(
    'a relaunch resumes in the capture\'s own account, unprompted',
    () async {
      // Signed in to two accounts, capturing in the first.
      session.signedInWith(<String, Object?>{
        ...tokens(),
        'accounts': <Object?>[
          <String, Object?>{'id': 'acc_a', 'name': 'A', 'role': 'owner'},
          <String, Object?>{'id': 'acc_b', 'name': 'B', 'role': 'surveyor'},
        ],
      });
      session.selectAccount('acc_a');
      final BackgroundUploadQueue first = newQueue();
      await first.enqueue(
        result().copyWith(
          controlDistances: const <ControlDistance>[
            ControlDistance(
              a: Offset(0, 0),
              b: Offset(12, 0),
              measuredM: 12.03,
            ),
          ],
        ),
        export: export(),
      );
      await _until(() => transport.enqueued.length == parts());

      // The surveyor switches account, then the app is killed.
      session.selectAccount('acc_b');
      await Future<void>.delayed(const Duration(milliseconds: 50));
      first.dispose();
      transport.active.clear();
      transport.enqueued.clear();
      final int before = backend.requests.length;

      // On relaunch the session is already there (restored from the
      // Keychain), so nothing waits for a sign-in.
      final BackgroundUploadQueue second = newQueue();
      addTearDown(second.dispose);
      await second.restore();
      await _until(() => transport.enqueued.length == parts());
      transport.finishAll();
      await _until(() => second.active!.complete);

      // Every call, before and after the relaunch, named the capture's
      // account, not the one the phone was switched to.
      expect(backend.requests.length, greaterThan(before));
      expect(
        backend.requests.map((http.Request r) => r.headers['X-Account-Id']),
        everyElement('acc_a'),
      );
      final Map<String, Object?> meta =
          jsonDecode(backend.requests.first.body) as Map<String, Object?>;
      expect(meta['controlDistances'], <Object?>[
        <String, Object?>{
          'a': <Object?>[0.0, 0.0],
          'b': <Object?>[12.0, 0.0],
          'measuredM': 12.03,
        },
      ]);
    },
  );

  test('stops when signed out, and resumes after sign-in', () async {
    backend.unauthorised = true;
    final BackgroundUploadQueue queue = newQueue();
    addTearDown(queue.dispose);

    await queue.enqueue(result(), export: export());
    await _until(() => queue.active!.status == UploadStatus.failed);
    // The refresh was refused too, so the session ended.
    expect(queue.active!.error, 'Your sign-in has ended. Sign in again.');
    expect(session.signedIn, isFalse);

    backend.unauthorised = false;
    // The app retries uploads once the user signs in again.
    session.signedInWith(tokens());
    await queue.retry();
    await _until(() => transport.enqueued.length == parts());
    expect(queue.active!.error, isNull);
  });

  test('waits for Wi-Fi when mobile data is off', () async {
    final BackgroundUploadQueue queue = newQueue(mobileData: false);
    addTearDown(queue.dispose);
    await queue.restore();
    expect(transport.wifiOnly, isTrue);

    await queue.enqueue(result(), export: export());
    await _until(() => transport.enqueued.length == parts());

    expect(transport.enqueued.every((PartUpload p) => p.wifiOnly), isTrue);
    expect(queue.active!.status, UploadStatus.waitingForWifi);

    await queue.setUploadOnMobileData(true);
    expect(transport.wifiOnly, isFalse);
  });

  test('a simulated scan sends its metadata with no files', () async {
    final BackgroundUploadQueue queue = newQueue();
    addTearDown(queue.dispose);

    await queue.enqueue(
      ScanResult(
        config: _config,
        geometry: FloorOutline.geometry,
        coverage: 0.9,
        closed: true,
        walls: const <WallQuality>[],
        tags: const <ScanTag>[],
        photos: 0,
        elapsed: Duration.zero,
      ),
    );

    await _until(() => queue.active!.complete);
    expect(transport.enqueued, isEmpty);
    expect(
      jsonDecode(backend.requests.first.body),
      containsPair('source', 'simulated'),
    );
  });

  test('a missing capture file stops the upload with a reason', () async {
    final BackgroundUploadQueue queue = newQueue();
    addTearDown(queue.dispose);

    await queue.enqueue(result(), export: export());
    // Deleted before its parts were cut.
    await model.delete();

    await _until(() => queue.active!.status == UploadStatus.failed);
    expect(queue.active!.error, contains('missing'));
  });
}
