import 'package:flutter/widgets.dart';

import '../services/auth_session.dart';
import 'account_picker_screen.dart';
import 'home_screen.dart';
import 'login_screen.dart';

/// Where the app belongs for the session as it stands:
///
/// - not signed in: sign-in;
/// - signed in, but in no gym account: a plain "no access" message, since
///   there is nothing to capture for;
/// - several accounts and none chosen yet: the account picker;
/// - otherwise home, in the chosen account.
///
/// Used after sign-in and at launch, when the session restored from the
/// Keychain decides it without a network call.
Widget screenForSession(AuthSession session) {
  if (!session.signedIn) return const LoginScreen();
  if (session.hasNoAccounts) return const NoAccessScreen();
  if (session.needsAccountChoice) return const AccountPickerScreen();
  return HomeScreen(email: session.user?.email ?? '');
}
