import Foundation
import RealityKit
import SwiftUI
import UIKit

/**
 "3D Object": one object (a machine, say) as a photo-textured 3D model,
 with Apple's Object Capture (iOS 17, LiDAR iPhones).

 Apple's own guided capture screen (ObjectCaptureView) is shown full
 screen over the app: the surveyor frames the object, starts, and walks
 round it while photos are taken automatically. Then PhotogrammetrySession
 builds the model on the phone, as `object.usdz`, which is handed back to
 Flutter. Cancelling hands back nothing.
 */
enum ObjectScanner {
  /// ObjectCaptureSession is main-actor isolated, so this is too.
  @MainActor
  static var isSupported: Bool {
    ObjectCaptureSession.isSupported && PhotogrammetrySession.isSupported
  }

  /// Shows the capture over the app. `completion` gets the result's map,
  /// or nil if cancelled, on the main thread.
  @MainActor
  static func present(completion: @escaping (Result<[String: Any]?, Error>) -> Void) {
    guard isSupported else {
      completion(.failure(ObjectCaptureModel.CaptureError.unsupported))
      return
    }
    guard let top = topViewController() else {
      completion(.failure(ObjectCaptureModel.CaptureError.noWindow))
      return
    }
    let model = ObjectCaptureModel()
    let host = UIHostingController(rootView: ObjectCaptureScreen(model: model))
    host.modalPresentationStyle = .fullScreen
    model.onFinish = { [weak host] result in
      host?.dismiss(animated: true) { completion(result) }
    }
    top.present(host, animated: true) { model.start() }
  }

  @MainActor
  private static func topViewController() -> UIViewController? {
    let window = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
      .first { $0.isKeyWindow }
    var top = window?.rootViewController
    while let presented = top?.presentedViewController { top = presented }
    return top
  }
}

/// The capture and the reconstruction after it.
@MainActor
final class ObjectCaptureModel: ObservableObject {
  enum CaptureError: LocalizedError {
    case unsupported, noWindow, noModel, notEnoughPhotos

    var errorDescription: String? {
      switch self {
      case .unsupported: return "This device cannot capture 3D objects."
      case .noWindow: return "The capture screen could not be shown."
      case .noModel: return "The 3D model could not be built. Try again with more of the object in view."
      case .notEnoughPhotos:
        return "Not enough photos to build the model. Walk slowly all the way round the object, "
          + "keeping it in view, until the ring fills."
      }
    }
  }

  /// Photos needed before Finish is offered. Photogrammetry refuses far
  /// fewer, and a full walk round takes many more.
  static let minimumPhotos = 20

  enum Phase {
    case capturing
    case building(progress: Double)
  }

  let session = ObjectCaptureSession()
  @Published var state: ObjectCaptureSession.CaptureState = .initializing
  @Published var phase: Phase = .capturing
  @Published var error: String?
  /// Photos taken so far in the walk round.
  @Published var shots = 0

  var onFinish: (@MainActor (Result<[String: Any]?, Error>) -> Void)?

  private let folder: URL
  private var imagesFolder: URL { folder.appendingPathComponent("Images", isDirectory: true) }
  private var checkpoints: URL { folder.appendingPathComponent("Checkpoints", isDirectory: true) }
  private var output: URL { folder.appendingPathComponent("object.usdz") }
  private var finished = false

