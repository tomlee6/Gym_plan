import 'dart:async';
import 'dart:io';
import 'dart:math' as math;

import '../models/scan.dart';
import 'gym_plan_api.dart';
import 'part_transport.dart';
import 'upload_manifest.dart';
import 'upload_queue.dart';
import '../models/equipment.dart';
import 'equipment_service.dart';
import 'package:room_scan/room_scan.dart';

/// The real upload queue.
///
/// Each capture goes up as an S3-style multipart upload through signed URLs
/// from the Gym Plan API:
///
/// 1. register the capture and its metadata;
/// 2. open an upload for each file and get a signed URL per 8 MB part;
/// 3. split the files into parts and hand them to background transfers,
///    which carry on while the app is suspended and retry when signal
///    returns. A dropped connection only resends the part that failed;
/// 4. once every part is sent, ask the platform to assemble and confirm the
///    capture, then delete the local copy.
///
/// Progress is written to a manifest after every step, so a capture carries
/// on from where it was after the app is closed or the phone restarts. The
/// session is restored from the Keychain before [restore] runs (see
/// `main.dart`), so an interrupted upload carries on at once after a
/// relaunch without anyone signing in again. Each capture remembers the
/// account it was made in and names it on every call (`X-Account-Id`).
class BackgroundUploadQueue extends UploadQueue {
  BackgroundUploadQueue({
    required this.api,
    required this.transport,
    required this.root,
    EquipmentService? equipmentApi,
    this.partSize = defaultPartSize,
    this.retryDelay = const Duration(seconds: 15),
    this.maxFailures = 12,
    bool uploadOnMobileData = true,
  }) : equipmentApi = equipmentApi ?? EquipmentService(),
       _mobileData = uploadOnMobileData;

  /// 8 MiB: above S3's 5 MiB minimum part size, and small enough that a
  /// dropped connection costs little.
  static const int defaultPartSize = 8 * 1024 * 1024;

  final GymPlanApi api;

  /// The equipment and 360 video endpoints (CHANGE 2, CHANGE 4).
  final EquipmentService equipmentApi;
  final PartTransport transport;

  /// Application Support. Uploads live under `Uploads/<job id>/`.
  final Directory root;
  final int partSize;

  /// First wait before retrying after the API could not be reached. Doubles
  /// on each failure, up to five minutes.
  final Duration retryDelay;
  final int maxFailures;

  bool _mobileData;
  StreamSubscription<PartEvent>? _events;

  /// Oldest first.
  final List<UploadManifest> _jobs = <UploadManifest>[];
  final Map<String, double> _partProgress = <String, double>{};
  final Map<String, PartState> _partStates = <String, PartState>{};
  final Map<String, UploadStatus> _phase = <String, UploadStatus>{};
  final Map<String, Timer> _retryTimers = <String, Timer>{};
  final Set<String> _busy = <String>{};
  final Set<String> _again = <String>{};
  final Map<String, Future<void>> _writes = <String, Future<void>>{};
  final Set<String> _writeWaiting = <String>{};

  // -- Reading state ------------------------------------------------------

  @override
  UploadJob? get active {
    if (_jobs.isEmpty) return null;
    final UploadManifest job = _jobs.firstWhere(
      (UploadManifest j) => !j.received,
      orElse: () => _jobs.last,
    );
    return _view(job);
  }

  @override
  int get pendingCount => _jobs.where((UploadManifest j) => !j.received).length;

  /// All captures this queue knows about, oldest first.
  List<UploadJob> get jobs => <UploadJob>[for (final j in _jobs) _view(j)];

  UploadJob _view(UploadManifest job) {
    const double mib = 1024 * 1024;
    double sent = job.sentBytes.toDouble();
    for (int f = 0; f < job.files.length; f++) {
      for (final ManifestPart p in job.files[f].parts) {
        if (!p.done) sent += (_partProgress[_taskId(job, f, p)] ?? 0) * p.bytes;
      }
    }
    return UploadJob(
      id: job.id,
      title: job.title,
      facility: job.facility,
      level: job.level,
      totalMb: job.totalBytes / mib,
      sentMb: job.received ? job.totalBytes / mib : sent / mib,
      resumes: job.resumes,
      status: _statusOf(job),
      error: job.error,
      received: job.received,
    );
  }

