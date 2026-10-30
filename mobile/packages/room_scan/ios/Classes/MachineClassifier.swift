import CoreML
import Foundation
import ImageIO
import Vision

/**
 Suggests a gym machine's type from a picture of it (F-07), on the phone.

 The model is a Core ML image classifier, `MachineClassifier.mlmodel`,
 trained (e.g. with Create ML) on photos of gym machines, with the app's
 machine type ids as its class labels: `treadmill`, `legPress`,
 `chestPress`, ... (mobile/lib/models/equipment.dart). Added to the Runner
 target in Xcode, it is compiled into the app as `MachineClassifier.mlmodelc`
 and found here. Without it there are no suggestions, and the surveyor
 names machines exactly as before.

 It runs on the device through Vision, so the picture never leaves the
 phone: there is no outside service to host, or to keep in Australia.
 */
final class MachineClassifier {
  static let shared = MachineClassifier()

  /// Suggestions below this are noise rather than help.
  private static let minimumConfidence: VNConfidence = 0.15
  private static let maximumSuggestions = 3

  private let queue = DispatchQueue(label: "flex.room_scan.machine_classifier", qos: .userInitiated)

  /// Loaded on first use. `.some(nil)` once it is known there is no model.
  private var model: VNCoreMLModel??

  private init() {}

  /// The likeliest types for the image at `imagePath`, best first, as
  /// `[{label, confidence}]`. Calls back on the main thread; empty when
  /// there is no model or the image cannot be read.
  func suggest(imagePath: String, completion: @escaping ([[String: Any]]) -> Void) {
    queue.async {
      let suggestions = self.classify(URL(fileURLWithPath: imagePath))
      DispatchQueue.main.async { completion(suggestions) }
    }
  }

  private func loadedModel() -> VNCoreMLModel? {
    if let loaded = model { return loaded }
    var found: VNCoreMLModel?
    if let url = Bundle.main.url(forResource: "MachineClassifier", withExtension: "mlmodelc") {
      do {
        let config = MLModelConfiguration()
        config.computeUnits = .all
        found = try VNCoreMLModel(for: MLModel(contentsOf: url, configuration: config))
      } catch {
        NSLog("MachineClassifier: the model could not be loaded: \(error)")
      }
    }
    model = .some(found)
    return found
  }

  private func classify(_ image: URL) -> [[String: Any]] {
    guard let model = loadedModel(),
      FileManager.default.fileExists(atPath: image.path)
    else { return [] }

    let request = VNCoreMLRequest(model: model)
    // The poster frame is a whole scene; a centre crop would cut off a
    // long machine.
    request.imageCropAndScaleOption = .scaleFit

    do {
      try VNImageRequestHandler(url: image, options: [:]).perform([request])
    } catch {
      NSLog("MachineClassifier: classification failed: \(error)")
      return []
    }

    let observations = (request.results as? [VNClassificationObservation]) ?? []
    return observations
      .filter { $0.confidence >= Self.minimumConfidence }
      .sorted { $0.confidence > $1.confidence }
      .prefix(Self.maximumSuggestions)
      .map { ["label": $0.identifier, "confidence": Double($0.confidence)] }
  }
}
