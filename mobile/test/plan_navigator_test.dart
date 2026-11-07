import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/widgets/plan_navigator.dart';

void main() {
  group('PlanView', () {
    const Size size = Size(300, 200);

    test('fitted maps every point to itself', () {
      const Offset p = Offset(40, 70);
      expect(PlanView.fitted.toScreen(size, p), p);
      expect(PlanView.fitted.isFitted, isTrue);
    });

    test('zooming about a point keeps that point still', () {
      const Offset focus = Offset(220, 50);
      final PlanView v = PlanView.fitted.about(size, focus, scale: 3);
      final Offset under = PlanView.fitted.toLocal(size, focus);
      expect((v.toScreen(size, under) - focus).distance, lessThan(1e-9));
    });

    test('turns a full 360 degrees and back to where it started', () {
      PlanView v = PlanView.fitted;
      for (int i = 0; i < 4; i++) {
        v = v.about(size, size.center(Offset.zero), rotation: v.rotation + math.pi / 2);
      }
      expect(v.degrees, 0);
      expect(v.isFitted, isTrue);
    });

    test('toLocal undoes toScreen when zoomed, turned and moved', () {
      const PlanView v = PlanView(scale: 2.5, rotation: 1.1, offset: Offset(13, -7));
      const Offset p = Offset(12, 160);
      expect((v.toLocal(size, v.toScreen(size, p)) - p).distance, lessThan(1e-9));
    });
  });

  group('PlanNavigator', () {
    late double rotation;

    Widget app() => MaterialApp(
      home: Scaffold(
        body: SizedBox(
          width: 400,
          height: 400,
          child: PlanNavigator(
            builder: (_, double r) {
              rotation = r;
              return const ColoredBox(color: Colors.blue, child: SizedBox.expand());
            },
          ),
        ),
      ),
    );

    Matrix4 planMatrix(WidgetTester tester) =>
        tester.widget<Transform>(find.byType(Transform).first).transform;

    testWidgets('zoom buttons zoom in and out', (WidgetTester tester) async {
      await tester.pumpWidget(app());
      expect(planMatrix(tester).getMaxScaleOnAxis(), closeTo(1, 1e-9));

      await tester.tap(find.bySemanticsLabel('Zoom in'));
      await tester.pump();
      expect(planMatrix(tester).getMaxScaleOnAxis(), closeTo(PlanNavigator.zoomStep, 1e-6));

      await tester.tap(find.bySemanticsLabel('Zoom out'));
      await tester.pump();
      expect(planMatrix(tester).getMaxScaleOnAxis(), closeTo(1, 1e-6));
    });

    testWidgets('rotate turns the plan a quarter, and reset puts it back', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(app());
      await tester.tap(find.bySemanticsLabel('Rotate 90 degrees'));
      await tester.pump();
      expect(rotation, closeTo(math.pi / 2, 1e-9));
      expect(find.text('90°'), findsOneWidget);

      await tester.tap(find.bySemanticsLabel(RegExp('Reset plan view')));
      await tester.pump();
      expect(rotation, 0);
      expect(find.text('90°'), findsNothing);
    });
  });
}
