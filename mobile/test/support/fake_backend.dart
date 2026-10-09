import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:mobile/models/scan.dart';
import 'package:mobile/services/api_client.dart';
import 'package:mobile/services/auth_session.dart';
import 'package:mobile/services/hub_auth.dart';
import 'package:mobile/services/offline_cache.dart';
import 'package:mobile/services/profile_service.dart';
import 'package:mobile/services/upload_queue.dart';
import 'package:room_scan/room_scan.dart';
import 'package:mobile/models/equipment.dart';

/// An in-memory stand-in for the Gym Plan backend, for widget tests. It
/// answers the routes of `backend/docs/api-contract-v2.md` with the same
/// shapes: Hub sign-in with PKCE, rotating refresh tokens, and
/// `X-Account-Id` on every customer route. It holds the backend seed's demo
/// data for the Northgate account.
class FakeBackend {
  FakeBackend() {
    final DateTime now = DateTime.now().toUtc();
    DateTime ago({int days = 0, int hours = 0, int minutes = 0}) =>
        now.subtract(Duration(days: days, hours: hours, minutes: minutes));

    reviewStartedNg2 = ago(hours: 1);
    rejectedSubmitted = ago(days: 10);
    rejectedReviewed = ago(days: 9);
    readyReviewed = ago(days: 2);

    plans = <Map<String, Object?>>[
      _plan(
        'plan_rv1',
        'fac_riverside',
        'Riverside Gym',
        1,
        'processing',
        submittedAt: ago(minutes: 6),
      ),
      _plan('plan_ng3', 'fac_northgate', 'Northgate Fitness', 3, 'uploading'),
      _plan(
        'plan_ng2',
        'fac_northgate',
        'Northgate Fitness',
        2,
        'in_review',
        submittedAt: ago(hours: 3),
        reviewStartedAt: reviewStartedNg2,
      ),
      _plan(
        'plan_ng1',
        'fac_northgate',
        'Northgate Fitness',
        1,
        'ready',
        version: 2,
        submittedAt: ago(days: 3),
        reviewedAt: readyReviewed,
      ),
      _plan(
        'plan_rv0',
        'fac_riverside',
        'Riverside Gym',
        0,
        'recapture',
        submittedAt: rejectedSubmitted,
        reviewedAt: rejectedReviewed,
        rejectionReason: 'Incomplete coverage',
      ),
      _plan(
        'plan_eb0',
        'fac_eastbrook',
        'Eastbrook Athletic Club',
        0,
        'ready',
        submittedAt: ago(days: 13),
        reviewedAt: ago(days: 12),
      ),
    ];
  }

  static const String email = 'sam.okafor@northgatefitness.com';

  /// What the fake Hub hands back on the callback.
  static const String hubCode = 'hub-code';
  static const String redirectUri = 'flexgymscan://auth/callback';

  static const Map<String, Object?> northgate = <String, Object?>{
    'id': 'acc_northgate',
    'name': 'Northgate Group',
    'role': 'owner',
  };
  static const Map<String, Object?> riverside = <String, Object?>{
    'id': 'acc_riverside',
    'name': 'Riverside Leisure',
    'role': 'surveyor',
  };

  /// The accounts the user belongs to. Tests add [riverside] for the
  /// picker, or clear the list for "no access".
  final List<Map<String, Object?>> accounts = <Map<String, Object?>>[northgate];

  /// Signed in at the Hub, but no membership or invite: 403 no_access.
  bool noAccess = false;

  /// The Hub answers with an error instead of a code (access_denied).
  bool hubRejects = false;

  /// Every session was revoked (the Hub disabled or deleted the user).
  bool refreshRevoked = false;

  /// What the phone sent to `POST /v1/auth/hub`, and the PKCE challenge
  /// the fake Hub saw on the authorise URL.
  Map<String, Object?>? hubRequest;
  String? codeChallenge;

  /// The fake Hub sheet. [useFakeBackend] installs it.
  late final FakeWebAuthenticator webAuth = FakeWebAuthenticator(this);

  /// The access token the backend accepts. Tests change it to make the
  /// phone's token "expire".
  String accessToken = 'access-token';

  /// Each refresh rotates the refresh token; only the newest is accepted.
  int _refreshGeneration = 0;
  String get currentRefreshToken => _refreshGeneration == 0
      ? 'refresh-token'
      : 'refresh-token-$_refreshGeneration';

  /// A new account whose admin has not added a gym yet.
  bool noFacilities = false;

