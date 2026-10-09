import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'package:mobile/services/api_client.dart';
import 'package:mobile/services/auth_session.dart';
import 'package:mobile/services/hub_auth.dart';

import 'support/fake_backend.dart';

/// A store whose reads fail, like a Keychain that cannot be opened.
class _BrokenStore implements SecureStore {
  @override
  Future<String?> read(String key) async => throw Exception('locked');

  @override
  Future<void> write(String key, String? value) async =>
      throw Exception('locked');
}

void main() {
  group('AuthSession and the Keychain', () {
    test('a saved session comes back after a relaunch', () async {
      final MemorySecureStore store = MemorySecureStore();
      final FakeBackend backend = FakeBackend()
        ..accounts.add(FakeBackend.riverside);
      final AuthSession first = AuthSession(store: store)
        ..signedInWith(backend.tokens())
        ..selectAccount('acc_riverside');
      await first.saved;

      final AuthSession relaunched = AuthSession(store: store);
      expect(relaunched.signedIn, isFalse);
      await relaunched.restore();

      expect(relaunched.signedIn, isTrue);
      expect(relaunched.refreshToken, 'refresh-token');
      expect(relaunched.user!.name, 'Sam Okafor');
      expect(relaunched.accounts.map((Account a) => a.name), <String>[
        'Northgate Group',
        'Riverside Leisure',
      ]);
      expect(relaunched.currentAccount!.name, 'Riverside Leisure');
    });

    test('one account is chosen without asking; several are not', () {
      final FakeBackend backend = FakeBackend();
      final AuthSession one = AuthSession()..signedInWith(backend.tokens());
      expect(one.currentAccountId, 'acc_northgate');
      expect(one.needsAccountChoice, isFalse);

      backend.accounts.add(FakeBackend.riverside);
      final AuthSession two = AuthSession()..signedInWith(backend.tokens());
      expect(two.currentAccount, isNull);
      expect(two.needsAccountChoice, isTrue);

      backend.accounts.clear();
      final AuthSession none = AuthSession()..signedInWith(backend.tokens());
      expect(none.hasNoAccounts, isTrue);
    });

    test('a remembered account the user has lost is asked for again', () {
      final FakeBackend backend = FakeBackend()
        ..accounts.add(FakeBackend.riverside);
      final AuthSession session = AuthSession()
        ..signedInWith(backend.tokens())
        ..selectAccount('acc_riverside');

      session.updateAccounts(<Account>[
        Account.fromJson(FakeBackend.northgate),
        const Account(id: 'acc_eastbrook', name: 'Eastbrook', role: 'owner'),
      ]);
      expect(session.currentAccount, isNull);
      expect(() => session.selectAccount('acc_riverside'), throwsArgumentError);
    });

    test('signing out empties the Keychain', () async {
      final MemorySecureStore store = MemorySecureStore();
      final AuthSession session = AuthSession(store: store)
        ..signedInWith(FakeBackend().tokens());
      await session.saved;
      expect(store.values, isNotEmpty);

      session.signOut();
      await session.saved;
      expect(store.values, isEmpty);
    });

    test('an unreadable Keychain just means signing in again', () async {
      final AuthSession session = AuthSession(store: _BrokenStore());
      await session.restore();
      expect(session.signedIn, isFalse);
      // Writes fail quietly too.
      session.signedInWith(FakeBackend().tokens());
      await session.saved;
      expect(session.signedIn, isTrue);
    });
  });

  group('ApiClient', () {
    late FakeBackend backend;
    late AuthSession session;
    late ApiClient api;

    setUp(() {
      backend = FakeBackend()..accounts.add(FakeBackend.riverside);
      session = AuthSession()
        ..signedInWith(backend.tokens())
        ..selectAccount('acc_northgate');
      api = ApiClient(
        baseUrl: 'https://api.test',
        session: session,
        client: backend.client,
      );
    });

    test('names the current account on every customer call', () async {
      await api.get('/v1/facilities');
      expect(backend.requests.last.headers['X-Account-Id'], 'acc_northgate');

      session.selectAccount('acc_riverside');
      await api.get('/v1/facilities');
      expect(backend.requests.last.headers['X-Account-Id'], 'acc_riverside');
    });

    test('an explicit account wins over the current one', () async {
      await api.get('/v1/facilities', accountId: 'acc_riverside');
      expect(backend.requests.last.headers['X-Account-Id'], 'acc_riverside');
    });

    test('sign-in calls carry no account or token', () async {
      await api.getPublic('/v1/auth/hub/config');
      final http.Request r = backend.requests.last;
      expect(r.headers.containsKey('X-Account-Id'), isFalse);
      expect(r.headers.containsKey('Authorization'), isFalse);
    });

    test('a missing account is refused by the backend', () async {
      final AuthSession noChoice = AuthSession()
        ..signedInWith(backend.tokens());
      final ApiClient client = ApiClient(
        baseUrl: 'https://api.test',
        session: noChoice,
        client: backend.client,
      );
      await expectLater(
        client.get('/v1/facilities'),
        throwsA(
          isA<ApiException>().having(
            (ApiException e) => e.code,
            'code',
            'no_account',
          ),
        ),
      );
    });

    test('an expired token is swapped once and the call repeated', () async {
      backend.accessToken = 'access-token-2';
      final Map<String, Object?> body = await api.get('/v1/facilities');
      expect(body['facilities'], isNotEmpty);
      expect(session.accessToken, 'access-token-2');
      expect(session.refreshToken, 'refresh-token-1');
    });

    test('a refused refresh signs out', () async {
      backend
        ..accessToken = 'access-token-2'
        ..refreshRevoked = true;
      await expectLater(
        api.get('/v1/facilities'),
        throwsA(isA<ApiException>().having((e) => e.unauthorised, '401', true)),
      );
      expect(session.signedIn, isFalse);
    });

    test('no signal never signs anyone out', () async {
      backend.offline = true;
      await expectLater(
        api.get('/v1/facilities'),
        throwsA(isA<ApiException>().having((e) => e.offline, 'offline', true)),
      );
      expect(session.signedIn, isTrue);
    });
  });

  group('PKCE', () {
    test('S256 is unpadded base64url of SHA-256', () {
      // Reference value from an independent implementation (Node's
      // crypto: sha256 digest, base64url).
      expect(
        PkceAttempt.challengeFor(
          'flex-gym-scan.verifier_0123456789~abcdefghijklmnopqrstuvwxyz',
        ),
        'sQkYPjjDDgRbza9fCxbivdOrXEs9UR_-oHpuuPwwKyk',
      );
    });

    test('values are fresh and from the unreserved set', () {
      final PkceAttempt a = PkceAttempt.generate(math.Random(1));
      final PkceAttempt b = PkceAttempt.generate(math.Random(2));
      expect(a.state, isNot(b.state));
      expect(a.codeVerifier, hasLength(64));
      expect(RegExp(r'^[A-Za-z0-9\-._~]+$').hasMatch(a.codeVerifier), isTrue);
      expect(a.codeChallenge, isNot(contains('=')));
    });

    test('the authorise URL carries everything the Hub needs', () {
      final PkceAttempt a = PkceAttempt.generate(math.Random(3));
      final Uri url = a.authorizeUrl(
        HubConfig.fromJson(<String, Object?>{
          'authorizeUrl': 'https://hub.test/oauth/authorize',
          'clientId': 'flex-gym-web',
          'scope': 'openid profile email',
          'redirectUris': <String, Object?>{
            'web': 'https://gym.test/auth/callback',
            'ios': 'flexgymscan://auth/callback',
          },
        }),
      );
      expect(url.path, '/oauth/authorize');
      expect(url.queryParameters, <String, String>{
        'response_type': 'code',
        'client_id': 'flex-gym-web',
        'redirect_uri': 'flexgymscan://auth/callback',
        'scope': 'openid profile email',
        'state': a.state,
        'nonce': a.nonce,
        'code_challenge': a.codeChallenge,
        'code_challenge_method': 'S256',
      });
    });
  });
}
