import 'api_client.dart';

export 'api_client.dart' show ApiException;

/// Where to send one part of one file.
class PartTarget {
  const PartTarget({required this.number, required this.url});

  factory PartTarget.fromJson(Map<String, Object?> json) => PartTarget(
    number: (json['number']! as num).toInt(),
    url: json['url']! as String,
  );

  /// 1-based, as S3 multipart numbers them.
  final int number;

  /// Short-lived signed URL to PUT the part's bytes to.
  final String url;
}

/// The upload plan for one file: its id on the platform and its parts.
class FileTarget {
  const FileTarget({
    required this.name,
    required this.fileId,
    required this.parts,
  });

  factory FileTarget.fromJson(Map<String, Object?> json) => FileTarget(
    name: json['name']! as String,
    fileId: json['fileId']! as String,
    parts: <PartTarget>[
      for (final Object? p in json['parts']! as List<Object?>)
        PartTarget.fromJson(p! as Map<String, Object?>),
    ],
  );

  final String name;
  final String fileId;
  final List<PartTarget> parts;
}

/// A file the app wants to upload, as described to the platform.
class FileDescription {
  const FileDescription({
    required this.name,
    required this.kind,
    required this.bytes,
    required this.contentType,
  });

  final String name;

  /// `model`, `room` or `photo`.
  final String kind;
  final int bytes;
  final String contentType;

  Map<String, Object?> toJson() => <String, Object?>{
    'name': name,
    'kind': kind,
    'bytes': bytes,
    'contentType': contentType,
  };
}

/// The platform's answer to "do you have everything?".
class CompletionResult {
  const CompletionResult.received() : missing = const <String, List<int>>{};
  const CompletionResult.incomplete(this.missing);

  /// Parts the platform never got, by file id. Empty once received.
  final Map<String, List<int>> missing;

  bool get received => missing.isEmpty;
}

/// The capture upload endpoints of the Gym Plan backend. The contract is in
/// `docs/upload-api.md`; the server side is `backend/src/modules/captures.js`.
///
/// The app never talks to storage directly: the API hands out short-lived
/// signed URLs, and the platform confirms receipt before the app deletes
/// anything.
///
/// Every call takes the [accountId] the capture was made in and sends it as
/// `X-Account-Id`. It is stored with the capture rather than read from the
/// session, because the surveyor may switch accounts while an upload is
/// still waiting for signal. Null falls back to the session's current
/// account (captures queued by older builds).
class GymPlanApi {
  GymPlanApi({ApiClient? client}) : _client = client;

  final ApiClient? _client;

  ApiClient get _api => _client ?? ApiClient.instance;

  /// The session's current account, for a capture being queued now.
  String? get currentAccountId => _api.session.currentAccountId;

  /// Registers a capture and its metadata. Returns the capture id.
  ///
  /// [idempotencyKey] makes a retried call after a lost response return the
  /// same capture instead of creating a second one.
  Future<String> createCapture(
    Map<String, Object?> metadata, {
    required String idempotencyKey,
    String? accountId,
  }) async {
    final Map<String, Object?> body = await _api.post(
      '/v1/captures',
      metadata,
      <String, String>{'Idempotency-Key': idempotencyKey},
      accountId,
    );
    return body['captureId']! as String;
  }

  /// Opens a multipart upload for each file and returns a signed URL for
  /// every part.
  Future<List<FileTarget>> startUpload(
    String captureId, {
    required List<FileDescription> files,
    required int partSize,
    String? accountId,
  }) async {
    final Map<String, Object?> body = await _api.post(
      '/v1/captures/$captureId/uploads',
      <String, Object?>{
        'partSize': partSize,
        'files': <Object?>[for (final FileDescription f in files) f.toJson()],
      },
      const <String, String>{},
      accountId,
    );
    return _targets(body);
  }

  /// Issues fresh signed URLs for parts whose URLs expired before they
  /// could be sent, e.g. after a long spell without signal.
  Future<List<FileTarget>> refreshParts(
    String captureId,
    Map<String, List<int>> partsByFileId, {
    String? accountId,
  }) async {
    final Map<String, Object?> body = await _api.post(
      '/v1/captures/$captureId/uploads/refresh',
      <String, Object?>{
        'files': <Object?>[
          for (final MapEntry<String, List<int>> e in partsByFileId.entries)
            <String, Object?>{'fileId': e.key, 'parts': e.value},
        ],
      },
      const <String, String>{},
      accountId,
    );
    return _targets(body);
  }

  /// Asks the platform to assemble the parts and confirm it holds the
  /// capture. Only a `received` answer lets the app delete its copy.
  Future<CompletionResult> complete(
    String captureId, {
    String? accountId,
  }) async {
    final Map<String, Object?> body = await _api.post(
      '/v1/captures/$captureId/complete',
      const <String, Object?>{},
      const <String, String>{},
      accountId,
    );
    switch (body['status']) {
      case 'received':
        return const CompletionResult.received();
      case 'incomplete':
        return CompletionResult.incomplete(<String, List<int>>{
          for (final Object? m in body['missing'] as List<Object?>? ?? const [])
            (m! as Map<String, Object?>)['fileId']! as String: <int>[
              for (final Object? n
                  in (m as Map<String, Object?>)['parts']! as List<Object?>)
                (n! as num).toInt(),
            ],
        });
      default:
        throw ApiException(
          'The platform did not confirm the capture (${body['status']}).',
        );
    }
  }

  List<FileTarget> _targets(Map<String, Object?> body) => <FileTarget>[
    for (final Object? f in body['files']! as List<Object?>)
      FileTarget.fromJson(f! as Map<String, Object?>),
  ];
}
