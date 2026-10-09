import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import '../services/api_client.dart';
import '../services/auth_service.dart';
import '../services/auth_session.dart';
import '../services/profile_service.dart';
import '../widgets/app_toast.dart';
import '../services/upload_queue.dart';
import '../theme/app_theme.dart';
import '../widgets/detail_widgets.dart';
import '../widgets/gym_tab_bar.dart';
import '../widgets/hairline_container.dart';
import '../widgets/nav_bar.dart';
import '../widgets/pressable.dart';
import 'account_picker_screen.dart';
import 'login_screen.dart';
import 'tab_navigation.dart';

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  final ProfileService _service = ProfileService();
  final CaptureSettings _settings = CaptureSettings.instance;

  ProfileData? _profile;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final ProfileData profile = await _service.load();
      if (!mounted) return;
      setState(() => _profile = profile);
      // The server's settings may differ from the ones the queue started
      // with, e.g. changed on another phone.
      await UploadQueue.instance.setUploadOnMobileData(
        _settings.uploadOnMobileData,
      );
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  /// Shows the change at once, saves it, and puts it back if saving fails.
  Future<void> _saveSetting({
    bool? uploadOnMobileData,
    bool? warnBeforePhotos,
  }) async {
    final bool oldMobile = _settings.uploadOnMobileData;
    final bool oldWarn = _settings.warnBeforePhotos;
    setState(() {
      _settings.uploadOnMobileData = uploadOnMobileData ?? oldMobile;
      _settings.warnBeforePhotos = warnBeforePhotos ?? oldWarn;
    });
    try {
      await _service.updateSettings(
        uploadOnMobileData: uploadOnMobileData,
        warnBeforePhotos: warnBeforePhotos,
      );
      if (uploadOnMobileData != null) {
        await UploadQueue.instance.setUploadOnMobileData(uploadOnMobileData);
      }
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _settings.uploadOnMobileData = oldMobile;
        _settings.warnBeforePhotos = oldWarn;
      });
      showAppToast(context, e.message);
    }
  }

  Future<void> _signOut() async {
    final bool? confirmed = await showCupertinoModalPopup<bool>(
      context: context,
      builder: (BuildContext sheetContext) => CupertinoActionSheet(
        title: Text(_profile?.email ?? ''),
        message: UploadQueue.instance.pendingCount > 0
            ? const Text(
                'A capture is still uploading. It resumes the next time you '
                'sign in on this iPhone.',
              )
            : null,
        actions: <Widget>[
          CupertinoActionSheetAction(
            isDestructiveAction: true,
            onPressed: () => Navigator.of(sheetContext).pop(true),
            child: const Text('Sign out'),
          ),
        ],
        cancelButton: CupertinoActionSheetAction(
          onPressed: () => Navigator.of(sheetContext).pop(false),
          child: const Text('Cancel'),
        ),
      ),
    );
    if (confirmed != true || !mounted) return;

    // Pending uploads stay queued and carry on after the next sign-in.
    await AuthService().signOut();
    if (!mounted) return;

    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute<void>(builder: (_) => const LoginScreen()),
      (Route<dynamic> _) => false,
    );
  }

  @override
  Widget build(BuildContext context) {
    final double bottomInset = MediaQuery.paddingOf(context).bottom;

    return Scaffold(
      backgroundColor: AppColors.background,
      body: Stack(
        children: <Widget>[
          SafeArea(
            bottom: false,
            child: Column(
              children: <Widget>[
                Padding(
                  padding: const EdgeInsets.only(left: 8, right: 12),
                  child: NavBar(
                    backLabel: 'Home',
                    onBack: () =>
                        openTab(context, GymTab.home, from: GymTab.profile),
                  ),
                ),
                Expanded(
                  child: _error != null
                      ? ErrorView(message: _error!, onRetry: _load)
                      : _profile == null
                      ? const LoadingView()
                      : _buildContent(_profile!, bottomInset),
                ),
              ],
            ),
          ),
          Positioned(
            left: 16,
            right: 16,
            bottom: bottomInset > 0 ? bottomInset : 20,
            child: GymTabBar(
              current: GymTab.profile,
              onSelect: (GymTab tab) =>
                  openTab(context, tab, from: GymTab.profile),
            ),
          ),
        ],
      ),
    );
  }

  /// Another gym account: everything on screen changes with it, so the
  /// picker starts the app again from home.
  void _switchAccount() {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => const AccountPickerScreen(switching: true),
      ),
    );
  }

  Widget _buildContent(ProfileData p, double bottomInset) {
    final bool canSwitch = AuthSession.instance.accounts.length > 1;
    return SingleChildScrollView(
      physics: const BouncingScrollPhysics(),
      padding: EdgeInsets.fromLTRB(20, 10, 20, bottomInset + 96),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          _buildIdentity(p),
          const SizedBox(height: 24),
          _Group(
            label: 'Account',
            children: <Widget>[
              _SettingRow(
                label: 'Account',
                trailing: Flexible(
                  child: Text(
                    p.organisation,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    textAlign: TextAlign.right,
                    style: const TextStyle(
                      fontSize: 13.5,
                      color: AppColors.textMuted,
                    ),
                  ),
                ),
              ),
              if (canSwitch)
                _SettingRow(
                  icon: Icons.swap_horiz_rounded,
                  label: 'Switch account',
                  onTap: _switchAccount,
                  trailing: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      _mutedValue(
                        '${AuthSession.instance.accounts.length} accounts',
                      ),
                      const SizedBox(width: 8),
                      const Icon(
                        CupertinoIcons.chevron_right,
                        size: 16,
                        color: AppColors.chevron,
                      ),
                    ],
                  ),
                ),
              _SettingRow(
                label: 'Facilities',
                trailing: _mutedValue('${p.facilities}'),
              ),
              _SettingRow(
                label: 'Plan quota',
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    _QuotaBar(used: p.plansUsed, total: p.planQuota),
                    const SizedBox(width: 10),
                    _mutedValue('${p.plansUsed} of ${p.planQuota}'),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 20),
          ListenableBuilder(
            listenable: UploadQueue.instance,
            builder: (BuildContext context, Widget? _) =>
                _buildCaptureGroup(UploadQueue.instance.pendingCount),
          ),
          const SizedBox(height: 20),
          Pressable(
            onTap: _signOut,
            pressedScale: 0.98,
            semanticLabel: 'Sign out',
            child: const HairlineContainer(
              radius: 19,
              child: SizedBox(
                height: 50,
                child: Center(
                  child: Text(
                    'Sign out',
                    style: TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                      color: AppColors.danger,
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildIdentity(ProfileData p) {
    return Row(
      children: <Widget>[
        Container(
          width: 62,
          height: 62,
          alignment: Alignment.center,
          decoration: const BoxDecoration(
            color: AppColors.avatarFill,
            shape: BoxShape.circle,
          ),
          child: Text(
            p.initials,
            style: const TextStyle(
              fontSize: 21,
              fontWeight: FontWeight.w600,
              color: AppColors.accent,
            ),
          ),
        ),
        const SizedBox(width: 15),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                p.name,
                style: const TextStyle(
                  fontSize: 21,
                  fontWeight: FontWeight.w700,
                  letterSpacing: -0.3,
                  color: AppColors.textPrimary,
                ),
              ),
              const SizedBox(height: 3),
              Text(
                p.role,
                style: const TextStyle(
                  fontSize: 13,
                  color: AppColors.textMuted,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildCaptureGroup(int pending) {
    return _Group(
      label: 'Capture',
      children: <Widget>[
        _SettingRow(
          icon: Icons.file_upload_outlined,
          label: 'Captures waiting to upload',
          onTap: () => openTab(context, GymTab.uploads, from: GymTab.profile),
          trailing: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              if (pending > 0) ...<Widget>[
                Container(
                  constraints: const BoxConstraints(minWidth: 20),
                  height: 20,
                  padding: const EdgeInsets.symmetric(horizontal: 6),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: AppColors.accent,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Text(
                    '$pending',
                    style: const TextStyle(
                      fontSize: 11.5,
                      fontWeight: FontWeight.w700,
                      color: AppColors.background,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
              ],
              const Icon(
                CupertinoIcons.chevron_right,
                size: 16,
                color: AppColors.chevron,
              ),
            ],
          ),
        ),
        _SettingRow(
          icon: Icons.signal_cellular_alt_rounded,
          label: 'Upload on mobile data',
          trailing: _Switch(
            value: _settings.uploadOnMobileData,
            label: 'Upload on mobile data',
            onChanged: (bool v) => _saveSetting(uploadOnMobileData: v),
          ),
        ),
        _SettingRow(
          icon: Icons.photo_camera_outlined,
          label: 'Warn before photos',
          trailing: _Switch(
            value: _settings.warnBeforePhotos,
            label: 'Warn before photos',
            onChanged: (bool v) => _saveSetting(warnBeforePhotos: v),
          ),
        ),
      ],
    );
  }

  Widget _mutedValue(String text) => Text(
    text,
    style: const TextStyle(fontSize: 13.5, color: AppColors.textMuted),
  );
}

/// Uppercase heading over a hairline card of rows.
class _Group extends StatelessWidget {
  const _Group({required this.label, required this.children});

  final String label;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(label.toUpperCase(), style: AppTheme.groupLabel),
        const SizedBox(height: 9),
        HairlineContainer(
          radius: 19,
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
          child: Column(
            children: <Widget>[
              for (int i = 0; i < children.length; i++) ...<Widget>[
                if (i > 0) const Divider(height: 1, color: AppColors.divider),
                children[i],
              ],
            ],
          ),
        ),
      ],
    );
  }
}

class _SettingRow extends StatelessWidget {
  const _SettingRow({
    required this.label,
    required this.trailing,
    this.icon,
    this.onTap,
  });

  final String label;
  final Widget trailing;
  final IconData? icon;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final Widget row = SizedBox(
      height: 48,
      child: Row(
        children: <Widget>[
          if (icon != null) ...<Widget>[
            Icon(icon, size: 19, color: AppColors.accent),
            const SizedBox(width: 12),
          ],
          Expanded(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 14,
                color: AppColors.textPrimary,
              ),
            ),
          ),
          const SizedBox(width: 10),
          trailing,
        ],
      ),
    );

    if (onTap == null) return row;
    return Pressable(
      onTap: onTap,
      haptic: HapticImpact.selection,
      pressedScale: 0.99,
      semanticLabel: label,
      child: row,
    );
  }
}

class _Switch extends StatelessWidget {
  const _Switch({
    required this.value,
    required this.label,
    required this.onChanged,
  });

  final bool value;
  final String label;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: label,
      child: CupertinoSwitch(
        value: value,
        activeTrackColor: AppColors.accent,
        inactiveTrackColor: AppColors.track,
        onChanged: onChanged,
      ),
    );
  }
}

class _QuotaBar extends StatelessWidget {
  const _QuotaBar({required this.used, required this.total});

  final int used;
  final int total;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(3),
      child: SizedBox(
        width: 58,
        height: 6,
        child: Stack(
          children: <Widget>[
            const Positioned.fill(child: ColoredBox(color: AppColors.track)),
            FractionallySizedBox(
              widthFactor: total == 0 ? 0 : (used / total).clamp(0, 1),
              heightFactor: 1,
              child: const ColoredBox(color: AppColors.accent),
            ),
          ],
        ),
      ),
    );
  }
}
