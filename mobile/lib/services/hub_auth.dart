import 'dart:convert';
import 'dart:math' as math;

import 'package:crypto/crypto.dart';
import 'package:flutter/services.dart';
import 'package:flutter_web_auth_2/flutter_web_auth_2.dart';

/// How to reach the GoalCert Hub's sign-in page, from
/// `GET /v1/auth/hub/config` (contract v2 §1). Fetched each time rather
/// than built in, so the Hub can move without an app release.
class HubConfig {
  const HubConfig({
    required this.authorizeUrl,
    required this.clientId,
    required this.scope,
    required this.redirectUri,
  });

  factory HubConfig.fromJson(Map<String, Object?> json) {
    final Map<String, Object?> redirects =
        json['redirectUris']! as Map<String, Object?>;
    return HubConfig(
      authorizeUrl: Uri.parse(json['authorizeUrl']! as String),
      clientId: json['clientId']! as String,
      scope: json['scope'] as String? ?? 'openid profile email',
      redirectUri: Uri.parse(redirects['ios']! as String),
    );
  }

  final Uri authorizeUrl;
  final String clientId;
  final String scope;

  /// The iPhone's callback, `flexgymscan://auth/callback`. Its scheme is
  /// what [WebAuthenticator] waits for.
  final Uri redirectUri;
}

/// The random values one sign-in attempt is bound to.
///
/// - `state` ties the callback to this attempt, so a callback from some
///   other, forged attempt is refused;
/// - `nonce` ends up inside the Hub's ID token, which the backend checks;
/// - the PKCE `codeVerifier` never leaves the phone until the code is
///   exchanged, so an authorisation code intercepted on the way back (by
///   another app claiming the same URL scheme) is useless on its own.
class PkceAttempt {
  PkceAttempt._(this.state, this.nonce, this.codeVerifier);

  factory PkceAttempt.generate([math.Random? random]) {
    final math.Random r = random ?? math.Random.secure();
    return PkceAttempt._(
      randomToken(r, 32),
      randomToken(r, 32),
      // 64 characters: inside RFC 7636's 43–128.
      randomToken(r, 64),
    );
  }

  final String state;
  final String nonce;
  final String codeVerifier;

  /// `base64url(sha256(codeVerifier))` without padding (S256).
  String get codeChallenge => challengeFor(codeVerifier);

  static const String _unreserved =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

  /// [length] characters from RFC 7636's unreserved set.
  static String randomToken(math.Random random, int length) =>
      String.fromCharCodes(<int>[
        for (int i = 0; i < length; i++)
          _unreserved.codeUnitAt(random.nextInt(_unreserved.length)),
      ]);

  static String challengeFor(String verifier) => base64Url
      .encode(sha256.convert(ascii.encode(verifier)).bytes)
      .replaceAll('=', '');

  /// The Hub's authorise page for this attempt.
  Uri authorizeUrl(HubConfig config) => config.authorizeUrl.replace(
    queryParameters: <String, String>{
      ...config.authorizeUrl.queryParameters,
      'response_type': 'code',
      'client_id': config.clientId,
      'redirect_uri': config.redirectUri.toString(),
      'scope': config.scope,
      'state': state,
      'nonce': nonce,
      'code_challenge': codeChallenge,
      'code_challenge_method': 'S256',
    },
  );
}

/// The surveyor closed the sign-in sheet without finishing.
class WebAuthCancelled implements Exception {
  const WebAuthCancelled();
}

/// Shows a web page for signing in and returns the URL it finally
/// redirected to. Behind an interface so widget tests can play the Hub.
abstract class WebAuthenticator {
  /// The one the app uses. Tests replace it.
  static WebAuthenticator instance = const SystemWebAuthenticator();

  /// Throws [WebAuthCancelled] when the user backs out.
  Future<Uri> authenticate({required Uri url, required String callbackScheme});
}

/// `ASWebAuthenticationSession` on iOS, through `flutter_web_auth_2`.
///
/// The sheet shares Safari's cookies (it is not ephemeral), so someone
/// already signed in to the Hub in Safari just confirms. The callback is
/// caught by the session itself, so the `flexgymscan` scheme does not need
/// registering in `Info.plist`.
class SystemWebAuthenticator implements WebAuthenticator {
  const SystemWebAuthenticator();

  @override
  Future<Uri> authenticate({
    required Uri url,
    required String callbackScheme,
  }) async {
    try {
      final String result = await FlutterWebAuth2.authenticate(
        url: url.toString(),
        callbackUrlScheme: callbackScheme,
      );
      return Uri.parse(result);
    } on PlatformException catch (e) {
      if (e.code == 'CANCELED') throw const WebAuthCancelled();
      rethrow;
    }
  }
}
