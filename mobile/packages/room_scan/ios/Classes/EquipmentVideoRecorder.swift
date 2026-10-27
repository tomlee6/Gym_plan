import AVFoundation
import CoreMotion
import Flutter
import UIKit

/**
 CHANGE 3: the 360 degree walk round one piece of gym equipment.

 This records an ordinary video with `AVCaptureSession`. It is deliberately
 **not** part of the RoomPlan scan:

 - ARKit owns the camera for as long as a `RoomCaptureSession` is running,
   and two capture sessions cannot hold the same device at once. The 360
   capture happens after the room scan has finished, which is the order the
   workflow asks for anyway.
 - The video is a reference asset. It never produces geometry: where a
   machine stands comes from the LiDAR scan and the approved plan.

 A poster frame is taken here, on the phone, so the server needs no
 transcoding step to show one (CHANGE 4.2).

 The video carries **no sound** (A-04). A walkaround happens on a gym
 floor with members talking nearby, and their voices must not be stored;
 the reviewer only needs the picture. The session therefore has no audio
 input at all, so the movie output has no audio connection and the app
 never asks for the microphone (Info.plist has no
 NSMicrophoneUsageDescription; adding an audio input without one gets the
 app killed by iOS).

 While recording, the camera's heading and pitch are sampled from
 CoreMotion and sent to Flutter (I-06), so the screen can show how far
 round the machine the surveyor has walked.

 Requires an iOS device to test: the simulator has no camera, so `prepare`
 fails there with `no_camera`.
 */
final class EquipmentVideoRecorder: NSObject, AVCaptureFileOutputRecordingDelegate {
  enum RecorderError: LocalizedError {
    case noCamera
    case busy
    case notRecording
    case nothingRecorded
    case thumbnailFailed

    var errorDescription: String? {
      switch self {
      case .noCamera: return "This device has no camera available for recording."
      case .busy: return "A recording is already running."
      case .notRecording: return "No recording is running."
      case .nothingRecorded: return "The recording produced no file."
      case .thumbnailFailed: return "A poster frame could not be taken from the video."
      }
    }
  }

  private let session = AVCaptureSession()
  private let output = AVCaptureMovieFileOutput()
  private let folder: URL
  private let motion = CMMotionManager()

  /// Receives `{type: "motion", headingDeg, pitchDeg}` about ten times a
  /// second while recording. Set by the plugin when Flutter listens.
  var onMotion: (([String: Any]) -> Void)?

  /// Which machine is being recorded, so a finished file cannot be filed
  /// against the wrong one.
  private var equipmentId: String?
  private var startedAt: Date?
  private var finish: ((Result<[String: Any], Error>) -> Void)?

  /// The session is configured once and kept, so a retake starts at once
  /// rather than warming the camera up again.
  private(set) var prepared = false

