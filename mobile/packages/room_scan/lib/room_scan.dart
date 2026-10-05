/// LiDAR room scanning, backed by Apple RoomPlan on iOS.
///
/// Coordinates are metres on the floor plane, seen from above: `x` is the
/// world x axis and `y` is the world z axis, both relative to where the
/// phone was when the scan started.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

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
