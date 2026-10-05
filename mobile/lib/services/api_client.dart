import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import 'app_config.dart';
import 'auth_session.dart';

/// Why an API call failed, and whether trying again later can help.
class ApiException implements Exception {
  const ApiException(this.message, {this.statusCode, this.retryable = true});

  /// Written for the user: the backend's own message when it sent one.
  final String message;
  final int? statusCode;

  /// False when retrying cannot help, e.g. a rejected request.
  final bool retryable;

  bool get unauthorised => statusCode == 401;
  bool get offline => statusCode == null;

  @override
  String toString() => 'ApiException($statusCode): $message';
}

/// The Gym Plan backend over HTTPS.
///
/// Adds the access token to each call. When the token has expired it swaps
/// the refresh token for a new pair once and repeats the call; if that fails
/// too, the session is ended and [AuthSession] tells the app to sign in.
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

  final String baseUrl;
  final AuthSession session;
  final Duration timeout;
  final http.Client _client;

  /// Shared between concurrent calls that all found the token expired.
  Future<bool>? _refreshing;

  Future<Map<String, Object?>> get(String path) => _send('GET', path);

  Future<Map<String, Object?>> post(
    String path, [
    Map<String, Object?> body = const <String, Object?>{},
    Map<String, String> headers = const <String, String>{},
  ]) => _send('POST', path, body: body, headers: headers);

  Future<Map<String, Object?>> patch(String path, Map<String, Object?> body) =>
      _send('PATCH', path, body: body);

  /// A call that needs no sign-in, e.g. signing in.
  Future<Map<String, Object?>> postPublic(
    String path,
    Map<String, Object?> body,
  ) => _send('POST', path, body: body, authenticated: false);

  Future<Map<String, Object?>> _send(
    String method,
    String path, {
    Map<String, Object?>? body,
    Map<String, String> headers = const <String, String>{},
    bool authenticated = true,
  }) async {
    http.Response response = await _raw(
      method,
      path,
      body,
      headers,
      authenticated,
    );

    if (response.statusCode == 401 && authenticated) {
      if (await _refresh()) {
        response = await _raw(method, path, body, headers, authenticated);
      }
      if (response.statusCode == 401) session.signOut();
    }
    return _decode(response);
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

  Future<bool> _refresh() {
    return _refreshing ??= _doRefresh().whenComplete(() => _refreshing = null);
  }

  Future<bool> _doRefresh() async {
    final String? refreshToken = session.refreshToken;
    if (refreshToken == null) return false;
    try {
      final http.Response response = await _raw(
        'POST',
        '/v1/auth/refresh',
        <String, Object?>{'refreshToken': refreshToken},
        const <String, String>{},
        false,
      );
      if (response.statusCode != 200) return false;
      session.signedInWith(jsonDecode(response.body) as Map<String, Object?>);
      return true;
    } on ApiException {
      return false;
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
      // Server trouble and rate limits pass; a rejected request does not.
      retryable: code >= 500 || code == 408 || code == 429,
    );
  }

  void close() => _client.close();
}
