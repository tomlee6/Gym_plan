import 'dart:convert';
import 'dart:io';
import 'dart:ui' show Offset;

import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';
import 'package:room_scan/room_scan.dart';

import '../models/room_measurements.dart';
import '../models/scan.dart';

/// One scan kept on this phone for the dashboard: its 3D model, room data,
/// a thumbnail and its floor plan, so it can be looked at again in 3D or as
/// a plan, even with no signal.
@immutable
class SavedScan {
  const SavedScan({
    required this.id,
    required this.title,
    required this.facility,
    required this.level,
    required this.createdAt,
    required this.geometry,
    required this.walls,
    required this.measurements,
    this.modelPath,
    this.dataPath,
    this.thumbnailPath,
  });

  final String id;

  /// "Northgate · Level 2".
  final String title;
  final String facility;
  final int level;
  final DateTime createdAt;

  /// The floor plan, in metres.
  final PlanGeometry geometry;
  final List<WallQuality> walls;
  final RoomMeasurements measurements;

  /// RoomPlan's `scan.usdz`, `scan.json` and a still of the model. Null when
  /// they could not be kept.
  final String? modelPath;
  final String? dataPath;
  final String? thumbnailPath;
}

/// The scans kept on this phone (Application Support, `ScanLibrary/<id>/`),
/// newest first.
///
/// The upload deletes a capture's own files once the platform has them, so
/// a scan is copied in here when it is submitted. Each folder holds the
/// model, the room data, a thumbnail and `entry.json` with the rest; paths
/// are stored relative to the folder, since iOS moves the app's container
/// between installs.
class ScanLibrary extends ChangeNotifier {
  ScanLibrary({
    Future<Directory> Function()? directory,
    Future<String?> Function(String modelPath, String outPath)? thumbnailer,
  }) : _directory = directory ?? getApplicationSupportDirectory,
       _thumbnailer = thumbnailer ?? renderModelThumbnail;

  /// The library the app uses. Tests replace it with [MemoryScanLibrary].
  static ScanLibrary instance = ScanLibrary();

  final Future<Directory> Function() _directory;
  final Future<String?> Function(String, String) _thumbnailer;

  Future<Directory> _root() async =>
      Directory('${(await _directory()).path}/ScanLibrary');

  /// Every kept scan, newest first. A folder that cannot be read is skipped.
  Future<List<SavedScan>> scans() async {
    final Directory root = await _root();
    if (!await root.exists()) return const <SavedScan>[];
    final List<SavedScan> found = <SavedScan>[];
    await for (final FileSystemEntity entry in root.list()) {
      if (entry is! Directory) continue;
      final File file = File('${entry.path}/entry.json');
      if (!await file.exists()) continue;
      try {
        found.add(
          _fromJson(
            entry.path,
            jsonDecode(await file.readAsString()) as Map<String, Object?>,
          ),
        );
      } catch (_) {
        // A damaged entry only hides that scan.
      }
    }
    found.sort(
      (SavedScan a, SavedScan b) => b.createdAt.compareTo(a.createdAt),
    );
    return found;
  }

  /// Keeps [result] and copies of [export]'s files. Returns the kept scan,
  /// or null if nothing could be written; keeping it is only ever a help,
  /// so a failure never stops a submit.
  Future<SavedScan?> save(ScanResult result, ScanExport? export) async {
    try {
      final String id = DateTime.now().microsecondsSinceEpoch.toString();
      final Directory folder = Directory('${(await _root()).path}/$id');
      await folder.create(recursive: true);

      Future<String?> copy(String? from, String name) async {
        if (from == null || !await File(from).exists()) return null;
        await File(from).copy('${folder.path}/$name');
        return name;
      }

      final String? model = await copy(export?.modelPath, 'scan.usdz');
      final String? data = await copy(export?.dataPath, 'scan.json');
      String? thumbnail;
      if (model != null) {
        final String? made = await _thumbnailer(
          '${folder.path}/$model',
          '${folder.path}/thumbnail.png',
        );
        if (made != null) thumbnail = 'thumbnail.png';
      }
      final double? height = data == null
          ? null
          : await RoomMeasurements.wallHeightFromScanJson(
              '${folder.path}/$data',
            );

      final Map<String, Object?> json = <String, Object?>{
        'id': id,
        'title': result.config.shortTitle,
        'facility': result.config.facility,
        'level': result.config.level,
        'createdAt': DateTime.now().toUtc().toIso8601String(),
        'model': model,
        'data': data,
        'thumbnail': thumbnail,
        'measurements': RoomMeasurements.of(
          result.geometry,
          heightM: height,
        ).toJson(),
        'metresPerUnit': result.geometry.metresPerUnit,
        'areaM2': result.geometry.areaM2,
        'walls': <Object?>[
          for (int i = 0; i < result.geometry.walls.length; i++)
            <Object?>[
              result.geometry.walls[i].start.dx,
              result.geometry.walls[i].start.dy,
              result.geometry.walls[i].end.dx,
              result.geometry.walls[i].end.dy,
              (i < result.walls.length ? result.walls[i] : WallQuality.captured)
                  .name,
            ],
        ],
        'objects': <Object?>[
          for (final List<Offset> o in result.geometry.objects)
            <Object?>[
              for (final Offset p in o) <double>[p.dx, p.dy],
            ],
        ],
      };
      await File('${folder.path}/entry.json').writeAsString(jsonEncode(json));
      notifyListeners();
      return _fromJson(folder.path, json);
    } catch (_) {
      return null;
    }
  }

