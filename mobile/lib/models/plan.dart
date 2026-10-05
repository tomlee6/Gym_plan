import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import '../utils/formatting.dart';

/// The filter a plan falls under on the "My plans" screen.
enum PlanGroup { ready, inProgress, recapture }

/// Where a captured floor plan sits in the review pipeline.
enum PlanStatus {
  ready(
    api: 'ready',
    label: 'Ready',
    color: AppColors.success,
    icon: Icons.check_rounded,
    group: PlanGroup.ready,
  ),
  inReview(
    api: 'in_review',
    label: 'In review',
    color: AppColors.info,
    icon: Icons.access_time_rounded,
    group: PlanGroup.inProgress,
  ),
  uploading(
    api: 'uploading',
    label: 'Uploading',
    color: AppColors.accent,
    icon: Icons.file_upload_outlined,
    group: PlanGroup.inProgress,
  ),
  processing(
    api: 'processing',
    label: 'Processing',
    color: AppColors.warning,
    icon: Icons.settings_outlined,
    group: PlanGroup.inProgress,
  ),
  recapture(
    api: 'recapture',
    label: 'Recapture',
    color: AppColors.danger,
    icon: Icons.warning_amber_rounded,
    group: PlanGroup.recapture,
  );

  const PlanStatus({
    required this.api,
    required this.label,
    required this.color,
    required this.icon,
    required this.group,
  });

  /// The status as the backend spells it.
  final String api;
  final String label;
  final Color color;
  final IconData icon;
  final PlanGroup group;

  /// Tint shared by the leading icon tile and the trailing pill.
  Color get tint => color.withValues(alpha: 0.15);

  static PlanStatus fromApi(String value) => PlanStatus.values.firstWhere(
    (PlanStatus s) => s.api == value,
    // A status added on the server later still shows, as in progress.
    orElse: () => PlanStatus.processing,
  );
}

/// "Ground" for level 0, otherwise "Level n".
String levelLabel(int level) => level == 0 ? 'Ground' : 'Level $level';

@immutable
class Plan {
  const Plan({
    required this.id,
    required this.site,
    required this.levelNumber,
    required this.status,
    this.facilityId,
    this.version = 1,
    this.submittedAt,
    this.reviewStartedAt,
    this.reviewedAt,
    this.rejectionReason,
  });

  /// One entry of `GET /v1/plans`.
  factory Plan.fromJson(Map<String, Object?> json) => Plan(
    id: json['id']! as String,
    facilityId: json['facilityId'] as String?,
    site: json['site']! as String,
    levelNumber: (json['level']! as num).toInt(),
    status: PlanStatus.fromApi(json['status']! as String),
    version: (json['version'] as num? ?? 1).toInt(),
    submittedAt: Formatting.parse(json['submittedAt']),
    reviewStartedAt: Formatting.parse(json['reviewStartedAt']),
    reviewedAt: Formatting.parse(json['reviewedAt']),
    rejectionReason: json['rejectionReason'] as String?,
  );

  final String id;
  final String? facilityId;
  final String site;

  /// 0 is the ground floor. Kept numeric so a recapture can prefill the
  /// capture form, which only accepts digits.
  final int levelNumber;
  final PlanStatus status;
  final int version;
  final DateTime? submittedAt;
  final DateTime? reviewStartedAt;
  final DateTime? reviewedAt;
  final String? rejectionReason;

  String get level => levelLabel(levelNumber);

  String get title => '$site · $level';

  /// Status line under the title, e.g. "Approved 2 days ago · version 2".
  String get detail => switch (status) {
    PlanStatus.ready =>
      reviewedAt == null
          ? 'Walkthrough ready · version $version'
          : 'Approved ${Formatting.ago(reviewedAt!)} · version $version',
    PlanStatus.inReview =>
      reviewStartedAt == null
          ? 'Waiting for a reviewer'
          : 'With a reviewer since ${Formatting.time(reviewStartedAt!)}',
    PlanStatus.uploading => 'Uploading · tap to see progress',
    PlanStatus.processing => 'Reading the plan',
    PlanStatus.recapture =>
      '${rejectionReason ?? 'Needs recapture'} · read the note',
  };
}
