import 'dart:math' as math;

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import 'hairline_container.dart';
import 'pressable.dart';

/// Title and one-line subtitle at the top of a pushed detail screen.
class DetailHeader extends StatelessWidget {
  const DetailHeader({super.key, required this.title, required this.subtitle});

  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(title, style: AppTheme.detailTitle),
        const SizedBox(height: 6),
        Text(subtitle, style: AppTheme.detailSubtitle),
      ],
    );
  }
}

/// One label/value line inside an [InfoRowsCard].
@immutable
class InfoRow {
  const InfoRow(this.label, this.value, {this.valueColor, this.dotColor});

  final String label;
  final String value;
  final Color? valueColor;

  /// Small status dot before the value, e.g. connection quality.
  final Color? dotColor;
}

/// Grouped card of label/value rows separated by hairlines.
class InfoRowsCard extends StatelessWidget {
  const InfoRowsCard({super.key, required this.rows, this.rowHeight = 46});

  final List<InfoRow> rows;
  final double rowHeight;

  @override
  Widget build(BuildContext context) {
    return HairlineContainer(
      radius: 19,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      child: Column(
        children: <Widget>[
          for (int i = 0; i < rows.length; i++) ...<Widget>[
            if (i > 0) const Divider(height: 1, color: AppColors.divider),
            SizedBox(
              height: rowHeight,
              child: Row(
                children: <Widget>[
                  Flexible(
                    child: Text(
                      rows[i].label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 13.5,
                        color: AppColors.textMuted,
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.end,
                      children: <Widget>[
                        if (rows[i].dotColor != null) ...<Widget>[
                          StatusDot(color: rows[i].dotColor!),
                          const SizedBox(width: 7),
                        ],
                        Flexible(
                          child: Text(
                            rows[i].value,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            textAlign: TextAlign.right,
                            style: TextStyle(
                              fontSize: 13.5,
                              fontWeight: FontWeight.w500,
                              fontFeatures: const <FontFeature>[
                                FontFeature.tabularFigures(),
                              ],
                              color:
                                  rows[i].valueColor ?? AppColors.textPrimary,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class StatusDot extends StatelessWidget {
  const StatusDot({super.key, required this.color, this.size = 7});

  final Color color;
  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
    );
  }
}

/// Coloured-edge card with a tinted icon tile, a title and a subtitle, e.g.
/// "Approved and generated" or "Needs recapture".
class StatusCallout extends StatelessWidget {
  const StatusCallout({
    super.key,
    required this.color,
    required this.icon,
    required this.title,
    required this.subtitle,
    this.large = false,
    this.child,
  });

  final Color color;
  final IconData icon;
  final String title;
  final String subtitle;

  /// The bigger heading used when the callout is the point of the screen.
  final bool large;

  /// Extra content under a divider, e.g. the reviewer's note.
  final Widget? child;

  @override
  Widget build(BuildContext context) {
    final double tile = large ? 42 : 36;

    return HairlineContainer(
      radius: large ? 19 : 17,
      borderColors: AppColors.edgeInto(color),
      padding: large
          ? const EdgeInsets.all(18)
          : const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Container(
                width: tile,
                height: tile,
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(large ? 14 : 12),
                ),
                child: Icon(icon, size: large ? 21 : 19, color: color),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      title,
                      style: TextStyle(
                        fontSize: large ? 17 : 14,
                        fontWeight: large ? FontWeight.w700 : FontWeight.w600,
                        color: AppColors.textPrimary,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(subtitle, style: AppTheme.label),
                  ],
                ),
              ),
            ],
          ),
          if (child != null) ...<Widget>[
            const SizedBox(height: 16),
            const Divider(height: 1, color: AppColors.divider),
            const SizedBox(height: 16),
            child!,
          ],
        ],
      ),
    );
  }
}

/// Muted full-width text action under a primary button, e.g. "Keep scanning".
class SecondaryAction extends StatelessWidget {
  const SecondaryAction({super.key, required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Pressable(
      onTap: onTap,
      haptic: HapticImpact.selection,
      semanticLabel: label,
      child: SizedBox(
        height: 44,
        child: Center(
          child: Text(
            label,
            style: const TextStyle(
              fontSize: 15,
              fontWeight: FontWeight.w500,
              color: AppColors.textMuted,
            ),
          ),
        ),
      ),
    );
  }
}

/// Shown in place of a screen's content when it could not load, e.g. with
/// no signal. [onRetry] loads it again.
class ErrorView extends StatelessWidget {
  const ErrorView({
    super.key,
    required this.message,
    required this.onRetry,
    this.icon = Icons.cloud_off_rounded,
    this.title,
  });

  final String message;
  final VoidCallback onRetry;
  final IconData icon;

  /// A short headline above the message, when the message needs one.
  final String? title;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(32, 0, 32, 60),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(icon, size: 40, color: AppColors.textMuted),
            const SizedBox(height: 14),
            if (title != null) ...<Widget>[
              Text(title!, textAlign: TextAlign.center, style: AppTheme.title),
              const SizedBox(height: 6),
            ],
            Text(message, textAlign: TextAlign.center, style: AppTheme.body),
            const SizedBox(height: 18),
            Pressable(
              onTap: onRetry,
              haptic: HapticImpact.selection,
              semanticLabel: 'Try again',
              child: const Padding(
                padding: EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                child: Text('Try again', style: AppTheme.link),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Centered activity indicator used while a screen's data loads.
class LoadingView extends StatelessWidget {
  const LoadingView({super.key});

  @override
  Widget build(BuildContext context) {
    return const Center(
      child: CupertinoActivityIndicator(color: AppColors.textMuted, radius: 12),
    );
  }
}

/// Thick ring showing upload progress, with the percentage in the middle.
class ProgressRing extends StatelessWidget {
  const ProgressRing({
    super.key,
    required this.progress,
    this.size = 188,
    this.complete = false,
  });

  /// 0–1.
  final double progress;
  final double size;

  /// Swaps the number for a tick once the upload lands.
  final bool complete;

  @override
  Widget build(BuildContext context) {
    final int percent = (progress * 100).floor();

    return Semantics(
      label: complete ? 'Upload complete' : 'Upload $percent percent complete',
      child: SizedBox(
        width: size,
        height: size,
        child: TweenAnimationBuilder<double>(
          tween: Tween<double>(end: progress),
          duration: const Duration(milliseconds: 280),
          curve: Curves.easeOut,
          builder: (BuildContext context, double value, Widget? _) {
            return CustomPaint(
              painter: _RingPainter(
                value,
                complete ? AppColors.success : AppColors.accent,
              ),
              child: Center(
                child: complete
                    ? const Icon(
                        Icons.check_rounded,
                        size: 64,
                        color: AppColors.success,
                      )
                    : Column(
                        mainAxisSize: MainAxisSize.min,
                        children: <Widget>[
                          Text(
                            '$percent',
                            style: const TextStyle(
                              fontSize: 42,
                              fontWeight: FontWeight.w700,
                              height: 1.1,
                              fontFeatures: <FontFeature>[
                                FontFeature.tabularFigures(),
                              ],
                              color: AppColors.textPrimary,
                            ),
                          ),
                          const Text(
                            'per cent',
                            style: TextStyle(
                              fontSize: 14,
                              fontWeight: FontWeight.w500,
                              color: AppColors.textMuted,
                            ),
                          ),
                        ],
                      ),
              ),
            );
          },
        ),
      ),
    );
  }
}

class _RingPainter extends CustomPainter {
  _RingPainter(this.progress, this.color);

  final double progress;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    const double stroke = 10;
    final Rect rect = (Offset.zero & size).deflate(stroke / 2 + 4);

    canvas.drawArc(
      rect,
      0,
      math.pi * 2,
      false,
      Paint()
        ..color = AppColors.track
        ..style = PaintingStyle.stroke
        ..strokeWidth = stroke,
    );
    if (progress <= 0) return;
    canvas.drawArc(
      rect,
      -math.pi / 2,
      math.pi * 2 * progress.clamp(0, 1),
      false,
      Paint()
        ..color = color
        ..style = PaintingStyle.stroke
        ..strokeCap = StrokeCap.round
        ..strokeWidth = stroke,
    );
  }

  @override
  bool shouldRepaint(_RingPainter old) =>
      old.progress != progress || old.color != color;
}
