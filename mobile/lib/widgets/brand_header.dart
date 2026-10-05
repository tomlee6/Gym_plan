import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

/// Flex Motion Technologies logo above the "GYM SCAN" product line.
class BrandHeader extends StatelessWidget {
  const BrandHeader({super.key, this.logoWidth = 196});

  final double logoWidth;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: <Widget>[
        Image.asset(
          'assets/images/flex_motion_logo.png',
          width: logoWidth,
          fit: BoxFit.contain,
          semanticLabel: 'Flex Motion Technologies',
          // Keep the mark crisp when it is scaled down from its native 300px.
          filterQuality: FilterQuality.medium,
        ),
        const SizedBox(height: 12),
        const Text(
          'GYM SCAN',
          style: TextStyle(
            fontSize: 12,
            fontWeight: FontWeight.w600,
            letterSpacing: 3.5,
            color: AppColors.accent,
          ),
        ),
      ],
    );
  }
}
