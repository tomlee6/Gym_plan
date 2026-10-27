import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import '../services/api_client.dart';
import '../services/auth_service.dart';
import '../services/auth_session.dart';
import '../services/profile_service.dart';
import '../theme/app_theme.dart';
import '../widgets/app_toast.dart';
import '../widgets/brand_header.dart';
import '../widgets/detail_widgets.dart';
import '../widgets/hairline_container.dart';
import '../widgets/nav_bar.dart';
import '../widgets/pressable.dart';
import '../widgets/primary_button.dart';
import 'home_screen.dart';
import 'login_screen.dart';

/// Chooses the gym account to work in.
///
/// A person can belong to several gym accounts (an owner of one group and
/// a contract surveyor for another); every capture, plan and facility
/// belongs to exactly one, so the app has to know which. Shown after
/// sign-in when there is more than one, and from Profile to switch. The
/// choice is remembered in the Keychain, so it is asked once, not at every
/// launch.
class AccountPickerScreen extends StatelessWidget {
  const AccountPickerScreen({super.key, this.switching = false, this.session});

  /// Opened from Profile: offers a way back and marks the current account.
  final bool switching;

  /// Defaults to [AuthSession.instance].
  final AuthSession? session;

  void _choose(BuildContext context, AuthSession session, Account account) {
    session.selectAccount(account.id);
    // Everything on screen belonged to the old account, so start again
    // from home in the new one.
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute<void>(
        builder: (_) => HomeScreen(email: session.user?.email ?? ''),
      ),
      (Route<dynamic> _) => false,
    );
  }

  @override
  Widget build(BuildContext context) {
    final AuthSession s = session ?? AuthSession.instance;
    final List<Account> accounts = s.accounts;

    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            if (switching)
              Padding(
                padding: const EdgeInsets.only(left: 8, right: 12),
                child: NavBar(
                  backLabel: 'Profile',
                  onBack: () => Navigator.of(context).maybePop(),
                ),
              )
            else
              const SizedBox(height: 32),
            Expanded(
              child: ListView(
                physics: const BouncingScrollPhysics(),
                padding: const EdgeInsets.fromLTRB(20, 10, 20, 24),
                children: <Widget>[
                  Text(
                    switching ? 'Switch account' : 'Choose an account',
                    style: AppTheme.largeTitle,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    s.user == null
                        ? 'Your captures and plans belong to one gym account '
                              'at a time.'
                        : '${s.user!.name}, you belong to ${accounts.length} '
                              'gym accounts. Captures and plans belong to the '
                              'one you pick; you can switch later in Profile.',
                    style: AppTheme.body,
                  ),
                  const SizedBox(height: 22),
                  for (final Account a in accounts) ...<Widget>[
                    _AccountRow(
                      account: a,
                      current: switching && a.id == s.currentAccountId,
                      onTap: () => _choose(context, s, a),
                    ),
                    const SizedBox(height: 10),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _AccountRow extends StatelessWidget {
  const _AccountRow({
    required this.account,
    required this.current,
    required this.onTap,
  });

  final Account account;
  final bool current;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Pressable(
      onTap: onTap,
      haptic: HapticImpact.selection,
      pressedScale: 0.98,
      semanticLabel: '${account.name}, ${account.roleLabel}',
      child: HairlineContainer(
        radius: 17,
        borderColors: current
            ? AppColors.edgeInto(AppColors.accent)
            : AppColors.hairline,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        child: Row(
          children: <Widget>[
            Container(
              width: 38,
              height: 38,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: AppColors.accent.withValues(alpha: 0.15),
                borderRadius: BorderRadius.circular(12),
              ),
              child: const Icon(
                Icons.home_work_outlined,
                size: 19,
                color: AppColors.accent,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    account.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                      color: AppColors.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(account.roleLabel, style: AppTheme.label),
                ],
              ),
            ),
            Icon(
              current ? Icons.check_circle : CupertinoIcons.chevron_right,
              size: current ? 20 : 16,
              color: current ? AppColors.accent : AppColors.chevron,
            ),
          ],
        ),
      ),
    );
  }
}

/// Signed in at GoalCert, but a member of no gym account.
///
/// Flex staff without a gym membership land here too: reviewing happens in
/// the web app, and the phone only captures for gym accounts. "Check again"
/// reloads the memberships, for someone who has just accepted an invite.
class NoAccessScreen extends StatefulWidget {
  const NoAccessScreen({super.key});

  @override
  State<NoAccessScreen> createState() => _NoAccessScreenState();
}

class _NoAccessScreenState extends State<NoAccessScreen> {
  bool _checking = false;

  Future<void> _checkAgain() async {
    setState(() => _checking = true);
    try {
      await ProfileService().load();
    } on ApiException catch (e) {
      if (mounted) showAppToast(context, e.message);
    }
    if (!mounted) return;
    setState(() => _checking = false);
    final AuthSession session = AuthSession.instance;
    if (!session.signedIn || session.hasNoAccounts) return;
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute<void>(
        builder: (_) => session.needsAccountChoice
            ? const AccountPickerScreen()
            : HomeScreen(email: session.user?.email ?? ''),
      ),
      (Route<dynamic> _) => false,
    );
  }

  Future<void> _signOut() async {
    await AuthService().signOut();
    if (!mounted) return;
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute<void>(builder: (_) => const LoginScreen()),
      (Route<dynamic> _) => false,
    );
  }

  @override
  Widget build(BuildContext context) {
    final SignedInUser? user = AuthSession.instance.user;
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(32, 48, 32, 32),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              const Center(child: BrandHeader()),
              const Spacer(),
              const Icon(
                Icons.lock_person_outlined,
                size: 40,
                color: AppColors.textMuted,
              ),
              const SizedBox(height: 14),
              const Text(
                'No gym access yet',
                textAlign: TextAlign.center,
                style: AppTheme.title,
              ),
              const SizedBox(height: 8),
              Text(
                '${user == null ? 'Your account' : user.email} is '
                'not a member of any gym account, so there is nothing to scan '
                'for. Ask your gym\'s account owner to invite you, then check '
                'again.',
                textAlign: TextAlign.center,
                style: AppTheme.body,
              ),
              const Spacer(),
              PrimaryButton(
                label: 'Check again',
                busy: _checking,
                onPressed: _checkAgain,
              ),
              const SizedBox(height: 8),
              SecondaryAction(label: 'Sign out', onTap: _signOut),
            ],
          ),
        ),
      ),
    );
  }
}
