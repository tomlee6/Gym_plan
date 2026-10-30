// F-07: machine type suggestions from the walkaround's picture, made on the
// phone. The classifier itself is Core ML in Swift and needs a device; what
// is covered here is what the app does with its answers.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:room_scan/room_scan.dart';

import 'package:mobile/models/equipment.dart';
import 'package:mobile/models/scan.dart';
import 'package:mobile/screens/equipment_capture_screen.dart';
import 'package:mobile/services/machine_type_suggester.dart';
import 'package:mobile/theme/app_theme.dart';

import 'phone_size.dart';

/// Answers every picture the same way, as a trained model might.
class _FakeSuggester extends MachineTypeSuggester {
  _FakeSuggester(this.answer);

  final List<MachineTypeSuggestion> answer;
  final List<String> asked = <String>[];

  @override
  Future<List<MachineTypeSuggestion>> classify(String imagePath) async {
    asked.add(imagePath);
    return answer;
  }
}

const MachineTypeSuggestion _treadmill = MachineTypeSuggestion(
  label: 'treadmill',
  confidence: 0.9,
);

EquipmentVideo _video({String id = 'EQ-001', bool simulated = false}) =>
    EquipmentVideo(
      equipmentId: id,
      path: '/videos/$id.mov',
      thumbnailPath: simulated ? null : '/videos/$id.jpg',
      bytes: 1000,
      duration: const Duration(seconds: 20),
      contentType: 'video/quicktime',
      simulated: simulated,
    );

Future<void> _open(
  WidgetTester tester, {
  List<Equipment> equipment = const <Equipment>[
    Equipment(equipmentId: 'EQ-001', type: 'bench', name: 'Bench'),
  ],
  Map<String, EquipmentVideo>? videos,
}) async {
  usePhoneSize(tester);
  await tester.pumpWidget(
    MaterialApp(
      theme: AppTheme.dark,
      home: EquipmentCaptureScreen(
        result: ScanResult(
          config: const ScanConfig(
            facilityId: 'fac_northgate',
            facility: 'Northgate Fitness',
            level: 2,
            heightM: 3.2,
          ),
          geometry: FloorOutline.geometry,
          coverage: 1,
          closed: true,
          walls: const <WallQuality>[],
          tags: const <ScanTag>[],
          photos: 0,
          elapsed: Duration.zero,
        ),
        equipment: equipment,
        videos: videos ?? <String, EquipmentVideo>{'EQ-001': _video()},
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  late _FakeSuggester suggester;

  void answer(List<MachineTypeSuggestion> suggestions) {
    suggester = _FakeSuggester(suggestions);
    MachineTypeSuggester.instance = suggester;
  }

  tearDown(() => MachineTypeSuggester.instance = const MachineTypeSuggester());

  group('the suggester', () {
    test('keeps likely types, best first, at most three', () async {
      answer(const <MachineTypeSuggestion>[
        MachineTypeSuggestion(label: 'bench', confidence: 0.31),
        MachineTypeSuggestion(label: 'treadmill', confidence: 0.9),
        MachineTypeSuggestion(label: 'elliptical', confidence: 0.05),
        MachineTypeSuggestion(label: 'rowingMachine', confidence: 0.4),
        MachineTypeSuggestion(label: 'legPress', confidence: 0.35),
      ]);
      final List<MachineTypeSuggestion> s = await suggester.suggest('x.jpg');
      expect(s.map((MachineTypeSuggestion e) => e.label), <String>[
        'treadmill',
        'rowingMachine',
        'legPress',
      ]);
    });

    test('off the phone there is no model, so no suggestions', () async {
      expect(await MachineClassifier.suggest('x.jpg'), isEmpty);
    });
  });

  group('on the equipment screen', () {
    testWidgets('offers the walkaround\'s suggestion, and uses it on tap', (
      WidgetTester tester,
    ) async {
      answer(const <MachineTypeSuggestion>[_treadmill]);
      await _open(tester);

      expect(suggester.asked, <String>['/videos/EQ-001.jpg']);
      expect(find.text('Looks like: Treadmill (90%)'), findsOneWidget);
      // Nothing changes until the surveyor says so.
      expect(find.textContaining('EQ-001 · Bench'), findsOneWidget);

      await tester.tap(find.widgetWithText(TextButton, 'Use'));
      await tester.pump();

      expect(find.textContaining('EQ-001 · Treadmill'), findsOneWidget);
      // The name followed the type, since it had not been typed over.
      expect(find.text('Treadmill'), findsOneWidget);
      expect(find.textContaining('Looks like'), findsNothing);
    });

    testWidgets('a name the surveyor typed is kept when the type changes', (
      WidgetTester tester,
    ) async {
      answer(const <MachineTypeSuggestion>[_treadmill]);
      await _open(
        tester,
        equipment: const <Equipment>[
          Equipment(equipmentId: 'EQ-001', type: 'bench', name: 'Front row'),
        ],
      );

      await tester.tap(find.widgetWithText(TextButton, 'Use'));
      await tester.pump();

      expect(find.textContaining('EQ-001 · Treadmill'), findsOneWidget);
      expect(find.text('Front row'), findsOneWidget);
    });

    testWidgets('says nothing when the suggestion agrees with the type', (
      WidgetTester tester,
    ) async {
      answer(const <MachineTypeSuggestion>[_treadmill]);
      await _open(
        tester,
        equipment: const <Equipment>[
          Equipment(equipmentId: 'EQ-001', type: 'treadmill', name: 'Run 1'),
        ],
      );
      expect(find.textContaining('Looks like'), findsNothing);
    });

    testWidgets('a simulated walkaround has no picture to classify', (
      WidgetTester tester,
    ) async {
      answer(const <MachineTypeSuggestion>[_treadmill]);
      await _open(
        tester,
        videos: <String, EquipmentVideo>{'EQ-001': _video(simulated: true)},
      );
      expect(suggester.asked, isEmpty);
      expect(find.textContaining('Looks like'), findsNothing);
    });

    testWidgets('no model on the phone: naming works exactly as before', (
      WidgetTester tester,
    ) async {
      answer(const <MachineTypeSuggestion>[]);
      await _open(tester);
      expect(find.textContaining('Looks like'), findsNothing);

      await tester.tap(find.byTooltip('Rename'));
      await tester.pumpAndSettle();
      expect(find.text('What is this machine?'), findsOneWidget);
      expect(find.text('Suggested from the walkaround'), findsNothing);
    });

    testWidgets('the rename sheet offers the suggestions above the list', (
      WidgetTester tester,
    ) async {
      answer(const <MachineTypeSuggestion>[
        _treadmill,
        MachineTypeSuggestion(label: 'elliptical', confidence: 0.5),
      ]);
      await _open(tester);

      await tester.tap(find.byTooltip('Rename'));
      await tester.pumpAndSettle();

      expect(find.text('Suggested from the walkaround'), findsOneWidget);
      expect(find.text('Treadmill 90%'), findsOneWidget);
      expect(find.text('Elliptical 50%'), findsOneWidget);

      await tester.tap(find.text('Treadmill 90%'));
      await tester.pump();
      await tester.ensureVisible(find.text('Save'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      expect(find.textContaining('EQ-001 · Treadmill'), findsOneWidget);
    });
  });
}
