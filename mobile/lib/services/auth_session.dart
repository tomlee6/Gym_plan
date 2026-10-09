import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Who is signed in, as the Gym Plan backend described them.
@immutable
class SignedInUser {
  const SignedInUser({
    required this.id,
    required this.name,
    required this.email,
    required this.initials,
    this.staffRole,
  });

  factory SignedInUser.fromJson(Map<String, Object?> json) => SignedInUser(
    id: json['id']! as String,
    name: json['name']! as String,
    email: json['email'] as String? ?? '',
    initials: json['initials'] as String? ?? '',
    staffRole: json['staffRole'] as String?,
  );

  final String id;
  final String name;
  final String email;
  final String initials;

  /// `reviewer` or `admin` for Flex staff, otherwise null. Staff review in
  /// the web app; the phone only cares about gym [Account]s.
  final String? staffRole;

  Map<String, Object?> toJson() => <String, Object?>{
    'id': id,
    'name': name,
    'email': email,
    'initials': initials,
    'staffRole': staffRole,
  };
}

/// A gym account the user belongs to (contract v2 §2). A person can be an
/// owner of one gym group and a surveyor for another, so the role is per
/// account, not per person.
@immutable
class Account {
  const Account({required this.id, required this.name, required this.role});

  factory Account.fromJson(Map<String, Object?> json) => Account(
    id: json['id']! as String,
    name: json['name']! as String,
    role: json['role'] as String? ?? 'surveyor',
  );

  final String id;
  final String name;

  /// `owner` or `surveyor`.
  final String role;

  String get roleLabel => role == 'owner' ? 'Owner' : 'Surveyor';

  Map<String, Object?> toJson() => <String, Object?>{
    'id': id,
    'name': name,
    'role': role,
  };

  @override
  bool operator ==(Object other) =>
      other is Account &&
      other.id == id &&
      other.name == name &&
      other.role == role;

  @override
  int get hashCode => Object.hash(id, name, role);
}

/// Somewhere small and private to keep the session between launches.
///
/// The app uses [KeychainStore]; tests use [MemorySecureStore], since the
/// Keychain only exists on a device.
abstract class SecureStore {
  Future<String?> read(String key);

  /// A null [value] deletes the key.
  Future<void> write(String key, String? value);
}

/// The iOS Keychain (Android Keystore elsewhere), via
/// `flutter_secure_storage`.
///
/// Items are readable after the first unlock since boot and never leave
/// this device (`first_unlock_this_device`): a background upload woken by
/// iOS while the phone is locked in a pocket must still be able to swap
/// its refresh token, and a backup restored to another phone must not
/// arrive signed in.
class KeychainStore implements SecureStore {
  KeychainStore()
    : _storage = const FlutterSecureStorage(
        iOptions: IOSOptions(
          accessibility: KeychainAccessibility.first_unlock_this_device,
        ),
      );

  final FlutterSecureStorage _storage;

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> write(String key, String? value) => value == null
      ? _storage.delete(key: key)
      : _storage.write(key: key, value: value);
}

/// Keeps the "stored" session in memory. For tests, and anywhere the
/// Keychain is not available.
class MemorySecureStore implements SecureStore {
  MemorySecureStore([Map<String, String>? values])
    : values = values ?? <String, String>{};

  final Map<String, String> values;

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String? value) async {
    if (value == null) {
      values.remove(key);
    } else {
      values[key] = value;
    }
  }
}

/// The signed-in user's tokens, their gym accounts, and which account the
/// app is working in.
///
/// The access token is short-lived (30 minutes); `ApiClient` swaps the
/// refresh token for a new pair when it expires. Everything is written to
/// [store] (the Keychain in the app), so the app opens signed in after a
/// relaunch and an interrupted upload carries on without a sign-in (B-06).
/// The user and accounts are cached with the tokens so the app can open
/// signed in with no signal at all (I-04).
class AuthSession extends ChangeNotifier {
  AuthSession({SecureStore? store}) : _store = store ?? MemorySecureStore();

  /// The app replaces this with a Keychain-backed session in `main.dart`;
  /// tests replace it with an in-memory one.
  static AuthSession instance = AuthSession();

  static const String _accessKey = 'flex.accessToken';
  static const String _refreshKey = 'flex.refreshToken';
  static const String _profileKey = 'flex.profile';
  static const String _accountKey = 'flex.accountId';

  final SecureStore _store;

  String? _accessToken;
  String? _refreshToken;
  SignedInUser? _user;
  List<Account> _accounts = const <Account>[];
  String? _accountId;
  Future<void>? _restoring;
  Future<void>? _writing;

  /// Sent as `Authorization: Bearer <token>` on every API call.
  String? get accessToken => _accessToken;
  String? get refreshToken => _refreshToken;
  SignedInUser? get user => _user;

  /// The gym accounts this user can work in, as last reported by the
  /// backend.
  List<Account> get accounts => _accounts;

