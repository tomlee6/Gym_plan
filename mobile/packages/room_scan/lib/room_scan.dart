/// LiDAR room scanning, backed by Apple RoomPlan on iOS.
///
/// Coordinates are metres on the floor plane, seen from above: `x` is the
/// world x axis and `y` is the world z axis, both relative to where the
/// phone was when the scan started.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

/// How sure RoomPlan is about a surface.
enum RoomScanConfidence { low, medium, high }

/// Whether this device can scan, and what it is.
@immutable
class RoomScanDeviceInfo {
  const RoomScanDeviceInfo({
    required this.supported,
    required this.model,
    required this.systemVersion,
    this.reason,
  });

  factory RoomScanDeviceInfo.fromMap(Map<Object?, Object?> map) {
    return RoomScanDeviceInfo(
      supported: map['supported'] == true,
      model: map['model'] as String? ?? 'iPhone',
      systemVersion: map['systemVersion'] as String? ?? '',
      reason: map['reason'] as String?,
    );
  }

  final bool supported;

  /// "iPhone" or "iPad".
  final String model;

  /// e.g. "18.2".
  final String systemVersion;

  /// Why scanning is unavailable, when it is.
  final String? reason;
}

/// One wall as a line on the floor plane.
@immutable
class RoomScanWall {
  const RoomScanWall({
    required this.start,
    required this.end,
    required this.confidence,
  });

  final Offset start;
  final Offset end;
  final RoomScanConfidence confidence;
}

/// The live state of the scan, sent about ten times a second while it runs.
@immutable
class RoomScanUpdate {
  const RoomScanUpdate({
    required this.walls,
    required this.objects,
    this.detected = const <RoomScanObject>[],
    required this.coverage,
    required this.closed,
    required this.elapsed,
    this.position,
    this.heading,
    this.areaM2,
    this.instruction,
  });

  factory RoomScanUpdate.fromMap(Map<Object?, Object?> map) {
    Offset point(Object? raw) {
      final List<Object?> xy = raw! as List<Object?>;
      return Offset((xy[0]! as num).toDouble(), (xy[1]! as num).toDouble());
    }

    final List<Object?> walls = map['walls'] as List<Object?>? ?? const [];
    final List<Object?> objects = map['objects'] as List<Object?>? ?? const [];
    final List<Object?> detected =
        map['detected'] as List<Object?>? ?? const [];
    final Object? position = map['position'];

    return RoomScanUpdate(
      walls: <RoomScanWall>[
        for (final Object? raw in walls)
          () {
            final Map<Object?, Object?> w = raw! as Map<Object?, Object?>;
            return RoomScanWall(
              start: point(w['a']),
              end: point(w['b']),
              confidence: RoomScanConfidence.values.firstWhere(
                (RoomScanConfidence c) => c.name == w['confidence'],
                orElse: () => RoomScanConfidence.low,
              ),
            );
          }(),
      ],
      objects: <List<Offset>>[
        for (final Object? raw in objects)
          <Offset>[for (final Object? p in raw! as List<Object?>) point(p)],
      ],
      detected: <RoomScanObject>[
        for (final Object? raw in detected)
          RoomScanObject.fromMap(raw! as Map<Object?, Object?>),
      ],
      coverage: (map['coverage'] as num? ?? 0).toDouble(),
      closed: map['closed'] == true,
      elapsed: Duration(milliseconds: (map['elapsedMs'] as num? ?? 0).round()),
      position: position == null ? null : point(position),
      heading: (map['heading'] as num?)?.toDouble(),
      areaM2: (map['areaM2'] as num?)?.toDouble(),
      instruction: map['instruction'] as String?,
    );
  }

  static const RoomScanUpdate empty = RoomScanUpdate(
    walls: <RoomScanWall>[],
    objects: <List<Offset>>[],
    coverage: 0,
    closed: false,
    elapsed: Duration.zero,
  );

  final List<RoomScanWall> walls;

  /// Every recognised object with its measurements, for marking machines
  /// (CHANGE 2.1). [objects] stays the plain footprints the plan draws.
  final List<RoomScanObject> detected;

  /// Furniture and equipment footprints, four corners each.
  final List<List<Offset>> objects;

  /// 0–1: how much of the outline is captured, weighted by confidence and
  /// by how many wall ends join up.
  final double coverage;

  /// True when every wall end meets another wall, so the outline is a loop.
  final bool closed;
  final Duration elapsed;

  /// Where the phone is, and which way it faces in radians.
  final Offset? position;
  final double? heading;

  /// Floor area, once RoomPlan has recognised the floor (iOS 17+).
  final double? areaM2;

  /// RoomPlan's coaching, e.g. "Slow down". Null when all is well.
  final String? instruction;
}

/// The files a finished scan leaves on the device.
@immutable
class RoomScanExport {
  const RoomScanExport({
    required this.usdzPath,
    required this.jsonPath,
    required this.bytes,
    required this.room,
  });

