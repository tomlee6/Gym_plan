import 'package:flutter/foundation.dart';

import 'api_client.dart';

/// The signed-in user's account, as `GET /v1/me` describes it.
@immutable
class ProfileData {
  const ProfileData({
    required this.name,
    required this.initials,
    required this.role,
    required this.email,
    required this.organisation,
    required this.facilities,
    required this.plansUsed,
    required this.planQuota,
  });

  factory ProfileData.fromJson(Map<String, Object?> json) => ProfileData(
    name: json['name']! as String,
    initials: json['initials']! as String,
    role: json['roleLabel']! as String,
    email: json['email']! as String,
    organisation: json['organisation']! as String,
    facilities: (json['facilityCount']! as num).toInt(),
    plansUsed: (json['plansUsed']! as num).toInt(),
    planQuota: (json['planQuota']! as num).toInt(),
  );

  final String name;
  final String initials;

  /// e.g. "Owner & Surveyor".
  final String role;
  final String email;
  final String organisation;
  final int facilities;
  final int plansUsed;
  final int planQuota;
}

/// Capture settings, kept on the server so they follow the user. A local
/// copy is read during a scan, which may be offline.
class CaptureSettings {
  CaptureSettings._();

  static final CaptureSettings instance = CaptureSettings._();

  bool uploadOnMobileData = true;

  /// Ask before the first reference photo in a scan, because photos can
  /// catch members in the frame.
  bool warnBeforePhotos = true;

  void apply(Map<String, Object?> json) {
    uploadOnMobileData = json['uploadOnMobileData'] != false;
    warnBeforePhotos = json['warnBeforePhotos'] != false;
  }

  void reset() {
    uploadOnMobileData = true;
    warnBeforePhotos = true;
  }
}

/// The account and settings endpoints (`backend/src/modules/profile.js`).
class ProfileService {
  ProfileService({ApiClient? client}) : _client = client;

  final ApiClient? _client;
  ApiClient get _api => _client ?? ApiClient.instance;

  /// Loads the profile and refreshes the local copy of the settings.
  Future<ProfileData> load() async {
    final Map<String, Object?> me = await _api.get('/v1/me');
    final Object? settings = me['settings'];
    if (settings is Map<String, Object?>) {
      CaptureSettings.instance.apply(settings);
    }
    return ProfileData.fromJson(me);
  }

  /// Saves one or both settings and returns what the server stored.
  Future<void> updateSettings({
    bool? uploadOnMobileData,
    bool? warnBeforePhotos,
  }) async {
    final Map<String, Object?> saved = await _api
        .patch('/v1/me/settings', <String, Object?>{
          'uploadOnMobileData': ?uploadOnMobileData,
          'warnBeforePhotos': ?warnBeforePhotos,
        });
    CaptureSettings.instance.apply(saved);
  }
}
