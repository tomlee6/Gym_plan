import 'package:flutter/material.dart';

import '../services/upload_queue.dart';
import '../theme/app_theme.dart';
import '../widgets/detail_widgets.dart';
import '../widgets/gym_tab_bar.dart';
import '../widgets/hairline_container.dart';
import '../widgets/nav_bar.dart';
import '../widgets/primary_button.dart';
import 'new_capture_screen.dart';
import 'tab_navigation.dart';

/// Background upload progress for the capture that was just submitted, and
/// the "Uploads" tab.
class UploadingScreen extends StatefulWidget {
  const UploadingScreen({super.key, this.queue});

  /// Defaults to [UploadQueue.instance].
  final UploadQueue? queue;

  @override
  State<UploadingScreen> createState() => _UploadingScreenState();
}

class _UploadingScreenState extends State<UploadingScreen> {
  late final UploadQueue _queue = widget.queue ?? UploadQueue.instance;

  void _goHome() =>
      Navigator.of(context).popUntil((Route<dynamic> route) => route.isFirst);

  void _startNextLevel(UploadJob job) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => NewCaptureScreen(
          initialFacility: job.facility,
          initialLevel: '${job.level + 1}',
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
              child: NavBar(backLabel: 'Home', onBack: _goHome),
            ),
            Expanded(
              child: ListenableBuilder(
                listenable: _queue,
                builder: (BuildContext context, Widget? _) {
                  final UploadJob? job = _queue.active;
                  return job == null ? _buildEmpty() : _buildJob(job);
                },
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildEmpty() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(32, 0, 32, 40),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          const Icon(
            Icons.cloud_done_outlined,
            size: 44,
            color: AppColors.accent,
          ),
          const SizedBox(height: 16),
          const Text(
            'Nothing waiting to upload',
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 20,
              fontWeight: FontWeight.w700,
              color: AppColors.textPrimary,
            ),
          ),
          const SizedBox(height: 8),
          const Text(
            'Captures appear here after you submit them.',
            textAlign: TextAlign.center,
            style: AppTheme.body,
          ),
          const SizedBox(height: 24),
          PrimaryButton(
            label: 'See all my plans',
            onPressed: () =>
                openTab(context, GymTab.plans, from: GymTab.uploads),
          ),
        ],
      ),
    );
  }

  Widget _buildJob(UploadJob job) {
    final bool done = job.complete;

    return Column(
      children: <Widget>[
        Expanded(
          child: SingleChildScrollView(
            physics: const BouncingScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(20, 20, 20, 16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                Center(
                  child: ProgressRing(progress: job.progress, complete: done),
                ),
                const SizedBox(height: 22),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  child: Column(
                    children: <Widget>[
                      Text(
                        done
                            ? 'Upload complete'
                            : 'Uploading in the background',
                        textAlign: TextAlign.center,
                        style: const TextStyle(
                          fontSize: 23,
                          fontWeight: FontWeight.w700,
                          letterSpacing: -0.3,
                          color: AppColors.textPrimary,
                        ),
                      ),
                      const SizedBox(height: 10),
                      Text(
                        done
                            ? 'The capture arrived and has been removed from '
                                  'this iPhone. A reviewer picks it up next.'
                            : 'You can close the app or lose signal. The '
                                  'upload picks up where it stopped — you do '
                                  'not need to stand here.',
                        textAlign: TextAlign.center,
                        style: AppTheme.body,
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 26),
                InfoRowsCard(
                  rowHeight: 48,
                  rows: <InfoRow>[
                    InfoRow('Capture', job.title),
                    InfoRow(
                      'Size',
                      done
                          ? '${job.totalMb.round()} MB'
                          : '${job.sentMb.round()} MB of '
                                '${job.totalMb.round()} MB',
                    ),
                    if (!done)
                      InfoRow(
                        'Status',
                        job.status.label,
                        dotColor: job.status.color,
                      ),
                    InfoRow(
                      'Resumed',
                      job.resumes == 1 ? '1 time' : '${job.resumes} times',
                    ),
                  ],
                ),
                if (job.error != null) ...<Widget>[
                  const SizedBox(height: 16),
                  StatusCallout(
                    color: AppColors.danger,
                    icon: Icons.error_outline_rounded,
                    title: 'Upload stopped',
                    subtitle: job.error!,
                  ),
                ],
                const SizedBox(height: 16),
                HairlineContainer(
                  radius: 17,
                  fillGradient: AppTheme.card160(AppColors.uploadCardFill),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 16,
                    vertical: 15,
                  ),
                  child: const Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Padding(
                        padding: EdgeInsets.only(top: 1),
                        child: Icon(
                          Icons.shield_outlined,
                          size: 18,
                          color: AppColors.accent,
                        ),
                      ),
                      SizedBox(width: 12),
                      Expanded(
                        child: Text(
                          'The capture stays on this iPhone until the '
                          'platform confirms it arrived, then it is deleted '
                          'from the device.',
                          style: AppTheme.caption,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 4, 20, 20),
          child: Column(
            children: <Widget>[
              // A stopped upload needs the user; everything else carries on
              // by itself.
              if (job.error != null)
                PrimaryButton(
                  label: 'Try again',
                  icon: Icons.refresh_rounded,
                  onPressed: _queue.retry,
                )
              else
                PrimaryButton(
                  label: 'See all my plans',
                  onPressed: () =>
                      openTab(context, GymTab.plans, from: GymTab.uploads),
                ),
              const SizedBox(height: 8),
              SecondaryAction(
                label: 'Start the next level',
                onTap: () => _startNextLevel(job),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
