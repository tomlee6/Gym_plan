import 'package:flutter/foundation.dart';

import 'api_client.dart';
import 'auth_session.dart';

/// The signed-in user and their current gym account, as `GET /v1/me`
/// describes them (contract v2 §2). The account block is the one named by
/// the `X-Account-Id` header the call was sent with.
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
    this.accounts = const <Account>[],
  });

  factory ProfileData.fromJson(Map<String, Object?> json) {
    final Map<String, Object?> account =
        json['account'] as Map<String, Object?>? ?? const <String, Object?>{};
    return ProfileData(
      name: json['name']! as String,
      initials: json['initials'] as String? ?? '',
      role: account['roleLabel'] as String? ?? 'No account selected',
      email: json['email'] as String? ?? '',
      organisation: account['name'] as String? ?? '—',
      facilities: (account['facilityCount'] as num? ?? 0).toInt(),
      plansUsed: (account['plansUsed'] as num? ?? 0).toInt(),
      planQuota: (account['planQuota'] as num? ?? 0).toInt(),
      accounts: <Account>[
        for (final Object? a in json['accounts'] as List<Object?>? ?? const [])
          if (a is Map<String, Object?>) Account.fromJson(a),
      ],
    );
  }

  final String name;
  final String initials;

  /// The user's role in the current account, e.g. "Owner & Surveyor".
  final String role;
  final String email;

  /// The current account's name, e.g. "Northgate Group".
  final String organisation;
  final int facilities;
  final int plansUsed;
  final int planQuota;

  /// Every account the user belongs to; more than one offers a switch.
  final List<Account> accounts;
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

/// The profile and settings endpoints (`/v1/me`).
class ProfileService {
  ProfileService({ApiClient? client}) : _client = client;

  final ApiClient? _client;
  ApiClient get _api => _client ?? ApiClient.instance;

  /// Loads the profile, refreshes the local copy of the settings, and
  /// brings the session's account list up to date (an invite accepted on
  /// the web, a membership removed).
  Future<ProfileData> load() async {
    final Map<String, Object?> me = await _api.get('/v1/me');
    final Object? settings = me['settings'];
    if (settings is Map<String, Object?>) {
      CaptureSettings.instance.apply(settings);
    }
    final ProfileData profile = ProfileData.fromJson(me);
    if (me['accounts'] is List<Object?>) {
      _api.session.updateAccounts(profile.accounts);
    }
    return profile;
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
