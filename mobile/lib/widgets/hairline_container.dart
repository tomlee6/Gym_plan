import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

/// A 1px gradient border wrapped around a solid fill, as used throughout the
/// prototype for inputs, cards and buttons.
class HairlineContainer extends StatelessWidget {
  const HairlineContainer({
    super.key,
    required this.child,
    required this.radius,
    this.borderColors = AppColors.hairline,
    this.fillColor = AppColors.background,
    this.fillGradient,
    this.padding = EdgeInsets.zero,
  });

  final Widget child;
  final double radius;
  final List<Color> borderColors;
  final Color fillColor;
  final Gradient? fillGradient;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(radius),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: borderColors,
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.all(1),
        child: DecoratedBox(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(radius - 1),
            color: fillGradient == null ? fillColor : null,
            gradient: fillGradient,
          ),
          child: Padding(padding: padding, child: child),
        ),
      ),
    );
  }
}
