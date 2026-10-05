import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:mobile/main.dart';
import 'package:mobile/screens/forgot_password_screen.dart';
import 'package:mobile/screens/home_screen.dart';
import 'package:mobile/screens/login_screen.dart';
import 'support/fake_backend.dart';

void main() {
  setUp(() => useFakeBackend(signedIn: false));

  testWidgets('login screen shows the brand mark and the sign-in form', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(const FlexGymScanApp());

    expect(find.byType(LoginScreen), findsOneWidget);
    expect(find.text('GYM SCAN'), findsOneWidget);
    // Once as the heading, once as the button label.
    expect(find.text('Sign in'), findsNWidgets(2));
    expect(find.text('Email'), findsOneWidget);
    expect(find.text('Password'), findsOneWidget);
    expect(find.text('Forgot password?'), findsOneWidget);

    // The logo is an asset image, not a text placeholder.
    final Image logo = tester.widget<Image>(find.byType(Image).first);
    expect(
      (logo.image as AssetImage).assetName,
      'assets/images/flex_motion_logo.png',
    );
  });

  testWidgets('invalid email is rejected before any auth call', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(const FlexGymScanApp());

    await tester.enterText(find.byType(TextField).first, 'not-an-email');
    await tester.tap(find.text('Sign in').last);
    await tester.pump();

    expect(find.text('Enter a valid email address.'), findsOneWidget);
  });

  testWidgets('wrong credentials surface an error', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(const FlexGymScanApp());

    await tester.enterText(find.byType(TextField).first, 'sam@example.com');
    await tester.enterText(find.byType(TextField).last, 'wrongpassword');
    await tester.tap(find.text('Sign in').last);
    await tester.pump();
    await tester.pump(const Duration(seconds: 2));

    expect(find.text('Incorrect email or password.'), findsOneWidget);
  });

  testWidgets('demo credentials sign in', (WidgetTester tester) async {
    await tester.pumpWidget(const FlexGymScanApp());

    await tester.enterText(find.byType(TextField).first, FakeBackend.email);
    await tester.enterText(find.byType(TextField).last, FakeBackend.password);
    await tester.tap(find.text('Sign in').last);
    await tester.pump();
    await tester.pump(const Duration(seconds: 2));
    await tester.pumpAndSettle();

    expect(find.byType(HomeScreen), findsOneWidget);
    expect(find.text('Gym Scan'), findsOneWidget);
  });

  testWidgets('forgot password sends a reset link and confirms', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(const FlexGymScanApp());

    await tester.tap(find.text('Forgot password?'));
    await tester.pumpAndSettle();

    expect(find.byType(ForgotPasswordScreen), findsOneWidget);

    await tester.enterText(find.byType(TextField).first, 'sam@example.com');
    await tester.tap(find.text('Send reset link'));
    await tester.pump();
    await tester.pump(const Duration(seconds: 2));
    await tester.pumpAndSettle();

    expect(find.text('Check your inbox'), findsOneWidget);
    expect(find.text('Back to sign in'), findsOneWidget);
  });
}
