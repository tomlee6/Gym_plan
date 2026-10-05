import 'dart:async';

import 'package:flutter/foundation.dart';

import 'api_client.dart';
import 'scan_backend.dart';

/// A gym the user can capture.
@immutable
class Facility {
  const Facility({required this.id, required this.name});

  factory Facility.fromJson(Map<String, Object?> json) =>
      Facility(id: json['id']! as String, name: json['name']! as String);

  final String id;
  final String name;

  @override
  bool operator ==(Object other) => other is Facility && other.id == id;

  @override
  int get hashCode => id.hashCode;
}

/// The facilities to choose from, and which to preselect.
@immutable
class FacilityList {
  const FacilityList({required this.facilities, this.defaultId});

  final List<Facility> facilities;
  final String? defaultId;
}

/// Whether this handset can run a LiDAR scan, and what to tell the user.
@immutable
class DeviceCapability {
  const DeviceCapability({
    required this.supported,
    required this.headline,
    required this.detail,
  });

  final bool supported;
  final String headline;
  final String detail;
}

/// What the capture setup screen needs: the user's facilities from the
/// backend (`backend/src/modules/facilities.js`) and whether this device can
/// scan (asked of RoomPlan, see [ScanBackend.detect]).
class CaptureService {
  CaptureService({this.deviceOverride, ApiClient? client}) : _client = client;

  /// Forces a capability result, so the unsupported-device path can be
  /// exercised on hardware that does have LiDAR.
  final DeviceCapability? deviceOverride;
  final ApiClient? _client;

  ApiClient get _api => _client ?? ApiClient.instance;

  Future<FacilityList> facilities() async {
    final Map<String, Object?> body = await _api.get('/v1/facilities');
    return FacilityList(
      facilities: <Facility>[
        for (final Object? f in body['facilities']! as List<Object?>)
          Facility.fromJson(f! as Map<String, Object?>),
      ],
      defaultId: body['defaultFacilityId'] as String?,
    );
  }

  Future<DeviceCapability> checkDevice() async =>
      deviceOverride ?? ScanBackend.detect();
}
