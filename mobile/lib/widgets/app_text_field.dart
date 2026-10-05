import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/app_theme.dart';
import 'hairline_container.dart';

/// Labelled pill input matching the prototype, with inline error text.
class AppTextField extends StatelessWidget {
  const AppTextField({
    super.key,
    required this.label,
    required this.controller,
    this.hintText,
    this.errorText,
    this.obscureText = false,
    this.keyboardType,
    this.textInputAction,
    this.autofillHints,
    this.focusNode,
    this.enabled = true,
    this.onSubmitted,
    this.suffix,
  });

  final String label;
  final TextEditingController controller;
  final String? hintText;
  final String? errorText;
  final bool obscureText;
  final TextInputType? keyboardType;
  final TextInputAction? textInputAction;
  final Iterable<String>? autofillHints;
  final FocusNode? focusNode;
  final bool enabled;
  final ValueChanged<String>? onSubmitted;
  final Widget? suffix;

  @override
  Widget build(BuildContext context) {
    final bool hasError = errorText != null;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          label,
          style: AppTheme.label.copyWith(
            color: hasError ? AppColors.danger : AppColors.textMuted,
          ),
        ),
        const SizedBox(height: 9),
        HairlineContainer(
          radius: 24,
          borderColors: hasError
              ? const <Color>[AppColors.danger, AppColors.danger]
              : AppColors.hairline,
          child: SizedBox(
            height: 46,
            child: Row(
              children: <Widget>[
                Expanded(
                  child: TextField(
                    controller: controller,
                    focusNode: focusNode,
                    enabled: enabled,
                    obscureText: obscureText,
                    keyboardType: keyboardType,
                    textInputAction: textInputAction,
                    autofillHints: autofillHints,
                    onSubmitted: onSubmitted,
                    style: const TextStyle(
                      fontSize: 14,
                      color: AppColors.textPrimary,
                    ),
                    // Without this the iOS keyboard renders light on a dark app.
                    keyboardAppearance: Brightness.dark,
                    cursorColor: AppColors.accent,
                    decoration: InputDecoration(
                      isCollapsed: true,
                      border: InputBorder.none,
                      hintText: hintText,
                      hintStyle: const TextStyle(
                        fontSize: 14,
                        color: Color(0xFF4A5157),
                      ),
                      contentPadding: EdgeInsets.only(
                        left: 18,
                        right: suffix == null ? 18 : 4,
                      ),
                    ),
                  ),
                ),
                ?suffix,
              ],
            ),
          ),
        ),
        if (hasError) ...<Widget>[
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

/// Eye toggle used inside the password field.
class PasswordVisibilityToggle extends StatelessWidget {
  const PasswordVisibilityToggle({
    super.key,
    required this.obscured,
    required this.onChanged,
  });

  final bool obscured;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: obscured ? 'Show password' : 'Hide password',
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () {
          HapticFeedback.selectionClick();
          onChanged();
        },
        child: SizedBox(
          width: 48,
          height: 46,
          child: Icon(
            obscured
                ? Icons.visibility_off_outlined
                : Icons.visibility_outlined,
            size: 19,
            color: AppColors.textMuted,
          ),
        ),
      ),
    );
  }
}
