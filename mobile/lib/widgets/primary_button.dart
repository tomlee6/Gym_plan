import 'package:flutter/cupertino.dart';

import '../theme/app_theme.dart';
import 'hairline_container.dart';
import 'pressable.dart';

/// Full-width gradient button with a press scale and a busy state.
class PrimaryButton extends StatelessWidget {
  const PrimaryButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.busy = false,
    this.icon,
  });

  final String label;
  final VoidCallback? onPressed;
  final bool busy;

  /// Optional teal glyph shown before the label.
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    return Pressable(
      semanticLabel: label,
      onTap: busy ? null : onPressed,
      child: HairlineContainer(
        radius: 26,
        borderColors: AppColors.primaryEdge,
        fillGradient: const LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: AppColors.primaryFill,
          stops: <double>[0, 0.55, 1],
        ),
        child: SizedBox(
          height: 50,
          child: Center(
            child: busy
                ? const CupertinoActivityIndicator(
                    color: AppColors.textPrimary,
                    radius: 10,
                  )
                : Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        if (icon != null) ...<Widget>[
                          Icon(icon, size: 19, color: AppColors.accent),
                          const SizedBox(width: 9),
                        ],
                        // Long labels ("Open walkthrough in Safari") must not
                        // overflow at large text sizes.
                        Flexible(
                          child: Text(
                            label,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w600,
                              color: AppColors.textPrimary,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
          ),
        ),
      ),
    );
  }
}

/// Bordered card with a leading icon, used for the LiDAR notice and the
/// "check your inbox" confirmation.
class InfoCard extends StatelessWidget {
  const InfoCard({
    super.key,
    required this.icon,
    required this.message,
    this.iconColor = AppColors.info,
  });

  final IconData icon;
  final String message;
  final Color iconColor;

  @override
  Widget build(BuildContext context) {
    return HairlineContainer(
      radius: 17,
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.only(top: 1),
            child: Icon(icon, size: 17, color: iconColor),
          ),
          const SizedBox(width: 12),
          Expanded(child: Text(message, style: AppTheme.caption)),
        ],
      ),
    );
  }
}
