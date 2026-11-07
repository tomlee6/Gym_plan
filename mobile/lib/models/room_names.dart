import 'dart:convert';
import 'dart:io';

/// Naming the rooms a scan found, on the review screen, before upload.
///
/// The platform makes one room (a plan "space") per floor RoomPlan reports
/// when there is more than one, and otherwise one room for the whole floor
/// (shared/plan/reading.js). The names go up in that order as the
/// capture's `roomNames`, so [roomCountFromScanJson] counts rooms by the
/// same rules, and [roomNameProblem] checks a name by the same rules as the
/// web editor (shared/plan/model.js `spaceNameProblem`).
class RoomNames {
  RoomNames._();

  /// Longest room name, as on the web.
  static const int maxLength = 60;

  /// A floor smaller than this is not a room (as the platform reads it).
  static const double minFloorM2 = 0.5;

  /// What a one-room scan is called unless the surveyor names it.
  static const String singleRoom = 'Gym floor';

  /// "Free   weights " → "Free weights".
  static String tidy(String name) =>
      name.trim().replaceAll(RegExp(r'\s+'), ' ');

  /// The names a scan of [count] rooms starts with.
  static List<String> defaults(int count) => count <= 1
      ? <String>[singleRoom]
      : <String>[for (int i = 1; i <= count; i++) 'Room $i'];

  /// What is wrong with [name] for the room at [index] among [all], or
  /// null when it is fine.
  static String? roomNameProblem(String name, int index, List<String> all) {
    final String t = tidy(name);
    if (t.isEmpty) return 'Give the room a name.';
    if (t.length > maxLength) {
      return 'Keep the room name to $maxLength characters.';
    }
    final String key = t.toLowerCase();
    for (int i = 0; i < all.length; i++) {
      if (i != index && tidy(all[i]).toLowerCase() == key) {
        return 'Another room is already called “${tidy(all[i])}”.';
      }
    }
    return null;
  }

  /// How many rooms the platform will make from a RoomPlan `scan.json`:
  /// its floors with at least three corners and half a square metre, when
  /// there are two or more; otherwise one. Top-level surfaces are used as
  /// they are; a structure carrying only `rooms` is merged room by room,
  /// each surface once.
  static int roomCountFromJson(Object? data) {
    if (data is! Map) return 1;
    const List<String> keys = <String>[
      'walls',
      'doors',
      'windows',
      'openings',
      'objects',
      'floors',
    ];
    List<Object?> listOf(Object? v) => v is List ? v : const <Object?>[];
    List<Object?> floors = listOf(data['floors']);
    final bool merged =
        keys.every((String k) => listOf(data[k]).isEmpty) &&
        listOf(data['rooms']).isNotEmpty;
    if (merged) {
      final Set<String> seen = <String>{};
      floors = <Object?>[];
      for (final Object? room in listOf(data['rooms'])) {
        if (room is! Map) continue;
        for (final Object? f in listOf(room['floors'])) {
          final Object? id = f is Map ? f['identifier'] : null;
          final String? key = id is String ? id.toUpperCase() : null;
          if (key != null && !seen.add(key)) continue;
          floors.add(f);
        }
      }
    }
    final int rooms = floors.where(_isRoomFloor).length;
    return rooms > 1 ? rooms : 1;
  }

  /// The room count from a `scan.json` on disk; one if it cannot be read.
  static Future<int> roomCountFromScanJson(String? path) async {
    if (path == null) return 1;
    try {
      return roomCountFromJson(jsonDecode(await File(path).readAsString()));
    } catch (_) {
      return 1;
    }
  }

  static bool _isRoomFloor(Object? floor) {
    if (floor is! Map) return false;
    final Object? t = floor['transform'];
    if (t is! List ||
        t.expand((Object? e) => e is List ? e : <Object?>[e]).length != 16) {
      return false;
    }
    final Object? raw = floor['polygonCorners'];
    if (raw is! List || raw.length < 3) return false;
    final List<List<double>> corners = <List<double>>[];
    for (final Object? c in raw) {
      if (c is List && c.length >= 2 && c.every((Object? v) => v is num)) {
        corners.add(<double>[
          for (final Object? v in c) (v! as num).toDouble(),
          if (c.length == 2) 0,
        ]);
      } else if (c is Map && c['x'] is num && c['y'] is num) {
        corners.add(<double>[
          (c['x']! as num).toDouble(),
          (c['y']! as num).toDouble(),
          ((c['z'] as num?) ?? 0).toDouble(),
        ]);
      } else {
        return false;
      }
    }
    // The outline lies flat in its own frame: its area is the largest of
    // its shadows on the three planes.
    double shadow(int a, int b) {
      double twice = 0;
      for (int i = 0; i < corners.length; i++) {
        final List<double> p = corners[i];
        final List<double> q = corners[(i + 1) % corners.length];
        twice += p[a] * q[b] - q[a] * p[b];
      }
      return twice.abs() / 2;
    }

    final double area = <double>[
      shadow(0, 1),
      shadow(0, 2),
      shadow(1, 2),
    ].reduce((double x, double y) => x > y ? x : y);
    return area >= minFloorM2;
  }
}
