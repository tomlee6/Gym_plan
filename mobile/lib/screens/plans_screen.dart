import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import '../models/plan.dart';
import '../services/api_client.dart';
import '../services/plans_service.dart';
import '../widgets/app_toast.dart';
import '../theme/app_theme.dart';
import '../widgets/detail_widgets.dart';
import '../widgets/gym_tab_bar.dart';
import '../widgets/home_cards.dart';
import '../widgets/nav_bar.dart';
import '../widgets/pressable.dart';
import 'tab_navigation.dart';

/// Filters on the "My plans" screen. Recaptures only show under "All",
/// matching the prototype: they are neither in progress nor ready.
enum PlanFilter {
  all('All'),
  inProgress('In progress'),
  ready('Ready');

  const PlanFilter(this.label);

  final String label;

  bool matches(Plan plan) => switch (this) {
    PlanFilter.all => true,
    PlanFilter.inProgress => plan.status.group == PlanGroup.inProgress,
    PlanFilter.ready => plan.status.group == PlanGroup.ready,
  };
}

class PlansScreen extends StatefulWidget {
  const PlansScreen({super.key});

  @override
  State<PlansScreen> createState() => _PlansScreenState();
}

class _PlansScreenState extends State<PlansScreen> {
  final PlansService _service = PlansService();

  List<Plan>? _plans;
  String? _error;
  PlanFilter _filter = PlanFilter.all;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final List<Plan> plans = await _service.plans();
      if (!mounted) return;
      setState(() {
        _plans = plans;
        _error = null;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      if (_plans == null) {
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

  String _countLabel(List<Plan> shown) {
    if (shown.isEmpty) return 'No plans';
    if (shown.length == 1) return '1 plan';
    final int sites = shown.map((Plan p) => p.site).toSet().length;
    return '${shown.length} plans across $sites '
        '${sites == 1 ? 'facility' : 'facilities'}';
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
                        openTab(context, GymTab.home, from: GymTab.plans),
                  ),
                ),
                Expanded(
                  child: _error != null
                      ? ErrorView(message: _error!, onRetry: _retry)
                      : _plans == null
                      ? const LoadingView()
                      : _buildContent(bottomInset),
                ),
              ],
            ),
          ),
          Positioned(
            left: 16,
            right: 16,
            bottom: bottomInset > 0 ? bottomInset : 20,
            child: GymTabBar(
              current: GymTab.plans,
              onSelect: (GymTab tab) =>
                  openTab(context, tab, from: GymTab.plans),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildContent(double bottomInset) {
    final List<Plan> shown = _plans!.where(_filter.matches).toList();

    return CustomScrollView(
      physics: const BouncingScrollPhysics(
        parent: AlwaysScrollableScrollPhysics(),
      ),
      slivers: <Widget>[
        CupertinoSliverRefreshControl(onRefresh: _load),
        SliverPadding(
          padding: EdgeInsets.fromLTRB(20, 6, 20, bottomInset + 96),
          sliver: SliverList.list(
            children: <Widget>[
              const Text('My plans', style: AppTheme.largeTitle),
              const SizedBox(height: 16),
              _FilterSegments(
                value: _filter,
                onChanged: (PlanFilter f) => setState(() => _filter = f),
              ),
              const SizedBox(height: 8),
              Text(
                _countLabel(shown),
                style: const TextStyle(
                  fontSize: 12.5,
                  color: AppColors.textMuted,
                ),
              ),
              const SizedBox(height: 12),
              for (int i = 0; i < shown.length; i++) ...<Widget>[
                if (i > 0) const SizedBox(height: 10),
                PlanRow(
                  plan: shown[i],
                  onTap: () => openPlan(context, shown[i]),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

/// Three-way segmented filter styled like the tab bar's active pill.
class _FilterSegments extends StatelessWidget {
  const _FilterSegments({required this.value, required this.onChanged});

  final PlanFilter value;
  final ValueChanged<PlanFilter> onChanged;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: AppColors.planCanvas,
        borderRadius: BorderRadius.circular(15),
        border: Border.all(color: AppColors.planBlockEdge),
      ),
      child: Row(
        children: <Widget>[
          for (final PlanFilter f in PlanFilter.values) ...<Widget>[
            if (f != PlanFilter.values.first) const SizedBox(width: 3),
            Expanded(
              child: Semantics(
                selected: f == value,
                child: Pressable(
                  onTap: () => onChanged(f),
                  haptic: HapticImpact.selection,
                  pressedScale: 0.96,
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 160),
                    height: 36,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: f == value
                          ? AppColors.tabActiveFill
                          : Colors.transparent,
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Text(
                      f.label,
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w600,
                        color: f == value
                            ? AppColors.accent
                            : AppColors.textMuted,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