  factory RoomScanExport.fromMap(Map<Object?, Object?> map) {
    return RoomScanExport(
      usdzPath: map['usdzPath']! as String,
      jsonPath: map['jsonPath']! as String,
      bytes: (map['bytes'] as num? ?? 0).toInt(),
      room: RoomScanUpdate.fromMap(
        map['room'] as Map<Object?, Object?>? ?? const <Object?, Object?>{},
      ),
    );
  }

  /// The 3D model, for the walkthrough.
  final String usdzPath;

  /// RoomPlan's structured room description.
  final String jsonPath;
  final int bytes;

  /// The room as RoomPlan finalised it, which can differ slightly from the
  /// last live update.
  final RoomScanUpdate room;
}

/// A scan failed, e.g. camera access is off or the device cannot scan.
class RoomScanException implements Exception {
  const RoomScanException(this.code, this.message);

  factory RoomScanException.from(Object error) {
    if (error is RoomScanException) return error;
    if (error is PlatformException) {
      return RoomScanException(error.code, error.message ?? error.code);
    }
    if (error is MissingPluginException) {
      return const RoomScanException(
        'unavailable',
        'LiDAR scanning is not available on this platform.',
      );
    }
    return RoomScanException('unknown', '$error');
  }

  final String code;
  final String message;

  @override
  String toString() => 'RoomScanException($code): $message';
}

/// Drives the native scanner. One scan runs at a time.
class RoomScan {
  const RoomScan._();

  static const MethodChannel _methods = MethodChannel('flex/room_scan');
  static const EventChannel _events = EventChannel('flex/room_scan/events');

  static Future<T?> _call<T>(String method, [Object? args]) async {
    try {
      return await _methods.invokeMethod<T>(method, args);
    } catch (e) {
      throw RoomScanException.from(e);
    }
  }

  static Future<RoomScanDeviceInfo> deviceInfo() async {
    final Map<Object?, Object?>? map = await _call<Map<Object?, Object?>>(
      'deviceInfo',
    );
    return RoomScanDeviceInfo.fromMap(map ?? const <Object?, Object?>{});
  }

  /// Live updates. Subscribe before calling [start]. Native failures arrive
  /// as [RoomScanException] errors on the stream.
  static Stream<RoomScanUpdate> updates() {
    return _events.receiveBroadcastStream().map((Object? event) {
      final Map<Object?, Object?> map = event! as Map<Object?, Object?>;
      if (map['type'] == 'error') {
        throw RoomScanException(
          map['code'] as String? ?? 'scan_failed',
          map['message'] as String? ?? 'The scan stopped.',
        );
      }
      return RoomScanUpdate.fromMap(map);
    });
  }

  /// Starts a new scan. Prompts for camera access the first time.
  static Future<void> start() => _call<void>('start');

  /// Freezes the clock and updates. The AR session keeps tracking so the
  /// scan can carry on from the same place.
  static Future<void> pause() => _call<void>('pause');

  static Future<void> resume() => _call<void>('resume');

  /// Abandons the scan without exporting anything.
  static Future<void> stop() => _call<void>('stop');

  /// Saves the current camera frame as a JPEG and returns its path. Uses
  /// the scan's own camera feed, so the scan is not interrupted.
  static Future<String> capturePhoto() async {
    final String? path = await _call<String>('capturePhoto');
    if (path == null) {
      throw const RoomScanException('photo_failed', 'No camera frame yet.');
    }
    return path;
  }

  /// Ends the scan, lets RoomPlan finalise the room, and exports it. Can
  /// take a few seconds. The scan cannot be resumed afterwards.
  static Future<RoomScanExport> finish() async {
    final Map<Object?, Object?>? map = await _call<Map<Object?, Object?>>(
      'finish',
    );
    if (map == null) {
      throw const RoomScanException('export_failed', 'Nothing was exported.');
    }
    return RoomScanExport.fromMap(map);
  }
}

/// One object RoomPlan recognised, with the measurements needed to mark it
/// as a gym machine (CHANGE 2.1).
///
/// [category] is RoomPlan's own, and it has no gym machine categories at
/// all: most gym equipment arrives as `object`. What makes this a treadmill
/// is the surveyor naming it.
@immutable
class RoomScanObject {
  const RoomScanObject({
    required this.index,
    required this.centre,
    required this.widthM,
    required this.depthM,
    required this.heightM,
    required this.elevationM,
    required this.rotationDeg,
    required this.category,
    required this.confidence,
  });

  factory RoomScanObject.fromMap(Map<Object?, Object?> map) {
    double number(String key) => (map[key]! as num).toDouble();
    return RoomScanObject(
      index: (map['index']! as num).toInt(),
      centre: Offset(number('x'), number('z')),
      widthM: number('widthM'),
      depthM: number('depthM'),
      heightM: number('heightM'),
      elevationM: number('elevationM'),
      rotationDeg: number('rotationDeg'),
      category: map['category'] as String? ?? 'object',
      confidence: RoomScanConfidence.values.firstWhere(
        (RoomScanConfidence c) => c.name == map['confidence'],
        orElse: () => RoomScanConfidence.low,
      ),
    );
  }

