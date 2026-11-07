import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:mobile/screens/new_capture_screen.dart';
import 'package:mobile/services/auth_session.dart';
import 'package:mobile/theme/app_theme.dart';

/// A session signed in to one account with [role].
AuthSession _signedInAs(String role) => AuthSession()
  ..signedInWith(<String, Object?>{
    'accessToken': 'dev-token',
    'refreshToken': 'dev-refresh',
    'accounts': <Object?>[
      <String, Object?>{'id': 'acc_1', 'name': 'Harbour Gyms', 'role': role},
    ],
  });

void main() {
  late AuthSession before;
  setUp(() => before = AuthSession.instance);
  tearDown(() => AuthSession.instance = before);

  test('only owners and surveyors scan', () {
    expect(const Account(id: 'a', name: 'A', role: 'owner').canScan, isTrue);
    expect(const Account(id: 'a', name: 'A', role: 'surveyor').canScan, isTrue);
    const Account installer = Account(id: 'a', name: 'A', role: 'installer');
    expect(installer.canScan, isFalse);
    expect(installer.roleLabel, 'Installer');
    // Before an account is chosen nothing changes.
    expect(AuthSession().canScan, isTrue);
  });

  testWidgets('an installer opening a capture is told why, not sent to scan', (
    WidgetTester tester,
  ) async {
    AuthSession.instance = _signedInAs('installer');
    await tester.pumpWidget(
      MaterialApp(theme: AppTheme.dark, home: const NewCaptureScreen()),
    );
    await tester.pump();

    expect(find.text('Scanning is for owners and surveyors'), findsOneWidget);
    expect(find.textContaining('installer in Harbour Gyms'), findsOneWidget);
    expect(find.text('Starting camera…'), findsNothing);
  });
}
