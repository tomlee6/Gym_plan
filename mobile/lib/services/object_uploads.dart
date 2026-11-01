import 'dart:io';

import 'api_client.dart';
import 'scan_library.dart';

/// Sends 3D Objects to the platform (`backend/src/modules/objects.js`).
///
/// An object scan is one USDZ, outside any capture: no plan, no review. It
/// goes up through the platform's chunked, signed-URL upload, the same as
/// a capture's files, so the bytes only ever go to a URL the platform
/// handed out.
abstract class ObjectUploads {
  /// The uploads the app uses. Tests replace it.
  static ObjectUploads instance = PlatformObjectUploads();

  /// Sends [scan]'s model and returns the platform's id for it. Sending the
  /// same scan again finds the same object rather than making another.
  Future<String> send(SavedScan scan);
}

class PlatformObjectUploads implements ObjectUploads {
  PlatformObjectUploads({ApiClient? client, HttpClient? http})
    : _client = client,
      _http = http ?? HttpClient();

  final ApiClient? _client;
  final HttpClient _http;

  ApiClient get _api => _client ?? ApiClient.instance;

  /// Parts of 8 MiB, as the capture upload uses.
  static const int partSize = 8 * 1024 * 1024;

  @override
  Future<String> send(SavedScan scan) async {
    final String? path = scan.modelPath;
    final File? file = path == null ? null : File(path);
    if (file == null || !file.existsSync()) {
      throw ApiException('The 3D model is no longer on this phone.');
    }
    final int bytes = await file.length();

    final Map<String, Object?> opened = await _api.post(
      '/v1/objects',
      <String, Object?>{
        'name': scan.title,
        'bytes': bytes,
        'contentType': 'model/vnd.usdz+zip',
        'partSize': partSize,
        'photoCount': ?scan.photos,
        'scannedAt': scan.createdAt.toUtc().toIso8601String(),
      },
      // The scan's own id, so a retry after a lost answer is the same object.
      <String, String>{'Idempotency-Key': 'object-${scan.id}'},
    );
    final String id = opened['objectId']! as String;
    if (opened['status'] == 'ready') return id;

    final Map<String, Object?> target = opened['file']! as Map<String, Object?>;
    for (final Object? p in target['parts']! as List<Object?>) {
      final Map<String, Object?> part = p! as Map<String, Object?>;
      final int start = ((part['number']! as num).toInt() - 1) * partSize;
      await _put(
        part['url']! as String,
        await _slice(file, start, start + partSize),
      );
    }

    final Map<String, Object?> done = await _api.post(
      '/v1/objects/$id/complete',
      const <String, Object?>{},
    );
    if (done['status'] != 'ready') {
      throw ApiException(
        'The upload did not finish. Check the connection and try again.',
      );
    }
    return id;
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
        'A part of the 3D model was refused (${response.statusCode}).',
      );
    }
  }
}
