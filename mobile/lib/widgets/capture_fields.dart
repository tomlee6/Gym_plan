import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/app_theme.dart';
import 'hairline_container.dart';
import 'pressable.dart';

/// Uppercase label above a capture form control, with optional inline error.
class LabelledField extends StatelessWidget {
  const LabelledField({
    super.key,
    required this.label,
    required this.child,
    this.errorText,
  });

  final String label;
  final Widget child;
  final String? errorText;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          label.toUpperCase(),
          style: AppTheme.fieldLabel.copyWith(
            color: errorText == null ? AppColors.textMuted : AppColors.danger,
          ),
        ),
        const SizedBox(height: 9),
        child,
        if (errorText != null) ...<Widget>[
          const SizedBox(height: 7),
          Padding(
            padding: const EdgeInsets.only(left: 4),
            child: Text(
              errorText!,
              style: const TextStyle(fontSize: 12.5, color: AppColors.danger),
            ),
          ),
        ],
      ],
    );
  }
}

/// Read-only field that opens a [CupertinoPicker] sheet, standing in for the
/// prototype's `<select>`.
class PickerField extends StatelessWidget {
  const PickerField({
    super.key,
    required this.icon,
    required this.value,
    required this.options,
    required this.onChanged,
  });

  final IconData icon;
  final String value;
  final List<String> options;
  final ValueChanged<String> onChanged;

  Future<void> _open(BuildContext context) async {
    final int startIndex = options.indexOf(value);
    final FixedExtentScrollController controller = FixedExtentScrollController(
      initialItem: startIndex < 0 ? 0 : startIndex,
    );
    // Tracks the wheel while it spins; only committed when Done is tapped.
    int pending = startIndex < 0 ? 0 : startIndex;

    final int? picked = await showCupertinoModalPopup<int>(
      context: context,
      builder: (BuildContext sheetContext) => Container(
        height: 292,
        color: AppColors.surface,
        child: Column(
          children: <Widget>[
            Container(
              height: 44,
              decoration: const BoxDecoration(
                color: AppColors.background,
                border: Border(bottom: BorderSide(color: Color(0xFF1B2227))),
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: <Widget>[
                  CupertinoButton(
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    onPressed: () => Navigator.of(sheetContext).pop(),
                    child: const Text(
                      'Cancel',
                      style: TextStyle(
                        fontSize: 16,
                        color: AppColors.textMuted,
                      ),
                    ),
                  ),
                  CupertinoButton(
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    onPressed: () => Navigator.of(sheetContext).pop(pending),
                    child: const Text(
                      'Done',
                      style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w600,
                        color: AppColors.accent,
                      ),
                    ),
                  ),
                ],
              ),
            ),
            Expanded(
              child: CupertinoPicker(
                scrollController: controller,
                itemExtent: 40,
                backgroundColor: AppColors.surface,
                selectionOverlay: const CupertinoPickerDefaultSelectionOverlay(
                  background: Color(0x1400CAB2),
                ),
                onSelectedItemChanged: (int index) => pending = index,
                children: options
                    .map(
                      (String option) => Center(
                        child: Text(
                          option,
                          style: const TextStyle(
                            fontSize: 19,
                            color: AppColors.textPrimary,
                          ),
                        ),
                      ),
                    )
                    .toList(),
              ),
            ),
          ],
        ),
      ),
    );

