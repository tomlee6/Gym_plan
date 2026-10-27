import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import '../models/plan.dart';
import '../services/api_client.dart';
import '../services/auth_service.dart';
import '../services/auth_session.dart';
import '../services/plans_service.dart';
import '../services/upload_queue.dart';
import '../theme/app_theme.dart';
import '../widgets/app_toast.dart';
import '../widgets/detail_widgets.dart';
import '../widgets/gym_tab_bar.dart';
import '../widgets/home_cards.dart';
import '../widgets/pressable.dart';
import 'login_screen.dart';
import 'tab_navigation.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.email});

  final String email;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  static const double _horizontalPadding = 20;

  final PlansService _plans = PlansService();

  GymTab _tab = GymTab.home;
  HomeData? _data;
  String? _error;

  /// Set while the home screen is built from the session cached on the
  /// phone because there is no signal (I-04): what the server would have
  /// said, and why it could not.
  String? _offline;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final HomeData data = await _plans.load();
      if (!mounted) return;
      setState(() {
        _data = data;
        _error = null;
        _offline = null;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      final SignedInUser? user = AuthSession.instance.user;
      // No signal, but the session is on the phone: open anyway, so a
      // capture can still be started. The upload waits for signal.
      if (e.offline && user != null && (_data == null || _offline != null)) {
        setState(() {
          _offline = e.message;
          _data = HomeData(
            gymName: AuthSession.instance.currentAccount?.name ?? 'Gym Scan',
            userInitials: user.initials,
            plans: const [],
            pendingUploads: UploadQueue.instance.pendingCount,
          );
        });
        return;
      }
      // Keep showing what was loaded before; only an empty screen needs
      // the error in its place.
      if (_data == null) {
        setState(() => _error = e.message);
      } else {
        showAppToast(context, e.message);
      }
    }
  }

  Future<void> _retry() async {
    setState(() => _error = null);
    await _load();
  }

  void _openNewCapture() => _onSelectTab(GymTab.capture);

  void _onSelectTab(GymTab tab) {
    if (tab == GymTab.home) {
      setState(() => _tab = tab);
      return;
    }
    // The other tabs sit on top of home, so home stays on the home tab.
    openTab(context, tab, from: GymTab.home, facility: _data?.gymName);
  }

  Future<void> _openAccountSheet() async {
    final bool? signOut = await showCupertinoModalPopup<bool>(
      context: context,
      builder: (BuildContext sheetContext) => CupertinoActionSheet(
        title: Text(widget.email),
        actions: <Widget>[
          CupertinoActionSheetAction(
            onPressed: () => Navigator.of(sheetContext).pop(false),
            child: const Text('Profile'),
          ),
          CupertinoActionSheetAction(
            isDestructiveAction: true,
            onPressed: () => Navigator.of(sheetContext).pop(true),
            child: const Text('Sign out'),
          ),
        ],
        cancelButton: CupertinoActionSheetAction(
          onPressed: () => Navigator.of(sheetContext).pop(),
          child: const Text('Cancel'),
        ),
      ),
    );

    if (!mounted) return;
    if (signOut == true) {
      await AuthService().signOut();
      if (!mounted) return;
      Navigator.of(context).pushReplacement(
        MaterialPageRoute<void>(builder: (_) => const LoginScreen()),
      );
    } else if (signOut == false) {
      _onSelectTab(GymTab.profile);
    }
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
            child: _error != null
                ? ErrorView(message: _error!, onRetry: _retry)
                : _data == null
                ? _buildLoading()
                : _buildContent(bottomInset),
          ),
          Positioned(
            left: 16,
            right: 16,
            bottom: bottomInset > 0 ? bottomInset : 20,
            child: GymTabBar(current: _tab, onSelect: _onSelectTab),
          ),
        ],
      ),
    );
  }

  Widget _buildLoading() {
    return const Center(
      child: CupertinoActivityIndicator(color: AppColors.textMuted, radius: 12),
    );
  }

  Widget _buildContent(double bottomInset) {
    final HomeData data = _data!;

    return CustomScrollView(
      physics: const BouncingScrollPhysics(
        parent: AlwaysScrollableScrollPhysics(),
      ),
      slivers: <Widget>[
        CupertinoSliverRefreshControl(onRefresh: _load),
        SliverPadding(
          padding: EdgeInsets.fromLTRB(
            _horizontalPadding,
            16,
            _horizontalPadding,
            // Clear the floating tab bar plus the home indicator.
            bottomInset + 96,
          ),
          sliver: SliverList.list(
            children: <Widget>[
              _buildHeader(data),
              const SizedBox(height: 22),
              CaptureCard(
                subtitle: 'Walk the perimeter · about 12 min',
                onTap: _openNewCapture,
              ),
              const SizedBox(height: 28),
              if (_offline != null)
                _OfflineNotice(message: _offline!, onRetry: _load)
              else ...<Widget>[
                _buildSectionHeader(),
                const SizedBox(height: 12),
                ..._buildPlanRows(data.plans),
              ],
              if (data.pendingUploads > 0) ...<Widget>[
                const SizedBox(height: 24),
                PendingUploadBanner(
                  count: data.pendingUploads,
                  onView: () => _onSelectTab(GymTab.uploads),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildHeader(HomeData data) {
    return Row(
      children: <Widget>[
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                data.gymName,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: AppTheme.label,
              ),
              const SizedBox(height: 3),
              const Text('Gym Scan', style: AppTheme.screenTitle),
            ],
          ),
        ),
        const SizedBox(width: 12),
        Pressable(
          onTap: _openAccountSheet,
          haptic: HapticImpact.selection,
          semanticLabel: 'Your profile',
          child: Container(
            width: 44,
            height: 44,
            alignment: Alignment.center,
            decoration: const BoxDecoration(
              color: AppColors.avatarFill,
              shape: BoxShape.circle,
            ),
            child: Text(
              data.userInitials,
              style: const TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w600,
                color: AppColors.accent,
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildSectionHeader() {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.baseline,
      textBaseline: TextBaseline.alphabetic,
      children: <Widget>[
        const Expanded(
          child: Text('Recent plans', style: AppTheme.sectionTitle),
        ),
        Pressable(
          onTap: () => _onSelectTab(GymTab.plans),
          haptic: HapticImpact.selection,
          child: const Padding(
            padding: EdgeInsets.symmetric(vertical: 4, horizontal: 2),
            child: Text('View all', style: AppTheme.link),
          ),
        ),
      ],
    );
  }

  List<Widget> _buildPlanRows(List<Plan> plans) {
    final List<Widget> rows = <Widget>[];
    for (int i = 0; i < plans.length; i++) {
      if (i > 0) rows.add(const SizedBox(height: 10));
      rows.add(
        PlanRow(plan: plans[i], onTap: () => openPlan(context, plans[i])),
      );
    }
    return rows;
  }
}

/// Shown in place of the plan list when the app opened without signal.
class _OfflineNotice extends StatelessWidget {
  const _OfflineNotice({required this.message, required this.onRetry});

  final String message;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    return StatusCallout(
      color: AppColors.warning,
      icon: Icons.cloud_off_rounded,
      title: 'Offline',
      subtitle: message,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Text(
            'Your plans load when you are back online. You can still start '
            'a capture; it uploads once there is signal.',
            style: AppTheme.caption,
          ),
          const SizedBox(height: 10),
          Pressable(
            onTap: onRetry,
            haptic: HapticImpact.selection,
            semanticLabel: 'Try again',
            child: const Padding(
              padding: EdgeInsets.symmetric(vertical: 4),
              child: Text('Try again', style: AppTheme.link),
            ),
          ),
        ],
      ),
    );
  }
}
