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
      do {
        let next = try RoomScanner(emit: { [weak self] event in self?.eventSink?(event) })
        scanner = next
        next.start()
        result(nil)
      } catch {
        result(FlutterError(code: "start_failed", message: error.localizedDescription, details: nil))
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
      result(nil)

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
