import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/widgets/keyboard_dismiss.dart';

void main() {
  Widget app(FocusNode focus) => MaterialApp(
    builder: (BuildContext context, Widget? child) => dismissesKeyboard(child!),
    home: Scaffold(
      body: ListView(
        children: <Widget>[
          TextField(focusNode: focus),
          const SizedBox(height: 2000),
        ],
      ),
    ),
  );

  testWidgets('a tap outside the field closes the keyboard', (
    WidgetTester tester,
  ) async {
    final FocusNode focus = FocusNode();
    addTearDown(focus.dispose);
    await tester.pumpWidget(app(focus));

    await tester.tap(find.byType(TextField));
    await tester.pump();
    expect(focus.hasFocus, isTrue);

    await tester.tapAt(const Offset(200, 500));
    await tester.pump();
    expect(focus.hasFocus, isFalse);
  });

  testWidgets('dragging the page closes the keyboard', (
    WidgetTester tester,
  ) async {
    final FocusNode focus = FocusNode();
    addTearDown(focus.dispose);
    await tester.pumpWidget(app(focus));

    await tester.tap(find.byType(TextField));
    await tester.pump();
    expect(focus.hasFocus, isTrue);

    await tester.drag(find.byType(ListView), const Offset(0, -300));
    await tester.pump();
    expect(focus.hasFocus, isFalse);
  });
}
