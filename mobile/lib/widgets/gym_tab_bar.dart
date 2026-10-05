import 'dart:ui';

import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import 'hairline_container.dart';
import 'pressable.dart';

enum GymTab {
  home(label: 'Home', icon: Icons.home_outlined),
  plans(label: 'Plans', icon: Icons.layers_outlined),
  capture(label: 'New capture', icon: Icons.add_rounded),
  uploads(label: 'Uploads', icon: Icons.file_upload_outlined),
  profile(label: 'Profile', icon: Icons.person_outline_rounded);

  const GymTab({required this.label, required this.icon});

  final String label;
  final IconData icon;
}

/// Floating pill tab bar. [GymTab.capture] renders as the raised teal action
/// rather than a selectable tab.
class GymTabBar extends StatelessWidget {
  const GymTabBar({super.key, required this.current, required this.onSelect});

  final GymTab current;
  final ValueChanged<GymTab> onSelect;

  @override
  Widget build(BuildContext context) {
    return HairlineContainer(
      radius: 29,
      fillColor: const Color(0x00000000),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(28),
        // The bar is translucent, so blur whatever scrolls beneath it.
        child: BackdropFilter(
          filter: ImageFilter.blur(sigmaX: 18, sigmaY: 18),
          child: Container(
            height: 56,
            padding: const EdgeInsets.symmetric(horizontal: 10),
            color: AppColors.tabBarFill,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: GymTab.values.map(_buildItem).toList(),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildItem(GymTab tab) {
    if (tab == GymTab.capture) {
      return Pressable(
        onTap: () => onSelect(tab),
        semanticLabel: tab.label,
        child: SizedBox(
          width: 52,
          height: 44,
          child: Center(
            child: Container(
              width: 44,
              height: 44,
              decoration: const BoxDecoration(
                color: AppColors.accent,
                shape: BoxShape.circle,
              ),
              child: const Icon(
                Icons.add_rounded,
                size: 24,
                color: AppColors.background,
              ),
            ),
          ),
        ),
      );
    }

    final bool selected = tab == current;

    return Pressable(
      onTap: () => onSelect(tab),
      haptic: HapticImpact.selection,
      pressedScale: 0.9,
      semanticLabel: tab.label,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 180),
        curve: Curves.easeOut,
        width: 52,
        height: 44,
        decoration: BoxDecoration(
          color: selected ? AppColors.tabActiveFill : Colors.transparent,
          borderRadius: BorderRadius.circular(22),
        ),
        child: Icon(
          tab.icon,
          size: 21,
          color: selected ? AppColors.accent : AppColors.textMuted,
        ),
      ),
    );
  }
}
