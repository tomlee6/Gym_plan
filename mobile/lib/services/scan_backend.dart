import 'package:flutter/foundation.dart';
import 'package:room_scan/room_scan.dart';

import '../models/scan.dart';
import 'capture_service.dart';
import 'lidar_scan_session.dart';
import 'scan_session.dart';

/// Whether this device can scan, and the scan it runs.
///
/// Only a LiDAR iPhone or iPad (the app needs iOS 17) can scan. Anywhere
/// else — a phone without LiDAR, a simulator, Android, a desktop — the
/// device is refused, in debug builds as in release: there is no demo walk
/// or made-up data, since a plan the reviewer cannot trust is worse than
/// none.
class ScanBackend {
  const ScanBackend._();

  /// Tests set this to stand in for the device check, so they choose the
  /// device rather than the app ever pretending to have one.
  @visibleForTesting
  static DeviceCapability? debugOverride;

  static Future<DeviceCapability> detect() async {
    final DeviceCapability? override = debugOverride;
    if (override != null) return override;

    String? reason;
    if (!kIsWeb && defaultTargetPlatform == TargetPlatform.iOS) {
      try {
        final RoomScanDeviceInfo info = await RoomScan.deviceInfo();
        if (info.supported) {
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

    return DeviceCapability(
      supported: false,
      headline: 'Cannot scan on this device',
      detail: reason ?? 'Needs a LiDAR iPhone or iPad Pro',
    );
  }

  /// The scan for [config]: always the LiDAR scanner.
  static ScanSession createSession(ScanConfig config) =>
      LidarScanSession(config: config);
}
