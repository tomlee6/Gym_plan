import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../services/auth_service.dart';
import '../services/upload_queue.dart';
import '../theme/app_theme.dart';
import '../utils/validators.dart';
import '../widgets/app_text_field.dart';
import '../widgets/brand_header.dart';
import '../widgets/primary_button.dart';
import 'forgot_password_screen.dart';
import 'home_screen.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final AuthService _auth = AuthService();

  /// The demo account the backend's seed creates (`npm run db:seed`),
  /// prefilled in debug builds only.
  static const String _demoEmail = 'sam.okafor@northgatefitness.com';
  static const String _demoPassword = 'flex1234';

  late final TextEditingController _emailController;
  late final TextEditingController _passwordController;
  final FocusNode _emailFocus = FocusNode();
  final FocusNode _passwordFocus = FocusNode();

  bool _obscurePassword = true;
  bool _busy = false;
  String? _emailError;
  String? _passwordError;
  String? _formError;

  @override
  void initState() {
    super.initState();
    // Pre-fill the demo account during development only; release builds start
    // empty.
    _emailController = TextEditingController(
      text: kDebugMode ? _demoEmail : '',
    );
    _passwordController = TextEditingController(
      text: kDebugMode ? _demoPassword : '',
    );
  }

  @override
  void dispose() {
    _emailController.dispose();
    _passwordController.dispose();
    _emailFocus.dispose();
    _passwordFocus.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    FocusScope.of(context).unfocus();

    final String? emailError = Validators.email(_emailController.text);
    final String? passwordError = Validators.password(_passwordController.text);

    setState(() {
      _emailError = emailError;
      _passwordError = passwordError;
      _formError = null;
    });

    if (emailError != null || passwordError != null) return;

    setState(() => _busy = true);

    final AuthResult result = await _auth.signIn(
      email: _emailController.text,
      password: _passwordController.text,
    );

    if (!mounted) return;
    setState(() => _busy = false);

    if (!result.ok) {
      HapticFeedback.heavyImpact();
      setState(() => _formError = result.error);
      return;
    }

    // Lets the iOS keychain offer to save the credentials.
    TextInput.finishAutofillContext();

    // An upload stopped by an expired sign-in can carry on now.
    UploadQueue.instance.retry();

    if (!mounted) return;
    Navigator.of(context).pushReplacement(
      MaterialPageRoute<void>(
        builder: (_) => HomeScreen(email: _emailController.text.trim()),
      ),
    );
  }

  void _openForgotPassword() {
    FocusScope.of(context).unfocus();
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) =>
            ForgotPasswordScreen(initialEmail: _emailController.text.trim()),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      // The scroll view below handles the keyboard, so the body must not be
      // resized as well.
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
                      padding: const EdgeInsets.fromLTRB(32, 48, 32, 40),
                      child: AutofillGroup(child: _buildForm()),
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

  Widget _buildForm() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        const Center(child: BrandHeader()),
        const SizedBox(height: 54),

        const Text('Sign in', style: AppTheme.title),
        const SizedBox(height: 10),
        const Text(
          'Use the same Flex account you use on the web. You will only see '
          'the gyms your account belongs to.',
          style: AppTheme.body,
        ),
        const SizedBox(height: 30),

        AppTextField(
          label: 'Email',
          controller: _emailController,
          focusNode: _emailFocus,
          errorText: _emailError,
          enabled: !_busy,
          hintText: 'you@yourgym.com',
          keyboardType: TextInputType.emailAddress,
          textInputAction: TextInputAction.next,
          autofillHints: const <String>[
            AutofillHints.username,
            AutofillHints.email,
          ],
          onSubmitted: (_) => _passwordFocus.requestFocus(),
        ),
        const SizedBox(height: 18),

        AppTextField(
          label: 'Password',
          controller: _passwordController,
          focusNode: _passwordFocus,
          errorText: _passwordError,
          enabled: !_busy,
          obscureText: _obscurePassword,
          textInputAction: TextInputAction.done,
          autofillHints: const <String>[AutofillHints.password],
          onSubmitted: (_) => _submit(),
          suffix: PasswordVisibilityToggle(
            obscured: _obscurePassword,
            onChanged: () =>
                setState(() => _obscurePassword = !_obscurePassword),
          ),
        ),
        const SizedBox(height: 14),

        Align(
          alignment: Alignment.centerRight,
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: _busy ? null : _openForgotPassword,
            child: const Padding(
              padding: EdgeInsets.symmetric(vertical: 4),
              child: Text(
                'Forgot password?',
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w500,
                  color: AppColors.accent,
                ),
              ),
            ),
          ),
        ),

        if (_formError != null) ...<Widget>[
          const SizedBox(height: 18),
          Row(
            children: <Widget>[
              const Icon(
                Icons.error_outline,
                size: 16,
                color: AppColors.danger,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  _formError!,
                  style: const TextStyle(fontSize: 13, color: AppColors.danger),
                ),
              ),
            ],
          ),
        ],

        const SizedBox(height: 30),
        PrimaryButton(label: 'Sign in', busy: _busy, onPressed: _submit),
        const SizedBox(height: 22),

        const InfoCard(
          icon: Icons.info_outline,
          message:
              'Scanning needs an iPhone 12 Pro or later. Devices without a '
              'LiDAR sensor are blocked at launch.',
        ),

        const Expanded(child: SizedBox(height: 24)),
        const Center(
          child: Text('Next XR · Flex 2.0', style: AppTheme.caption),
        ),
      ],
    );
  }
}