    controller.dispose();
    if (picked != null) onChanged(options[picked]);
  }

  @override
  Widget build(BuildContext context) {
    return Pressable(
      onTap: () => _open(context),
      haptic: HapticImpact.selection,
      pressedScale: 0.99,
      semanticLabel: 'Facility, $value',
      child: HairlineContainer(
        radius: 17,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
        child: SizedBox(
          height: 48,
          child: Row(
            children: <Widget>[
              Icon(icon, size: 20, color: AppColors.deepTeal),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  value,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w500,
                    color: AppColors.textPrimary,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              const Icon(
                CupertinoIcons.chevron_up_chevron_down,
                size: 15,
                color: AppColors.chevron,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Numeric entry with an optional trailing unit, e.g. "3.20 m".
class NumericField extends StatelessWidget {
  const NumericField({
    super.key,
    required this.controller,
    this.unit,
    this.decimal = false,
    this.focusNode,
    this.hasError = false,
    this.onSubmitted,
    this.semanticLabel,
  });

  final TextEditingController controller;
  final String? unit;
  final bool decimal;
  final FocusNode? focusNode;
  final bool hasError;
  final ValueChanged<String>? onSubmitted;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    return HairlineContainer(
      radius: 17,
      borderColors: hasError
          ? const <Color>[AppColors.danger, AppColors.danger]
          : AppColors.hairline,
      child: SizedBox(
        height: 48,
        child: Row(
          children: <Widget>[
            Expanded(
              child: TextField(
                controller: controller,
                focusNode: focusNode,
                onSubmitted: onSubmitted,
                textInputAction: TextInputAction.done,
                keyboardType: TextInputType.numberWithOptions(decimal: decimal),
                inputFormatters: <TextInputFormatter>[
                  FilteringTextInputFormatter.allow(
                    decimal ? RegExp(r'[0-9.]') : RegExp(r'[0-9]'),
                  ),
                ],
                style: AppTheme.fieldValue,
                keyboardAppearance: Brightness.dark,
                cursorColor: AppColors.accent,
                decoration: const InputDecoration(
                  isCollapsed: true,
                  border: InputBorder.none,
                  contentPadding: EdgeInsets.only(left: 16),
                ),
              ),
            ),
            if (unit != null)
              Padding(
                padding: const EdgeInsets.only(left: 6, right: 14),
                child: Text(
                  unit!,
                  style: const TextStyle(
                    fontSize: 14,
                    color: AppColors.textMuted,
                  ),
                ),
              )
            else
              const SizedBox(width: 16),
          ],
        ),
      ),
    );
  }
}

/// Device capability row: green when the phone can scan, red when it cannot.
class DeviceStatusRow extends StatelessWidget {
  const DeviceStatusRow({
    super.key,
    required this.supported,
    required this.headline,
    required this.detail,
  });

  final bool supported;
  final String headline;
  final String detail;

  @override
  Widget build(BuildContext context) {
    final Color color = supported ? AppColors.success : AppColors.danger;

    return HairlineContainer(
      radius: 17,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      child: Row(
        children: <Widget>[
          Container(
            width: 34,
            height: 34,
            decoration: BoxDecoration(
              color: color.withValues(alpha: 0.15),
              borderRadius: BorderRadius.circular(11),
            ),
            child: Icon(
              supported ? Icons.check_rounded : Icons.close_rounded,
              size: 18,
              color: color,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  headline,
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                    color: AppColors.textPrimary,
                  ),
                ),
                const SizedBox(height: 2),
                Text(detail, style: AppTheme.label),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The "Before you start" numbered checklist.
class ChecklistCard extends StatelessWidget {
  const ChecklistCard({
    super.key,
    required this.title,
    required this.steps,
    this.icon = Icons.wb_sunny_outlined,
  });

  final String title;
  final List<String> steps;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return HairlineContainer(
      radius: 17,
      fillGradient: AppTheme.card160(AppColors.uploadCardFill),
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Icon(icon, size: 18, color: AppColors.accent),
              const SizedBox(width: 10),
              Text(
                title,
                style: const TextStyle(
                  fontSize: 13.5,
                  fontWeight: FontWeight.w600,
                  color: AppColors.textPrimary,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          for (int i = 0; i < steps.length; i++) ...<Widget>[
            if (i > 0) const SizedBox(height: 9),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  '${i + 1}',
                  style: const TextStyle(
                    fontSize: 12.5,
                    height: 1.44,
                    color: AppColors.deepTeal,
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(child: Text(steps[i], style: AppTheme.caption)),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
