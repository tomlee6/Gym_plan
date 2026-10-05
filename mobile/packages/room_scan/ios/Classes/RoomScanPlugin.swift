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

  public static func register(with registrar: FlutterPluginRegistrar) {
    let instance = RoomScanPlugin()
    let methods = FlutterMethodChannel(
      name: "flex/room_scan", binaryMessenger: registrar.messenger())
    registrar.addMethodCallDelegate(instance, channel: methods)
    let events = FlutterEventChannel(
      name: "flex/room_scan/events", binaryMessenger: registrar.messenger())
    events.setStreamHandler(instance)
  }

  // MARK: - Methods

  public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    if call.method == "deviceInfo" {
      result(deviceInfo())
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
