import 'package:flutter/material.dart';

/// Design tokens taken from the Gym Scan iOS prototype.
class AppColors {
  const AppColors._();

  static const Color background = Color(0xFF01060A);
  static const Color surface = Color(0xFF010508);
  static const Color textPrimary = Color(0xFFFFFFFF);
  static const Color textMuted = Color(0xFF7B8188);
  static const Color accent = Color(0xFF00CAB2);
  static const Color info = Color(0xFF00AAE2);
  static const Color success = Color(0xFF00C260);
  static const Color danger = Color(0xFFFB485B);

  /// Weak coverage, processing, and other "needs attention" states.
  static const Color warning = Color(0xFFFF7A1C);

  /// Mirror-wall tags.
  static const Color violet = Color(0xFF927DE5);

  /// The "indicative only" disclaimer glyph.
  static const Color caution = Color(0xFFFFCC00);

  /// Row separators inside grouped cards.
  static const Color divider = Color(0xFF393939);

  /// Floor-plan canvas: background, equipment blocks and their edges.
  static const Color planCanvas = Color(0xFF000E15);
  static const Color planBlock = Color(0xFF0C1D25);
  static const Color planBlockEdge = Color(0xFF1D444F);

  /// Walls the scan has not reached yet.
  static const Color notCaptured = Color(0xFF3E626C);

  /// Fill and edge of the small chips on the scanning screen.
  static const Color chipFill = Color(0xFF01242E);
  static const Color chipEdge = Color(0xFF3F6773);

  /// Unfilled track behind progress bars and rings.
  static const Color track = Color(0x1FFFFFFF);

  /// Avatar chip in the home header.
  static const Color avatarFill = Color(0xFF00232D);

  /// Disclosure chevrons on tappable rows.
  static const Color chevron = Color(0xFF3F6773);

  /// Deep teal used for field glyphs and checklist numbering.
  static const Color deepTeal = Color(0xFF02798D);

  /// Floating tab bar: translucent fill, plus the active item's pill.
  static const Color tabBarFill = Color(0xF0070D15);
  static const Color tabActiveFill = Color(0xFF06232D);

  /// Fill of the primary "New capture" card.
  static const List<Color> heroCardFill = <Color>[
    Color(0xFF011F26),
    Color(0xFF010508),
  ];

  /// Fill of the pending-upload banner.
  static const List<Color> uploadCardFill = <Color>[
    Color(0xFF071A1C),
    Color(0xFF0A2527),
  ];

  /// Hairline border used around inputs and info cards.
  static const List<Color> hairline = <Color>[
    Color(0xFF575F61),
    Color(0x99393939),
    Color(0xFF6F7E83),
  ];

  /// Hairline border used around the primary button.
  static const List<Color> primaryEdge = <Color>[
    Color(0xFF4B7B87),
    Color(0xFF01303B),
    Color(0xFF8DA8B2),
  ];

  /// Fill of the primary button.
  static const List<Color> primaryFill = <Color>[
    Color(0xFF012831),
    Color(0xFF01171D),
    Color(0xFF01080C),
  ];

  /// Hairline that fades from grey into [color], used on the status
  /// callouts (orange warnings, red rejection, green approval).
  static List<Color> edgeInto(Color color) => <Color>[
    const Color(0xFF6F7E83),
    color.withValues(alpha: 0.45),
    color,
  ];
}

class AppTheme {
  const AppTheme._();