  UploadStatus _statusOf(UploadManifest job) {
    if (job.received) return UploadStatus.done;
    if (job.error != null) return UploadStatus.failed;
    final UploadStatus? phase = _phase[job.id];
    if (phase != null) return phase;

    final Iterable<PartState> states = _statesOf(job);
    if (states.contains(PartState.running)) return UploadStatus.uploading;
    if (!_mobileData) return UploadStatus.waitingForWifi;
    if (states.contains(PartState.retrying)) {
      return UploadStatus.waitingForNetwork;
    }
    return UploadStatus.uploading;
  }

  Iterable<PartState> _statesOf(UploadManifest job) sync* {
    for (int f = 0; f < job.files.length; f++) {
      for (final ManifestPart p in job.files[f].parts) {
        final PartState? s = _partStates[_taskId(job, f, p)];
        if (s != null) yield s;
      }
    }
  }

  // -- Starting up --------------------------------------------------------

  /// Picks up uploads left from a previous run. Call once at start-up.
  Future<void> restore() async {
    _events ??= transport.events.listen(_onEvent);
    await transport.setWifiOnly(!_mobileData);

    final Directory uploads = Directory('${root.path}/Uploads');
    if (await uploads.exists()) {
      final List<UploadManifest> found = <UploadManifest>[];
      await for (final FileSystemEntity e in uploads.list()) {
        if (e is! Directory) continue;
        final UploadManifest? m = await UploadManifest.load(e);
        if (m != null) found.add(m);
      }
      found.sort(
        (UploadManifest a, UploadManifest b) =>
            a.createdAt.compareTo(b.createdAt),
      );
      _jobs
        ..clear()
        ..addAll(found);
      await _pruneReceived();
    }
    notifyListeners();

    // Replays transfers that finished while the app was closed. Done after
    // loading the manifests, so the replayed events find their parts.
    await transport.start();
    for (final UploadManifest job in List<UploadManifest>.of(_jobs)) {
      if (!job.received && job.error == null) unawaited(_drive(job));
    }
  }

  // -- Queueing -----------------------------------------------------------

  @override
  Future<void> enqueue(
    ScanResult result, {
    ScanExport? export,
    List<Equipment> equipment = const <Equipment>[],
    Map<String, EquipmentVideo> videos = const <String, EquipmentVideo>{},
  }) async {
    _events ??= transport.events.listen(_onEvent);

    final List<(String, String, String)> sources = <(String, String, String)>[
      if (export != null) ...<(String, String, String)>[
        (export.modelPath, 'model', 'model/vnd.usdz+zip'),
        (export.dataPath, 'room', 'application/json'),
      ],
      for (final String photo in result.photoPaths)
        (photo, 'photo', 'image/jpeg'),
    ];

    int photoNumber = 0;
    final List<ManifestFile> files = <ManifestFile>[];
    for (final (String path, String kind, String type) in sources) {
      final File file = File(path);
      final String ext = path.contains('.') ? path.split('.').last : 'bin';
      files.add(
        ManifestFile(
          source: UploadManifest.relativise(file.path, root),
          name: kind == 'photo' ? 'photo-${++photoNumber}.$ext' : 'scan.$ext',
          kind: kind,
          contentType: type,
          bytes: await file.length(),
        ),
      );
    }

    final UploadManifest job = UploadManifest(
      id: _newId(),
      title: result.config.shortTitle,
      facility: result.config.facility,
      level: result.config.level,
      metadata: _metadata(result, lidar: export != null),
      files: files,
      createdAt: DateTime.now(),
      accountId: result.config.accountId ?? api.currentAccountId,
      equipment: <Map<String, Object?>>[
        for (final Equipment e in equipment) e.toJson(),
      ],
      // The video files stay where the recorder wrote them until the
      // platform confirms it has them.
      videos: <Map<String, Object?>>[
        // A simulated walkaround has no file and is not sent: a made-up
        // video in front of a reviewer would be worse than none, the same
        // reason a simulated scan uploads no model. The machine itself is
        // still registered, so the plan still places it.
        for (final MapEntry<String, EquipmentVideo> v in videos.entries)
          if (!v.value.simulated)
            <String, Object?>{
              'equipmentId': v.key,
              'path': v.value.path,
              'thumbnailPath': v.value.thumbnailPath,
              'bytes': v.value.bytes,
              'durationSeconds': v.value.duration.inMilliseconds / 1000,
              'contentType': v.value.contentType,
            },
      ],
    );
    await _save(job);
    _jobs.add(job);
    notifyListeners();
    unawaited(_drive(job));
  }