  /// The account every customer call is made in, sent as `X-Account-Id`.
  /// Null until one is chosen (see [needsAccountChoice]).
  Account? get currentAccount =>
      _accounts.where((Account a) => a.id == _accountId).firstOrNull;
  String? get currentAccountId => currentAccount?.id;

  /// A refresh token is enough: the access token may have expired while
  /// the app was closed, and the first call swaps it.
  bool get signedIn => _refreshToken != null || _accessToken != null;

  /// Signed in, but a member of no gym account: nothing to capture for.
  bool get hasNoAccounts => signedIn && _accounts.isEmpty;

  /// Signed in with several accounts and none chosen yet.
  bool get needsAccountChoice =>
      signedIn && _accounts.isNotEmpty && currentAccount == null;

  /// Loads the session saved by the last run. Safe to call more than once;
  /// later calls wait for the first. A session that is already signed in
  /// (e.g. set up by a test) is left alone.
  Future<void> restore() => _restoring ??= _restore();

  Future<void> _restore() async {
    if (signedIn) return;
    try {
      final String? refresh = await _store.read(_refreshKey);
      if (refresh == null) return;
      _refreshToken = refresh;
      _accessToken = await _store.read(_accessKey);
      _accountId = await _store.read(_accountKey);
      final String? profile = await _store.read(_profileKey);
      if (profile != null) _applyProfile(jsonDecode(profile));
    } catch (_) {
      // A Keychain that cannot be read (or a corrupt entry) just means
      // signing in again; it must never stop the app opening.
      _accessToken = null;
      _refreshToken = null;
      _user = null;
      _accounts = const <Account>[];
      _accountId = null;
    }
    notifyListeners();
  }

  /// Stores the body of `POST /v1/auth/hub` or `/v1/auth/refresh`: the
  /// (rotated) tokens, and the user and accounts when present.
  void signedInWith(Map<String, Object?> body) {
    _accessToken = body['accessToken']! as String;
    _refreshToken = body['refreshToken']! as String;
    _applyProfile(body);
    _chooseAccount();
    _persist();
    notifyListeners();
  }

  /// The accounts as `/v1/me` reports them, which may have changed since
  /// sign-in (an invite accepted, a membership removed).
  void updateAccounts(List<Account> accounts) {
    if (listEquals(accounts, _accounts)) return;
    _accounts = List<Account>.unmodifiable(accounts);
    _chooseAccount();
    _persist();
    notifyListeners();
  }

  /// Switches the account the app works in. Remembered across launches.
  void selectAccount(String accountId) {
    if (!_accounts.any((Account a) => a.id == accountId)) {
      throw ArgumentError.value(accountId, 'accountId', 'not a member');
    }
    if (_accountId == accountId) return;
    _accountId = accountId;
    _persist();
    notifyListeners();
  }

  /// Forgets everything, here and in the Keychain.
  void signOut() {
    if (!signedIn) return;
    _accessToken = null;
    _refreshToken = null;
    _user = null;
    _accounts = const <Account>[];
    _accountId = null;
    _persist();
    notifyListeners();
  }

  /// Waits for the Keychain writes queued so far. For tests.
  Future<void> get saved => _writing ?? Future<void>.value();

  void _applyProfile(Object? json) {
    if (json is! Map<String, Object?>) return;
    final Object? user = json['user'];
    if (user is Map<String, Object?>) _user = SignedInUser.fromJson(user);
    final Object? accounts = json['accounts'];
    if (accounts is List<Object?>) {
      _accounts = List<Account>.unmodifiable(<Account>[
        for (final Object? a in accounts)
          if (a is Map<String, Object?>) Account.fromJson(a),
      ]);
    }
  }

  /// One account needs no choosing. A remembered account the user has
  /// since lost is dropped, so the picker asks again.
  void _chooseAccount() {
    if (_accounts.length == 1) {
      _accountId = _accounts.single.id;
    } else if (currentAccount == null) {
      _accountId = null;
    }
  }

  /// Writes are chained so a quick refresh-then-sign-out can never land in
  /// the wrong order and resurrect the session.
  void _persist() {
    final String? access = _accessToken;
    final String? refresh = _refreshToken;
    final String? accountId = _accountId;
    final String? profile = refresh == null
        ? null
        : jsonEncode(<String, Object?>{
            'user': _user?.toJson(),
            'accounts': <Object?>[
              for (final Account a in _accounts) a.toJson(),
            ],
          });
    // Started lazily, so the chain lives in the zone of whoever first
    // changed the session (it matters in widget tests' fake clock).
    _writing = (_writing ?? Future<void>.value()).then((_) async {
      try {
        await _store.write(_accessKey, access);
        await _store.write(_refreshKey, refresh);
        await _store.write(_profileKey, profile);
        await _store.write(_accountKey, accountId);
      } catch (_) {
        // Not saved: the next launch signs in again. Nothing else breaks.
      }
    });
  }
}
