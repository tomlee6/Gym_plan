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

/// One choice in the dashboard's "What do you want to create?" panel.
@immutable
class CreateOption {
  const CreateOption({
    required this.icon,
    required this.label,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;
}

/// "What do you want to create?", Polycam style: a tile per thing to make,
/// three to a row, with a close button that hides the panel.
class CreatePanel extends StatelessWidget {
  const CreatePanel({super.key, required this.options, this.onClose});

  final List<CreateOption> options;
  final VoidCallback? onClose;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 14, 10, 16),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(20),
        gradient: const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: <Color>[Color(0xFF053A44), Color(0xFF02222B)],
        ),
        border: Border.all(color: AppColors.accent.withValues(alpha: 0.35)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Row(
            children: <Widget>[
              const Expanded(
                child: Text(
                  'What do you want to create?',
                  style: TextStyle(
                    fontSize: 17,
                    fontWeight: FontWeight.w700,
                    color: AppColors.textPrimary,
                  ),
                ),
              ),
              if (onClose != null)
                Pressable(
                  onTap: onClose,
                  haptic: HapticImpact.selection,
                  semanticLabel: 'Hide',
                  child: const Padding(
                    padding: EdgeInsets.all(6),
                    child: Icon(
                      CupertinoIcons.xmark,
                      size: 18,
                      color: AppColors.textMuted,
                    ),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 14),
          Padding(
            padding: const EdgeInsets.only(right: 6),
            child: LayoutBuilder(
              builder: (BuildContext context, BoxConstraints box) {
                const double gap = 10;
                final double tile = (box.maxWidth - gap * 2) / 3;
                return Wrap(
                  spacing: gap,
                  runSpacing: gap,
                  children: <Widget>[
                    for (final CreateOption o in options)
                      SizedBox(
                        width: tile,
                        child: _CreateTile(option: o),
                      ),
                  ],
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _CreateTile extends StatelessWidget {
  const _CreateTile({required this.option});

  final CreateOption option;

  @override
  Widget build(BuildContext context) {
    return Pressable(
      onTap: option.onTap,
      semanticLabel: option.label,
      child: Container(
        height: 92,
        decoration: BoxDecoration(
          color: AppColors.background.withValues(alpha: 0.75),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: Colors.white.withValues(alpha: 0.10)),
        ),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            Icon(option.icon, size: 26, color: AppColors.accent),
            const SizedBox(height: 10),
            Text(
              option.label,
              textAlign: TextAlign.center,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w600,
                color: AppColors.textPrimary,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// One kept scan on the dashboard: a still of its 3D model, its level and
/// the day it was scanned. Tapping it opens it in 3D.
class ScanTile extends StatelessWidget {
  const ScanTile({
    super.key,
    required this.title,
    required this.date,
    required this.onTap,
    this.thumbnail,
    this.onLongPress,
    this.tag = '3D',
  });

  final String title;

  /// What kind of scan it is, e.g. "Plan", "Space" or "Object".
  final String tag;

  /// e.g. "31 Oct".
  final String date;

  /// The still of the model, when one could be made.
  final ImageProvider? thumbnail;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onLongPress: onLongPress,
      child: Pressable(
        onTap: onTap,
        semanticLabel: '$title, $date',
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            AspectRatio(
              aspectRatio: 1.1,
              child: ClipRRect(
                borderRadius: BorderRadius.circular(16),
                child: DecoratedBox(
                  decoration: const BoxDecoration(color: AppColors.planCanvas),
                  child: thumbnail != null
                      ? Image(image: thumbnail!, fit: BoxFit.cover)
                      : const Center(
                          child: Icon(
                            Icons.view_in_ar_rounded,
                            size: 40,
                            color: AppColors.chipEdge,
                          ),
                        ),
                ),
              ),
            ),
            const SizedBox(height: 8),
            Row(
              children: <Widget>[
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 6,
                    vertical: 2,
                  ),
                  decoration: BoxDecoration(
                    color: AppColors.chipFill,
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(color: AppColors.chipEdge),
                  ),
                  child: Text(
                    tag,
                    style: const TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w700,
                      color: AppColors.accent,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  date,
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: AppColors.textPrimary,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 2),
            Text(
              title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: AppTheme.caption,
            ),
          ],
        ),
      ),
    );
  }
}
