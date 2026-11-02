#if canImport(ARKit)
import ARKit
import AVFoundation
import CoreImage
import Foundation

/**
 The room video recorded in the background of a LiDAR room scan, for the
 reviewer to set beside the 3D model and check it against the real room.

 It opens no camera of its own. ARKit holds the camera for the whole of a
 RoomPlan scan, and a second capture session would interrupt it, so the
 video is made from the frames the scan's own `ARSession` already produces:
 `currentFrame` is read on a timer (the same way `RoomScanner.capturePhoto`
 takes a photo), and each new frame is downscaled and appended with
 `AVAssetWriter`. Nothing is set as the AR session's delegate, so RoomPlan's
 handling of the session is left exactly as it was.

 - Portrait, H.264 in an MP4, so every browser plays it as it is.
 - No sound, like the equipment walkaround (A-04): members' voices in a gym
   are never stored.
 - 15 frames a second at 960 × 720: enough to see the room, small enough
   for a ten-minute scan to upload on a phone connection (about 2 Mbit/s).
 - Pausing the scan pauses the video; the paused stretch is left out, so the
   video plays straight through.
 - At most one frame is held at a time. ARKit reuses a small pool of camera
   buffers, and holding several would starve the scan; a frame that arrives
   while the last is still being encoded is skipped.

 Best effort by design: if the video cannot be written, the scan itself is
 unaffected and is submitted without it.

 Called on the main thread, like the rest of the scanner; encoding runs on
 its own queue.
 */
final class ScanVideoRecorder {
  struct Recording {
    let url: URL
    let bytes: Int
    let durationMs: Int
  }

  private static let framesPerSecond: Double = 15
  /// Landscape, as the sensor delivers it; the track is turned to portrait.
  private static let size = CGSize(width: 960, height: 720)
  private static let bitRate = 2_000_000

  private let url: URL
  private let queue = DispatchQueue(label: "flex.room_scan.scan_video")
  private let ciContext = CIContext(options: [.cacheIntermediates: false])

  private var writer: AVAssetWriter?
  private var input: AVAssetWriterInput?
  private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
  private var timer: Timer?

  /// Read on the main thread only.
  private var running = false
  private var stopped = false
  private var lastFrameTimestamp: TimeInterval = -1
  /// Set by a pause, so the next frame follows straight on from the last.
  private var needsRebase = true
  private var offset: TimeInterval = 0
  /// So the first frame lands at zero.
  private var lastPresentation: TimeInterval = -1 / ScanVideoRecorder.framesPerSecond

  /// A frame is on its way to the encoder. Guarded by `lock`: set on the
  /// main thread, cleared on `queue`.
  private let lock = NSLock()
  private var inFlight = false

  /// Touched on `queue` only.
  private var appended = 0
  private var sessionStarted = false

  init(folder: URL) {
    url = folder.appendingPathComponent("room-video.mp4")
  }

  /// Opens the file. A failure is kept quiet: the scan goes on without video.
  func start(frames: @escaping () -> ARFrame?) {
    guard writer == nil, !stopped else { return }
    try? FileManager.default.removeItem(at: url)
    do {
      let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
      let input = AVAssetWriterInput(
        mediaType: .video,
        outputSettings: [
          AVVideoCodecKey: AVVideoCodecType.h264,
          AVVideoWidthKey: Int(Self.size.width),
          AVVideoHeightKey: Int(Self.size.height),
          AVVideoCompressionPropertiesKey: [
            AVVideoAverageBitRateKey: Self.bitRate,
            AVVideoExpectedSourceFrameRateKey: Int(Self.framesPerSecond),
            AVVideoMaxKeyFrameIntervalKey: Int(Self.framesPerSecond * 2),
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
          ],
        ])
      input.expectsMediaDataInRealTime = true
      // The sensor is landscape and the app portrait (as in capturePhoto).
      input.transform = CGAffineTransform(rotationAngle: .pi / 2)
      let adaptor = AVAssetWriterInputPixelBufferAdaptor(
        assetWriterInput: input,
        sourcePixelBufferAttributes: [
          kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
          kCVPixelBufferWidthKey as String: Int(Self.size.width),
          kCVPixelBufferHeightKey as String: Int(Self.size.height),
          kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
        ])
      guard writer.canAdd(input) else { return }
      writer.add(input)
      guard writer.startWriting() else { return }
      self.writer = writer
      self.input = input
      self.adaptor = adaptor
    } catch {
      return
    }
    running = true
    let timer = Timer(timeInterval: 1 / Self.framesPerSecond, repeats: true) { [weak self] _ in
      guard let self = self, self.running, let frame = frames() else { return }
      self.take(frame)
    }
    // Common modes, so frames keep coming while a sheet or list is dragged.
    RunLoop.main.add(timer, forMode: .common)
    self.timer = timer
  }

