import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:room_scan/room_scan.dart';

/// Recording a 360 degree walk round one machine.
///
/// Two implementations, the same split the room scan already makes:
/// [CameraRecording] records a real video on an iPhone, and
/// [SimulatedRecording] runs a demo walk so the flow can be worked through
/// on a device with no camera for it — an Android phone, a simulator, a
/// desktop. The screen treats them the same.
abstract class EquipmentRecording {
  /// Readies whatever this will record with.
  Future<void> prepare();

  Future<void> start(String equipmentId);

  /// Ends the take and returns it.
  Future<EquipmentVideo> stop();

  Future<void> discard(EquipmentVideo video);

  Future<void> dispose();

  /// What fills the screen while recording: a viewfinder, or the demo walk.
  Widget preview({required bool recording, required Duration elapsed});

  /// Which way the camera points while recording, for the coverage ring
  /// (I-06). Empty when there is no motion data: the demo walk animates
  /// its own progress instead.
  Stream<RecorderMotion> motion();
}

/// The real thing: AVFoundation on an iPhone, through `room_scan`.
class CameraRecording implements EquipmentRecording {
  const CameraRecording();

  @override
  Future<void> prepare() => EquipmentRecorder.prepare();

  @override
  Future<void> start(String equipmentId) =>
      EquipmentRecorder.start(equipmentId);

  @override
  Future<EquipmentVideo> stop() => EquipmentRecorder.stop();

  @override
  Future<void> discard(EquipmentVideo video) =>
      EquipmentRecorder.discard(video);

  @override
  Future<void> dispose() => EquipmentRecorder.dispose();

  @override
  Widget preview({required bool recording, required Duration elapsed}) =>
      const EquipmentVideoPreview();

  @override
  Stream<RecorderMotion> motion() => EquipmentRecorder.motion();
}

/// A demo walk round a machine, for a device that cannot record one.
///
/// It produces an [EquipmentVideo] marked `simulated`, carrying no file.
/// Nothing is uploaded for it: a fabricated video in front of a reviewer
/// would be worse than none at all, the same reason a simulated scan
/// uploads no model. What it does do is let the whole capture flow —
/// marking machines, finishing the step, submitting — be worked through
/// without an iPhone.
class SimulatedRecording implements EquipmentRecording {
  SimulatedRecording({this.walk = const Duration(seconds: 12)});

  /// How long a full lap of the machine takes.
  final Duration walk;

  @override
  Future<void> prepare() async {}

  @override
  Future<void> start(String equipmentId) async {}

  @override
  Future<EquipmentVideo> stop() async => EquipmentVideo(
    equipmentId: '',
    path: '',
    thumbnailPath: null,
    bytes: 0,
    duration: Duration.zero,
    contentType: 'video/quicktime',
    simulated: true,
  );

  @override
  Future<void> discard(EquipmentVideo video) async {}

  @override
  Future<void> dispose() async {}

  @override
  Stream<RecorderMotion> motion() => const Stream<RecorderMotion>.empty();

  @override
  Widget preview({required bool recording, required Duration elapsed}) =>
      EquipmentWalkAnimation(
        recording: recording,
        progress: walk.inMilliseconds == 0
            ? 0
            : (elapsed.inMilliseconds / walk.inMilliseconds).clamp(0.0, 1.0),
      );
}

/// Decides whether a walkaround is recorded for real or simulated.
///
/// The same rule the room scan uses: a real capture where the hardware
/// allows it, a demo walk in debug builds anywhere else, and a refusal in
/// release builds — a made-up walkaround would be worthless to a reviewer.
class EquipmentCaptureBackend {
  const EquipmentCaptureBackend._();

  static bool _usesCamera = false;

  /// Whether [create] will record a real video. Settled by [detect].
  static bool get usesCamera => _usesCamera;

  /// Why this device cannot record, or null when it can.
  static Future<String?> detect() async {
    _usesCamera = false;
    if (!kIsWeb && defaultTargetPlatform == TargetPlatform.iOS) {
      _usesCamera = true;
      return null;
    }
    if (kDebugMode) return null;
    return 'Recording equipment video needs an iPhone or iPad.';
  }

  /// Replaces what [create] returns, so a widget test can drive the record
  /// screen with its own motion samples.
  @visibleForTesting
  static EquipmentRecording Function()? debugCreate;

  static EquipmentRecording create() =>
      debugCreate?.call() ??
      (_usesCamera ? const CameraRecording() : SimulatedRecording());
}

/// The demo walk: a camera going once round a machine, seen from above.
///
/// It stands in for the viewfinder on a device that cannot record, the way
/// the scanning screen's floor plan stands in for a LiDAR scan.
class EquipmentWalkAnimation extends StatelessWidget {
  const EquipmentWalkAnimation({
    super.key,
    required this.recording,
    required this.progress,
  });

  final bool recording;

  /// 0–1 of the way round the machine.
  final double progress;

  @override
  Widget build(BuildContext context) => AspectRatio(
    aspectRatio: 3 / 4,
    child: CustomPaint(
      painter: _WalkPainter(recording: recording, progress: progress),
      child: Center(
        child: Text(
          recording
              ? '${(progress * 100).round()}% around'
              : 'Simulated walkaround',
          style: TextStyle(
            color: recording
                ? const Color(0xFF00CAB2)
                : const Color(0xFF7B8188),
            fontWeight: FontWeight.w600,
          ),
        ),
      ),
    ),
  );
}

class _WalkPainter extends CustomPainter {
  const _WalkPainter({required this.recording, required this.progress});

  final bool recording;
  final double progress;

  @override
  void paint(Canvas canvas, Size size) {
    final Offset centre = Offset(size.width / 2, size.height / 2);
    final double radius = size.shortestSide * 0.32;

    // The machine, seen from above.
    final Rect machine = Rect.fromCenter(
      center: centre,
      width: radius * 0.9,
      height: radius * 1.5,
    );
    canvas.drawRRect(
      RRect.fromRectAndRadius(machine, const Radius.circular(6)),
      Paint()..color = const Color(0xFF0C1D25),
    );
    canvas.drawRRect(
      RRect.fromRectAndRadius(machine, const Radius.circular(6)),
      Paint()
        ..color = const Color(0xFF1D444F)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.5,
    );

    // The path round it, and how much of it has been walked.
    final Rect orbit = Rect.fromCircle(center: centre, radius: radius);
    canvas.drawCircle(
      centre,
      radius,
      Paint()
        ..color = const Color(0x1FFFFFFF)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2,
    );
    if (progress > 0) {
      canvas.drawArc(
        orbit,
        -math.pi / 2,
        2 * math.pi * progress,
        false,
        Paint()
          ..color = const Color(0xFF00CAB2)
          ..style = PaintingStyle.stroke
          ..strokeWidth = 3
          ..strokeCap = StrokeCap.round,
      );
    }

    // Where the camera is now.
    final double angle = -math.pi / 2 + 2 * math.pi * progress;
    final Offset at =
        centre + Offset(radius * math.cos(angle), radius * math.sin(angle));
    canvas.drawCircle(at, 7, Paint()..color = const Color(0xFF00CAB2));
  }

  @override
  bool shouldRepaint(_WalkPainter old) =>
      old.progress != progress || old.recording != recording;
}
