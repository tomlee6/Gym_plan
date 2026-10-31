import AVFoundation
import Flutter
import UIKit

#if canImport(RoomPlan)
import RoomPlan
#endif

/// Flutter entry point. Methods arrive on `flex/room_scan`; live scan
/// updates go out on `flex/room_scan/events`, and the walkaround recorder's
/// motion samples on `flex/room_scan/video_events`.
///
/// The app's minimum is iOS 17, so RoomPlan (iOS 16+) and every API used
/// here is always there; the only remaining check is whether the device has
/// a LiDAR sensor (`RoomCaptureSession.isSupported`).
public class RoomScanPlugin: NSObject, FlutterPlugin, FlutterStreamHandler {
  private var eventSink: FlutterEventSink?

  /// A `RoomScanner` while a scan exists. Typed loosely because the class
  /// is only compiled where RoomPlan can be imported.
  private var scanner: AnyObject?

  /// The active container showing the live camera preview.
  private weak var captureContainer: RoomCaptureContainerView?
  private var fallbackCamera: FallbackCameraView?

  /// The 360 degree equipment recorder, made on first use.
  private lazy var videoRecorder = EquipmentVideoRecorder()

  /// Forwards the recorder's motion samples to Flutter (I-06).
  private let videoEvents = VideoEventStream()

  public static func register(with registrar: FlutterPluginRegistrar) {
    let instance = RoomScanPlugin()
    let methods = FlutterMethodChannel(
      name: "flex/room_scan", binaryMessenger: registrar.messenger())
    registrar.addMethodCallDelegate(instance, channel: methods)
    let events = FlutterEventChannel(
      name: "flex/room_scan/events", binaryMessenger: registrar.messenger())
    events.setStreamHandler(instance)
    let videoEvents = FlutterEventChannel(
      name: "flex/room_scan/video_events", binaryMessenger: registrar.messenger())
    videoEvents.setStreamHandler(instance.videoEvents)

    registrar.register(
      EquipmentVideoPreviewFactory(recorder: { instance.recorder() }),
      withId: "flex/equipment_video_preview")

    registrar.register(
      RoomCaptureViewFactory(plugin: instance),
      withId: "flex/room_capture_view")

    // The finished room in 3D, shown before it is submitted.
    registrar.register(
      ScanModelViewFactory(messenger: registrar.messenger()), withId: "flex/scan_model_view")
  }

  func attachCaptureContainer(_ container: RoomCaptureContainerView) {
    self.captureContainer = container
    updateCaptureView()
  }

  /// The scan has ended (finished or discarded) and its screen is closing.
  /// The camera is left free rather than going back to the preview, so
  /// the 360 equipment recorder can take it next.
  private func releaseCamera() {
    fallbackCamera?.stop()
    fallbackCamera = nil
    captureContainer?.activeView = nil
  }

  /// The viewfinder is gone. Stops the preview camera unless a newer
  /// viewfinder has taken over.
  func detachCaptureContainer(_ container: RoomCaptureContainerView) {
    guard captureContainer == nil || captureContainer === container else { return }
    captureContainer = nil
    fallbackCamera?.stop()
    fallbackCamera = nil
  }

  func updateCaptureView() {
    guard let container = captureContainer else { return }

    #if canImport(RoomPlan)
    if RoomCaptureSession.isSupported, let scanner = scanner as? RoomScanner, let rcv = scanner.roomCaptureView {
      fallbackCamera?.stop()
      fallbackCamera = nil
      container.activeView = rcv
      return
    }
    #endif

    if fallbackCamera == nil {
      fallbackCamera = FallbackCameraView(frame: container.bounds)
    }
    container.activeView = fallbackCamera
  }

  private func recorder() -> EquipmentVideoRecorder {
    let made = videoRecorder
    if made.onMotion == nil {
      made.onMotion = { [weak self] sample in self?.videoEvents.send(sample) }
    }
    return made
  }

  // MARK: - Methods

  public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    if call.method == "deviceInfo" {
      result(deviceInfo())
      return
    }

    // The 360 equipment recorder (CHANGE 3). It needs no LiDAR, so it is
    // handled before the RoomPlan availability check below.
    if call.method.hasPrefix("video.") {
      handleVideo(call, result: result)
      return
    }

    // A still of a finished scan's 3D model, for the dashboard's thumbnails.
    // Rendered off screen, off the main thread; null if it cannot be.
    if call.method == "modelThumbnail" {
      let args = call.arguments as? [String: Any] ?? [:]
      guard let path = args["path"] as? String, let out = args["out"] as? String else {
        result(nil)
        return
      }
      DispatchQueue.global(qos: .utility).async {
        let rendered = ModelThumbnail.render(modelPath: path, to: out)
        DispatchQueue.main.async { result(rendered ? out : nil) }
      }
      return
    }

