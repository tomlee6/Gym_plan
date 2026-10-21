import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../services/auth_service.dart';
import '../services/auth_session.dart';
import '../services/upload_queue.dart';
import '../theme/app_theme.dart';
import '../widgets/brand_header.dart';
import '../widgets/primary_button.dart';
import 'session_routes.dart';

/// "Sign in with GoalCert" (B-08).
///
/// The app has no password field of its own any more (B-03): the button
/// opens the GoalCert Hub's sign-in page in an `ASWebAuthenticationSession`
/// sheet, and the Hub sends the phone back with a one-time code. The Hub
/// handles passwords, resets and any second factor, and the phone never
/// sees a password at all.
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, this.authService});

  /// Injectable so tests can play the Hub.
  final AuthService? authService;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  late final AuthService _auth = widget.authService ?? AuthService();

  bool _busy = false;
  String? _error;

  Future<void> _signIn() async {
    setState(() {
      _busy = true;
      _error = null;
    });

    final AuthResult result = await _auth.signInWithHub();

    if (!mounted) return;
    setState(() => _busy = false);

    // Closing the sheet is a choice, not a failure: nothing to say.
    if (result.cancelled) return;
    if (!result.ok) {
      HapticFeedback.heavyImpact();
      setState(() => _error = result.error);
      return;
    }

    // An upload stopped by an expired sign-in can carry on now.
    UploadQueue.instance.retry();

    Navigator.of(context).pushReplacement(
      MaterialPageRoute<void>(
        builder: (_) => screenForSession(AuthSession.instance),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: LayoutBuilder(
          builder: (BuildContext context, BoxConstraints constraints) {
            return SingleChildScrollView(
              child: ConstrainedBox(
                constraints: BoxConstraints(minHeight: constraints.maxHeight),
                child: IntrinsicHeight(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(32, 48, 32, 40),
                    child: _buildContent(),
                  ),
                ),
              ),
            );
          },
        ),
      ),
    );
  }

  Widget _buildContent() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        const Center(child: BrandHeader()),
        const SizedBox(height: 54),

        const Text('Sign in', style: AppTheme.title),
        const SizedBox(height: 10),
        const Text(
          'Use the email and password you use for Flex Gym Scan on the web. '
          'You will only see the gyms your account belongs to.',
          style: AppTheme.body,
        ),

        if (_error != null) ...<Widget>[
          const SizedBox(height: 22),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              const Padding(
                padding: EdgeInsets.only(top: 1),
                child: Icon(
                  Icons.error_outline,
                  size: 16,
                  color: AppColors.danger,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  _error!,
                  style: const TextStyle(fontSize: 13, color: AppColors.danger),
                ),
              ),
            ],
          ),
        ],

        const SizedBox(height: 30),
        PrimaryButton(
          label: 'Sign in',
          icon: Icons.verified_user_outlined,
          busy: _busy,
          onPressed: _signIn,
        ),
        const SizedBox(height: 22),

        const InfoCard(
          icon: Icons.info_outline,
          message:
              'Forgotten your password? Choose "Forgot your password?" on the sign-in page. '
              'Scanning needs an iPhone with a LiDAR sensor (12 Pro or later '
              'Pro models) on iOS 17.',
        ),

        const Expanded(child: SizedBox(height: 24)),
        const Center(
          child: Text('Next XR · Flex 2.0', style: AppTheme.caption),
        ),
      ],
    );
  }
}
