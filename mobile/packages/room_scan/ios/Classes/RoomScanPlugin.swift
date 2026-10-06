import Flutter
import UIKit

#if canImport(RoomPlan)
import RoomPlan
#endif

/// Flutter entry point. Methods arrive on `flex/room_scan`; live updates go
/// out on `flex/room_scan/events`.
public class RoomScanPlugin: NSObject, FlutterPlugin, FlutterStreamHandler {
  private var eventSink: FlutterEventSink?

  /// A `RoomScanner` while a scan exists. Typed loosely because the class
  /// only exists on iOS 16+.
  private var scanner: AnyObject?

  /// The 360 degree equipment recorder, made on first use (iOS 13+).
  private var recorderStorage: AnyObject?

  public static func register(with registrar: FlutterPluginRegistrar) {
    let instance = RoomScanPlugin()
    let methods = FlutterMethodChannel(
      name: "flex/room_scan", binaryMessenger: registrar.messenger())
    registrar.addMethodCallDelegate(instance, channel: methods)
    let events = FlutterEventChannel(
      name: "flex/room_scan/events", binaryMessenger: registrar.messenger())
    events.setStreamHandler(instance)

    if #available(iOS 13.0, *) {
      registrar.register(
        EquipmentVideoPreviewFactory(recorder: { instance.recorder() }),
        withId: "flex/equipment_video_preview")
    }
  }

  @available(iOS 13.0, *)
  private func recorder() -> EquipmentVideoRecorder {
    if let existing = recorderStorage as? EquipmentVideoRecorder { return existing }
    let made = EquipmentVideoRecorder()
    recorderStorage = made
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
      if #available(iOS 13.0, *) {
        handleVideo(call, result: result)
      } else {
        result(
          FlutterError(
            code: "unsupported",
            message: "Recording equipment video needs iOS 13 or later.", details: nil))
      }
      return
    }

    #if canImport(RoomPlan)
    guard #available(iOS 16.0, *) else {
      result(unsupported())
      return
    }
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
    if #available(iOS 16.0, *) {
      if RoomCaptureSession.isSupported {
        info["supported"] = true
      } else {
        info["reason"] = "This device has no LiDAR sensor."
      }
    } else {
      info["reason"] = "Scanning needs iOS 16 or later."
    }
    #else
    info["reason"] = "RoomPlan is not available in this build."
    #endif
    return info
  }

  private func unsupported() -> FlutterError {
    FlutterError(
      code: "unsupported",
      message: "LiDAR scanning needs a LiDAR iPhone or iPad on iOS 16 or later.",
      details: nil)
  }

  #if canImport(RoomPlan)
  @available(iOS 16.0, *)
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
  @available(iOS 13.0, *)
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
