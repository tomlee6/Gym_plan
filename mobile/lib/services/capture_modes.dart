import 'package:room_scan/room_scan.dart';

/// Drives a 3D Space (LiDAR mesh) scan. The app uses [NativeMeshScanning];
/// tests stand in for it.
abstract class MeshScanning {
  /// The live camera, nothing meshed yet.
  Future<void> prepare();

  /// Starts meshing.
  Future<void> start();
  Future<MeshScanStatus> status();

  /// Stops, colours and writes the mesh.
  Future<MeshScanExport> finish();
  Future<void> cancel();
}

class NativeMeshScanning implements MeshScanning {
  const NativeMeshScanning();

  @override
  Future<void> prepare() => MeshScan.prepare();

  @override
  Future<void> start() => MeshScan.start();

  @override
  Future<MeshScanStatus> status() => MeshScan.status();

  @override
  Future<MeshScanExport> finish() => MeshScan.finish();

  @override
  Future<void> cancel() => MeshScan.cancel();
}

/// The capture modes beyond the floor-plan scan: 3D Space and 3D Object.
/// Replaced in tests, which have no camera.
class CaptureModes {
  const CaptureModes._();

  static MeshScanning Function() meshScanning = NativeMeshScanning.new;

  static Future<bool> Function() objectCaptureSupported =
      ObjectCapture.isSupported;

  /// Apple's guided capture and the model build; null if cancelled.
  static Future<ObjectCaptureResult?> Function() captureObject =
      ObjectCapture.capture;

  /// Back to the real thing, after a test.
  static void reset() {
    meshScanning = NativeMeshScanning.new;
    objectCaptureSupported = ObjectCapture.isSupported;
    captureObject = ObjectCapture.capture;
  }
}
