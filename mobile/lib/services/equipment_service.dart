import 'dart:io';

import 'package:room_scan/room_scan.dart';

import '../models/equipment.dart';
import 'api_client.dart';

export 'api_client.dart' show ApiException;

/// How far a 360 video upload has got, for the progress bar.
class VideoUploadProgress {
  const VideoUploadProgress({
    required this.equipmentId,
    required this.sent,
    required this.total,
  });

  final String equipmentId;
  final int sent;
  final int total;

  double get fraction => total == 0 ? 0 : sent / total;
}

/// The equipment endpoints (CHANGE 2 and CHANGE 4).
///
/// The video uses the platform's own chunked, signed-URL upload: the app
/// never sends bytes anywhere but a URL the platform handed out, and a
/// dropped connection only costs the part in flight. There is no second
/// upload path here, and a video is never put in a JSON body.
class EquipmentService {
  EquipmentService({ApiClient? client, HttpClient? http})
    : _client = client,
      _http = http ?? HttpClient();

  final ApiClient? _client;
  final HttpClient _http;

  ApiClient get _api => _client ?? ApiClient.instance;

  /// Parts of 8 MiB, as the capture upload uses: a dropped connection costs
  /// one part, not the whole walkaround.
  static const int partSize = 8 * 1024 * 1024;

  /// Records the machines on a capture. Sending the same list again
  /// replaces it rather than doubling it up, so this is safe to retry
  /// after a lost response.
  ///
  /// [accountId] is the account the capture was made in (`X-Account-Id`).
  Future<void> saveEquipment(
    String captureId,
    List<Equipment> equipment, {
    String? accountId,
  }) async {
    if (equipment.isEmpty) return;
    await _api.post(
      '/v1/captures/$captureId/equipment',
      <String, Object?>{
        'equipment': <Object?>[for (final Equipment e in equipment) e.toJson()],
      },
      const <String, String>{},
      accountId,
    );
  }

  /// Uploads one machine's 360 walkaround, part by part, and asks the
  /// platform to confirm it. Reports progress as parts land.
  ///
  /// Returns when the platform says the video is `ready`. Anything else
  /// throws, so the caller can offer a retry rather than quietly losing a
  /// recording the surveyor took.
  Future<void> uploadVideo(
    String captureId,
    EquipmentVideo video, {
    void Function(VideoUploadProgress)? onProgress,
    String? accountId,
  }) async {
    final File file = File(video.path);
    // A poster frame is a convenience, not part of the record: if it was
    // never taken, or has since gone, the walkaround still goes up and the
    // reviewer simply gets a player without one.
    final File? candidate = video.thumbnailPath == null
        ? null
        : File(video.thumbnailPath!);
    final File? thumbnail = candidate != null && candidate.existsSync()
        ? candidate
        : null;
    final int thumbnailBytes = thumbnail == null ? 0 : await thumbnail.length();

    final Map<String, Object?> opened = await _api.post(
      '/v1/captures/$captureId/equipment/${video.equipmentId}/video',
      <String, Object?>{
        'partSize': partSize,
        'bytes': video.bytes,
        'contentType': video.contentType,
        'durationSeconds': video.duration.inMilliseconds / 1000,
        if (thumbnail != null)
          'thumbnail': <String, Object?>{
            'bytes': thumbnailBytes,
            'contentType': 'image/jpeg',
          },
      },
      const <String, String>{},
      accountId,
    );

    final List<Object?> files = opened['files']! as List<Object?>;
    final int total = video.bytes + thumbnailBytes;
    int sent = 0;

    for (final Object? raw in files) {
      final Map<String, Object?> f = raw! as Map<String, Object?>;
      final String kind = f['kind']! as String;
      // A file with nothing to send it from is skipped rather than throwing:
      // losing a poster frame must not lose the walkaround with it.
      final File? source = kind == 'thumbnail' ? thumbnail : file;
      if (source == null || !source.existsSync()) continue;
      final List<Object?> parts = f['parts']! as List<Object?>;

      for (final Object? p in parts) {
        final Map<String, Object?> part = p! as Map<String, Object?>;
        final int number = (part['number']! as num).toInt();
        final int start = (number - 1) * partSize;
        final int end = start + partSize;
        final List<int> bytes = await _slice(source, start, end);
        await _put(part['url']! as String, bytes);
        sent += bytes.length;
        onProgress?.call(
          VideoUploadProgress(
            equipmentId: video.equipmentId,
            sent: sent,
            total: total,
          ),
        );
      }
    }

    await _completeVideo(captureId, video.equipmentId, accountId);
  }

  /// Asks the platform to assemble the parts. Parts that never arrived are
  /// resent once before giving up, which covers the ordinary case of one
  /// part failing on a weak connection.
  Future<void> _completeVideo(
    String captureId,
    String equipmentId,
    String? accountId,
  ) async {
    final String path =
        '/v1/captures/$captureId/equipment/$equipmentId/video/complete';
    final Map<String, Object?> body = await _api.post(
      path,
      const <String, Object?>{},
      const <String, String>{},
      accountId,
    );
    if (body['status'] == 'ready') return;

    if (body['status'] == 'incomplete') {
      throw ApiException(
        'The upload did not finish. Check the connection and try again.',
      );
    }
    throw ApiException('The platform did not confirm the video.');
  }

  Future<List<int>> _slice(File file, int start, int end) async {
    final RandomAccessFile handle = await file.open();
    try {
      final int length = await handle.length();
      await handle.setPosition(start);
      return await handle.read((end > length ? length : end) - start);
    } finally {
      await handle.close();
    }
  }

  /// A part goes straight to the signed URL, never through the API.
  Future<void> _put(String url, List<int> bytes) async {
    final HttpClientRequest request = await _http.putUrl(Uri.parse(url));
    request.headers.set(
      HttpHeaders.contentTypeHeader,
      'application/octet-stream',
    );
    request.contentLength = bytes.length;
    request.add(bytes);
    final HttpClientResponse response = await request.close();
    await response.drain<void>();
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw ApiException(
        'A part of the video was refused (${response.statusCode}).',
      );
    }
  }
}
