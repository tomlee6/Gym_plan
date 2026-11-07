import 'package:flutter/widgets.dart';

/// Makes the keyboard easy to put away everywhere in the app:
///
/// * a tap anywhere outside the field being typed in closes the keyboard
///   (Flutter only does this for a mouse by default, so on a phone the
///   keyboard stayed up, and the iOS number pad has no key to close it), and
/// * dragging any list or page closes it too, as in iOS Settings.
///
/// Wraps the whole app once, so every field gets it, including ones added
/// later.
Widget dismissesKeyboard(Widget child) {
  return Actions(
    actions: <Type, Action<Intent>>{
      EditableTextTapOutsideIntent:
          CallbackAction<EditableTextTapOutsideIntent>(
            onInvoke: (EditableTextTapOutsideIntent intent) {
              intent.focusNode.unfocus();
              return null;
            },
          ),
    },
    child: Builder(
      builder: (BuildContext context) => ScrollConfiguration(
        behavior: ScrollConfiguration.of(context).copyWith(
          keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
        ),
        child: child,
      ),
    ),
  );
}
