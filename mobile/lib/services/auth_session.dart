import 'package:flutter/foundation.dart';

/// Who is signed in, as the Gym Plan backend described them.
@immutable
class SignedInUser {
  const SignedInUser({
    required this.id,
    required this.name,
    required this.email,
    required this.initials,
    required this.role,
  });

  factory SignedInUser.fromJson(Map<String, Object?> json) => SignedInUser(
    id: json['id']! as String,
    name: json['name']! as String,
    email: json['email']! as String,
    initials: json['initials']! as String,
    role: json['role']! as String,
  );

  final String id;
  final String name;
  final String email;
  final String initials;

  /// `owner`, `surveyor` or `reviewer`.
  final String role;
}

/// The signed-in user's tokens.
///
/// The access token is short-lived (30 minutes); `ApiClient` swaps the
/// refresh token for a new pair when it expires. Held in memory, so the app
/// starts at sign-in each launch.
class AuthSession extends ChangeNotifier {
  AuthSession();

  static AuthSession instance = AuthSession();

  String? _accessToken;
  String? _refreshToken;
  SignedInUser? _user;

  /// Sent as `Authorization: Bearer <token>` on every API call.
  String? get accessToken => _accessToken;
  String? get refreshToken => _refreshToken;
  SignedInUser? get user => _user;
  bool get signedIn => _accessToken != null;

  /// Stores the tokens from `/v1/auth/login` or `/v1/auth/refresh`.
  void signedInWith(Map<String, Object?> tokens) {
    _accessToken = tokens['accessToken']! as String;
    _refreshToken = tokens['refreshToken']! as String;
    final Object? user = tokens['user'];
    if (user is Map<String, Object?>) _user = SignedInUser.fromJson(user);
    notifyListeners();
  }

  void signOut() {
    if (!signedIn) return;
    _accessToken = null;
    _refreshToken = null;
    _user = null;
    notifyListeners();
  }
}
