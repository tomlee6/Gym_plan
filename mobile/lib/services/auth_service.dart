import 'api_client.dart';
import 'auth_session.dart';

/// Sign-in, sign-out and password reset against the Gym Plan backend
/// (`backend/src/modules/auth.js`).
class AuthService {
  AuthService({ApiClient? client}) : _client = client;

  final ApiClient? _client;
  ApiClient get _api => _client ?? ApiClient.instance;

  Future<AuthResult> signIn({
    required String email,
    required String password,
  }) async {
    try {
      final Map<String, Object?> tokens = await _api.postPublic(
        '/v1/auth/login',
        <String, Object?>{'email': email.trim(), 'password': password},
      );
      _api.session.signedInWith(tokens);
      return const AuthResult.success();
    } on ApiException catch (e) {
      return AuthResult.failure(e.message);
    }
  }

  /// The backend answers the same whether or not the address has an
  /// account, so this cannot be used to discover who the customers are.
  Future<AuthResult> sendPasswordReset({required String email}) async {
    try {
      await _api.postPublic('/v1/auth/password-reset', <String, Object?>{
        'email': email.trim(),
      });
      return const AuthResult.success();
    } on ApiException catch (e) {
      return AuthResult.failure(e.message);
    }
  }

  /// Revokes the refresh token on the server, then forgets the session.
  /// Signing out still works offline; the token then just expires.
  Future<void> signOut() async {
    final AuthSession session = _api.session;
    final String? refreshToken = session.refreshToken;
    if (refreshToken != null) {
      try {
        await _api.postPublic('/v1/auth/logout', <String, Object?>{
          'refreshToken': refreshToken,
        });
      } on ApiException {
        // Offline: the local sign-out below is what matters.
      }
    }
    session.signOut();
  }
}

class AuthResult {
  const AuthResult.success() : error = null;
  const AuthResult.failure(this.error);

  final String? error;

  bool get ok => error == null;
}