  init() {
    let support =
      (try? FileManager.default.url(
        for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
      ?? URL(fileURLWithPath: NSTemporaryDirectory())
    folder = support.appendingPathComponent("Objects", isDirectory: true)
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
  }

  func start() {
    try? FileManager.default.createDirectory(at: imagesFolder, withIntermediateDirectories: true)
    try? FileManager.default.createDirectory(at: checkpoints, withIntermediateDirectories: true)
    var configuration = ObjectCaptureSession.Configuration()
    configuration.checkpointDirectory = checkpoints
    session.start(imagesDirectory: imagesFolder, configuration: configuration)
    // The session may already have moved on (to .ready) before the loop
    // below starts listening, and stateUpdates only reports changes from
    // then on; without this the screen waits for a .ready that has passed.
    apply(session.state)
    Task {
      for await state in session.stateUpdates {
        apply(state)
      }
    }
    // Twice a second until the walk round ends: picks up a state the stream
    // did not report while the camera starts, and counts the photos, which
    // the session does not announce.
    Task {
      while !finished && !building {
        try? await Task.sleep(nanoseconds: 500_000_000)
        if case .initializing = state { apply(session.state) }
        shots = session.numberOfShotsTaken
      }
    }
  }

  private var building = false

  private func apply(_ newState: ObjectCaptureSession.CaptureState) {
    state = newState
    switch newState {
    case .completed:
      guard !building else { return }
      building = true
      Task { await build() }
    case .failed(let failure):
      error = failure.localizedDescription
    default:
      break
    }
  }

  /// The one button under the camera, by stage: frame the object, start
  /// the walk round, then finish.
  var actionTitle: String {
    switch state {
    case .ready: return "Continue"
    case .detecting: return "Start capture"
    case .capturing:
      return shots < Self.minimumPhotos
        ? "Keep walking round · \(shots)/\(Self.minimumPhotos) photos"
        : "Finish · \(shots) photos"
    case .finishing: return "Finishing…"
    case .failed: return "Close"
    default: return "Starting the camera…"
    }
  }

  /// Whether the button does anything at this stage. Finish waits for
  /// enough photos: the model cannot be built from a handful.
  var actionEnabled: Bool {
    switch state {
    case .ready, .detecting, .failed: return true
    case .capturing: return shots >= Self.minimumPhotos
    default: return false
    }
  }

  func act() {
    switch state {
    case .ready: _ = session.startDetecting()
    case .detecting: session.startCapturing()
    case .capturing:
      guard session.numberOfShotsTaken >= Self.minimumPhotos else { return }
      session.finish()
    case .failed: cancel()
    default: break
    }
    // Read back at once, so the button moves on even if the update is late.
    apply(session.state)
  }

  func cancel() {
    // A session that has completed or failed is already over; cancelling
    // it again is an error to ObjectCaptureSession.
    switch session.state {
    case .completed, .failed: break
    default: session.cancel()
    }
    try? FileManager.default.removeItem(at: folder)
    done(.success(nil))
  }

  /// Builds the model from the photos, on the phone.
  private func build() async {
    phase = .building(progress: 0)
    let taken = (try? FileManager.default.contentsOfDirectory(atPath: imagesFolder.path).count) ?? 0
    guard taken >= Self.minimumPhotos else {
      try? FileManager.default.removeItem(at: folder)
      done(.failure(CaptureError.notEnoughPhotos))
      return
    }
    do {
      var configuration = PhotogrammetrySession.Configuration()
      configuration.checkpointDirectory = checkpoints
      let photogrammetry = try PhotogrammetrySession(input: imagesFolder, configuration: configuration)
      try photogrammetry.process(requests: [.modelFile(url: output, detail: .reduced)])
      for try await message in photogrammetry.outputs {
        switch message {
        case .requestProgress(_, let fraction):
          phase = .building(progress: fraction)
        case .requestError(_, let failure):
          throw failure
        case .processingComplete:
          guard FileManager.default.fileExists(atPath: output.path) else {
            throw CaptureError.noModel
          }
          let photos =
            (try? FileManager.default.contentsOfDirectory(atPath: imagesFolder.path).count) ?? 0
          let bytes =
            ((try? FileManager.default.attributesOfItem(atPath: output.path))?[.size] as? NSNumber)?
            .intValue ?? 0
          // The photos are only needed to build it.
          try? FileManager.default.removeItem(at: imagesFolder)
          try? FileManager.default.removeItem(at: checkpoints)
          done(.success(["modelPath": output.path, "photos": photos, "bytes": bytes]))
          return
        default:
          break
        }
      }
    } catch {
      done(.failure(error))
    }
  }

  private func done(_ result: Result<[String: Any]?, Error>) {
    guard !finished else { return }
    finished = true
    onFinish?(result)
  }
}

/// Apple's guided capture with a cancel button and the one action button,
/// then progress while the model is built.
@MainActor
struct ObjectCaptureScreen: View {
  @ObservedObject var model: ObjectCaptureModel

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()
      switch model.phase {
      case .capturing:
        capture
      case .building(let progress):
        building(progress)
      }
    }
  }

  private var capture: some View {
    ZStack {
      ObjectCaptureView(session: model.session)
        .ignoresSafeArea()
      VStack {
        HStack {
          Button("Cancel") { model.cancel() }
            .padding(.horizontal, 16)
            .padding(.vertical, 9)
            .background(.black.opacity(0.55), in: Capsule())
            .foregroundStyle(.white)
          Spacer()
        }
        .padding()
        Spacer()
        if let error = model.error {
          Text(error)
            .font(.footnote)
            .foregroundStyle(.white)
            .padding(12)
            .background(.red.opacity(0.75), in: RoundedRectangle(cornerRadius: 12))
            .padding(.horizontal)
        }
        Button(action: { model.act() }) {
          Text(model.actionTitle)
            .font(.headline)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 15)
        }
        .disabled(!model.actionEnabled)
        .background(
          Color(red: 0.0, green: 0.79, blue: 0.70).opacity(model.actionEnabled ? 1 : 0.45),
          in: Capsule()
        )
        .foregroundStyle(Color(red: 0.0, green: 0.02, blue: 0.04))
        .padding(.horizontal, 24)
        .padding(.bottom, 24)
      }
    }
  }

  private func building(_ progress: Double) -> some View {
    VStack(spacing: 16) {
      ProgressView(value: progress)
        .progressViewStyle(.linear)
        .tint(Color(red: 0.0, green: 0.79, blue: 0.70))
        .frame(width: 220)
      Text("Building your 3D object…")
        .font(.headline)
        .foregroundStyle(.white)
      Text("\(Int(progress * 100))% · keep the app open")
        .font(.footnote)
        .foregroundStyle(.gray)
      if let error = model.error {
        Text(error).font(.footnote).foregroundStyle(.red)
      }
    }
  }
}