  late final DateTime reviewStartedNg2;
  late final DateTime rejectedSubmitted;
  late final DateTime rejectedReviewed;
  late final DateTime readyReviewed;
  late final List<Map<String, Object?>> plans;

  final List<http.Request> requests = <http.Request>[];
  final Map<String, Object?> settings = <String, Object?>{
    'uploadOnMobileData': true,
    'warnBeforePhotos': true,
  };
  String? shareUrl;

  /// Knobs for failure cases.
  bool offline = false;
  bool failSettings = false;

  /// Routes that should answer 500 once, then work.
  final Set<String> failOnce = <String>{};

  static Map<String, Object?> _plan(
    String id,
    String facilityId,
    String site,
    int level,
    String status, {
    int version = 1,
    DateTime? submittedAt,
    DateTime? reviewStartedAt,
    DateTime? reviewedAt,
    String? rejectionReason,
  }) => <String, Object?>{
    'id': id,
    'facilityId': facilityId,
    'site': site,
    'level': level,
    'status': status,
    'version': version,
    'submittedAt': submittedAt?.toIso8601String(),
    'reviewStartedAt': reviewStartedAt?.toIso8601String(),
    'reviewedAt': reviewedAt?.toIso8601String(),
    'rejectionReason': rejectionReason,
  };

  late final MockClient client = MockClient(_handle);

  Future<http.Response> _handle(http.Request req) async {
    requests.add(req);
    if (offline) throw http.ClientException('Network is unreachable');

    final String path = req.url.path;
    if (failOnce.remove(path)) {
      return _json(<String, Object?>{
        'message': 'Something went wrong on our side.',
      }, 500);
    }
    final Map<String, Object?> body = req.body.isEmpty
        ? const <String, Object?>{}
        : jsonDecode(req.body) as Map<String, Object?>;

    // Public routes.
    switch ((req.method, path)) {
      case ('GET', '/v1/auth/hub/config'):
        return _json(<String, Object?>{
          'authorizeUrl': 'https://hub.test/oauth/authorize',
          'clientId': 'flex-gym-web',
          'scope': 'openid profile email',
          'redirectUris': <String, Object?>{
            'web': 'https://gym.test/auth/callback',
            'ios': redirectUri,
          },
        });
      case ('POST', '/v1/auth/hub'):
        hubRequest = body;
        final String? verifier = body['codeVerifier'] as String?;
        final bool pkceOk =
            verifier != null &&
            PkceAttempt.challengeFor(verifier) == codeChallenge;
        if (body['code'] != hubCode ||
            !pkceOk ||
            body['redirectUri'] != redirectUri ||
            body['client'] != 'ios' ||
            (body['nonce'] as String? ?? '').isEmpty) {
          return _json(<String, Object?>{
            'code': 'hub_rejected',
            'message': 'The Hub did not accept the sign-in.',
          }, 401);
        }
        if (noAccess) {
          return _json(<String, Object?>{
            'code': 'no_access',
            'message': 'No access.',
          }, 403);
        }
        return _json(_tokens());
      case ('POST', '/v1/auth/refresh'):
        if (refreshRevoked || body['refreshToken'] != currentRefreshToken) {
          return _json(<String, Object?>{'message': 'Sign in again.'}, 401);
        }
        _refreshGeneration++;
        return _json(_tokens());
      case ('POST', '/v1/auth/logout'):
        return http.Response('', 204);
    }

    if (req.headers['Authorization'] != 'Bearer $accessToken') {
      return _json(<String, Object?>{'message': 'Sign in again.'}, 401);
    }

    // Every customer route names its account (contract v2 §2).
    final String? accountId = req.headers['X-Account-Id'];
    final Map<String, Object?>? account = accounts
        .where((Map<String, Object?> a) => a['id'] == accountId)
        .firstOrNull;
    final bool needsAccount =
        path.startsWith('/v1/facilities') ||
        path.startsWith('/v1/plans') ||
        path.startsWith('/v1/captures');
    if (needsAccount && account == null) {
      return _json(<String, Object?>{
        'code': 'no_account',
        'message': 'Choose an account first.',
      }, 403);
    }
    final bool inRiverside = account?['id'] == riverside['id'];

    if (req.method == 'GET' && path == '/v1/me') {
      return _json(<String, Object?>{
        'id': 'usr_sam',
        'name': 'Sam Okafor',
        'initials': 'SO',
        'email': email,
        'staffRole': null,
        'accounts': accounts,
        // Present when X-Account-Id names one of the user's accounts.
        'account': account == null
            ? null
            : <String, Object?>{
                ...account,
                'roleLabel': account['role'] == 'owner'
                    ? 'Owner & Surveyor'
                    : 'Surveyor',
                'facilityCount': inRiverside ? 1 : 3,
                'defaultFacility': inRiverside
                    ? <String, Object?>{
                        'id': 'fac_riverside',
                        'name': 'Riverside Gym',
                      }
                    : <String, Object?>{
                        'id': 'fac_northgate',
                        'name': 'Northgate Fitness',
                      },
                'plansUsed': 6,
                'planQuota': 10,
              },
        'settings': settings,
      });
    }
    if (req.method == 'PATCH' && path == '/v1/me/settings') {
      if (failSettings) {
        return _json(<String, Object?>{'message': 'Could not save.'}, 500);
      }
      settings.addAll(body);
      return _json(settings);
    }
    if (req.method == 'GET' && path == '/v1/facilities') {
      if (inRiverside) {
        return _json(<String, Object?>{
          'facilities': <Object?>[
            <String, Object?>{'id': 'fac_riverside', 'name': 'Riverside Gym'},
          ],
          'defaultFacilityId': 'fac_riverside',
        });
      }
      if (noFacilities) {
        return _json(<String, Object?>{
          'facilities': <Object?>[],
          'defaultFacilityId': null,
        });
      }
      return _json(<String, Object?>{
        'facilities': <Object?>[
          <String, Object?>{
            'id': 'fac_eastbrook',
            'name': 'Eastbrook Athletic Club',
          },
          <String, Object?>{'id': 'fac_northgate', 'name': 'Northgate Fitness'},
          <String, Object?>{'id': 'fac_riverside', 'name': 'Riverside Gym'},
        ],
        'defaultFacilityId': 'fac_northgate',
      });
    }
    if (req.method == 'GET' && path == '/v1/plans') {
      final int limit =
          int.tryParse(req.url.queryParameters['limit'] ?? '') ?? 100;
      return _json(<String, Object?>{'plans': plans.take(limit).toList()});
    }

    final RegExpMatch? plan = RegExp(
      r'^/v1/plans/([\w-]+)(/share-links)?$',
    ).firstMatch(path);
    if (plan != null) {
      final Map<String, Object?>? p = plans
          .where((Map<String, Object?> p) => p['id'] == plan[1])
          .firstOrNull;
      if (p == null) {
        return _json(<String, Object?>{
          'message': 'This plan does not exist.',
        }, 404);
      }

      if (plan[2] != null && req.method == 'POST') {
        if (p['status'] != 'ready') {
          return _json(<String, Object?>{
            'message': 'Only an approved walkthrough can be shared.',
          }, 409);
        }
        final bool created = shareUrl == null;
        shareUrl ??= 'https://walkthrough.test/s/abc123';
        return _json(<String, Object?>{'url': shareUrl}, created ? 201 : 200);
      }
      return _json(_detail(p));
    }

    return _json(<String, Object?>{'message': 'Not found.'}, 404);
  }