  /// Removes a kept scan and its files. The submitted capture on the
  /// platform is not touched.
  Future<void> delete(SavedScan scan) async {
    try {
      final Directory folder = Directory('${(await _root()).path}/${scan.id}');
      if (await folder.exists()) await folder.delete(recursive: true);
    } catch (_) {
      // Already gone, or not ours to remove.
    }
    notifyListeners();
  }

  static SavedScan _fromJson(String folder, Map<String, Object?> json) {
    String? path(String key) {
      final String? name = json[key] as String?;
      return name == null ? null : '$folder/$name';
    }

    final List<WallSegment> segments = <WallSegment>[];
    final List<WallQuality> qualities = <WallQuality>[];
    for (final Object? raw in json['walls'] as List<Object?>? ?? const []) {
      final List<Object?> w = raw! as List<Object?>;
      double n(int i) => (w[i]! as num).toDouble();
      segments.add(WallSegment(Offset(n(0), n(1)), Offset(n(2), n(3))));
      qualities.add(
        WallQuality.values.firstWhere(
          (WallQuality q) => q.name == w[4],
          orElse: () => WallQuality.captured,
        ),
      );
    }
    final List<List<Offset>> objects = <List<Offset>>[
      for (final Object? o in json['objects'] as List<Object?>? ?? const [])
        <Offset>[
          for (final Object? p in o! as List<Object?>)
            Offset(
              ((p! as List<Object?>)[0]! as num).toDouble(),
              ((p as List<Object?>)[1]! as num).toDouble(),
            ),
        ],
    ];

    return SavedScan(
      id: json['id']! as String,
      title: json['title']! as String,
      facility: json['facility'] as String? ?? '',
      level: (json['level'] as num? ?? 0).toInt(),
      createdAt: DateTime.parse(json['createdAt']! as String).toLocal(),
      geometry: PlanGeometry.fitted(
        walls: segments,
        objects: objects,
        areaM2: (json['areaM2'] as num?)?.toDouble(),
      ),
      walls: qualities,
      measurements: RoomMeasurements.fromJson(
        json['measurements'] as Map<String, Object?>? ?? const {},
      ),
      modelPath: path('model'),
      dataPath: path('data'),
      thumbnailPath: path('thumbnail'),
    );
  }
}

/// Keeps scans in memory only, for tests.
class MemoryScanLibrary extends ScanLibrary {
  MemoryScanLibrary();

  final List<SavedScan> kept = <SavedScan>[];

  @override
  Future<List<SavedScan>> scans() async => List<SavedScan>.of(kept.reversed);

  @override
  Future<SavedScan?> save(ScanResult result, ScanExport? export) async {
    final SavedScan scan = SavedScan(
      id: '${kept.length + 1}',
      title: result.config.shortTitle,
      facility: result.config.facility,
      level: result.config.level,
      createdAt: DateTime.now(),
      geometry: result.geometry,
      walls: result.walls,
      measurements: RoomMeasurements.of(result.geometry),
      modelPath: export?.modelPath,
      dataPath: export?.dataPath,
    );
    kept.add(scan);
    notifyListeners();
    return scan;
  }

  @override
  Future<void> delete(SavedScan scan) async {
    kept.removeWhere((SavedScan s) => s.id == scan.id);
    notifyListeners();
  }
}