  /// Stable within one scan, so a mark follows its object as the scan is
  /// refined.
  final int index;

  /// Centre on the floor plane, in the same frame as the walls.
  final Offset centre;
  final double widthM;
  final double depthM;
  final double heightM;

  /// How far the object's underside sits above the floor.
  final double elevationM;
  final double rotationDeg;
  final String category;
  final RoomScanConfidence confidence;
}

/// A finished 360 degree walkaround, waiting to be kept or retaken.
@immutable
class EquipmentVideo {
  const EquipmentVideo({
    required this.equipmentId,
    required this.path,
    required this.thumbnailPath,
    required this.bytes,
    required this.duration,
    required this.contentType,
    this.simulated = false,
  });

  factory EquipmentVideo.fromMap(Map<Object?, Object?> map) => EquipmentVideo(
    equipmentId: map['equipmentId']! as String,
    path: map['path']! as String,
    thumbnailPath: map['thumbnailPath'] as String?,
    bytes: (map['bytes']! as num).toInt(),
    duration: Duration(
      milliseconds: ((map['durationSeconds']! as num) * 1000).round(),
    ),
    contentType: map['contentType'] as String? ?? 'video/quicktime',
  );

  final String equipmentId;
  final String path;

  /// A poster frame taken on the phone, so the reviewer sees one without
  /// the server having to transcode anything.
  final String? thumbnailPath;
  final int bytes;
  final Duration duration;
  final String contentType;

  /// A demo walkaround from a device with no camera for it. It carries no
  /// file and is never uploaded: a made-up video in front of a reviewer
  /// would be worse than none.
  final bool simulated;
}

/// One sample of which way the camera points while a walkaround is being
/// recorded (I-06), from CoreMotion's device attitude.
@immutable
class RecorderMotion {
  const RecorderMotion({required this.headingDeg, this.pitchDeg});

  factory RecorderMotion.fromMap(Map<Object?, Object?> map) => RecorderMotion(
    headingDeg: (map['headingDeg']! as num).toDouble(),
    pitchDeg: (map['pitchDeg'] as num?)?.toDouble(),
  );

  /// The camera's horizontal direction, 0–360°, against an arbitrary but
  /// fixed reference: only changes in it mean anything.
  final double headingDeg;

  /// How far the camera points above (+) or below (−) the horizon.
  final double? pitchDeg;
}

/// The 360 degree equipment recorder (CHANGE 3).
///
/// Recording is a separate step from the room scan, not part of it: ARKit
/// holds the camera for as long as a RoomPlan scan is running, so the
/// walkaround happens once the scan is done. The video is a reference
/// asset and never produces geometry.
class EquipmentRecorder {
  const EquipmentRecorder._();

  /// Starts the camera and asks for access if it has not been given.
  /// Throws [RoomScanException] with code `scan_running` if a scan is still
  /// going, and `video_failed` if there is no camera (a simulator).
  static Future<void> prepare() => RoomScan._call<void>('video.prepare');

  static Future<void> start(String equipmentId) => RoomScan._call<void>(
    'video.start',
    <String, Object?>{'equipmentId': equipmentId},
  );

  /// Ends the recording and returns the file, its length and poster frame.
  static Future<EquipmentVideo> stop() async {
    final Map<Object?, Object?>? map =
        await RoomScan._call<Map<Object?, Object?>>('video.stop');
    return EquipmentVideo.fromMap(map ?? const <Object?, Object?>{});
  }

  /// Throws away a take the surveyor did not keep.
  static Future<void> discard(EquipmentVideo video) => RoomScan._call<void>(
    'video.discard',
    <String, Object?>{'path': video.path},
  );

  /// Releases the camera once the equipment step is over.
  static Future<void> dispose() => RoomScan._call<void>('video.dispose');

  static const EventChannel _motion = EventChannel(
    'flex/room_scan/video_events',
  );

  /// The camera's heading and pitch, about ten times a second while a
  /// recording runs, so the screen can show how far round the machine the
  /// surveyor has walked (I-06). Empty where there is no motion data, e.g.
  /// a simulator; anything malformed is skipped rather than ending it.
  static Stream<RecorderMotion> motion() => _motion
      .receiveBroadcastStream()
      .where(
        (Object? e) =>
            e is Map && e['type'] == 'motion' && e['headingDeg'] is num,
      )
      .map((Object? e) => RecorderMotion.fromMap(e! as Map<Object?, Object?>))
      .handleError((Object _) {});
}

/// The viewfinder for [EquipmentRecorder]. Shows nothing until
/// [EquipmentRecorder.prepare] has finished.
class EquipmentVideoPreview extends StatelessWidget {
  const EquipmentVideoPreview({super.key});

  @override
  Widget build(BuildContext context) {
    if (defaultTargetPlatform != TargetPlatform.iOS) {
      // Android has no recorder yet, for the same reason it has no scanner.
      return const ColoredBox(color: Color(0xFF000000));
    }
    return const UiKitView(
      viewType: 'flex/equipment_video_preview',
      creationParamsCodec: StandardMessageCodec(),
    );
  }
}
