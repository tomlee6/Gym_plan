import 'dart:convert';
import 'dart:io';
import 'dart:ui' show Size;

import 'package:flutter/foundation.dart';

import 'scan.dart';

/// The headline measurements of a scanned room: how big it is across, its
/// floor area and wall height, as shown beside the 3D model and the floor
/// plan.
@immutable
class RoomMeasurements {
  const RoomMeasurements({
    required this.wallCount,
    this.widthM,
    this.lengthM,
    this.areaM2,
    this.heightM,
    this.doorCount = 0,
    this.windowCount = 0,
  });

  /// From the scanned outline. [heightM] comes from RoomPlan's room data
  /// (see [wallHeightFromScanJson]), which the outline does not carry.
  factory RoomMeasurements.of(PlanGeometry geometry, {double? heightM}) {
    final Size? extent = geometry.wallExtentM;
    return RoomMeasurements(
      wallCount: geometry.walls.length,
      widthM: extent?.width,
      lengthM: extent?.height,
      areaM2: geometry.areaM2,
      heightM: heightM,
      doorCount: geometry.countOf(OpeningKind.door),
      windowCount: geometry.countOf(OpeningKind.window),
    );
  }

  factory RoomMeasurements.fromJson(Map<String, Object?> json) =>
      RoomMeasurements(
        wallCount: (json['wallCount'] as num? ?? 0).toInt(),
        widthM: (json['widthM'] as num?)?.toDouble(),
        lengthM: (json['lengthM'] as num?)?.toDouble(),
        areaM2: (json['areaM2'] as num?)?.toDouble(),
        heightM: (json['heightM'] as num?)?.toDouble(),
        doorCount: (json['doorCount'] as num? ?? 0).toInt(),
        windowCount: (json['windowCount'] as num? ?? 0).toInt(),
      );

  final int wallCount;

  /// Doors and windows RoomPlan found in the walls.
  final int doorCount;
  final int windowCount;

  /// The outline's extent along each side, in metres.
  final double? widthM;
  final double? lengthM;

  /// Floor area, once RoomPlan recognised the floor.
  final double? areaM2;

  /// The tallest wall RoomPlan measured: the room's wall height.
  final double? heightM;

  /// "12.4 × 8.1 m", or null before any wall.
  String? get sizeLabel => widthM == null || lengthM == null
      ? null
      : '${widthM!.toStringAsFixed(1)} × ${lengthM!.toStringAsFixed(1)} m';

  String? get areaLabel =>
      areaM2 == null ? null : '${areaM2!.toStringAsFixed(0)} m²';

  String? get heightLabel =>
      heightM == null ? null : '${heightM!.toStringAsFixed(2)} m high';

  Map<String, Object?> toJson() => <String, Object?>{
    'wallCount': wallCount,
    'widthM': widthM,
    'lengthM': lengthM,
    'areaM2': areaM2,
    'heightM': heightM,
    'doorCount': doorCount,
    'windowCount': windowCount,
  };

  /// The tallest wall in RoomPlan's `scan.json`: a CapturedRoom, or a
  /// CapturedStructure with its walls at the top or only in its `rooms`.
  /// Each wall's `dimensions` is (width, height, depth). Null when the file
  /// cannot be read or has no walls.
  static Future<double?> wallHeightFromScanJson(String path) async {
    try {
      final Object? data = jsonDecode(await File(path).readAsString());
      if (data is! Map) return null;
      final List<Object?> walls = <Object?>[
        ...(data['walls'] as List<Object?>? ?? const <Object?>[]),
        if ((data['walls'] as List<Object?>? ?? const <Object?>[]).isEmpty)
          for (final Object? room
              in data['rooms'] as List<Object?>? ?? const [])
            if (room is Map) ...(room['walls'] as List<Object?>? ?? const []),
      ];
      double? tallest;
      for (final Object? wall in walls) {
        if (wall is! Map) continue;
        final Object? dims = wall['dimensions'];
        if (dims is! List || dims.length < 2 || dims[1] is! num) continue;
        final double h = (dims[1] as num).toDouble();
        if (h > 0 && (tallest == null || h > tallest)) tallest = h;
      }
      return tallest;
    } catch (_) {
      return null;
    }
  }
}