  /// The scan's clock stopped: frames are left out until it resumes.
  func pause() {
    running = false
    needsRebase = true
  }

  func resume() {
    guard writer != nil, !stopped else { return }
    running = true
  }

  private func take(_ frame: ARFrame) {
    let timestamp = frame.timestamp
    guard timestamp != lastFrameTimestamp else { return }
    lastFrameTimestamp = timestamp
    if needsRebase {
      // First frame, or the first after a pause: carry on one frame after the last.
      offset = timestamp - (lastPresentation + 1 / Self.framesPerSecond)
      needsRebase = false
    }
    let presentation = timestamp - offset
    guard presentation > lastPresentation else { return }

    // Skip this frame rather than hold a second camera buffer.
    lock.lock()
    if inFlight {
      lock.unlock()
      return
    }
    inFlight = true
    lock.unlock()

    lastPresentation = presentation
    let pixels = frame.capturedImage
    queue.async { [weak self] in
      guard let self = self else { return }
      self.append(pixels, at: presentation)
      self.lock.lock()
      self.inFlight = false
      self.lock.unlock()
    }
  }

  /// On `queue`.
  private func append(_ pixels: CVPixelBuffer, at seconds: TimeInterval) {
    guard
      let writer = writer, writer.status == .writing,
      let input = input, input.isReadyForMoreMediaData,
      let adaptor = adaptor, let pool = adaptor.pixelBufferPool
    else { return }
    var out: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &out) == kCVReturnSuccess, let target = out
    else { return }

    let source = CIImage(cvPixelBuffer: pixels)
    let scale = CGAffineTransform(
      scaleX: Self.size.width / source.extent.width,
      y: Self.size.height / source.extent.height)
    ciContext.render(source.transformed(by: scale), to: target)

    let time = CMTime(seconds: seconds, preferredTimescale: 600)
    if !sessionStarted {
      writer.startSession(atSourceTime: time)
      sessionStarted = true
    }
    if adaptor.append(target, withPresentationTime: time) { appended += 1 }
  }

  /// Ends the video. Nil when there is nothing usable: no frames, or the
  /// writer failed, in which case the file is removed.
  func finish() async -> Recording? {
    guard !stopped else { return nil }
    stopped = true
    running = false
    timer?.invalidate()
    timer = nil
    guard let writer = writer, let input = input else { return nil }
    let url = self.url
    let durationMs = Int(max(lastPresentation, 0) * 1000)

    return await withCheckedContinuation { continuation in
      // Behind any frame still being encoded.
      queue.async { [weak self] in
        guard let self = self, self.appended > 0, writer.status == .writing else {
          writer.cancelWriting()
          try? FileManager.default.removeItem(at: url)
          continuation.resume(returning: nil)
          return
        }
        input.markAsFinished()
        writer.finishWriting {
          guard writer.status == .completed else {
            try? FileManager.default.removeItem(at: url)
            continuation.resume(returning: nil)
            return
          }
          let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
          let bytes = (attributes?[.size] as? NSNumber)?.intValue ?? 0
          continuation.resume(
            returning: bytes > 0 ? Recording(url: url, bytes: bytes, durationMs: durationMs) : nil)
        }
      }
    }
  }

  /// The scan was discarded: stop and delete the file.
  func cancel() {
    guard !stopped else { return }
    stopped = true
    running = false
    timer?.invalidate()
    timer = nil
    let writer = self.writer
    let url = self.url
    queue.async {
      if writer?.status == .writing { writer?.cancelWriting() }
      try? FileManager.default.removeItem(at: url)
    }
  }
}
#endif
