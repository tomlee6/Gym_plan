import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/plan.dart';
import 'package:url_launcher/url_launcher.dart';

import '../services/api_client.dart';
import '../services/plans_service.dart';
import '../theme/app_theme.dart';
import '../widgets/app_toast.dart';
import '../widgets/detail_widgets.dart';
import '../widgets/hairline_container.dart';
import '../widgets/nav_bar.dart';
import '../widgets/pressable.dart';
import '../widgets/primary_button.dart';

/// An approved plan with its generated walkthrough.
class PlanReadyScreen extends StatefulWidget {
  const PlanReadyScreen({super.key, required this.plan});

  final Plan plan;

  @override
  State<PlanReadyScreen> createState() => _PlanReadyScreenState();
}

class _PlanReadyScreenState extends State<PlanReadyScreen> {
  final PlansService _service = PlansService();

  PlanReadyDetail? _detail;
  String? _error;
  String? _shareLink;
  bool _sharing = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final PlanReadyDetail detail = await _service.readyDetail(widget.plan);
      if (!mounted) return;
      setState(() {
        _detail = detail;
        _shareLink = detail.shareLink;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  /// Creates the share link on first use, then copies it.
  Future<void> _share() async {
    if (_sharing) return;
    setState(() => _sharing = true);
    try {
      final String link =
          _shareLink ?? await _service.createShareLink(widget.plan);
      await Clipboard.setData(ClipboardData(text: link));
      if (!mounted) return;
      setState(() => _shareLink = link);
      showAppToast(context, 'Share link copied.');
    } on ApiException catch (e) {
      if (mounted) showAppToast(context, e.message);
    } finally {
      if (mounted) setState(() => _sharing = false);
    }
  }

  Future<void> _openWalkthrough(String url) async {
    final bool opened = await launchUrl(
      Uri.parse(url),
      mode: LaunchMode.externalApplication,
    );
    if (!opened && mounted) {
      showAppToast(context, 'Could not open the walkthrough.');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: Column(
          children: <Widget>[
            Padding(
              padding: const EdgeInsets.only(left: 8, right: 12),
              child: NavBar(
                backLabel: 'Plans',
                onBack: () => Navigator.of(context).maybePop(),
                trailing: _detail == null
                    ? null
                    : Pressable(
                        onTap: _share,
                        haptic: HapticImpact.selection,
                        semanticLabel: 'Share this walkthrough',
                        child: SizedBox(
                          width: 44,
                          height: 44,
                          child: _sharing
                              ? const CupertinoActivityIndicator(
                                  color: AppColors.accent,
                                  radius: 9,
                                )
                              : const Icon(
                                  CupertinoIcons.share,
                                  size: 21,
                                  color: AppColors.accent,
                                ),
                        ),
                      ),
              ),
            ),
            Expanded(
              child: _error != null
                  ? ErrorView(message: _error!, onRetry: _load)
                  : _detail == null
                  ? const LoadingView()
                  : _buildContent(_detail!),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildContent(PlanReadyDetail d) {
    return Column(
      children: <Widget>[
        Expanded(
          child: SingleChildScrollView(
            physics: const BouncingScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(20, 6, 20, 16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                DetailHeader(
                  title: d.plan.site,
                  subtitle:
                      '${d.plan.level} · '
                      '${d.areaM2 == null ? '' : '${d.areaM2} m² · '}'
                      'version ${d.version}',
                ),
                const SizedBox(height: 16),
                _buildPreview(),
                const SizedBox(height: 16),
                StatusCallout(
                  color: AppColors.success,
                  icon: Icons.check_rounded,
                  title: 'Approved and generated',
                  subtitle: d.approvedBy == null
                      ? 'Approved'
                      : '${d.approvedBy!.name} · ${d.approvedBy!.at}',
                ),
                const SizedBox(height: 14),
                InfoRowsCard(
                  rows: <InfoRow>[
                    InfoRow('Version', d.versionLabel),
                    if (d.reviewerTime != null)
                      InfoRow('Reviewer time', d.reviewerTime!),
                    InfoRow(
                      'Share link',
                      _shareLink == null ? 'Not created' : 'Copied',
                      valueColor: AppColors.accent,
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 4, 20, 20),
          child: Column(
            children: <Widget>[
              PrimaryButton(
                label: 'Open walkthrough in Safari',
                icon: Icons.open_in_new_rounded,
                // Approved but not generated yet: nothing to open.
                onPressed: d.walkthroughUrl == null
                    ? null
                    : () => _openWalkthrough(d.walkthroughUrl!),
              ),
              const SizedBox(height: 11),
              Text(
                d.walkthroughUrl == null
                    ? 'The walkthrough is still being generated.'
                    : 'Opens on this iPhone, a laptop or an iPad. Nothing to '
                          'install.',
                textAlign: TextAlign.center,
                style: AppTheme.footnote,
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildPreview() {
    return HairlineContainer(
      radius: 21,
      fillColor: AppColors.planCanvas,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Semantics(
              image: true,
              label: 'Preview of the generated walkthrough',
              child: const AspectRatio(
                aspectRatio: 349 / 196,
                child: CustomPaint(painter: _WalkthroughPreviewPainter()),
              ),
            ),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
              decoration: const BoxDecoration(
                color: Color(0xE601060A),
                border: Border(top: BorderSide(color: AppColors.divider)),
              ),
              child: const Row(
                children: <Widget>[
                  Icon(
                    Icons.info_outline_rounded,
                    size: 15,
                    color: AppColors.caution,
                  ),
                  SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'Indicative only. This is not a certified drawing.',
                      style: TextStyle(
                        fontSize: 11,
                        height: 1.36,
                        color: AppColors.textMuted,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// One-point-perspective sketch of the generated room, standing in for the
/// walkthrough's first frame until the real thumbnail is available.
class _WalkthroughPreviewPainter extends CustomPainter {
  const _WalkthroughPreviewPainter();

  @override
  void paint(Canvas canvas, Size size) {
    canvas.save();
    canvas.scale(size.width / 349, size.height / 196);

    Path poly(List<Offset> points) => Path()..addPolygon(points, true);

    void shape(List<Offset> points, Color fill, Color edge, [double w = 1.5]) {
      final Path p = poly(points);
      canvas.drawPath(p, Paint()..color = fill);
      canvas.drawPath(
        p,
        Paint()
          ..color = edge
          ..style = PaintingStyle.stroke
          ..strokeWidth = w,
      );
    }

    canvas.drawRect(
      const Rect.fromLTWH(0, 0, 349, 196),
      Paint()..color = AppColors.background,
    );
    // Floor.
    canvas.drawRect(
      const Rect.fromLTWH(0, 132, 349, 64),
      Paint()..color = const Color(0xFF050E12),
    );

    const Color sideWall = Color(0xFF071A1C);
    const Color backWall = Color(0xFF0A2527);

    // Left, right and back walls.
    shape(
      const <Offset>[
        Offset(52, 44),
        Offset(142, 62),
        Offset(142, 150),
        Offset(52, 176),
      ],
      sideWall,
      AppColors.planBlockEdge,
    );
    shape(
      const <Offset>[
        Offset(297, 44),
        Offset(207, 62),
        Offset(207, 150),
        Offset(297, 176),
      ],
      sideWall,
      AppColors.planBlockEdge,
    );
    shape(
      const <Offset>[
        Offset(142, 62),
        Offset(207, 62),
        Offset(207, 150),
        Offset(142, 150),
      ],
      backWall,
      AppColors.planBlockEdge,
    );

    // Ceiling line.
    canvas.drawPath(
      Path()
        ..moveTo(52, 44)
        ..lineTo(142, 62)
        ..lineTo(207, 62)
        ..lineTo(297, 44),
      Paint()
        ..color = AppColors.notCaptured
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.5,
    );

    // Doorway in the back wall.
    shape(
      const <Offset>[
        Offset(156, 104),
        Offset(193, 104),
        Offset(193, 150),
        Offset(156, 150),
      ],
      AppColors.planBlock,
      AppColors.chipEdge,
      1,
    );

    // Mirror wall on the left, glass panel on the right.
    shape(
      const <Offset>[
        Offset(100, 96),
        Offset(128, 102),
        Offset(128, 140),
        Offset(100, 148),
      ],
      AppColors.violet.withValues(alpha: 0.22),
      AppColors.violet,
    );
    shape(
      const <Offset>[
        Offset(221, 102),
        Offset(249, 96),
        Offset(249, 148),
        Offset(221, 140),
      ],
      AppColors.accent.withValues(alpha: 0.10),
      AppColors.deepTeal,
    );

    // Viewer position.
    canvas.drawCircle(
      const Offset(174, 176),
      4,
      Paint()..color = AppColors.accent,
    );

    canvas.restore();
  }

  @override
  bool shouldRepaint(_WalkthroughPreviewPainter oldDelegate) => false;
}