  Map<String, Object?> _detail(Map<String, Object?> p) {
    final bool reviewed =
        p['reviewedAt'] != null || p['reviewStartedAt'] != null;
    return <String, Object?>{
      ...p,
      'areaM2': p['id'] == 'plan_ng1'
          ? 486
          : (p['id'] == 'plan_eb0' ? 358 : null),
      'coverage': p['id'] == 'plan_rv0' ? 0.71 : 0.95,
      'overrideRecorded': p['id'] == 'plan_rv0',
      'review': reviewed
          ? <String, Object?>{
              'reviewer': <String, Object?>{
                'name': 'Maya Restrepo',
                'initials': 'MR',
              },
              'seconds': p['id'] == 'plan_ng1' ? 680 : 540,
              'note': p['id'] == 'plan_rv0'
                  ? 'The north-east corner is missing about 6 m of wall and the '
                        'free-weight area reads as one block.'
                  : null,
            }
          : null,
      'walkthroughUrl': p['status'] == 'ready'
          ? 'https://walkthrough.test/w/${p['id']}'
          : null,
      'shareLink': shareUrl == null ? null : <String, Object?>{'url': shareUrl},
    };
  }

  /// The body of a successful sign-in or refresh (contract v2 §1).
  Map<String, Object?> tokens() => <String, Object?>{
    'accessToken': accessToken,
    'refreshToken': currentRefreshToken,
    'expiresIn': 1800,
    'user': <String, Object?>{
      'id': 'usr_sam',
      'name': 'Sam Okafor',
      'email': email,
      'initials': 'SO',
      'staffRole': null,
    },
    'accounts': accounts,
  };

