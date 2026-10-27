import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/plan.dart';
import '../utils/formatting.dart';
import 'api_client.dart';
import 'upload_queue.dart';

/// Home screen data for the signed-in user.
@immutable
class HomeData {
  const HomeData({
    required this.gymName,
    required this.userInitials,
    required this.plans,
    required this.pendingUploads,
  });

  final String gymName;
  final String userInitials;
  final List<Plan> plans;

  /// Captures held on the device until there is signal.
  final int pendingUploads;
}

/// Who reviewed a plan, and when.
@immutable
class ReviewerStamp {
  const ReviewerStamp({
    required this.name,
    required this.initials,
    required this.at,
  });

  final String name;
  final String initials;

  /// Formatted for display, e.g. "15 Mar, 08:26".
  final String at;
}

/// Everything the "Walkthrough ready" screen shows.
@immutable
class PlanReadyDetail {
  const PlanReadyDetail({
    required this.plan,
    required this.areaM2,
    required this.version,
    required this.approvedBy,
    required this.reviewerTime,
    this.walkthroughUrl,
    this.shareLink,
  });

  final Plan plan;
  final int? areaM2;
  final int version;
  final ReviewerStamp? approvedBy;

  /// How long the reviewer spent, e.g. "11 min 20 s".
  final String? reviewerTime;
  final String? walkthroughUrl;

  /// Null until the owner creates one.
  final String? shareLink;

  String get versionLabel =>
      version > 1 ? '$version · supersedes v${version - 1}' : '$version';
}

/// Everything the "Needs recapture" screen shows.
@immutable
class PlanRejection {
  const PlanRejection({
    required this.plan,
    required this.submittedAt,
    required this.reason,
    required this.note,
    required this.reviewer,
    required this.coverageAtSubmit,
    required this.overrideRecorded,
  });

  final Plan plan;
  final String submittedAt;
  final String reason;
  final String note;
  final ReviewerStamp? reviewer;
  final int? coverageAtSubmit;
  final bool overrideRecorded;
}

/// Plans from the Gym Plan backend (`backend/src/modules/plans.js`).
class PlansService {
  PlansService({ApiClient? client}) : _client = client;

  final ApiClient? _client;
  ApiClient get _api => _client ?? ApiClient.instance;

  /// The signed-in user's gym, initials and three most recent plans.
  Future<HomeData> load() async {
    // Both requests go out together. Awaited one by one (rather than with
    // `.wait`) so a failure surfaces as the ApiException the screens catch.
    final Future<Map<String, Object?>> meCall = _api.get('/v1/me');
    final Future<Map<String, Object?>> recentCall = _api.get(
      '/v1/plans?limit=3',
    );
    // Stop the second failure being reported as unhandled if the first
    // one throws.
    unawaited(recentCall.then((_) {}, onError: (Object _) {}));
    final Map<String, Object?> me = await meCall;
    final Map<String, Object?> recent = await recentCall;
    // The account block is the current account's (`X-Account-Id`).
    final Map<String, Object?>? account =
        me['account'] as Map<String, Object?>?;
    final Map<String, Object?>? facility =
        account?['defaultFacility'] as Map<String, Object?>?;
    return HomeData(
      gymName:
          facility?['name'] as String? ??
          account?['name'] as String? ??
          _api.session.currentAccount?.name ??
          'Flex Gym Scan',
      userInitials: me['initials']! as String,
      plans: _plans(recent),
      // Held on this phone, so the phone knows best.
      pendingUploads: UploadQueue.instance.pendingCount,
    );
  }

  /// Every plan the user can see, most recently changed first.
  Future<List<Plan>> plans() async => _plans(await _api.get('/v1/plans'));

  Future<PlanReadyDetail> readyDetail(Plan plan) async {
    final Map<String, Object?> d = await _api.get('/v1/plans/${plan.id}');
    final Map<String, Object?>? review = d['review'] as Map<String, Object?>?;
    final DateTime? reviewedAt = Formatting.parse(d['reviewedAt']);
    final Map<String, Object?>? share = d['shareLink'] as Map<String, Object?>?;
    final int? seconds = (review?['seconds'] as num?)?.toInt();

    return PlanReadyDetail(
      plan: Plan.fromJson(d),
      areaM2: (d['areaM2'] as num?)?.round(),
      version: (d['version']! as num).toInt(),
      approvedBy: _stamp(review, reviewedAt),
      reviewerTime: seconds == null ? null : Formatting.duration(seconds),
      walkthroughUrl: d['walkthroughUrl'] as String?,
      shareLink: share?['url'] as String?,
    );
  }

  Future<PlanRejection> rejection(Plan plan) async {
    final Map<String, Object?> d = await _api.get('/v1/plans/${plan.id}');
    final Map<String, Object?>? review = d['review'] as Map<String, Object?>?;
    final DateTime? submitted = Formatting.parse(d['submittedAt']);
    final num? coverage = d['coverage'] as num?;

    return PlanRejection(
      plan: Plan.fromJson(d),
      submittedAt: submitted == null ? '—' : Formatting.stamp(submitted),
      reason: d['rejectionReason'] as String? ?? 'Needs recapture',
      note: review?['note'] as String? ?? 'The reviewer left no note.',
      reviewer: _stamp(review, Formatting.parse(d['reviewedAt'])),
      coverageAtSubmit: coverage == null ? null : (coverage * 100).round(),
      overrideRecorded: d['overrideRecorded'] == true,
    );
  }

  /// A read-only link to the walkthrough. The server reuses an existing one.
  Future<String> createShareLink(Plan plan) async {
    final Map<String, Object?> body = await _api.post(
      '/v1/plans/${plan.id}/share-links',
    );
    return body['url']! as String;
  }

  List<Plan> _plans(Map<String, Object?> body) => <Plan>[
    for (final Object? p in body['plans']! as List<Object?>)
      Plan.fromJson(p! as Map<String, Object?>),
  ];

  ReviewerStamp? _stamp(Map<String, Object?>? review, DateTime? at) {
    final Map<String, Object?>? r =
        review?['reviewer'] as Map<String, Object?>?;
    if (r == null) return null;
    return ReviewerStamp(
      name: r['name']! as String,
      initials: r['initials']! as String,
      at: at == null ? '' : Formatting.stamp(at),
    );
  }
}