  /// Sends the marked machines and their 360 videos (CHANGE 2, CHANGE 4).
  ///
  /// The machines go first: a video is filed against a machine, so one
  /// cannot be uploaded before the machine it belongs to exists. Both
  /// calls are safe to repeat, so a retry after a lost response does not
  /// double anything up.
  Future<void> _sendEquipment(UploadManifest job) async {
    final String captureId = job.captureId!;
    if (job.equipment.isNotEmpty) {
      await equipmentApi
          .saveEquipment(captureId, accountId: job.accountId, <Equipment>[
            for (final Map<String, Object?> e in job.equipment)
              Equipment(
                equipmentId: e['equipmentId']! as String,
                type: e['type']! as String,
                name: e['name']! as String,
                x: (e['x'] as num?)?.toDouble(),
                z: (e['z'] as num?)?.toDouble(),
                elevationM: (e['elevationM'] as num?)?.toDouble(),
                rotationDeg: (e['rotationDeg'] as num?)?.toDouble(),
                widthM: (e['widthM'] as num?)?.toDouble(),
                depthM: (e['depthM'] as num?)?.toDouble(),
                heightM: (e['heightM'] as num?)?.toDouble(),
                confidence: (e['confidence'] as num?)?.toDouble(),
                source: e['source'] as String? ?? 'surveyor',
              ),
          ]);
    }

    for (final Map<String, Object?> v in job.videos) {
      final File file = File(v['path']! as String);
      // A take whose file has gone is skipped rather than failing the whole
      // capture: the scan matters more than one walkaround.
      if (!file.existsSync()) continue;
      await equipmentApi.uploadVideo(
        captureId,
        EquipmentVideo(
          equipmentId: v['equipmentId']! as String,
          path: file.path,
          thumbnailPath: v['thumbnailPath'] as String?,
          bytes: (v['bytes']! as num).toInt(),
          duration: Duration(
            milliseconds: ((v['durationSeconds']! as num) * 1000).round(),
          ),
          contentType: v['contentType'] as String? ?? 'video/quicktime',
        ),
        accountId: job.accountId,
      );
    }

    job.equipmentSent = true;
    await _save(job);
  }

  Map<String, Object?> _metadata(ScanResult r, {required bool lidar}) =>
      <String, Object?>{
        'facilityId': r.config.facilityId,
        'facilityName': r.config.facility,
        'level': r.config.level,
        'floorToFloorM': r.config.heightM,
        'source': lidar ? 'lidar' : 'simulated',
        'coverage': r.coverage,
        'closed': r.closed,
        'overrideReason': r.overrideReason,
        'areaM2': r.areaM2,
        'durationSeconds': r.elapsed.inSeconds,
        'photoCount': r.photos,
        'weakWallCount': r.walls
            .where((WallQuality q) => q == WallQuality.weak)
            .length,
        'tags': <Object?>[
          for (final ScanTag t in r.tags)
            <String, Object?>{
              'type': t.type.name,
              'x': t.position.dx,
              'y': t.position.dy,
              'heightM': t.heightM,
            },
        ],
        // Laser-measured checks of the scan's scale (F-03), in the same
        // plan frame as the tags.
        'controlDistances': <Object?>[
          for (final ControlDistance c in r.controlDistances) c.toJson(),
        ],
        'capturedAt': DateTime.now().toUtc().toIso8601String(),
      };

  @override
  Future<void> retry() async {
    for (final UploadManifest job in _jobs) {
      if (job.received) continue;
      _retryTimers.remove(job.id)?.cancel();
      job
        ..error = null
        ..failures = 0;
      await _save(job);
      unawaited(_drive(job));
    }
    notifyListeners();
  }

  @override
  Future<void> setUploadOnMobileData(bool allowed) async {
    _mobileData = allowed;
    await transport.setWifiOnly(!allowed);
    notifyListeners();
  }

  // -- The state machine --------------------------------------------------

