# fastlane: iPhone build pipeline (M-13)

Builds the Flutter app for iOS, signs it with `match`, and uploads it to
TestFlight. Runs on a Mac (locally or a macOS CI runner) with Xcode, Flutter,
Ruby and Bundler installed.

```sh
cd mobile/ios
bundle install
bundle exec fastlane test    # flutter pub get && flutter test
bundle exec fastlane beta    # signed release build -> TestFlight
```

## Lanes

| Lane   | What it does |
|--------|--------------|
| `test` | `flutter pub get` and `flutter test` in `mobile/`. |
| `beta` | Fetches signing with `match` (read-only on CI), switches the Runner target to manual signing with that profile, takes the next build number from TestFlight, runs `flutter build ipa --release --dart-define=GYM_PLAN_API=...`, and uploads with `upload_to_testflight`. |

## Environment

| Variable | Used for |
|----------|----------|
| `APP_IDENTIFIER` | Bundle id, e.g. `com.goalcert.flexgymscan`. The Xcode project still says `com.example.mobile`; the `beta` lane overrides it for the build. |
| `APPLE_TEAM_ID` | Apple Developer team id. |
| `GYM_PLAN_API` | API base URL compiled into the app, e.g. `https://api.staging.gym.goalcert.example`. |
| `ASC_KEY_ID`, `ASC_ISSUER_ID` | App Store Connect API key (Users and Access > Integrations). Role: App Manager. |
| `ASC_KEY_CONTENT` | The key's `.p8` file, base64-encoded (`base64 -i AuthKey_XXXX.p8`). |
| `MATCH_GIT_URL` | Private git repository holding the encrypted certificates and profiles. |
| `MATCH_PASSWORD` | Passphrase for that repository. |
| `MATCH_GIT_BASIC_AUTHORIZATION` | CI only, for HTTPS: base64 of `user:token`. |
| `TESTFLIGHT_CHANGELOG` | Optional "What to Test" text. |
| `CI` | Set by CI runners. Makes `match` read-only and uses a temporary keychain. |

## First-time signing setup

Done once, on a Mac, by someone with the App Manager or Admin role:

```sh
cd mobile/ios
export APP_IDENTIFIER=... APPLE_TEAM_ID=... MATCH_GIT_URL=... MATCH_PASSWORD=...
bundle exec fastlane match appstore     # creates the cert and profile, stores them
```

From then on, CI and other developers only read them (`readonly: true`). When
the distribution certificate expires (yearly), run the same command again. If
the old certificate was revoked, run `fastlane match nuke distribution` first.

## Notes

- Keep the `.p8` key, `MATCH_PASSWORD` and the signing repository credentials
  in the CI secret store, never in this repository.
- The App Store Connect app record (bundle id, name) must exist before the
  first upload.
- The build talks to whichever API `GYM_PLAN_API` names. Use the staging API
  for builds handed to testers and the prod API for release candidates.
- `update_code_signing_settings` edits `Runner.xcodeproj` in the CI checkout
  only. Do not commit that change.