  static ThemeData get dark {
    final ThemeData base = ThemeData.dark(useMaterial3: true);

    return base.copyWith(
      scaffoldBackgroundColor: AppColors.background,
      colorScheme: base.colorScheme.copyWith(
        surface: AppColors.background,
        primary: AppColors.accent,
        error: AppColors.danger,
      ),
      // Slide-in-from-right transitions on both platforms, matching iOS.
      pageTransitionsTheme: const PageTransitionsTheme(
        builders: <TargetPlatform, PageTransitionsBuilder>{
          TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
          TargetPlatform.android: CupertinoPageTransitionsBuilder(),
          TargetPlatform.macOS: CupertinoPageTransitionsBuilder(),
        },
      ),
      textSelectionTheme: const TextSelectionThemeData(
        cursorColor: AppColors.accent,
        selectionColor: Color(0x3300CAB2),
        selectionHandleColor: AppColors.accent,
      ),
      splashFactory: NoSplash.splashFactory,
      highlightColor: Colors.transparent,
    );
  }

  static const TextStyle title = TextStyle(
    fontSize: 26,
    fontWeight: FontWeight.w700,
    letterSpacing: -0.3,
    color: AppColors.textPrimary,
  );

  static const TextStyle body = TextStyle(
    fontSize: 14,
    height: 1.5,
    color: AppColors.textMuted,
  );

  static const TextStyle label = TextStyle(
    fontSize: 12.5,
    fontWeight: FontWeight.w500,
    color: AppColors.textMuted,
  );

  static const TextStyle caption = TextStyle(
    fontSize: 12.5,
    height: 1.44,
    color: AppColors.textMuted,
  );

  /// Screen title in the home header.
  static const TextStyle screenTitle = TextStyle(
    fontSize: 28,
    fontWeight: FontWeight.w700,
    letterSpacing: -0.5,
    color: AppColors.textPrimary,
  );

  /// "Recent plans" and friends.
  static const TextStyle sectionTitle = TextStyle(
    fontSize: 16,
    fontWeight: FontWeight.w600,
    color: AppColors.textPrimary,
  );

  /// Inline teal action such as "View all".
  static const TextStyle link = TextStyle(
    fontSize: 13,
    fontWeight: FontWeight.w500,
    color: AppColors.accent,
  );

  /// Large title on a pushed screen, e.g. "New capture".
  static const TextStyle largeTitle = TextStyle(
    fontSize: 30,
    fontWeight: FontWeight.w700,
    letterSpacing: -0.6,
    color: AppColors.textPrimary,
  );

  /// Uppercase field label above a form control.
  static const TextStyle fieldLabel = TextStyle(
    fontSize: 12.5,
    fontWeight: FontWeight.w600,
    letterSpacing: 0.3,
    color: AppColors.textMuted,
  );

  /// Value shown inside a form control.
  static const TextStyle fieldValue = TextStyle(
    fontSize: 17,
    fontWeight: FontWeight.w600,
    color: AppColors.textPrimary,
  );

  /// Title on a detail screen, e.g. "Review before submit".
  static const TextStyle detailTitle = TextStyle(
    fontSize: 27,
    fontWeight: FontWeight.w700,
    letterSpacing: -0.5,
    color: AppColors.textPrimary,
  );

  /// Subtitle under [detailTitle].
  static const TextStyle detailSubtitle = TextStyle(
    fontSize: 13.5,
    color: AppColors.textMuted,
  );

  /// Small uppercase heading above a grouped card, e.g. "ACCOUNT".
  static const TextStyle groupLabel = TextStyle(
    fontSize: 11.5,
    fontWeight: FontWeight.w600,
    letterSpacing: 0.4,
    color: AppColors.textMuted,
  );

  /// Fine print under a card, e.g. the photo privacy note.
  static const TextStyle footnote = TextStyle(
    fontSize: 11.5,
    height: 1.48,
    color: AppColors.textMuted,
  );

  /// Nav bar action, e.g. "Home" / "Cancel".
  static const TextStyle navAction = TextStyle(
    fontSize: 16,
    fontWeight: FontWeight.w500,
  );

  /// The CSS `linear-gradient(160deg, ...)` used by the home cards.
  static LinearGradient card160(List<Color> colors) => LinearGradient(
    begin: const Alignment(-0.34, -1),
    end: const Alignment(0.34, 1),
    colors: colors,
  );
}
