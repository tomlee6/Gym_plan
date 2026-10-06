import 'package:flutter/foundation.dart';
import 'package:room_scan/room_scan.dart';

/// A gym machine on a capture (CHANGE 2).
///
/// Position and size are metres in the scan's own frame, the same frame the
/// walls are in, so a machine ends up where it was scanned when the plan is
/// read. `(x, z)` here becomes `[x, y]` on the floor plan.
@immutable
class Equipment {
  const Equipment({
    required this.equipmentId,
    required this.type,
    required this.name,
    this.x,
    this.z,
    this.elevationM,
    this.rotationDeg,
    this.widthM,
    this.depthM,
    this.heightM,
    this.confidence,
    this.source = 'surveyor',
    this.detectedIndex,
  });

  /// A machine built from an object RoomPlan recognised: its measurements
  /// are kept, and only the name comes from the surveyor.
  factory Equipment.fromDetected({
    required String equipmentId,
    required String type,
    required String name,
    required RoomScanObject object,
  }) => Equipment(
    equipmentId: equipmentId,
    type: type,
    name: name,
    x: object.centre.dx,
    z: object.centre.dy,
    elevationM: object.elevationM,
    rotationDeg: object.rotationDeg,
    widthM: object.widthM,
    depthM: object.depthM,
    heightM: object.heightM,
    confidence: switch (object.confidence) {
      RoomScanConfidence.high => 0.95,
      RoomScanConfidence.medium => 0.7,
      RoomScanConfidence.low => 0.4,
    },
    source: 'roomplan',
    detectedIndex: object.index,
  );

  /// The reference the reviewer sees, e.g. `EQ-001`. Unique in its capture.
  final String equipmentId;

  /// Free text: the catalogue is a starting point, not a closed set, so a
  /// gym may use a machine type nothing else has heard of.
  final String type;
  final String name;

  final double? x;
  final double? z;
  final double? elevationM;
  final double? rotationDeg;
  final double? widthM;
  final double? depthM;
  final double? heightM;
  final double? confidence;

  /// `roomplan` when the scan found the shape, `surveyor` when it was
  /// placed by hand.
  final String source;

  /// Which scanned object this came from, so one object is not marked
  /// twice. Not sent to the platform: it means nothing outside this scan.
  final int? detectedIndex;

  bool get placed => x != null && z != null;

  Equipment copyWith({String? type, String? name}) => Equipment(
    equipmentId: equipmentId,
    type: type ?? this.type,
    name: name ?? this.name,
    x: x,
    z: z,
    elevationM: elevationM,
    rotationDeg: rotationDeg,
    widthM: widthM,
    depthM: depthM,
    heightM: heightM,
    confidence: confidence,
    source: source,
    detectedIndex: detectedIndex,
  );

  Map<String, Object?> toJson() => <String, Object?>{
    'equipmentId': equipmentId,
    'type': type,
    'name': name,
    'x': x,
    'z': z,
    'elevationM': elevationM,
    'rotationDeg': rotationDeg,
    'widthM': widthM,
    'depthM': depthM,
    'heightM': heightM,
    'confidence': confidence,
    'source': source,
  };
}

/// Suggestions, not a closed set (CHANGE 2.1). A type the surveyor types in
/// by hand is accepted by the platform exactly as typed.
const List<String> kEquipmentTypes = <String>[
  'treadmill',
  'legPress',
  'chestPress',
  'latPulldown',
  'cableMachine',
  'exerciseBike',
  'elliptical',
  'squatRack',
  'bench',
  'dumbbellRack',
  'smithMachine',
  'rowingMachine',
];

/// A readable label for a machine type, including one not in the list.
String equipmentLabel(String type) {
  if (type.isEmpty) return 'Equipment';
  final String spaced = type.replaceAllMapped(
    RegExp(r'([a-z0-9])([A-Z])'),
    (Match m) => '${m[1]} ${m[2]}',
  );
  return spaced[0].toUpperCase() + spaced.substring(1);
}

/// The next free reference in a list, as `EQ-001`, `EQ-002`, ...
String nextEquipmentId(Iterable<Equipment> existing) {
  final Set<String> used = existing.map((Equipment e) => e.equipmentId).toSet();
  for (int n = 1; n <= 999; n++) {
    final String id = 'EQ-${n.toString().padLeft(3, '0')}';
    if (!used.contains(id)) return id;
  }
  return 'EQ-${DateTime.now().millisecondsSinceEpoch}';
}
