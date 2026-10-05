import 'package:flutter/material.dart';

import '../models/plan.dart';
import '../widgets/app_toast.dart';
import '../widgets/gym_tab_bar.dart';
import 'new_capture_screen.dart';
import 'plan_ready_screen.dart';
import 'plan_rejected_screen.dart';
import 'plans_screen.dart';
import 'profile_screen.dart';
import 'uploading_screen.dart';

/// Moves between the tab bar's destinations.
///
/// Home is always the bottom route. The other tabs replace whatever sits
/// above it, so hopping between tabs never builds up a back stack. New
/// capture is a flow, not a tab, so it is pushed on top.
void openTab(
  BuildContext context,
  GymTab tab, {
  required GymTab from,
  String? facility,
}) {
  if (tab == from && tab != GymTab.capture) return;

  final NavigatorState navigator = Navigator.of(context);

  Widget? screen;
  switch (tab) {
    case GymTab.home:
      navigator.popUntil((Route<dynamic> route) => route.isFirst);
      return;
    case GymTab.capture:
      navigator.push(
        MaterialPageRoute<void>(
          builder: (_) => NewCaptureScreen(initialFacility: facility),
        ),
      );
      return;
    case GymTab.plans:
      screen = const PlansScreen();
    case GymTab.uploads:
      screen = const UploadingScreen();
    case GymTab.profile:
      screen = const ProfileScreen();
  }

  navigator.pushAndRemoveUntil(
    MaterialPageRoute<void>(builder: (_) => screen!),
    (Route<dynamic> route) => route.isFirst,
  );
}

/// Opens whatever is useful for a plan in its current state. Plans that are
/// still with the platform have nothing to open yet, so they say why.
void openPlan(BuildContext context, Plan plan) {
  final Widget? screen = switch (plan.status) {
    PlanStatus.ready => PlanReadyScreen(plan: plan),
    PlanStatus.recapture => PlanRejectedScreen(plan: plan),
    PlanStatus.uploading => const UploadingScreen(),
    PlanStatus.inReview || PlanStatus.processing => null,
  };

  if (screen == null) {
    showAppToast(
      context,
      plan.status == PlanStatus.inReview
          ? 'A reviewer is checking this plan.'
          : 'The 3D model is still being generated.',
    );
    return;
  }
  Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => screen));
}
