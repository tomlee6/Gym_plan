import 'dart:io';

import 'package:flutter/services.dart';

import 'api_client.dart';
import 'auth_session.dart';
import 'hub_auth.dart';
import 'offline_cache.dart';

/// Sign-in through the GoalCert Hub, and sign-out (contract v2 §1).
///
/// There are no passwords in this app (B-03): the Hub holds them, and the
/// phone only ever sees an authorisation code, which the backend exchanges
/// with its client secret.
class AuthService {
  AuthService({
    ApiClient? client,
    WebAuthenticator? webAuth,
    String? deviceLabel,
  }) : _client = client,
       _webAuth = webAuth,
       deviceLabel = deviceLabel ?? defaultDeviceLabel;

  final ApiClient? _client;
  final WebAuthenticator? _webAuth;

  /// Names this phone in the user's list of sessions. iOS no longer hands
  /// apps the user-chosen device name, so it is the model family.
  final String deviceLabel;

  static String get defaultDeviceLabel =>
      Platform.isIOS ? 'iPhone' : Platform.operatingSystem;

  ApiClient get _api => _client ?? ApiClient.instance;
  WebAuthenticator get _web => _webAuth ?? WebAuthenticator.instance;

  /// Runs the whole Hub sign-in: fetch the Hub config, open its sign-in
  /// sheet with a fresh state, nonce and PKCE challenge, check the state on
  /// the way back, and exchange the code for Flex tokens.
  Future<AuthResult> signInWithHub() async {
    try {
      final HubConfig config = HubConfig.fromJson(
        await _api.getPublic('/v1/auth/hub/config'),
      );
      final PkceAttempt attempt = PkceAttempt.generate();

      final Uri callback = await _web.authenticate(
        url: attempt.authorizeUrl(config),
        callbackScheme: config.redirectUri.scheme,
      );

      final Map<String, String> query = callback.queryParameters;
      // A callback for some other attempt (or a forged one) is never
      // exchanged.
      if (query['state'] != attempt.state) {
        return const AuthResult.failure(
          'The sign-in could not be confirmed. Try again.',
        );
      }
      if (query['error'] != null) {
        return AuthResult.failure(
          query['error'] == 'access_denied'
              ? 'Sign-in was cancelled.'
              : query['error_description'] ??
                    'We could not sign you in. Try again.',
        );
      }
      final String? code = query['code'];
      if (code == null || code.isEmpty) {
        return const AuthResult.failure(
          'The sign-in page did not return a sign-in code. Try again.',
        );
      }

      final Map<String, Object?> body = await _api
          .postPublic('/v1/auth/hub', <String, Object?>{
            'code': code,
            'codeVerifier': attempt.codeVerifier,
            'redirectUri': config.redirectUri.toString(),
            'nonce': attempt.nonce,
            'client': 'ios',
            'deviceLabel': deviceLabel,
          });
      _api.session.signedInWith(body);
      return const AuthResult.success();
    } on WebAuthCancelled {
      return const AuthResult.cancelled();
    } on ApiException catch (e) {
      return AuthResult.failure(switch (e.code) {
        'no_access' =>
          'You are signed in, but your account has no access to '
              'Flex Gym Scan. Ask your gym\'s account owner to invite you.',
        'hub_rejected' => 'The sign-in was not accepted. Try again.',
        _ => e.message,
      }, noAccess: e.code == 'no_access');
    } on PlatformException catch (e) {
      return AuthResult.failure(
        e.message ?? 'The sign-in page could not be opened.',
      );
    } on FormatException {
      return const AuthResult.failure(
        'The server sent an unexpected sign-in setup. Try again later.',
      );
    }
  }

  /// Revokes the refresh token on the server, then forgets the session and
  /// the offline copies made for it. Signing out still works offline; the
  /// token then just expires.
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
    await FacilityCache.instance.clear();
  }
}

class AuthResult {
  const AuthResult.success()
    : error = null,
      cancelled = false,
      noAccess = false;
  const AuthResult.cancelled()
    : error = null,
      cancelled = true,
      noAccess = false;
  const AuthResult.failure(this.error, {this.noAccess = false})
    : cancelled = false;

  final String? error;

  /// The user closed the sign-in sheet. Not an error worth showing.
  final bool cancelled;

  /// Signed in at the Hub, but with no Flex membership or invite.
  final bool noAccess;

  bool get ok => error == null && !cancelled;
}
