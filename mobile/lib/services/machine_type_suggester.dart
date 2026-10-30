import 'package:room_scan/room_scan.dart';

/// Suggests a machine's type from a picture of it (F-07): the walkaround's
/// poster frame, classified on the phone (see [MachineClassifier]).
///
/// Only ever a suggestion. The surveyor confirms it, or names the machine
/// as before; nothing is set without them, and the reviewer still sees and
/// can change the type.
class MachineTypeSuggester {
  const MachineTypeSuggester();

  /// Replaced in tests.
  static MachineTypeSuggester instance = const MachineTypeSuggester();

  /// Below this a suggestion is more likely to mislead than help.
  static const double minimumConfidence = 0.3;

  static const int maximumSuggestions = 3;

  /// The likeliest types, best first. Empty when there is no model on the
  /// phone or nothing is likely enough.
  Future<List<MachineTypeSuggestion>> suggest(String imagePath) async {
    final List<MachineTypeSuggestion> raw = await classify(imagePath);
    return (raw
            .where(
              (MachineTypeSuggestion s) => s.confidence >= minimumConfidence,
            )
            .toList()
          ..sort(
            (MachineTypeSuggestion a, MachineTypeSuggestion b) =>
                b.confidence.compareTo(a.confidence),
          ))
        .take(maximumSuggestions)
        .toList();
  }

  /// The classifier's raw answer.
  Future<List<MachineTypeSuggestion>> classify(String imagePath) =>
      MachineClassifier.suggest(imagePath);
}
