import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import '../models/plan.dart';
import '../theme/app_theme.dart';
import 'hairline_container.dart';
import 'pressable.dart';

/// The primary "New capture" call to action at the top of the home screen.
class CaptureCard extends StatelessWidget {
  const CaptureCard({super.key, required this.onTap, required this.subtitle});

  final VoidCallback onTap;
  final String subtitle;

  @override
  Widget build(BuildContext context) {
    return Pressable(
      onTap: onTap,
      semanticLabel: 'New capture',
      child: HairlineContainer(
        radius: 21,
        fillGradient: AppTheme.card160(AppColors.heroCardFill),
        padding: const EdgeInsets.all(20),
        child: Row(
          children: <Widget>[
            Container(
              width: 48,
              height: 48,
              decoration: const BoxDecoration(
                color: AppColors.accent,
                shape: BoxShape.circle,
              ),
              child: const Icon(
                Icons.crop_free_rounded,
                size: 24,
                color: AppColors.background,
              ),
            ),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  const Text(
                    'New capture',
                    style: TextStyle(
                      fontSize: 17,
                      fontWeight: FontWeight.w600,
                      color: AppColors.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 3),
                  Text(subtitle, style: AppTheme.label),
                ],
              ),
            ),
            const SizedBox(width: 12),
            const Icon(
              CupertinoIcons.chevron_right,
              size: 18,
              color: AppColors.chevron,
            ),
          ],
        ),
      ),
    );
  }
}

/// One row in the "Recent plans" list.
class PlanRow extends StatelessWidget {
  const PlanRow({super.key, required this.plan, required this.onTap});

  final Plan plan;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Pressable(
      onTap: onTap,
      haptic: HapticImpact.selection,
      semanticLabel: '${plan.title}, ${plan.status.label}. ${plan.detail}',
      child: HairlineContainer(
        radius: 17,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        child: Row(
          children: <Widget>[
            Container(
              width: 38,
              height: 38,
              decoration: BoxDecoration(
                color: plan.status.tint,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(plan.status.icon, size: 19, color: plan.status.color),
            ),
            const SizedBox(width: 13),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    plan.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 14.5,
                      fontWeight: FontWeight.w600,
                      color: AppColors.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 3),
                  // Wraps rather than clipping, so hints like "tap to read"
                  // survive on narrow devices.
                  Text(
                    plan.detail,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: AppTheme.label,
                  ),
                ],
              ),
            ),
            const SizedBox(width: 10),
            StatusPill(status: plan.status),
          ],
        ),
      ),
    );
  }
}

class StatusPill extends StatelessWidget {
  const StatusPill({super.key, required this.status});

  final PlanStatus status;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: status.tint,
        borderRadius: BorderRadius.circular(11),
      ),
      child: Text(
        status.label,
        style: TextStyle(
          fontSize: 11.5,
          fontWeight: FontWeight.w600,
          color: status.color,
        ),
      ),
    );
  }
}

/// Banner shown while captures are still queued on the device.
class PendingUploadBanner extends StatelessWidget {
  const PendingUploadBanner({
    super.key,
    required this.count,
    required this.onView,
  });

  final int count;
  final VoidCallback onView;

  @override
  Widget build(BuildContext context) {
    final String noun = count == 1 ? 'capture' : 'captures';

    return HairlineContainer(
      radius: 17,
      fillGradient: AppTheme.card160(AppColors.uploadCardFill),
      padding: const EdgeInsets.all(16),
      child: Row(
        children: <Widget>[
          const Icon(
            Icons.autorenew_rounded,
            size: 20,
            color: AppColors.accent,
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  '$count $noun waiting to upload',
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: AppColors.textPrimary,
                  ),
                ),
                const SizedBox(height: 2),
                const Text(
                  'Resumes on its own when you have signal',
                  style: TextStyle(fontSize: 12, color: AppColors.textMuted),
                ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          Pressable(
            onTap: onView,
            haptic: HapticImpact.selection,
            semanticLabel: 'View pending uploads',
            child: const Padding(
              padding: EdgeInsets.symmetric(horizontal: 4, vertical: 6),
              child: Text(
                'View',
                style: TextStyle(
                  fontSize: 12.5,
                  fontWeight: FontWeight.w600,
                  color: AppColors.accent,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
