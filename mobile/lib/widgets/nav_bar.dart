import 'package:flutter/cupertino.dart';

import '../theme/app_theme.dart';
import 'pressable.dart';

/// iOS-style top bar: a teal back action on the left and an optional plain
/// action on the right. 44pt tall so both stay inside the tap-target minimum.
class NavBar extends StatelessWidget {
  const NavBar({
    super.key,
    required this.backLabel,
    required this.onBack,
    this.trailingLabel,
    this.onTrailing,
    this.trailing,
  });

  final String backLabel;
  final VoidCallback onBack;
  final String? trailingLabel;
  final VoidCallback? onTrailing;

  /// Custom right-hand action, e.g. a share icon. Used when there is no
  /// [trailingLabel].
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 44,
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: <Widget>[
          Pressable(
            onTap: onBack,
            haptic: HapticImpact.selection,
            semanticLabel: 'Back to $backLabel',
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  const Icon(
                    CupertinoIcons.chevron_left,
                    size: 20,
                    color: AppColors.accent,
                  ),
                  const SizedBox(width: 2),
                  Text(
                    backLabel,
                    style: AppTheme.navAction.copyWith(color: AppColors.accent),
                  ),
                ],
              ),
            ),
          ),
          if (trailingLabel != null)
            Pressable(
              onTap: onTrailing,
              haptic: HapticImpact.selection,
              semanticLabel: trailingLabel,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8),
                child: Text(
                  trailingLabel!,
                  style: AppTheme.navAction.copyWith(
                    color: AppColors.textMuted,
                  ),
                ),
              ),
            )
          else
            ?trailing,
        ],
      ),
    );
  }
}
