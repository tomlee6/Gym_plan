import 'package:flutter/foundation.dart';
import 'package:room_scan/room_scan.dart';

import '../models/scan.dart';
import 'lidar_scan_session.dart';
import 'capture_service.dart';
import 'simulated_scan_session.dart';
import 'scan_session.dart';

/// Decides whether scans use the LiDAR sensor or the simulated walk.
///
/// - A LiDAR iPhone or iPad (the app needs iOS 17) always scans for real.
/// - Anywhere else, debug builds fall back to the simulated walk so the
///   flow can be developed on a simulator, emulator or desktop.
/// - Release builds on other devices refuse to scan: a simulated plan would
///   be worthless to the reviewer.
class ScanBackend {
  const ScanBackend._();

  static bool _useLidar = false;

  /// Whether [createSession] will return a real scan. Settled by [detect].
  static bool get usesLidar => _useLidar;

  static const DeviceCapability simulated = DeviceCapability(
    supported: true,
    headline: 'Simulated scan',
    detail: 'No LiDAR here · runs a demo walk',
  );

  static Future<DeviceCapability> detect() async {
    _useLidar = false;
    String? reason;

    if (!kIsWeb && defaultTargetPlatform == TargetPlatform.iOS) {
      try {
        final RoomScanDeviceInfo info = await RoomScan.deviceInfo();
        if (info.supported) {
          _useLidar = true;
          return DeviceCapability(
            supported: true,
            headline: 'LiDAR ready',
            detail: '${info.model} · iOS ${info.systemVersion}',
          );
        }
        reason = '${info.model} · ${info.reason ?? 'No LiDAR sensor'}';
      } on RoomScanException catch (e) {
        reason = e.message;
      }
    }

    if (kDebugMode) return simulated;
    return DeviceCapability(
      supported: false,
      headline: 'Cannot scan on this device',
      detail: reason ?? 'Needs a LiDAR iPhone or iPad Pro',
    );
  }

  static ScanSession createSession(ScanConfig config) => _useLidar
      ? LidarScanSession(config: config)
      : SimulatedScanSession(config: config);
}
