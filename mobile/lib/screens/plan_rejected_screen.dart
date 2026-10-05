import 'package:flutter/material.dart';

import '../models/plan.dart';
import '../services/api_client.dart';
import '../services/plans_service.dart';
import '../theme/app_theme.dart';
import '../widgets/detail_widgets.dart';
import '../widgets/nav_bar.dart';
import '../widgets/primary_button.dart';
import 'new_capture_screen.dart';

/// A plan the reviewer sent back, with their reason and note.
class PlanRejectedScreen extends StatefulWidget {
  const PlanRejectedScreen({super.key, required this.plan});

  final Plan plan;

  @override
  State<PlanRejectedScreen> createState() => _PlanRejectedScreenState();
}

class _PlanRejectedScreenState extends State<PlanRejectedScreen> {
  final PlansService _service = PlansService();

  PlanRejection? _rejection;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final PlanRejection rejection = await _service.rejection(widget.plan);
      if (!mounted) return;
      setState(() => _rejection = rejection);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  void _startRecapture() {
    // Replace this screen: after recapturing, "back" should not land on the
    // stale rejection.
    Navigator.of(context).pushReplacement(
      MaterialPageRoute<void>(
        builder: (_) => NewCaptureScreen(
          initialFacility: widget.plan.site,
          initialLevel: '${widget.plan.levelNumber}',
        ),
      ),
    );
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
              ),
            ),
            Expanded(
              child: _error != null
                  ? ErrorView(message: _error!, onRetry: _load)
                  : _rejection == null
                  ? const LoadingView()
                  : _buildContent(_rejection!),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildContent(PlanRejection r) {
    final String level = r.plan.levelNumber == 0
        ? 'Ground floor'
        : r.plan.level;

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
                  title: r.plan.site,
                  subtitle: '$level · submitted ${r.submittedAt}',
                ),
                const SizedBox(height: 18),
                StatusCallout(
                  large: true,
                  color: AppColors.danger,
                  icon: Icons.warning_amber_rounded,
                  title: 'Needs recapture',
                  subtitle: 'No 3D model was generated',
                  child: _buildReviewerNote(r),
                ),
                const SizedBox(height: 16),
                InfoRowsCard(
                  rows: <InfoRow>[
                    InfoRow('Submitted', r.submittedAt),
                    InfoRow(
                      'Coverage at submit',
                      r.coverageAtSubmit == null
                          ? '—'
                          : '${r.coverageAtSubmit} per cent',
                      valueColor: (r.coverageAtSubmit ?? 100) < 90
                          ? AppColors.warning
                          : null,
                    ),
                    InfoRow(
                      'Your override',
                      r.overrideRecorded ? 'Recorded' : 'None',
                    ),
                  ],
                ),
                const SizedBox(height: 14),
                const Text(
                  'A recapture starts a new version. The rejected version '
                  'stays in the history and is never edited.',
                  style: AppTheme.footnote,
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
                label: 'Start recapture',
                icon: Icons.replay_rounded,
                onPressed: _startRecapture,
              ),
              const SizedBox(height: 8),
              SecondaryAction(
                label: 'Back to plans',
                onTap: () => Navigator.of(context).maybePop(),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildReviewerNote(PlanRejection r) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        const Text('REASON', style: AppTheme.groupLabel),
        const SizedBox(height: 8),
        Container(
          height: 28,
          padding: const EdgeInsets.symmetric(horizontal: 12),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: AppColors.danger.withValues(alpha: 0.15),
            borderRadius: BorderRadius.circular(14),
          ),
          child: Text(
            r.reason,
            style: const TextStyle(
              fontSize: 12.5,
              fontWeight: FontWeight.w600,
              color: AppColors.danger,
            ),
          ),
        ),
        const SizedBox(height: 16),
        const Text('NOTE FROM THE REVIEWER', style: AppTheme.groupLabel),
        const SizedBox(height: 8),
        Text(
          r.note,
          style: const TextStyle(
            fontSize: 13.5,
            height: 1.48,
            color: AppColors.textPrimary,
          ),
        ),
        if (r.reviewer != null) ...<Widget>[
          const SizedBox(height: 16),
          _buildReviewer(r),
        ],
      ],
    );
  }

  Widget _buildReviewer(PlanRejection r) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Row(
          children: <Widget>[
            Container(
              width: 30,
              height: 30,
              alignment: Alignment.center,
              decoration: const BoxDecoration(
                color: AppColors.avatarFill,
                shape: BoxShape.circle,
              ),
              child: Text(
                r.reviewer!.initials,
                style: const TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w600,
                  color: AppColors.accent,
                ),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                '${r.reviewer!.name} · ${r.reviewer!.at}',
                style: AppTheme.label,
              ),
            ),
          ],
        ),
      ],
    );
  }
}
