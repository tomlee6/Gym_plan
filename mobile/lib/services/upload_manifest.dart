import 'dart:convert';
import 'dart:io';

/// One part of one file: a byte range, sent as its own PUT.
class ManifestPart {
  ManifestPart({
    required this.number,
    required this.offset,
    required this.bytes,
    this.url,
    this.done = false,
  });

  factory ManifestPart.fromJson(Map<String, Object?> json) => ManifestPart(
    number: (json['number']! as num).toInt(),
    offset: (json['offset']! as num).toInt(),
    bytes: (json['bytes']! as num).toInt(),
    url: json['url'] as String?,
    done: json['done'] == true,
  );

  /// 1-based.
  final int number;
  final int offset;
  final int bytes;

  /// Signed URL to PUT to. Cleared when it fails, so a fresh one is asked
  /// for before the part is sent again.
  String? url;
  bool done;

  Map<String, Object?> toJson() => <String, Object?>{
    'number': number,
    'offset': offset,
    'bytes': bytes,
    'url': url,
    'done': done,
  };
}

/// One file of a capture: the 3D model, the room data or a photo.
class ManifestFile {
  ManifestFile({
    required this.source,
    required this.name,
    required this.kind,
    required this.contentType,
    required this.bytes,
    this.fileId,
    List<ManifestPart>? parts,
  }) : parts = parts ?? <ManifestPart>[];

  factory ManifestFile.fromJson(Map<String, Object?> json) => ManifestFile(
    source: json['source']! as String,
    name: json['name']! as String,
    kind: json['kind']! as String,
    contentType: json['contentType']! as String,
    bytes: (json['bytes']! as num).toInt(),
    fileId: json['fileId'] as String?,
    parts: <ManifestPart>[
      for (final Object? p in json['parts'] as List<Object?>? ?? const [])
        ManifestPart.fromJson(p! as Map<String, Object?>),
    ],
  );

  /// Where the original is, relative to Application Support when it lives
  /// there (see [UploadManifest.resolve]).
  final String source;
  final String name;
  final String kind;
  final String contentType;
  final int bytes;

  /// The platform's id for the file, once the upload is opened.
  String? fileId;
  List<ManifestPart> parts;

  int get sentBytes => parts
      .where((ManifestPart p) => p.done)
      .fold(0, (int sum, ManifestPart p) => sum + p.bytes);

  Map<String, Object?> toJson() => <String, Object?>{
    'source': source,
    'name': name,
    'kind': kind,
    'contentType': contentType,
    'bytes': bytes,
    'fileId': fileId,
    'parts': <Object?>[for (final ManifestPart p in parts) p.toJson()],
  };
}

/// Everything needed to carry an upload on after the app restarts, written
/// to disk after every change.
class UploadManifest {
  UploadManifest({
    required this.id,
    required this.title,
    required this.facility,
    required this.level,
    required this.metadata,
    required this.files,
    required this.createdAt,
    this.captureId,
    this.resumes = 0,
    this.failures = 0,
    this.received = false,
    this.error,
  });

  factory UploadManifest.fromJson(Map<String, Object?> json) => UploadManifest(
    id: json['id']! as String,
    title: json['title']! as String,
    facility: json['facility']! as String,
    level: (json['level']! as num).toInt(),
    metadata: (json['metadata'] as Map<String, Object?>?) ?? const {},
    files: <ManifestFile>[
      for (final Object? f in json['files'] as List<Object?>? ?? const [])
        ManifestFile.fromJson(f! as Map<String, Object?>),
    ],
    createdAt: DateTime.parse(json['createdAt']! as String),
    captureId: json['captureId'] as String?,
    resumes: (json['resumes'] as num? ?? 0).toInt(),
    failures: (json['failures'] as num? ?? 0).toInt(),
    received: json['received'] == true,
    error: json['error'] as String?,
  );

  static const String fileName = 'manifest.json';

  /// Local id; also the idempotency key for registering the capture.
  final String id;
  final String title;
  final String facility;
  final int level;

  /// Sent when the capture is registered: facility, level, coverage, tags.
  final Map<String, Object?> metadata;
  final List<ManifestFile> files;
  final DateTime createdAt;

  /// The platform's id for the capture, once registered.
  String? captureId;
  int resumes;

  /// Failures since the last part got through. Too many and the upload
  /// stops and asks the user to try again.
  int failures;

  /// The platform confirmed it holds the capture; local files are gone.
  bool received;

  /// Set when the upload has stopped and needs the user.
  String? error;

  int get totalBytes =>
      files.fold(0, (int sum, ManifestFile f) => sum + f.bytes);

  int get sentBytes =>
      files.fold(0, (int sum, ManifestFile f) => sum + f.sentBytes);

  bool get allPartsDone => files.every(
    (ManifestFile f) =>
        f.parts.isNotEmpty && f.parts.every((ManifestPart p) => p.done),
  );

  Map<String, Object?> toJson() => <String, Object?>{
    'id': id,
    'title': title,
    'facility': facility,
    'level': level,
    'metadata': metadata,
    'files': <Object?>[for (final ManifestFile f in files) f.toJson()],
    'createdAt': createdAt.toIso8601String(),
    'captureId': captureId,
    'resumes': resumes,
    'failures': failures,
    'received': received,
    'error': error,
  };

  /// Writes atomically: a crash mid-write leaves the previous version.
  Future<void> save(Directory dir) async {
    await dir.create(recursive: true);
    final File tmp = File('${dir.path}/$fileName.tmp');
    await tmp.writeAsString(jsonEncode(toJson()), flush: true);
    await tmp.rename('${dir.path}/$fileName');
  }

  static Future<UploadManifest?> load(Directory dir) async {
    final File file = File('${dir.path}/$fileName');
    if (!await file.exists()) return null;
    try {
      return UploadManifest.fromJson(
        jsonDecode(await file.readAsString()) as Map<String, Object?>,
      );
    } on FormatException {
      return null;
    }
  }

  /// Stores [path] relative to [root] when it is inside it. iOS changes the
  /// app container's absolute path across updates, so absolute paths saved
  /// today may not resolve tomorrow.
  static String relativise(String path, Directory root) {
    final String prefix = '${root.path}${Platform.pathSeparator}';
    return path.startsWith(prefix) ? path.substring(prefix.length) : path;
  }

  static String resolve(String path, Directory root) =>
      File(path).isAbsolute ? path : '${root.path}/$path';
}
