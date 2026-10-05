# Flex Gym Scan — mobile

Flutter client for Gym Scan. iOS is the primary target; Android is kept working.

## Status

Implemented so far:

- **Login** (`lib/screens/login_screen.dart`)
- **Forgot password** (`lib/screens/forgot_password_screen.dart`)
- **Home** (`lib/screens/home_screen.dart`) — header, New capture card, Recent
  plans list, pending-upload banner and the floating tab bar.
- **New capture** (`lib/screens/new_capture_screen.dart`) — facility picker,
  level and floor-to-floor height, device check and the pre-scan checklist.

The New capture card and the tab bar's `+` both open New capture. Plans,
Uploads, Profile, a plan row and "Start scan" show a short toast naming what is
coming rather than silently doing nothing.

## Auth is mocked

There is no backend yet. `lib/services/mock_auth_service.dart` fakes a ~1.2s
round trip so the screens exercise their loading and error states.

| Field    | Value                             |
| -------- | --------------------------------- |
| Email    | `sam.okafor@northgatefitness.com` |
| Password | `flex1234`                        |

Anything else fails with "Incorrect email or password." Debug builds pre-fill
these credentials; release builds start with empty fields.

Password reset always reports success, even for an unknown address — confirming
whether an account exists would let anyone enumerate Flex users. The real
endpoint should keep that behaviour.

To wire up the real API, replace the bodies of `signIn` and
`sendPasswordReset`. The UI only depends on their signatures.

## Mock data

`lib/services/mock_plans_service.dart` returns the three sample plans and the
queued-upload count from the prototype after a ~0.7s delay, so the loading
spinner and pull-to-refresh are real. Swap `load()` for an HTTP call when the
backend is ready.

`lib/services/mock_capture_service.dart` supplies the facility list and the
device check. Its `checkDevice()` currently returns a canned "LiDAR ready";
the real one should ask ARKit whether scene reconstruction is available rather
than matching model names. Pass `deviceOverride` to exercise the blocked path.

Floor-to-floor height is validated to 2.0–12.0 m, since the 3D model extrudes
walls to whatever is entered.

## Design

Colours, spacing and radii come from `Gym Scan — Mobile Prototype (iOS).html`
in the repo root and live in `lib/theme/app_theme.dart`. The brand mark is
`assets/images/flex_motion_logo.png`, rendered by `lib/widgets/brand_header.dart`.

## iOS notes

- Portrait only on iPhone (`Info.plist` + `SystemChrome`).
- Launch screen and Android window background are set to `#01060A` so there is
  no white flash before the first frame.
- Text fields set `keyboardAppearance: Brightness.dark`; the iOS keyboard would
  otherwise come up light against the dark UI.
- `AutofillGroup` plus `TextInput.finishAutofillContext()` let the iOS keychain
  offer to save credentials.
- Page transitions use `CupertinoPageTransitionsBuilder` on both platforms.
- Home uses `CupertinoSliverRefreshControl` for pull-to-refresh and bouncing
  scroll physics.
- The floating tab bar is translucent over a `BackdropFilter` blur, so content
  scrolling underneath stays visible but unreadable.
- The avatar chip opens a `CupertinoActionSheet` (currently Profile / Sign out).
- The facility select is a `CupertinoPicker` sheet with Cancel / Done, not a
  Material dropdown.
- New capture lets the body resize for the keyboard so the focused field
  scrolls into view; the numeric keypads have no return key, so tapping
  anywhere off a field dismisses them.

## Run

```sh
flutter pub get
flutter run            # add -d <device> to pick a simulator or emulator
flutter test
flutter analyze
```