  override init() {
    let support = try? FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask,
      appropriateFor: nil, create: true)
    // Application Support rather than tmp: an upload may outlive the app.
    folder = (support ?? URL(fileURLWithPath: NSTemporaryDirectory()))
      .appendingPathComponent("EquipmentVideos", isDirectory: true)
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    super.init()
  }

  /// The layer a Flutter platform view shows the viewfinder in.
  func previewLayer() -> AVCaptureVideoPreviewLayer {
    let layer = AVCaptureVideoPreviewLayer(session: session)
    layer.videoGravity = .resizeAspectFill
    return layer
  }

  // MARK: - Lifecycle

  /**
   Starts the camera. Asks for access first: the usage description already
   covers the camera, since the LiDAR scan uses it too. Only the camera:
   there is deliberately no microphone input (see the class comment).
   */
  func prepare() async throws {
    if prepared { return }

    if AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined {
      _ = await AVCaptureDevice.requestAccess(for: .video)
    }
    guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
      throw RecorderError.noCamera
    }

    session.beginConfiguration()
    session.sessionPreset = .high

    guard
      let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
      let videoInput = try? AVCaptureDeviceInput(device: camera),
      session.canAddInput(videoInput)
    else {
      session.commitConfiguration()
      throw RecorderError.noCamera
    }
    session.addInput(videoInput)

    // No audio input is added, ever: the walkaround is recorded silent so
    // members' voices are never stored. With only a video input, the movie
    // output gets only a video connection.
    guard session.canAddOutput(output) else {
      session.commitConfiguration()
      throw RecorderError.noCamera
    }
    session.addOutput(output)
    // Belt and braces: should an audio connection ever appear (another
    // input added by mistake), it records nothing.
    if let audio = output.connection(with: .audio) { audio.isEnabled = false }
    session.commitConfiguration()

    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      // startRunning blocks, so it stays off the main thread.
      DispatchQueue.global(qos: .userInitiated).async {
        self.session.startRunning()
        continuation.resume()
      }
    }
    prepared = true
  }

  /// Begins recording the walk round `equipmentId`.
  func start(equipmentId: String) throws {
    guard prepared else { throw RecorderError.noCamera }
    guard !output.isRecording else { throw RecorderError.busy }

    let url = folder.appendingPathComponent("\(equipmentId)-\(UUID().uuidString).mov")
    self.equipmentId = equipmentId
    startedAt = Date()
    // Keep the screen awake: a walkaround is slow and mostly hands-off.
    UIApplication.shared.isIdleTimerDisabled = true
    output.startRecording(to: url, recordingDelegate: self)
    startMotion()
  }

  // MARK: - Walk-around coverage (I-06)

  /**
   Samples which way the camera points, ten times a second.

   The heading is worked out from the attitude's rotation matrix rather
   than its yaw angle: the phone is held upright, which is exactly where
   Euler angles lose track of yaw (gimbal lock). The camera looks along the
   device's -z axis; its direction in the reference frame gives the
   heading (horizontal part) and the pitch (vertical part).

   Which way round the matrix is (reference-to-device or the reverse) is
   checked against gravity on each sample instead of assumed, so a wrong
   assumption cannot silently produce a heading that never changes. A
   camera pointing nearly straight up or down has no useful heading, and
   that sample is skipped.
   */
  private func startMotion() {
    guard motion.isDeviceMotionAvailable, !motion.isDeviceMotionActive else { return }
    motion.deviceMotionUpdateInterval = 0.1
    motion.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: OperationQueue.main) {
      [weak self] data, _ in
      guard let self = self, let data = data else { return }
      let m = data.attitude.rotationMatrix
      let g = data.gravity
      // Gravity, in device coordinates, is the reference frame's "down"
      // seen from the device: -(m13, m23, m33) if the rows are the device
      // axes, -(m31, m32, m33) if the columns are.
      let rowsError = abs(g.x + m.m13) + abs(g.y + m.m23)
      let columnsError = abs(g.x + m.m31) + abs(g.y + m.m32)
      let forwardX = rowsError <= columnsError ? -m.m31 : -m.m13
      let forwardY = rowsError <= columnsError ? -m.m32 : -m.m23
      let forwardZ = -m.m33
      guard (forwardX * forwardX + forwardY * forwardY).squareRoot() > 0.2 else { return }

      var heading = atan2(forwardY, forwardX) * 180 / Double.pi
      if heading < 0 { heading += 360 }
      let pitch = asin(max(-1, min(1, forwardZ))) * 180 / Double.pi
      guard heading.isFinite, pitch.isFinite else { return }
      self.onMotion?(["type": "motion", "headingDeg": heading, "pitchDeg": pitch])
    }
  }

  private func stopMotion() {
    if motion.isDeviceMotionActive { motion.stopDeviceMotionUpdates() }
  }

  /**
   Ends the recording and returns the file, its length and a poster frame.
   The continuation is resumed from the delegate callback below, once
   AVFoundation has finished writing.
   */
  func stop() async throws -> [String: Any] {
    guard output.isRecording else { throw RecorderError.notRecording }
    stopMotion()
    return try await withCheckedThrowingContinuation { continuation in
      finish = { continuation.resume(with: $0) }
      output.stopRecording()
    }
  }

  /// Throws away a take the surveyor did not keep (CHANGE 3.2, "Retake").
  func discard(path: String) {
    try? FileManager.default.removeItem(at: URL(fileURLWithPath: path))
    let thumbnail = URL(fileURLWithPath: path).deletingPathExtension().appendingPathExtension("jpg")
    try? FileManager.default.removeItem(at: thumbnail)
  }

  /// Releases the camera once the equipment step is over.
  func dispose() {
    stopMotion()
    if output.isRecording { output.stopRecording() }
    UIApplication.shared.isIdleTimerDisabled = false
    if session.isRunning {
      DispatchQueue.global(qos: .userInitiated).async { self.session.stopRunning() }
    }
    prepared = false
  }

  // MARK: - AVCaptureFileOutputRecordingDelegate

  func fileOutput(
    _ output: AVCaptureFileOutput,
    didFinishRecordingTo outputFileURL: URL,
    from connections: [AVCaptureConnection],
    error: Error?
  ) {
    UIApplication.shared.isIdleTimerDisabled = false
    stopMotion()
    let callback = finish
    finish = nil
    let id = equipmentId
    equipmentId = nil

    if let error = error {
      try? FileManager.default.removeItem(at: outputFileURL)
      callback?(.failure(error))
      return
    }

    Task {
      do {
        let asset = AVURLAsset(url: outputFileURL)
        let duration = try await asset.load(.duration)
        let thumbnail = try Self.posterFrame(of: asset, besideVideoAt: outputFileURL)
        let bytes =
          (try? FileManager.default.attributesOfItem(atPath: outputFileURL.path)[.size] as? NSNumber)??
          .intValue ?? 0

        callback?(
          .success([
            "equipmentId": id ?? "",
            "path": outputFileURL.path,
            "thumbnailPath": thumbnail.path,
            "bytes": bytes,
            "durationSeconds": CMTimeGetSeconds(duration),
            // The recorder writes QuickTime; the platform accepts it
            // alongside mp4 and stores it as recorded.
            "contentType": "video/quicktime",
          ]))
      } catch {
        callback?(.failure(error))
      }
    }
  }

  /**
   A frame from early in the walkaround, written beside the video.

   Taken here rather than on the server so no transcoding step is needed to
   show a poster frame in the reviewer (CHANGE 4.2).
   */
  private static func posterFrame(of asset: AVURLAsset, besideVideoAt url: URL) throws -> URL {
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: 1280, height: 1280)

    // One second in, by which point the camera has settled and is pointing
    // at the machine rather than the floor.
    let at = CMTime(seconds: 1, preferredTimescale: 600)
    guard
      let image = try? generator.copyCGImage(at: at, actualTime: nil)
        ?? generator.copyCGImage(at: .zero, actualTime: nil),
      let data = UIImage(cgImage: image).jpegData(compressionQuality: 0.8)
    else {
      throw RecorderError.thumbnailFailed
    }

    let destination = url.deletingPathExtension().appendingPathExtension("jpg")
    try data.write(to: destination)
    return destination
  }
}

