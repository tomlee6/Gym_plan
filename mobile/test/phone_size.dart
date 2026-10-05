import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

/// Renders at an iPhone 15 Pro's logical size (393 × 852) instead of the
/// default 800 × 600 test surface, which is shorter than the screens are
/// designed for.
void usePhoneSize(WidgetTester tester) {
  tester.view.physicalSize = const Size(393, 852) * 3;
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
}
