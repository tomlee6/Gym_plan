import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import 'app_config.dart';
import 'auth_session.dart';

/// Why an API call failed, and whether trying again later can help.
class ApiException implements Exception {
  const ApiException(
    this.message, {
    this.statusCode,
    this.retryable = true,
    this.code,
  });

  /// Written for the user: the backend's own message when it sent one.
  final String message;
  final int? statusCode;

  /// False when retrying cannot help, e.g. a rejected request.
  final bool retryable;

  /// The backend's machine-readable reason, e.g. `no_access`,
  /// `hub_rejected` or `no_account` (contract v2).
  final String? code;

  bool get unauthorised => statusCode == 401;
  bool get offline => statusCode == null;

  @override
  String toString() => 'ApiException($statusCode): $message';
}

/// The Gym Plan backend over HTTPS.
///
/// Adds the access token to each call, and the `X-Account-Id` header naming
/// the gym account the call is made in (contract v2 §2): the session's
/// current account unless the caller names one, as the upload queue does
/// for a capture taken in an account the user has since switched away
/// from.
///
/// When the token has expired it swaps the refresh token for a new pair
/// once and repeats the call. Only a refresh the backend *refuses* (the
/// token was revoked, or the Hub disabled or deleted the user) ends the
/// session; a refresh that cannot get through for lack of signal leaves the
/// phone signed in, so starting the app offline never signs anyone out.
class ApiClient {
  ApiClient({
    required this.baseUrl,
    AuthSession? session,
    http.Client? client,
    this.timeout = const Duration(seconds: 30),
  }) : session = session ?? AuthSession.instance,
       _client = client ?? http.Client();

  /// The client the app uses. Tests replace it with one on a fake backend.
  static ApiClient instance = ApiClient(baseUrl: AppConfig.apiBaseUrl);

  static const String accountHeader = 'X-Account-Id';

  final String baseUrl;
  final AuthSession session;
  final Duration timeout;
  final http.Client _client;

  /// Shared between concurrent calls that all found the token expired.
  Future<_Refresh>? _refreshing;

  /// [accountId] overrides the session's current account for this call.
  Future<Map<String, Object?>> get(String path, {String? accountId}) =>
      _send('GET', path, accountId: accountId);

  Future<Map<String, Object?>> post(
    String path, [
    Map<String, Object?> body = const <String, Object?>{},
    Map<String, String> headers = const <String, String>{},
    String? accountId,
  ]) => _send('POST', path, body: body, headers: headers, accountId: accountId);

  Future<Map<String, Object?>> patch(String path, Map<String, Object?> body) =>
      _send('PATCH', path, body: body);

  /// A call that needs no sign-in, e.g. signing in.
  Future<Map<String, Object?>> postPublic(
    String path,
    Map<String, Object?> body,
  ) => _send('POST', path, body: body, authenticated: false);

  /// A GET that needs no sign-in, e.g. the Hub's sign-in configuration.
  Future<Map<String, Object?>> getPublic(String path) =>
      _send('GET', path, authenticated: false);

  Future<Map<String, Object?>> _send(
    String method,
    String path, {
    Map<String, Object?>? body,
    Map<String, String> headers = const <String, String>{},
    bool authenticated = true,
    String? accountId,
  }) async {
    final String? account = authenticated
        ? accountId ?? session.currentAccountId
        : null;
    final Map<String, String> all = <String, String>{
      accountHeader: ?account,
      ...headers,
    };

    // A session restored from the Keychain may hold only a refresh token.
    if (authenticated &&
        session.accessToken == null &&
        session.refreshToken != null) {
      await _refreshOrThrow();
    }

    http.Response response = await _raw(method, path, body, all, authenticated);

    if (response.statusCode == 401 && authenticated) {
      await _refreshOrThrow();
      response = await _raw(method, path, body, all, authenticated);
      if (response.statusCode == 401) session.signOut();
    }
    return _decode(response);
  }

  /// Swaps the refresh token. Signs out if the backend refuses it; throws
  /// a retryable error, still signed in, if it could not be asked.
  Future<void> _refreshOrThrow() async {
    switch (await _refresh()) {
      case _Refresh.ok:
        return;
      case _Refresh.refused:
        session.signOut();
        throw const ApiException(
          'Your sign-in has ended. Sign in again.',
          statusCode: 401,
          retryable: false,
        );
      case _Refresh.unreachable:
        throw const ApiException('No connection. Check your signal.');
    }
  }

  Future<http.Response> _raw(
    String method,
    String path,
    Map<String, Object?>? body,
    Map<String, String> headers,
    bool authenticated,
  ) async {
    final String? token = session.accessToken;
    if (authenticated && token == null) {
      throw const ApiException(
        'Sign in to continue.',
        statusCode: 401,
        retryable: false,
      );
    }

    final http.Request request = http.Request(
      method,
      Uri.parse('$baseUrl$path'),
    );
    request.headers.addAll(<String, String>{
      'Accept': 'application/json',
      if (body != null) 'Content-Type': 'application/json',
      if (authenticated) 'Authorization': 'Bearer $token',
      ...headers,
    });
    if (body != null) request.body = jsonEncode(body);

    try {
      return await http.Response.fromStream(
        await _client.send(request).timeout(timeout),
      );
    } on SocketException {
      throw const ApiException('No connection. Check your signal.');
    } on TimeoutException {
      throw const ApiException('The server took too long to answer.');
    } on http.ClientException {
      throw const ApiException('No connection. Check your signal.');
    }
  }

  Future<_Refresh> _refresh() {
    return _refreshing ??= _doRefresh().whenComplete(() => _refreshing = null);
  }

  Future<_Refresh> _doRefresh() async {
    final String? refreshToken = session.refreshToken;
    if (refreshToken == null) return _Refresh.refused;
    try {
      final http.Response response = await _raw(
        'POST',
        '/v1/auth/refresh',
        <String, Object?>{'refreshToken': refreshToken},
        const <String, String>{},
        false,
      );
      if (response.statusCode == 200) {
        // The session writes the rotated pair to the Keychain at once: a
        // relaunch that reused the old token would revoke every session of
        // this user.
        session.signedInWith(jsonDecode(response.body) as Map<String, Object?>);
        return _Refresh.ok;
      }
      // 4xx: the token is no good any more. Server trouble is not the
      // user's fault and must not sign them out.
      return response.statusCode >= 400 && response.statusCode < 500
          ? _Refresh.refused
          : _Refresh.unreachable;
    } on ApiException {
      return _Refresh.unreachable;
    }
  }

  Map<String, Object?> _decode(http.Response response) {
    final int code = response.statusCode;
    Object? json;
    if (response.body.isNotEmpty) {
      try {
        json = jsonDecode(response.body);
      } on FormatException {
        json = null;
      }
    }

    if (code >= 200 && code < 300) {
      return json is Map<String, Object?> ? json : const <String, Object?>{};
    }

    final String message = json is Map && json['message'] is String
        ? json['message'] as String
        : 'The server returned an error ($code).';
    throw ApiException(
      message,
      statusCode: code,
      code: json is Map && json['code'] is String
          ? json['code'] as String
          : null,
      // Server trouble and rate limits pass; a rejected request does not.
      retryable: code >= 500 || code == 408 || code == 429,
    );
  }

  void close() => _client.close();
}

enum _Refresh { ok, refused, unreachable }