/**
 The viewfinder, as a Flutter platform view. The layer follows the view's
 bounds so it keeps filling the frame through a rotation.
 */
final class EquipmentVideoPreview: NSObject, FlutterPlatformView {
  private let container: PreviewView

  init(frame: CGRect, recorder: EquipmentVideoRecorder) {
    container = PreviewView(frame: frame)
    container.previewLayer = recorder.previewLayer()
    super.init()
  }

  func view() -> UIView { container }

  private final class PreviewView: UIView {
    var previewLayer: AVCaptureVideoPreviewLayer? {
      didSet {
        oldValue?.removeFromSuperlayer()
        if let layer = previewLayer {
          layer.frame = bounds
          self.layer.addSublayer(layer)
        }
      }
    }

    override func layoutSubviews() {
      super.layoutSubviews()
      previewLayer?.frame = bounds
    }
  }
}

final class EquipmentVideoPreviewFactory: NSObject, FlutterPlatformViewFactory {
  private let recorder: () -> EquipmentVideoRecorder

  init(recorder: @escaping () -> EquipmentVideoRecorder) {
    self.recorder = recorder
    super.init()
  }

  func create(withFrame frame: CGRect, viewIdentifier viewId: Int64, arguments args: Any?)
    -> FlutterPlatformView
  {
    EquipmentVideoPreview(frame: frame, recorder: recorder())
  }
}