    // Machine type suggestions (F-07), on the phone. They need no LiDAR,
    // and no model or a failure simply means no suggestions.
    if call.method == "suggestTypes" {
      guard let path = (call.arguments as? [String: Any])?["path"] as? String else {
        result([Any]())
        return
      }
      MachineClassifier.shared.suggest(imagePath: path) { suggestions in
        result(suggestions)
      }
      return
    }

    #if canImport(RoomPlan)
    handleScan(call, result: result)
    #else
    result(unsupported())
    #endif
  }

  private func deviceInfo() -> [String: Any] {
    var info: [String: Any] = [
      "model": UIDevice.current.model,
      "systemVersion": UIDevice.current.systemVersion,
      "supported": false,
    ]
    #if canImport(RoomPlan)
    if RoomCaptureSession.isSupported {
      info["supported"] = true
    } else {
      info["reason"] = "This device has no LiDAR sensor."
    }
    #else
    info["reason"] = "RoomPlan is not available in this build."
    #endif
    return info
  }

  private func unsupported() -> FlutterError {
    FlutterError(
      code: "unsupported",
      message: "LiDAR scanning needs an iPhone or iPad with a LiDAR sensor.",
      details: nil)
  }

  #if canImport(RoomPlan)
  private func handleScan(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    let active = scanner as? RoomScanner

    switch call.method {
    case "start":
      guard RoomCaptureSession.isSupported else {
        result(unsupported())
        return
      }
      active?.stop()
      // The preview camera shown before the scan must let go of the camera
      // before ARKit takes it: two capture sessions cannot share it.
      let launch = { [weak self] in
        guard let self = self else { return }
        do {
          let next = try RoomScanner(emit: { [weak self] event in self?.eventSink?(event) })
          self.scanner = next
          self.updateCaptureView()
          next.start()
          result(nil)
        } catch {
          result(FlutterError(code: "start_failed", message: error.localizedDescription, details: nil))
        }
      }
      if let camera = fallbackCamera {
        camera.stop(then: launch)
      } else {
        launch()
      }

    case "pause":
      active?.pause()
      result(nil)

    case "resume":
      active?.resume()
      result(nil)

    case "stop":
      active?.stop()
      scanner = nil
      releaseCamera()
      result(nil)

    case "nextSection":
      guard let active = active else {
        result(noScan())
        return
      }
      Task { @MainActor in
        do {
          try await active.nextSection()
          result(nil)
        } catch {
          result(FlutterError(code: "section_failed", message: error.localizedDescription, details: nil))
        }
      }

    case "capturePhoto":
      guard let active = active else {
        result(noScan())
        return
      }
      do {
        result(try active.capturePhoto())
      } catch {
        result(FlutterError(code: "photo_failed", message: error.localizedDescription, details: nil))
      }

    case "finish":
      guard let active = active else {
        result(noScan())
        return
      }
      Task { @MainActor in
        do {
          let export = try await active.finish()
          self.scanner = nil
          self.releaseCamera()
          result(export)
        } catch {
          result(FlutterError(code: "export_failed", message: error.localizedDescription, details: nil))
        }
      }

    default:
      result(FlutterMethodNotImplemented)
    }
  }
  #endif

  private func noScan() -> FlutterError {
    FlutterError(code: "no_scan", message: "No scan is running.", details: nil)
  }

  // MARK: - Equipment video

  /**
   The 360 degree walkaround (CHANGE 3).

   A recording is refused while a scan is running: ARKit holds the camera
   for the length of a `RoomCaptureSession`, and two capture sessions
   cannot share one. The workflow records equipment after the room scan,
   so this only ever fires if the two are asked for out of order.
   */
  private func handleVideo(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    let args = call.arguments as? [String: Any] ?? [:]
    let recorder = self.recorder()

    func fail(_ error: Error) {
      result(
        FlutterError(
          code: "video_failed", message: error.localizedDescription, details: nil))
    }

    switch call.method {
    case "video.prepare":
      if scanner != nil {
        result(
          FlutterError(
            code: "scan_running",
            message: "Finish the room scan before recording equipment.", details: nil))
        return
      }
      Task { @MainActor in
        do {
          try await recorder.prepare()
          result(nil)
        } catch { fail(error) }
      }

    case "video.start":
      guard let equipmentId = args["equipmentId"] as? String else {
        result(
          FlutterError(code: "bad_args", message: "An equipment id is required.", details: nil))
        return
      }
      do {
        try recorder.start(equipmentId: equipmentId)
        result(nil)
      } catch { fail(error) }

    case "video.stop":
      Task { @MainActor in
        do {
          result(try await recorder.stop())
        } catch { fail(error) }
      }

    case "video.discard":
      if let path = args["path"] as? String { recorder.discard(path: path) }
      result(nil)

    case "video.dispose":
      recorder.dispose()
      result(nil)

    default:
      result(FlutterMethodNotImplemented)
    }
  }

  // MARK: - Events

  public func onListen(withArguments arguments: Any?, eventSink events: @escaping FlutterEventSink)
    -> FlutterError?
  {
    eventSink = events
    return nil
  }

  public func onCancel(withArguments arguments: Any?) -> FlutterError? {
    eventSink = nil
    return nil
  }
}