  Map<String, Object?> _tokens() => tokens();

  http.Response _json(Object body, [int status = 200]) => http.Response(
    jsonEncode(body),
    status,
    headers: <String, String>{
      'content-type': 'application/json; charset=utf-8',
    },
  );
}

/// An upload queue the test drives by hand.
class FakeUploadQueue extends UploadQueue {
  UploadJob? job;
  final List<ScanResult> enqueued = <ScanResult>[];

  /// Machines and their 360 walkarounds sent with each capture.
  final List<List<Equipment>> enqueuedEquipment = <List<Equipment>>[];
  final List<Map<String, EquipmentVideo>> enqueuedVideos =
      <Map<String, EquipmentVideo>>[];
  final List<ScanExport?> exports = <ScanExport?>[];
  int retries = 0;
  bool? mobileData;

  @override
  UploadJob? get active => job;

  @override
  int get pendingCount => job != null && !job!.complete ? 1 : 0;

  @override
  Future<void> enqueue(
    ScanResult result, {
    ScanExport? export,
    List<Equipment> equipment = const <Equipment>[],
    Map<String, EquipmentVideo> videos = const <String, EquipmentVideo>{},
  }) async {
    enqueued.add(result);
    exports.add(export);
    enqueuedEquipment.add(equipment);
    enqueuedVideos.add(videos);
    job = UploadJob(
      id: 'job-${enqueued.length}',
      title: result.config.shortTitle,
      facility: result.config.facility,
      level: result.config.level,
      totalMb: 12,
    );
    notifyListeners();
  }

  @override
  Future<void> retry() async {
    retries++;
    job?.error = null;
    notifyListeners();
  }

  @override
  Future<void> setUploadOnMobileData(bool allowed) async =>
      mobileData = allowed;

  void update(void Function(UploadJob job) change) {
    change(job!);
    notifyListeners();
  }
}

/// The GoalCert Hub's sign-in sheet, played in-process: it notes the
/// authorise URL the app built and "redirects" back with a code and the
/// same state, unless told to cancel, reject or tamper.
class FakeWebAuthenticator implements WebAuthenticator {
  FakeWebAuthenticator(this.backend);

  final FakeBackend backend;
  final List<Uri> opened = <Uri>[];
  String? callbackScheme;

  /// The user closes the sheet.
  bool cancel = false;

  /// The callback comes back carrying someone else's state.
  bool tamperState = false;

  @override
  Future<Uri> authenticate({
    required Uri url,
    required String callbackScheme,
  }) async {
    opened.add(url);
    this.callbackScheme = callbackScheme;
    if (cancel) throw const WebAuthCancelled();
    final Map<String, String> q = url.queryParameters;
    backend.codeChallenge = q['code_challenge_method'] == 'S256'
        ? q['code_challenge']
        : null;
    final String state = tamperState ? 'forged' : q['state'] ?? '';
    final Uri back = Uri.parse(q['redirect_uri']!);
    return back.replace(
      queryParameters: backend.hubRejects
          ? <String, String>{'error': 'access_denied', 'state': state}
          : <String, String>{'code': FakeBackend.hubCode, 'state': state},
    );
  }
}

/// Points the app at a fresh [FakeBackend] and [FakeUploadQueue], with an
/// in-memory "Keychain", facility cache and Hub sheet.
///
/// Pass `signedIn: false` for tests that start at the sign-in screen,
/// [store] to start from a session "saved" by an earlier run, and
/// [configure] to set the backend up before anyone signs in.
({FakeBackend backend, FakeUploadQueue uploads}) useFakeBackend({
  bool signedIn = true,
  SecureStore? store,
  void Function(FakeBackend backend)? configure,
}) {
  final FakeBackend backend = FakeBackend();
  configure?.call(backend);
  final AuthSession session = AuthSession(store: store ?? MemorySecureStore());
  AuthSession.instance = session;
  if (signedIn) session.signedInWith(backend._tokens());
  WebAuthenticator.instance = backend.webAuth;
  FacilityCache.instance = MemoryFacilityCache();
  ApiClient.instance = ApiClient(
    baseUrl: 'https://api.test',
    session: session,
    client: backend.client,
  );
  final FakeUploadQueue uploads = FakeUploadQueue();
  UploadQueue.instance = uploads;
  CaptureSettings.instance.reset();
  return (backend: backend, uploads: uploads);
}