  /// Moves [job] as far forward as it can go. Safe to call at any time:
  /// each step checks what is already done.
  Future<void> _drive(UploadManifest job) async {
    if (_disposed || job.received || job.error != null) return;
    if (!_busy.add(job.id)) {
      _again.add(job.id);
      return;
    }
    _retryTimers.remove(job.id)?.cancel();

    try {
      // 1. Register the capture.
      if (job.captureId == null) {
        _setPhase(job, UploadStatus.preparing);
        job.captureId = await api.createCapture(
          job.metadata,
          idempotencyKey: job.id,
          accountId: job.accountId,
        );
        await _save(job);
      }

      // 1b. Register the machines and send their walkarounds. This runs
      // before the scan files so the platform has the equipment by the
      // time it reads the plan, and so a failure here is reported while
      // the surveyor is still looking at the upload.
      if (!job.equipmentSent &&
          (job.equipment.isNotEmpty || job.videos.isNotEmpty)) {
        await _sendEquipment(job);
      }

      // 2. Open the uploads, or refresh URLs that failed or expired.
      await _ensureTargets(job);

      // 3 and 4. Split into parts and send what is not yet sent.
      if (!job.allPartsDone) {
        await _sendParts(job);
      } else {
        // 5. Everything is sent: ask the platform to confirm it.
        _setPhase(job, UploadStatus.confirming);
        final CompletionResult result = await api.complete(
          job.captureId!,
          accountId: job.accountId,
        );
        if (!result.received) {
          // Some parts never arrived, e.g. a transfer iOS reported done but
          // the server lost. Send exactly those again, with fresh URLs.
          for (final ManifestFile f in job.files) {
            final List<int>? parts = result.missing[f.fileId];
            if (parts == null) continue;
            for (final ManifestPart p in f.parts) {
              if (parts.contains(p.number)) {
                p
                  ..done = false
                  ..url = null;
              }
            }
          }
          await _save(job);
          _setPhase(job, null);
          // Runs again once this pass ends (see below the try).
          _again.add(job.id);
        } else {
          job.received = true;
          await _save(job);
          _setPhase(job, null);
          await _deleteLocalCopy(job);
          await _pruneReceived();
        }
      }
    } on ApiException catch (e) {
      if (!e.retryable || e.unauthorised) {
        await _stop(job, e.message);
      } else {
        _setPhase(job, UploadStatus.waitingForNetwork);
        await _failedAttempt(job);
      }
    } on FileSystemException catch (e) {
      await _stop(
        job,
        'The capture files are missing from this iPhone (${e.message}).',
      );
    } finally {
      _busy.remove(job.id);
      notifyListeners();
    }

    if (_again.remove(job.id)) unawaited(_drive(job));
  }

  Future<void> _ensureTargets(UploadManifest job) async {
    final String captureId = job.captureId!;

    // Files never opened on the platform get their whole part plan.
    final List<ManifestFile> unopened = job.files
        .where((ManifestFile f) => f.fileId == null)
        .toList();
    if (unopened.isNotEmpty) {
      _setPhase(job, UploadStatus.preparing);
      final List<FileTarget> targets = await api.startUpload(
        captureId,
        accountId: job.accountId,
        partSize: partSize,
        files: <FileDescription>[
          for (final ManifestFile f in unopened)
            FileDescription(
              name: f.name,
              kind: f.kind,
              bytes: f.bytes,
              contentType: f.contentType,
            ),
        ],
      );
      for (final ManifestFile f in unopened) {
        final FileTarget t = targets.firstWhere(
          (FileTarget t) => t.name == f.name,
          orElse: () => throw ApiException(
            'The platform did not open an upload for ${f.name}.',
            retryable: false,
          ),
        );
        f
          ..fileId = t.fileId
          ..parts = _planParts(f.bytes, t.parts);
      }
      await _save(job);
    }

    // Parts whose URL was cleared by a failure need a fresh one.
    final Map<String, List<int>> stale = <String, List<int>>{
      for (final ManifestFile f in job.files)
        if (f.parts.any((ManifestPart p) => !p.done && p.url == null))
          f.fileId!: <int>[
            for (final ManifestPart p in f.parts)
              if (!p.done && p.url == null) p.number,
          ],
    };
    if (stale.isNotEmpty) {
      final List<FileTarget> fresh = await api.refreshParts(
        captureId,
        stale,
        accountId: job.accountId,
      );
      for (final FileTarget t in fresh) {
        final ManifestFile f = job.files.firstWhere(
          (ManifestFile f) => f.fileId == t.fileId,
        );
        for (final PartTarget pt in t.parts) {
          f.parts.firstWhere((ManifestPart p) => p.number == pt.number).url =
              pt.url;
        }
      }
      await _save(job);
    }
  }

  /// Byte ranges for a file, matched to the platform's numbered URLs. The
  /// platform numbers parts from the same size, so the counts must agree.
  List<ManifestPart> _planParts(int bytes, List<PartTarget> targets) {
    final int count = math.max(1, (bytes / partSize).ceil());
    if (targets.length != count) {
      throw ApiException(
        'The platform planned ${targets.length} parts; expected $count.',
        retryable: false,
      );
    }
    return <ManifestPart>[
      for (final PartTarget t in targets)
        ManifestPart(
          number: t.number,
          offset: (t.number - 1) * partSize,
          bytes: math.min(partSize, bytes - (t.number - 1) * partSize),
          url: t.url,
        ),
    ];
  }