/// The stream handler for `flex/room_scan/video_events`. Samples sent while
/// nobody listens are dropped.
final class VideoEventStream: NSObject, FlutterStreamHandler {
  private var sink: FlutterEventSink?

  func send(_ event: [String: Any]) {
    sink?(event)
  }

  func onListen(withArguments arguments: Any?, eventSink events: @escaping FlutterEventSink)
    -> FlutterError?
  {
    sink = events
    return nil
  }

  func onCancel(withArguments arguments: Any?) -> FlutterError? {
    sink = nil
    return nil
  }
}

// MARK: - Platform View (Live Camera & RoomCaptureView)

final class RoomCapturePlatformView: NSObject, FlutterPlatformView {
  private let container = RoomCaptureContainerView()
  private weak var plugin: RoomScanPlugin?

  init(frame: CGRect, plugin: RoomScanPlugin) {
    container.frame = frame
    self.plugin = plugin
    super.init()
    plugin.attachCaptureContainer(container)
  }

  func view() -> UIView { container }

  /// The scan screen has closed: let go of the preview camera, so it does
  /// not keep running behind the rest of the app.
  deinit {
    let container = self.container
    DispatchQueue.main.async { [weak plugin] in
      plugin?.detachCaptureContainer(container)
    }
  }
}

final class RoomCaptureViewFactory: NSObject, FlutterPlatformViewFactory {
  private let plugin: RoomScanPlugin

  init(plugin: RoomScanPlugin) {
    self.plugin = plugin
    super.init()
  }

  func create(withFrame frame: CGRect, viewIdentifier viewId: Int64, arguments args: Any?)
    -> FlutterPlatformView
  {
    RoomCapturePlatformView(frame: frame, plugin: plugin)
  }
}

final class RoomCaptureContainerView: UIView {
  var activeView: UIView? {
    didSet {
      oldValue?.removeFromSuperview()
      if let active = activeView {
        active.frame = bounds
        active.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(active)
      }
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    activeView?.frame = bounds
  }
}

/// The live camera shown before the scan starts, Polycam style: the
/// surveyor sees the room at once and taps capture to start RoomPlan.
/// Released before ARKit takes the camera (see `stop(then:)`).
final class FallbackCameraView: UIView {
  private let session = AVCaptureSession()
  private var previewLayer: AVCaptureVideoPreviewLayer?
  private var isRunning = false

  /// Configuring, starting and stopping, one at a time, off the main thread.
  private let queue = DispatchQueue(label: "flex.room_scan.preview_camera")

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .black

    let layer = AVCaptureVideoPreviewLayer(session: session)
    layer.videoGravity = .resizeAspectFill
    layer.frame = bounds
    self.layer.addSublayer(layer)
    self.previewLayer = layer

    // Asks for camera access the first time; RoomPlan needs it anyway.
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      configureAndStart()
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
        guard granted else { return }
        DispatchQueue.main.async { self?.configureAndStart() }
      }
    default:
      break  // Refused: the scan says so when it cannot start.
    }
  }

  required init?(coder: NSCoder) { nil }

  private func configureAndStart() {
    guard !isRunning else { return }
    isRunning = true
    queue.async { [session] in
      if session.inputs.isEmpty {
        session.beginConfiguration()
        session.sessionPreset = .high
        if let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
          let input = try? AVCaptureDeviceInput(device: device),
          session.canAddInput(input)
        {
          session.addInput(input)
        }
        session.commitConfiguration()
      }
      session.startRunning()
    }
  }

  func start() {
    configureAndStart()
  }

  /// Stops the preview, then calls `then` on the main thread once the
  /// camera is free for ARKit.
  func stop(then: (() -> Void)? = nil) {
    isRunning = false
    queue.async { [session] in
      if session.isRunning { session.stopRunning() }
      if let then = then { DispatchQueue.main.async(execute: then) }
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    previewLayer?.frame = bounds
  }

  deinit {
    stop()
  }
}
