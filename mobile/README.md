# Flex Gym Scan — mobile

Flutter client for Gym Scan. iOS 17+ on a LiDAR iPhone is the target;
Android and desktop still build, and run the simulated scan in debug builds.

The app talks only to the Gym Plan backend, using the contract in
`../backend/docs/api-contract-v2.md` (sign-in, accounts, sessions) and
`docs/upload-api.md` (capture upload).

## Signing in (B-06, B-08, B-03)

There are no passwords in the app. "Sign in with GoalCert" runs the Hub's
OpenID Connect authorization-code flow with PKCE
(`lib/services/hub_auth.dart`, `lib/services/auth_service.dart`):

1. `GET /v1/auth/hub/config` for the Hub's authorise URL, client id, scope
   and the iPhone redirect URI (`flexgymscan://auth/callback`);
2. a fresh `state`, `nonce` and PKCE verifier (S256 challenge, `crypto`);
3. the Hub page in an `ASWebAuthenticationSession` sheet
   (`flutter_web_auth_2`, callback scheme `flexgymscan`). The sheet catches
   the callback itself, so the scheme is not registered in `Info.plist`;
4. the callback's `state` is checked, then `POST /v1/auth/hub` with the code,
   verifier, redirect URI, nonce, `client: 'ios'` and a device label.

The web sheet is behind `WebAuthenticator`, so widget tests play the Hub
(`test/support/fake_backend.dart`).

Tokens, the user and their accounts are kept in the Keychain
(`flutter_secure_storage`, accessibility `first_unlock_this_device`, so a
background upload can still refresh while the phone is locked, and the
session never travels to another phone in a backup). `AuthSession.restore()`
runs before the first frame, so the app opens signed in; every refresh
rotates the token and the new pair is written straight away. Only a refresh
the backend refuses (401, e.g. the Hub disabled or deleted the user) signs
the phone out; no signal never does.

Forgotten passwords are reset on the GoalCert page.

## Accounts

The sign-in answer and `GET /v1/me` list the user's gym `accounts`. One is
chosen automatically; with several, the account picker asks once and the
choice is remembered in the Keychain. Every customer call sends
`X-Account-Id` (added by `ApiClient`). Profile shows the account and offers
"Switch account" when there is more than one. A user in no account gets a
"No gym access yet" screen with "Check again" and "Sign out".

Each capture stores the account it was taken in (`ScanConfig.accountId`,
`UploadManifest.accountId`), and its upload names that account even if the
surveyor switches before it finishes.

## Launch

`StartupScreen` restores the session and checks the device in parallel:

- no LiDAR (RoomPlan `isSupported` false, via `ScanBackend.detect`) in a
  release build: "This app needs an iPhone with LiDAR", no way on (APP-01).
  Debug builds fall back to the simulated scan, as before, and the blocked
  screen offers "Continue with the simulated scan (debug)";
- otherwise sign-in, the account picker, "no access", or home.

## Offline start (I-04)

With no signal the app still opens signed in (the session is on the phone).
Home shows an "Offline" notice instead of the plan list, with the capture
card still there. Each account's facility list is saved on every online load
(`lib/services/offline_cache.dart`, `FacilityCache/<account>.json` in
Application Support) and New capture falls back to it, marked "Offline ·
saved facility list". The upload waits for signal as before. Signing out
clears the cache.

## Capture

- **Scanning**: live outline, coverage, tags and photos. The scanned
  extent (width × length of the walls' bounding box) is shown live; past
  `AppConfig.maxScanExtentM` (`--dart-define=MAX_SCAN_EXTENT_M=…`, default
  40) a warning stays up saying the floor must be scanned in sections, and
  Finish is off (F-04). Sectioned scanning itself is still to do.
- **Review**: warnings, tags, photos, and optional laser **control
  distances** (F-03): tap two points on the outline (taps snap to corners),
  type the laser reading. Sent as `controlDistances: [{a: [x, y], b: [x, y],
  measuredM}]` in the capture's register body, in the same plan frame as the
  tags. Fewer than two, or any under 3 m, is warned about but never blocks.
- **Equipment 360°**: name each machine and walk round it. The video is
  recorded silent (A-04). On an iPhone the coverage ring is driven by the
  camera's heading from CoreMotion: 36 sectors of 10°, plus which heights
  (low, middle, top) are still to film (I-06). The simulated walk keeps its
  own animation.

## Uploads

`BackgroundUploadQueue` sends captures as multipart uploads through signed
URLs with iOS background transfers, resuming after the app closes. Because
the session is restored from the Keychain before the queue starts, an
interrupted upload carries on at relaunch without signing in again.

## Design

Colours, spacing and radii come from `Gym Scan — Mobile Prototype (iOS).html`
in the repo root and live in `lib/theme/app_theme.dart`. The brand mark is
`assets/images/flex_motion_logo.png`, rendered by `lib/widgets/brand_header.dart`.

## iOS notes

- Deployment target iOS 17.0 (`ios/Runner.xcodeproj`, the `room_scan`
  podspec). The bundle id is still `com.example.mobile` (I-02 is open).
- Portrait only on iPhone (`Info.plist` + `SystemChrome`).
- No microphone usage description: nothing records sound.
- Launch screen and Android window background are `#01060A`, so there is no
  white flash before the first frame.
- Page transitions use `CupertinoPageTransitionsBuilder` on both platforms.

## Run

```sh
flutter pub get
flutter run --dart-define=GYM_PLAN_API=http://<your-computer>:8080
flutter test
flutter analyze
```
