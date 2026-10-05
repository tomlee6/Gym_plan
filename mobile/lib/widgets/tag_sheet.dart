import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import '../models/scan.dart';
import '../theme/app_theme.dart';
import 'capture_fields.dart';
import 'pressable.dart';
import 'primary_button.dart';

/// What the surveyor picked in the tag sheet.
typedef TagChoice = ({TagType type, double? heightM});

/// Opens the "Add a tag" sheet. Resolves to null if it was cancelled.
Future<TagChoice?> showTagSheet(
  BuildContext context, {
  required double defaultHeightM,
}) {
  return showModalBottomSheet<TagChoice>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: Colors.transparent,
    barrierColor: const Color(0xB801060A),
    builder: (_) => TagSheet(defaultHeightM: defaultHeightM),
  );
}

class TagSheet extends StatefulWidget {
  const TagSheet({super.key, required this.defaultHeightM});

  /// Prefills the measured height when a ceiling tag is chosen.
  final double defaultHeightM;

  @override
  State<TagSheet> createState() => _TagSheetState();
}

class _TagSheetState extends State<TagSheet> {
  static const double _minHeightM = 2.0;
  static const double _maxHeightM = 12.0;

  TagType _picked = TagType.mirror;
  late final TextEditingController _height = TextEditingController(
    text: widget.defaultHeightM.toStringAsFixed(2),
  );
  String? _heightError;

  @override
  void dispose() {
    _height.dispose();
    super.dispose();
  }

  void _drop() {
    double? height;
    if (_picked == TagType.ceiling) {
      height = double.tryParse(_height.text.trim());
      final String? error = height == null
          ? 'Enter the measured height.'
          : (height < _minHeightM || height > _maxHeightM)
          ? 'Height must be between ${_minHeightM.toStringAsFixed(1)} and '
                '${_maxHeightM.toStringAsFixed(1)} m.'
          : null;
      setState(() => _heightError = error);
      if (error != null) return;
    }
    Navigator.of(context).pop((type: _picked, heightM: height));
  }

  @override
  Widget build(BuildContext context) {
    final double keyboard = MediaQuery.viewInsetsOf(context).bottom;
    final double bottomSafe = MediaQuery.paddingOf(context).bottom;

    return Padding(
      padding: EdgeInsets.only(bottom: keyboard),
      // Same gradient hairline as the cards, but open along the bottom edge
      // where the sheet meets the screen.
      child: DecoratedBox(
        decoration: const BoxDecoration(
          borderRadius: BorderRadius.vertical(top: Radius.circular(29)),
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: AppColors.hairline,
          ),
        ),
        child: Container(
          margin: const EdgeInsets.only(left: 1, top: 1, right: 1),
          decoration: const BoxDecoration(
            color: AppColors.background,
            borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
          ),
          child: SingleChildScrollView(
            padding: EdgeInsets.fromLTRB(20, 10, 20, 20 + bottomSafe),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                Center(
                  child: Container(
                    width: 38,
                    height: 5,
                    decoration: BoxDecoration(
                      color: const Color(0x38FFFFFF),
                      borderRadius: BorderRadius.circular(3),
                    ),
                  ),
                ),
                const SizedBox(height: 16),
                _buildHeader(),
                const SizedBox(height: 10),
                const Text(
                  'Dropped at your current position on the outline.',
                  textAlign: TextAlign.center,
                  style: AppTheme.caption,
                ),
                const SizedBox(height: 16),
                for (final TagType type in TagType.values) ...<Widget>[
                  if (type != TagType.values.first) const SizedBox(height: 8),
                  _TagOption(
                    type: type,
                    selected: type == _picked,
                    onTap: () => setState(() {
                      _picked = type;
                      _heightError = null;
                    }),
                  ),
                ],
                if (_picked == TagType.ceiling) ...<Widget>[
                  const SizedBox(height: 14),
                  LabelledField(
                    label: 'Measured height',
                    errorText: _heightError,
                    child: NumericField(
                      controller: _height,
                      unit: 'm',
                      decimal: true,
                      hasError: _heightError != null,
                      semanticLabel: 'Measured ceiling height in metres',
                      onSubmitted: (_) => _drop(),
                    ),
                  ),
                ],
                const SizedBox(height: 18),
                PrimaryButton(label: 'Drop tag here', onPressed: _drop),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildHeader() {
    const TextStyle action = TextStyle(
      fontSize: 16,
      fontWeight: FontWeight.w500,
      color: AppColors.textMuted,
    );

    return Row(
      children: <Widget>[
        Pressable(
          onTap: () => Navigator.of(context).pop(),
          haptic: HapticImpact.selection,
          semanticLabel: 'Cancel',
          child: const Padding(
            padding: EdgeInsets.symmetric(vertical: 6),
            child: Text('Cancel', style: action),
          ),
        ),
        const Expanded(
          child: Text(
            'Add a tag',
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 17,
              fontWeight: FontWeight.w600,
              color: AppColors.textPrimary,
            ),
          ),
        ),
        // Mirrors "Cancel" so the title stays centred.
        const ExcludeSemantics(
          child: Text(
            'Cancel',
            style: TextStyle(fontSize: 16, color: Colors.transparent),
          ),
        ),
      ],
    );
  }
}

class _TagOption extends StatelessWidget {
  const _TagOption({
    required this.type,
    required this.selected,
    required this.onTap,
  });

  final TagType type;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Pressable(
      onTap: onTap,
      haptic: HapticImpact.selection,
      pressedScale: 0.99,
      semanticLabel:
          '${type.label}. ${type.hint}${selected ? ', selected' : ''}',
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 160),
        padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 13),
        decoration: BoxDecoration(
          color: selected ? AppColors.tabActiveFill : AppColors.planCanvas,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
            color: selected ? AppColors.deepTeal : AppColors.planBlockEdge,
          ),
        ),
        child: Row(
          children: <Widget>[
            Container(
              width: 36,
              height: 36,
              decoration: BoxDecoration(
                color: type.tint,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(type.icon, size: 18, color: type.color),
            ),
            const SizedBox(width: 13),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    type.label,
                    style: const TextStyle(
                      fontSize: 14.5,
                      fontWeight: FontWeight.w600,
                      color: AppColors.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    type.hint,
                    style: const TextStyle(
                      fontSize: 12,
                      color: AppColors.textMuted,
                    ),
                  ),
                ],
              ),
            ),
            if (selected)
              const Icon(
                CupertinoIcons.checkmark_alt,
                size: 20,
                color: AppColors.accent,
              ),
          ],
        ),
      ),
    );
  }
}
