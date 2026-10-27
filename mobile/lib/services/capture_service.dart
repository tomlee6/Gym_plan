import 'dart:async';

import 'package:flutter/foundation.dart';

import 'api_client.dart';
import 'offline_cache.dart';
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
  const FacilityList({required this.facilities, this.defaultId, this.cachedAt});

  final List<Facility> facilities;
  final String? defaultId;

  /// Set when the list came from the phone's offline copy rather than the
  /// server: when that copy was saved.
  final DateTime? cachedAt;

  bool get offline => cachedAt != null;
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

/// What the capture setup screen needs: the account's facilities from the
/// backend (`GET /v1/facilities`, in the current account) and whether this
/// device can scan (asked of RoomPlan, see [ScanBackend.detect]).
class CaptureService {
  CaptureService({this.deviceOverride, ApiClient? client, FacilityCache? cache})
    : _client = client,
      _cache = cache;

  /// Forces a capability result, so the unsupported-device path can be
  /// exercised on hardware that does have LiDAR.
  final DeviceCapability? deviceOverride;
  final ApiClient? _client;
  final FacilityCache? _cache;

  ApiClient get _api => _client ?? ApiClient.instance;
  FacilityCache get _offline => _cache ?? FacilityCache.instance;

  /// The account's facilities. Each online answer is saved; with no signal
  /// the saved copy is returned instead (marked [FacilityList.offline]) so
  /// a capture can still be started (I-04). With neither, the offline
  /// error is passed on.
  Future<FacilityList> facilities() async {
    final String? accountId = _api.session.currentAccountId;
    try {
      final Map<String, Object?> body = await _api.get('/v1/facilities');
      final FacilityList list = FacilityList(
        facilities: <Facility>[
          for (final Object? f in body['facilities']! as List<Object?>)
            Facility.fromJson(f! as Map<String, Object?>),
        ],
        defaultId: body['defaultFacilityId'] as String?,
      );
      if (accountId != null) await _offline.save(accountId, list);
      return list;
    } on ApiException catch (e) {
      // Only a missing connection falls back: a refusal from the server
      // (e.g. the membership was removed) must not be papered over.
      if (!e.offline && !(e.retryable && (e.statusCode ?? 0) >= 500)) {
        rethrow;
      }
      final FacilityList? cached = accountId == null
          ? null
          : await _offline.load(accountId);
      if (cached == null) rethrow;
      return cached;
    }
  }

  Future<DeviceCapability> checkDevice() async =>
      deviceOverride ?? ScanBackend.detect();
}
