import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';

import 'capture_service.dart';

/// The facility list of each account, kept on the phone so a capture can
/// be started with no signal (I-04, APP-13).
///
/// Gyms are often basements and steel sheds: the surveyor may open the app
/// where there is no signal at all. The session (user and accounts) is
/// already cached with the tokens in the Keychain; this keeps the other
/// thing the setup screen needs. One small JSON file per account under
/// Application Support, `FacilityCache/<account id>.json`, replaced every
/// time the list loads online. The upload still waits for signal.
class FacilityCache {
  FacilityCache({Future<Directory> Function()? directory})
    : _directory = directory ?? getApplicationSupportDirectory;

  /// The cache the app uses. Tests replace it with [MemoryFacilityCache].
  static FacilityCache instance = FacilityCache();

  final Future<Directory> Function() _directory;

  /// Remembers [list] as [accountId]'s facilities, stamped now.
  Future<void> save(String accountId, FacilityList list) async {
    try {
      await write(
        _fileName(accountId),
        jsonEncode(<String, Object?>{
          'savedAt': DateTime.now().toUtc().toIso8601String(),
          'defaultFacilityId': list.defaultId,
          'facilities': <Object?>[
            for (final Facility f in list.facilities)
              <String, Object?>{'id': f.id, 'name': f.name},
          ],
        }),
      );
    } catch (_) {
      // A cache that cannot be written only costs the offline start.
    }
  }

  /// The last list saved for [accountId], with [FacilityList.cachedAt]
  /// set, or null if there is none.
  Future<FacilityList?> load(String accountId) async {
    try {
      final String? raw = await read(_fileName(accountId));
      if (raw == null) return null;
      final Map<String, Object?> json = jsonDecode(raw) as Map<String, Object?>;
      return FacilityList(
        facilities: <Facility>[
          for (final Object? f in json['facilities']! as List<Object?>)
            Facility.fromJson(f! as Map<String, Object?>),
        ],
        defaultId: json['defaultFacilityId'] as String?,
        cachedAt: DateTime.parse(json['savedAt']! as String).toLocal(),
      );
    } catch (_) {
      return null;
    }
  }

  /// Drops every account's list, on sign-out.
  Future<void> clear() async {
    try {
      await deleteAll();
    } catch (_) {
      // Nothing cached, or nothing to be done about it.
    }
  }

  String _fileName(String accountId) =>
      '${accountId.replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '_')}.json';

  Future<Directory> _folder() async =>
      Directory('${(await _directory()).path}/FacilityCache');

  /// Storage primitives, replaced by [MemoryFacilityCache].
  Future<String?> read(String name) async {
    final File file = File('${(await _folder()).path}/$name');
    return await file.exists() ? file.readAsString() : null;
  }

  Future<void> write(String name, String contents) async {
    final Directory folder = await _folder();
    await folder.create(recursive: true);
    // Written aside and renamed, so a crash never leaves half a list.
    final File tmp = File('${folder.path}/$name.tmp');
    await tmp.writeAsString(contents, flush: true);
    await tmp.rename('${folder.path}/$name');
  }

  Future<void> deleteAll() async {
    final Directory folder = await _folder();
    if (await folder.exists()) await folder.delete(recursive: true);
  }
}

/// Keeps the cache in memory, for widget tests (real file I/O does not
/// complete inside a widget test's fake clock).
class MemoryFacilityCache extends FacilityCache {
  MemoryFacilityCache() : super(directory: () async => Directory.systemTemp);

  final Map<String, String> files = <String, String>{};

  @override
  Future<String?> read(String name) async => files[name];

  @override
  Future<void> write(String name, String contents) async =>
      files[name] = contents;

  @override
  Future<void> deleteAll() async => files.clear();
}