  Future<void> _sendParts(UploadManifest job) async {
    final Set<String> inFlight = await transport.activeTaskIds(job.id);
    final List<PartUpload> toSend = <PartUpload>[];

    for (int f = 0; f < job.files.length; f++) {
      final ManifestFile file = job.files[f];
      for (final ManifestPart part in file.parts) {
        final String taskId = _taskId(job, f, part);
        if (part.done || part.url == null || inFlight.contains(taskId)) {
          continue;
        }
        final File chunk = _chunkFile(job, f, part);
        if (!await chunk.exists()) {
          _setPhase(job, UploadStatus.preparing);
          await _writeChunk(
            File(UploadManifest.resolve(file.source, root)),
            part,
            chunk,
          );
        }
        toSend.add(
          PartUpload(
            taskId: taskId,
            url: part.url!,
            directory: 'Uploads/${job.id}',
            filename: _chunkName(f, part),
            group: job.id,
            wifiOnly: !_mobileData,
          ),
        );
      }
    }

    _setPhase(job, null);
    if (toSend.isEmpty) return;
    for (final PartUpload p in toSend) {
      _partStates[p.taskId] = PartState.queued;
    }
    await transport.enqueue(toSend);
  }

  /// Copies one byte range into its own file, so the background transfer
  /// can send it with a plain file upload. Written under a temporary name,
  /// so a crash never leaves a short part that looks complete.
  Future<void> _writeChunk(File source, ManifestPart part, File target) async {
    final RandomAccessFile input = await source.open();
    final File partial = File('${target.path}.tmp');
    final IOSink out = partial.openWrite();
    try {
      await input.setPosition(part.offset);
      int remaining = part.bytes;
      while (remaining > 0) {
        final List<int> bytes = await input.read(math.min(remaining, 1 << 20));
        if (bytes.isEmpty) {
          throw FileSystemException(
            'File is shorter than expected',
            source.path,
          );
        }
        out.add(bytes);
        remaining -= bytes.length;
      }
      await out.flush();
    } finally {
      await out.close();
      await input.close();
    }
    await partial.rename(target.path);
  }

  // -- Transfer events ----------------------------------------------------

  void _onEvent(PartEvent event) {
    final (UploadManifest, int, ManifestPart)? found = _find(event.taskId);
    if (found == null) return;
    final (UploadManifest job, int fileIndex, ManifestPart part) = found;

    switch (event) {
      case PartProgress(:final double fraction):
        _partProgress[event.taskId] = fraction;
        notifyListeners();

      case PartStatusChange(:final PartState state):
        final PartState? before = _partStates[event.taskId];
        _partStates[event.taskId] = state;
        switch (state) {
          case PartState.running:
            if (before == PartState.retrying) {
              job.resumes++;
              unawaited(_save(job));
            }
          case PartState.done:
            unawaited(_partDone(job, fileIndex, part));
          case PartState.failed:
            unawaited(_partFailed(job, part));
          case PartState.queued || PartState.retrying:
            break;
        }
        notifyListeners();
    }
  }

  Future<void> _partDone(
    UploadManifest job,
    int fileIndex,
    ManifestPart part,
  ) async {
    if (part.done) return;
    part.done = true;
    job.failures = 0;
    _partProgress.remove(_taskId(job, fileIndex, part));
    await _save(job);
    final File chunk = _chunkFile(job, fileIndex, part);
    if (await chunk.exists()) await chunk.delete();
    if (job.allPartsDone) await _drive(job);
  }

  /// The system already retried this part. Its URL may have expired, so ask
  /// for a fresh one and send it again after a pause.
  Future<void> _partFailed(UploadManifest job, ManifestPart part) async {
    part.url = null;
    await _save(job);
    await _failedAttempt(job);
  }

  Future<void> _failedAttempt(UploadManifest job) async {
    job.failures++;
    await _save(job);
    if (job.failures > maxFailures) {
      await _stop(
        job,
        'The upload keeps failing. Check the connection and try again.',
      );
      return;
    }
    final int factor = math.min(1 << math.min(job.failures - 1, 5), 20);
    final Duration wait = retryDelay * factor;
    _retryTimers.remove(job.id)?.cancel();
    _retryTimers[job.id] = Timer(
      wait > const Duration(minutes: 5) ? const Duration(minutes: 5) : wait,
      () {
        _retryTimers.remove(job.id);
        _setPhase(job, null);
        unawaited(_drive(job));
      },
    );
    notifyListeners();
  }

