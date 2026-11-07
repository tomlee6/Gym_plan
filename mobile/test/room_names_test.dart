import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/models/room_names.dart';

/// A floor as RoomPlan writes it: a 4×4 transform and corners in its frame.
Map<String, Object?> floor(double w, double d, {String? id}) => <String, Object?>{
  'identifier': ?id,
  'transform': <double>[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  'polygonCorners': <List<double>>[
    <double>[0, 0, 0],
    <double>[w, 0, 0],
    <double>[w, d, 0],
    <double>[0, d, 0],
  ],
};

void main() {
  group('counting rooms as the platform does', () {
    test('one room for a scan with no floors, or only one', () {
      expect(RoomNames.roomCountFromJson(<String, Object?>{'walls': <Object?>[]}), 1);
      expect(
        RoomNames.roomCountFromJson(<String, Object?>{
          'floors': <Object?>[floor(10, 6)],
        }),
        1,
      );
    });

    test('a room per floor when the scan has several', () {
      expect(
        RoomNames.roomCountFromJson(<String, Object?>{
          'floors': <Object?>[floor(10, 6), floor(4, 4), floor(3, 2)],
        }),
        3,
      );
    });

    test('leaves out a floor too small to be a room, or without corners', () {
      expect(
        RoomNames.roomCountFromJson(<String, Object?>{
          'floors': <Object?>[
            floor(10, 6),
            floor(4, 4),
            floor(0.5, 0.5), // 0.25 m²
            <String, Object?>{'transform': <double>[], 'polygonCorners': <Object?>[]},
          ],
        }),
        2,
      );
    });

    test('merges a structure that only lists rooms, each floor once', () {
      final Map<String, Object?> structure = <String, Object?>{
        'rooms': <Object?>[
          <String, Object?>{
            'floors': <Object?>[floor(10, 6, id: 'a'), floor(4, 4, id: 'b')],
          },
          <String, Object?>{
            'floors': <Object?>[floor(4, 4, id: 'B'), floor(3, 3, id: 'c')],
          },
        ],
      };
      expect(RoomNames.roomCountFromJson(structure), 3);
      // Top-level surfaces win: the rooms are not merged in.
      expect(
        RoomNames.roomCountFromJson(<String, Object?>{
          ...structure,
          'walls': <Object?>[<String, Object?>{}],
        }),
        1,
      );
    });
  });

  group('room names', () {
    test('start as the platform would name them', () {
      expect(RoomNames.defaults(1), <String>['Gym floor']);
      expect(RoomNames.defaults(3), <String>['Room 1', 'Room 2', 'Room 3']);
    });

    test('are checked as on the web', () {
      final List<String> all = <String>['Free weights', 'cardio', 'Cardio '];
      expect(RoomNames.roomNameProblem('Free weights', 0, all), isNull);
      expect(RoomNames.roomNameProblem('  ', 0, all), 'Give the room a name.');
      expect(
        RoomNames.roomNameProblem('x' * 61, 0, all),
        'Keep the room name to 60 characters.',
      );
      expect(
        RoomNames.roomNameProblem('Cardio ', 2, all),
        'Another room is already called “cardio”.',
      );
      expect(RoomNames.tidy('  Free   weights '), 'Free weights');
    });
  });
}
