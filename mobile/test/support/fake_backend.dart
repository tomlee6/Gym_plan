import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:mobile/models/scan.dart';
import 'package:mobile/services/api_client.dart';
import 'package:mobile/services/auth_session.dart';
import 'package:mobile/services/profile_service.dart';
import 'package:mobile/services/upload_queue.dart';
import 'package:room_scan/room_scan.dart';
import 'package:mobile/models/equipment.dart';

/// An in-memory stand-in for the Gym Plan backend, for widget tests. It
/// answers the same routes with the same shapes as `backend/src/modules`, and
/// holds the same demo data as `backend/src/db/seed.js`.
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
  static const String password = 'flex1234';

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
      case ('POST', '/v1/auth/login'):
        final bool ok =
            (body['email'] as String?)?.toLowerCase() == email &&
            body['password'] == password;
        return ok
            ? _json(_tokens())
            : _json(<String, Object?>{
                'message': 'Incorrect email or password.',
              }, 401);
      case ('POST', '/v1/auth/refresh'):
        return _json(_tokens());
      case ('POST', '/v1/auth/logout'):
        return http.Response('', 204);
      case ('POST', '/v1/auth/password-reset'):
        return _json(<String, Object?>{'message': 'Sent.'}, 202);
    }

    if (req.headers['Authorization'] != 'Bearer access-token') {
      return _json(<String, Object?>{'message': 'Sign in again.'}, 401);
    }

    if (req.method == 'GET' && path == '/v1/me') {
      return _json(<String, Object?>{
        'id': 'usr_sam',
        'name': 'Sam Okafor',
        'initials': 'SO',
        'email': email,
        'role': 'owner',
        'roleLabel': 'Owner & Surveyor',
        'organisation': 'Northgate Group',
        'facilityCount': 3,
        'defaultFacility': <String, Object?>{
          'id': 'fac_northgate',
          'name': 'Northgate Fitness',
        },
        'plansUsed': 6,
        'planQuota': 10,
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

  Map<String, Object?> _tokens() => <String, Object?>{
    'accessToken': 'access-token',
    'refreshToken': 'refresh-token',
    'expiresIn': 1800,
    'user': <String, Object?>{
      'id': 'usr_sam',
      'name': 'Sam Okafor',
      'email': email,
      'initials': 'SO',
      'role': 'owner',
    },
  };

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

/// Points the app at a fresh [FakeBackend] and [FakeUploadQueue].
///
/// Pass `signedIn: false` for tests that start at the sign-in screen.
({FakeBackend backend, FakeUploadQueue uploads}) useFakeBackend({
  bool signedIn = true,
}) {
  final FakeBackend backend = FakeBackend();
  final AuthSession session = AuthSession();
  AuthSession.instance = session;
  if (signedIn) session.signedInWith(backend._tokens());
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
