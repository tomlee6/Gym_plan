import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../services/auth_service.dart';
import '../theme/app_theme.dart';
import '../utils/validators.dart';
import '../widgets/app_text_field.dart';
import '../widgets/brand_header.dart';
import '../widgets/primary_button.dart';

class ForgotPasswordScreen extends StatefulWidget {
  const ForgotPasswordScreen({super.key, this.initialEmail = ''});

  /// Carried over from the login screen so the user does not retype it.
  final String initialEmail;

  @override
  State<ForgotPasswordScreen> createState() => _ForgotPasswordScreenState();
}

class _ForgotPasswordScreenState extends State<ForgotPasswordScreen> {
  final AuthService _auth = AuthService();

  late final TextEditingController _emailController;

  bool _busy = false;
  bool _sent = false;
  String? _emailError;

  @override
  void initState() {
    super.initState();
    _emailController = TextEditingController(text: widget.initialEmail);
  }

  @override
  void dispose() {
    _emailController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    FocusScope.of(context).unfocus();

    final String? emailError = Validators.email(_emailController.text);
    setState(() => _emailError = emailError);
    if (emailError != null) return;

    setState(() => _busy = true);
    final AuthResult result = await _auth.sendPasswordReset(
      email: _emailController.text.trim(),
    );

    if (!mounted) return;
    if (!result.ok) {
      // e.g. no signal; the backend itself never says an address is unknown.
      setState(() {
        _busy = false;
        _emailError = result.error;
      });
      return;
    }
    HapticFeedback.mediumImpact();
    setState(() {
      _busy = false;
      _sent = true;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      resizeToAvoidBottomInset: false,
      body: GestureDetector(
        onTap: () => FocusScope.of(context).unfocus(),
        behavior: HitTestBehavior.opaque,
        child: SafeArea(
          child: LayoutBuilder(
            builder: (BuildContext context, BoxConstraints constraints) {
              return SingleChildScrollView(
                padding: EdgeInsets.only(
                  bottom: MediaQuery.viewInsetsOf(context).bottom,
                ),
                child: ConstrainedBox(
                  constraints: BoxConstraints(minHeight: constraints.maxHeight),
                  child: IntrinsicHeight(
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(32, 12, 32, 40),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: <Widget>[
                          _buildBackButton(),
                          const SizedBox(height: 20),
                          const Center(child: BrandHeader(logoWidth: 160)),
                          const SizedBox(height: 46),
                          // The form and the confirmation share this slot.
                          AnimatedSwitcher(
                            duration: const Duration(milliseconds: 260),
                            switchInCurve: Curves.easeOut,
                            child: _sent ? _buildSentState() : _buildForm(),
                          ),
                          const Expanded(child: SizedBox(height: 24)),
                          const Center(
                            child: Text(
                              'Next XR · Flex 2.0',
                              style: AppTheme.caption,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              );
            },
          ),
        ),
      ),
    );
  }

  Widget _buildBackButton() {
    return Align(
      alignment: Alignment.centerLeft,
      child: Semantics(
        button: true,
        label: 'Back to sign in',
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: () => Navigator.of(context).maybePop(),
          child: const SizedBox(
            width: 44,
            height: 44,
            child: Icon(
              CupertinoIcons.chevron_left,
              size: 22,
              color: AppColors.textPrimary,
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildForm() {
    return Column(
      key: const ValueKey<String>('form'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        const Text('Forgot password?', style: AppTheme.title),
        const SizedBox(height: 10),
        const Text(
          'Enter the email on your Flex account and we will send you a link '
          'to set a new password.',
          style: AppTheme.body,
        ),
        const SizedBox(height: 30),

        AutofillGroup(
          child: AppTextField(
            label: 'Email',
            controller: _emailController,
            errorText: _emailError,
            enabled: !_busy,
            hintText: 'you@yourgym.com',
            keyboardType: TextInputType.emailAddress,
            textInputAction: TextInputAction.done,
            autofillHints: const <String>[
              AutofillHints.username,
              AutofillHints.email,
            ],
            onSubmitted: (_) => _submit(),
          ),
        ),
        const SizedBox(height: 30),

        PrimaryButton(
          label: 'Send reset link',
          busy: _busy,
          onPressed: _submit,
        ),
        const SizedBox(height: 22),

        const InfoCard(
          icon: Icons.info_outline,
          message:
              'The link expires in 30 minutes. If your gym uses single '
              'sign-on, ask your gym admin to reset it for you instead.',
        ),
      ],
    );
  }

  Widget _buildSentState() {
    return Column(
      key: const ValueKey<String>('sent'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        const Text('Check your inbox', style: AppTheme.title),
        const SizedBox(height: 10),
        Text.rich(
          TextSpan(
            style: AppTheme.body,
            children: <InlineSpan>[
              const TextSpan(text: 'If an account exists for '),
              TextSpan(
                text: _emailController.text.trim(),
                style: const TextStyle(
                  color: AppColors.textPrimary,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const TextSpan(
                text:
                    ', a reset link is on its way. It can take a minute to '
                    'arrive.',
              ),
            ],
          ),
        ),
        const SizedBox(height: 30),

        const InfoCard(
          icon: Icons.mark_email_read_outlined,
          iconColor: AppColors.accent,
          message:
              'No email? Check your spam folder, then confirm you used the '
              'address your gym registered with Flex.',
        ),
        const SizedBox(height: 26),

        PrimaryButton(
          label: 'Back to sign in',
          onPressed: () => Navigator.of(context).maybePop(),
        ),
        const SizedBox(height: 18),

        Center(
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: () => setState(() => _sent = false),
            child: const Padding(
              padding: EdgeInsets.symmetric(vertical: 6, horizontal: 12),
              child: Text(
                'Use a different email',
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w500,
                  color: AppColors.accent,
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}
