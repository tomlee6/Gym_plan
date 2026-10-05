import 'dart:async';

import 'package:background_downloader/background_downloader.dart';

/// One file part to PUT to a signed URL.
class PartUpload {
  const PartUpload({
    required this.taskId,
    required this.url,
    required this.directory,
    required this.filename,
    required this.group,
    required this.wifiOnly,
  });

  final String taskId;
  final String url;

  /// Relative to the app's Application Support directory. Absolute paths
  /// are avoided because iOS moves the app container between installs.
  final String directory;
  final String filename;

  /// Every part of one capture shares a group.
  final String group;
  final bool wifiOnly;
}

enum PartState { queued, running, retrying, done, failed }

sealed class PartEvent {
  const PartEvent(this.taskId);
  final String taskId;
}

class PartProgress extends PartEvent {
  const PartProgress(super.taskId, this.fraction);

  /// 0–1 of this part sent.
  final double fraction;
}

class PartStatusChange extends PartEvent {
  const PartStatusChange(
    super.taskId,
    this.state, {
    this.httpStatus,
    this.error,
  });

  final PartState state;
  final int? httpStatus;
  final String? error;
}

/// Sends parts in the background and reports on them.
abstract class PartTransport {
  Stream<PartEvent> get events;

  /// Replays anything that happened while the app was suspended or closed.
  /// Call once, after subscribing to [events].
  Future<void> start();

  Future<void> enqueue(List<PartUpload> parts);

  /// Parts still queued, running or waiting to retry.
  Future<Set<String>> activeTaskIds(String group);

  Future<void> cancelGroup(String group);

  Future<void> setWifiOnly(bool wifiOnly);
}

/// iOS background URLSession (and Android WorkManager) transfers, via the
/// `background_downloader` package. Transfers carry on while the app is
/// suspended, and the system retries them when signal returns.
class BackgroundTransferTransport implements PartTransport {
  BackgroundTransferTransport({FileDownloader? downloader})
    : _downloader = downloader ?? FileDownloader();

  final FileDownloader _downloader;
  final StreamController<PartEvent> _events =
      StreamController<PartEvent>.broadcast();
  StreamSubscription<TaskUpdate>? _updates;

  /// Retries per part before the queue has to step in, e.g. to refresh an
  /// expired URL. The system adds exponential backoff between attempts.
  static const int _retries = 6;

  @override
  Stream<PartEvent> get events => _events.stream;

  @override
  Future<void> start() async {
    _updates ??= _downloader.updates.listen(_forward);
    // Tracks tasks in the package's own database and replays updates missed
    // while suspended. Its own rescheduling of killed tasks is off: iOS
    // drops every transfer when the app is swiped away, and the queue's
    // restore re-sends whatever is neither done nor in flight. Doing both
    // could queue a part twice.
    await _downloader.start(doRescheduleKilledTasks: false);
  }

  void _forward(TaskUpdate update) {
    switch (update) {
      case TaskProgressUpdate(:final Task task, :final double progress):
        // Negative values are the package's status markers, not progress.
        if (progress >= 0) _events.add(PartProgress(task.taskId, progress));
      case TaskStatusUpdate(
        :final Task task,
        :final TaskStatus status,
        :final int? responseStatusCode,
        :final TaskException? exception,
      ):
        _events.add(
          PartStatusChange(
            task.taskId,
            switch (status) {
              TaskStatus.enqueued => PartState.queued,
              TaskStatus.running => PartState.running,
              TaskStatus.waitingToRetry => PartState.retrying,
              TaskStatus.paused => PartState.retrying,
              TaskStatus.complete => PartState.done,
              TaskStatus.notFound ||
              TaskStatus.failed ||
              TaskStatus.canceled => PartState.failed,
            },
            httpStatus:
                responseStatusCode ??
                (exception is TaskHttpException
                    ? exception.httpResponseCode
                    : null),
            error: exception?.description,
          ),
        );
    }
  }

  @override
  Future<void> enqueue(List<PartUpload> parts) async {
    await _downloader.enqueueAll(<Task>[
      for (final PartUpload p in parts)
        UploadTask(
          taskId: p.taskId,
          url: p.url,
          baseDirectory: BaseDirectory.applicationSupport,
          directory: p.directory,
          filename: p.filename,
          httpRequestMethod: 'PUT',
          post: 'binary',
          mimeType: 'application/octet-stream',
          // An empty value stops the package adding its own
          // Content-Disposition, which a signed URL would not expect.
          headers: const <String, String>{'Content-Disposition': ''},
          group: p.group,
          updates: Updates.statusAndProgress,
          requiresWiFi: p.wifiOnly,
          retries: _retries,
        ),
    ]);
  }

  @override
  Future<Set<String>> activeTaskIds(String group) async =>
      (await _downloader.allTaskIds(group: group)).toSet();

  @override
  Future<void> cancelGroup(String group) async {
    await _downloader.cancelAll(group: group);
  }

  @override
  Future<void> setWifiOnly(bool wifiOnly) async {
    await _downloader.requireWiFi(
      wifiOnly ? RequireWiFi.forAllTasks : RequireWiFi.asSetByTask,
    );
  }
}
