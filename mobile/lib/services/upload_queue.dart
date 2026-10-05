import 'dart:ui' show Color;

import 'package:flutter/foundation.dart';

import '../models/scan.dart';
import '../theme/app_theme.dart';

/// What the upload is doing right now, as shown on the upload screen.
enum UploadStatus {
  preparing(label: 'Preparing files', color: AppColors.accent),
  uploading(label: 'Uploading', color: AppColors.success),
  waitingForNetwork(label: 'Waiting for signal', color: AppColors.warning),
  waitingForWifi(label: 'Waiting for Wi-Fi', color: AppColors.warning),
  confirming(label: 'Confirming receipt', color: AppColors.accent),
  failed(label: 'Upload stopped', color: AppColors.danger),
  done(label: 'Received', color: AppColors.success);

  const UploadStatus({required this.label, required this.color});

  final String label;
  final Color color;
}

/// One capture on its way to the platform, as the screens see it.
class UploadJob {
  UploadJob({
    required this.id,
    required this.title,
    required this.facility,
    required this.level,
    required this.totalMb,
    this.sentMb = 0,
    this.resumes = 0,
    this.status = UploadStatus.uploading,
    this.error,
    this.received = false,
  });

  final String id;

  /// "Northgate · Level 2".
  final String title;

  /// Where the capture was taken, so "Start the next level" can prefill.
  final String facility;
  final int level;
  final double totalMb;
  double sentMb;

  /// How many times the upload picked up again after losing signal.
  int resumes;
  UploadStatus status;

  /// Why the upload stopped, when it has.
  String? error;

  /// Set once the platform has confirmed it holds the capture. Until then
  /// the capture must stay on the device, even if every byte has been sent.
  bool received;

  double get progress =>
      totalMb <= 0 ? 1 : (sentMb / totalMb).clamp(0, 1).toDouble();
  int get percent => (progress * 100).floor();
  bool get complete => received;
}

/// The captures waiting to reach the platform. The app's queue is
/// `BackgroundUploadQueue`, which sends files with iOS background transfers.
abstract class UploadQueue extends ChangeNotifier {
  /// The queue the app uses, created at start-up in `main.dart`.
  static late UploadQueue instance;

  /// The capture to show on the upload screen: the oldest one still
  /// uploading, otherwise the most recent. Null when nothing was queued.
  UploadJob? get active;

  /// Captures still held on the device.
  int get pendingCount;

  /// Queues a finished scan for upload.
  Future<void> enqueue(ScanResult result, {ScanExport? export});

  /// Tries a stopped upload again now, rather than waiting for the next
  /// automatic retry.
  Future<void> retry();

  /// Mirrors the "Upload on mobile data" setting.
  Future<void> setUploadOnMobileData(bool allowed);
}