  Future<void> _stop(UploadManifest job, String message) async {
    job.error = message;
    _setPhase(job, null);
    await _save(job);
    notifyListeners();
  }

  // -- Housekeeping -------------------------------------------------------

  /// The platform holds the capture now, so the phone does not need to.
  Future<void> _deleteLocalCopy(UploadManifest job) async {
    final Set<Directory> parents = <Directory>{};
    for (final ManifestFile f in job.files) {
      final File file = File(UploadManifest.resolve(f.source, root));
      parents.add(file.parent);
      if (await file.exists()) await file.delete();
    }
    // The scan's own folder, if the upload emptied it.
    for (final Directory d in parents) {
      if (await d.exists() && await d.list().isEmpty) await d.delete();
    }
    // Only parts: the manifest, and any write of it in flight, must stay.
    await for (final FileSystemEntity e in _dirOf(job).list()) {
      if (e is File &&
          (e.path.endsWith('.part') || e.path.endsWith('.part.tmp'))) {
        await e.delete();
      }
    }
  }

  /// Keeps only the latest received capture, so the upload screen can still
  /// show "Upload complete" after a restart.
  Future<void> _pruneReceived() async {
    final List<UploadManifest> received = _jobs
        .where((UploadManifest j) => j.received)
        .toList();
    for (final UploadManifest old in received.take(
      math.max(0, received.length - 1),
    )) {
      _jobs.remove(old);
      final Directory dir = _dirOf(old);
      if (await dir.exists()) await dir.delete(recursive: true);
    }
  }

  /// Writes [job]'s manifest. Writes for one job run one at a time, since
  /// parts often finish together and would otherwise race on the file, and a
  /// write that is still waiting to start is shared: it saves the latest
  /// state anyway.
  Future<void> _save(UploadManifest job) {
    final Future<void>? queued = _writes[job.id];
    if (queued != null && _writeWaiting.contains(job.id)) return queued;

    _writeWaiting.add(job.id);
    final Future<void> next = (queued ?? Future<void>.value())
        .catchError((Object _) {})
        .then((_) {
          _writeWaiting.remove(job.id);
          return job.save(_dirOf(job));
        });
    _writes[job.id] = next;
    return next;
  }

  /// Waits for pending manifest writes. For tests, before they clean up.
  Future<void> settle() async {
    for (final Future<void> w in _writes.values.toList()) {
      await w.catchError((Object _) {});
    }
  }

  void _setPhase(UploadManifest job, UploadStatus? phase) {
    if (phase == null) {
      _phase.remove(job.id);
    } else {
      _phase[job.id] = phase;
    }
    notifyListeners();
  }

  Directory _dirOf(UploadManifest job) =>
      Directory('${root.path}/Uploads/${job.id}');

  String _chunkName(int fileIndex, ManifestPart part) =>
      'f$fileIndex-p${part.number}.part';

  File _chunkFile(UploadManifest job, int fileIndex, ManifestPart part) =>
      File('${_dirOf(job).path}/${_chunkName(fileIndex, part)}');

  String _taskId(UploadManifest job, int fileIndex, ManifestPart part) =>
      '${job.id}~$fileIndex~${part.number}';

  (UploadManifest, int, ManifestPart)? _find(String taskId) {
    final List<String> bits = taskId.split('~');
    if (bits.length != 3) return null;
    for (final UploadManifest job in _jobs) {
      if (job.id != bits[0]) continue;
      final int? f = int.tryParse(bits[1]);
      final int? n = int.tryParse(bits[2]);
      if (f == null || n == null || f >= job.files.length) return null;
      for (final ManifestPart p in job.files[f].parts) {
        if (p.number == n) return (job, f, p);
      }
    }
    return null;
  }

  static String _newId() {
    final math.Random r = math.Random.secure();
    return '${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}-'
        '${List<String>.generate(8, (_) => r.nextInt(36).toRadixString(36)).join()}';
  }

  bool _disposed = false;

  /// Async work can finish after disposal; it must not notify then.
  @override
  void notifyListeners() {
    if (!_disposed) super.notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _events?.cancel();
    for (final Timer t in _retryTimers.values) {
      t.cancel();
    }
    super.dispose();
  }
}
