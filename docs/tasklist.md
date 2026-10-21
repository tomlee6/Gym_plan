# Task list: what is missing against the delivery plan

**8 October 2026.** Audited against commit `1316d60` (Thomas, 6 October: "equipment 360 degree video implemented"). This file tracks the work in [delivery-plan.md](delivery-plan.md); section numbers (§) refer to that plan.

**Status values:**

- **Done:** the code and its tests exist. None of it has run, because nothing runs until T-01 is fixed.
- **Partial:** some of it exists; the notes say what is left.
- **Missing:** nothing exists yet.

**Phase** is the phase in plan §12. **P0** marks tasks that block that phase.

**Summary:**

| Area | Tasks | Done | Partial | Missing |
|---|---|---|---|---|
| Do first | 6 | 0 | 0 | 6 |
| Backend | 33 | 3 | 2 | 28 |
| Web | 14 | 1 | 0 | 13 |
| iPhone | 14 | 2 | 1 | 11 |
| Equipment 3D | 10 | 0 | 0 | 10 |
| Infrastructure | 16 | 0 | 0 | 16 |
| GoalCert side | 6 | 0 | 0 | 6 |
| Product | 6 | 0 | 0 | 6 |
| **Total** | **105** | **6** | **3** | **96** |

---

## 0. Do first

| ID | Task | Status | Notes | Phase |
|---|---|---|---|---|
| T-01 | Get `shared/plan` from Thomas, commit it, remove `/shared/` from `.gitignore` | Missing | Now 34 functions used by 17 files (was 21 and 13). Backend: 8 of 8 test files fail. Web: 7 of 9 fail. Both apps fail to start or build. | 0 · P0 |
| T-02 | Run the backend, web and mobile test suites green after T-01 | Missing | Mobile has never been run: Flutter is not installed on this PC. | 0 · P0 |
| T-03 | Fix CodeCommit access from this machine | Missing | `git fetch` returns 403. The code here is what was fetched on 6 October at 16:42; anything pushed since is not visible. | 0 · P0 |
| T-04 | Fix the equipment-recording crash: remove audio from the 360° recorder | Missing | The recorder adds the microphone ([EquipmentVideoRecorder.swift:107–112](../mobile/packages/room_scan/ios/Classes/EquipmentVideoRecorder.swift#L107-L112)), but `Info.plist` has no `NSMicrophoneUsageDescription`. iOS ends the app on the first recording. Dropping audio also keeps members' voices out of stored videos. | 0 · P0 |
| T-05 | Provide a Mac with Xcode and a LiDAR iPhone for iOS work | Missing | No iOS build or device test is possible on this Windows PC. | 0 · P0 |
| T-06 | Run the app on a LiDAR iPhone against a local backend, end to end: scan, name machines, record videos, submit | Missing | No device run has ever happened. Needs T-01, T-04 and T-05. | 0 · P0 |

---

## 1. Backend

### Sign-in and tenancy (plan §4)

| ID | Task | Status | Notes | Phase |
|---|---|---|---|---|
| B-01 | `POST /v1/auth/hub`: exchange the Hub code with PKCE; verify the identity's signature against Hub keys, plus issuer, audience, expiry, nonce and org | Missing | [auth.js](../backend/src/modules/auth.js) still uses passwords. | 1 · P0 |
| B-02 | `POST /v1/hub/events`: check the HMAC; handle `user.disabled`, `user.deleted` and `session.revoked` | Missing | | 1 |
| B-03 | Remove password sign-in, password reset and `password_hash` | Missing | | 1 |
| B-04 | Migrate to `users` + `memberships` + `invites`, keyed on the Hub user id | Missing | | 1 · P0 |
| B-05 | `X-Account-Id` middleware; replace `req.user.orgId` in every module | Missing | Affects captures, equipment, capture-uploads, plans, review, profile, facilities and admin. `1316d60` added more `orgId` uses. | 1 · P0 |
| B-06 | Invite matching on first sign-in, by verified email, then never by email again | Missing | | 1 |
| B-07 | Refresh tokens: client, device label, Hub session id; 60 days on iPhone | Missing | | 1 |
| B-08 | Extend the isolation tests: users in several accounts, and the share route | Partial | Single-account isolation is tested, including equipment ("hides another customer's capture entirely"). | 1 |

### Processing pipeline (plan §9)

| ID | Task | Status | Notes | Phase |
|---|---|---|---|---|
| B-10 | Jobs table, outbox, SQS client, worker entry point, dead-letter handling | Missing | | 1 · P0 |
| B-11 | Move plan reading out of `POST /complete` into `scan.read` and `drawing.read` jobs | Missing | Still runs inside the request: [captures.js](../backend/src/modules/captures.js) `readPlan`. | 1 |
| B-12 | State-events table with a timestamp for every state change | Missing | | 1 |
| B-13 | A failed job lands in the reviewer queue with its machine reason (RDR-08, GEN-05) | Missing | | 1 |
| B-14 | Add a "generating" state; approval queues `plan.generate` | Missing | Approval still sets Ready immediately ([review.js](../backend/src/modules/review.js)). | 3 |

### Plan format v2 and reading (plan §5, §6)

| ID | Task | Status | Notes | Phase |
|---|---|---|---|---|
| B-20 | `gymplan/2` measurements:<br>• wall height, thickness, length, bearing<br>• opening height, sill, swing<br>• object elevation, machine names<br>• room figures, v1 upgrade, measurement validation | Partial | Built in `1316d60` and tested in [measurements.test.js](../backend/test/measurements.test.js), but the code lives in the missing `shared/plan` (T-01). Room figures are stored on each version (migration 003). | 2 |
| B-21 | Extend v2:<br>• spaces and per-space ceilings<br>• wall kind, curves, mirror spans<br>• opening kinds and hinge<br>• beams, level changes, stair and lift outlines, column shape<br>• machine model and facing | Missing | | 2 |
| B-22 | Scan reader: merge sections, add mesh-based machine boxes, apply control distances | Missing | | 2 |
| B-23 | Keyframe crops and vision-model type suggestions, hosted in Australia | Missing | Types today come only from the surveyor or reviewer. | 2 |
| B-24 | Automatic reading of uploaded drawings (RDR-05) | Missing | Drawings are traced by hand. | Later |

### Equipment (plan §7)

| ID | Task | Status | Notes | Phase |
|---|---|---|---|---|
| B-30 | Record machines on a capture: mark, list, correct, delete | Done | [equipment.js](../backend/src/modules/equipment.js), migration 004, [equipment.test.js](../backend/test/equipment.test.js) | — |
| B-31 | 360° video upload per machine: resumable signed URLs, retake, per-org storage path | Done | Same files and tests as B-30. | — |
| B-32 | Carry positioned machines into the plan; give the reviewer each machine with a playable video | Done | `equipmentForPlan` and `equipmentForReview` in equipment.js. | — |
| B-33 | Let the reviewer place machines added by hand | Missing | Machines without a position are dropped from the plan ([equipment.js:144](../backend/src/modules/equipment.js#L144)), so their videos never reach the editor. Pairs with W-06. | 2 |
| B-34 | Clean up the S3 objects and unfinished uploads a retake leaves behind | Missing | A retake deletes the rows only ([equipment.js:326–330](../backend/src/modules/equipment.js#L326-L330)). | 4 |
| B-35 | The model build, its states and approval | Missing | See E-05 and E-06. | 4 |

### Generation, email, hardening

| ID | Task | Status | Notes | Phase |
|---|---|---|---|---|
| B-40 | Generator worker: plan v2 to a level GLB plus machine placements, stored under the plan hash and generator version | Missing | `buildModel.js` is the starting point. | 3 |
| B-41 | Signed CloudFront links for level and machine models | Missing | | 3 |
| B-50 | Send email through SES: the three PRD notifications and invites | Missing | [mailer.js](../backend/src/mailer.js) only logs. | 1 |
| B-51 | Store share tokens hashed | Missing | Stored in plain text today. | 5 |
| B-52 | Production config checks: no simulated scans, S3 storage, default region Sydney | Missing | [config.js:54](../backend/src/config.js#L54) still defaults to `eu-west-2`. | 1 |
| B-53 | Dockerfiles for the API and the worker | Missing | | 1 · P0 |
| B-54 | Move to MySQL 8.4 (Docker Compose and tests) | Missing | `docker-compose.yml` uses 8.0, which is out of support. | 1 |
| B-55 | Retention job: raw scans go to cold storage 90 days after approval | Missing | | 5 |
| B-56 | Account data removal as a background job | Missing | Runs inside the request today. | 5 |

---

## 2. Web

| ID | Task | Status | Notes | Phase |
|---|---|---|---|---|
| W-01 | Sign in through the Hub: redirect, callback route, PKCE | Missing | [LoginPage.jsx](../web/src/lib/LoginPage.jsx) is a password form. | 1 · P0 |
| W-02 | Account switcher for users in several gym accounts | Missing | | 1 |
| W-03 | Admin: invites instead of passwords; memberships per account; staff roles | Missing | | 1 |
| W-04 | Editor `gymplan/2` measurements:<br>• wall length typed in, height, thickness<br>• opening height, sill, swing<br>• naming and turning machines, clearances, flagging a machine<br>• 360° video player | Done | `1316d60`: [Sidebar.jsx](../web/src/review/editor/Sidebar.jsx), [measure.js](../web/src/review/editor/measure.js), and their tests. Depends on T-01. | — |
| W-05 | Editor tools for the rest of v2:<br>• spaces and ceilings, wall kind, mirror spans<br>• opening kinds and hinge, level changes, stair and lift outlines | Missing | | 2 |
| W-06 | Editor: list machines with no position and let the reviewer place them | Missing | Pairs with B-33. | 2 |
| W-07 | Editor: show the scan mesh underlay and the keyframes | Missing | | 2 |
| W-08 | Machine model review: the 3D model beside its 360° video; approve or reject; "same as" another machine | Missing | | 4 |
| W-09 | Viewer: use the measured wall heights and thicknesses and the opening heights and sills | Missing | [buildModel.js](../web/src/viewer/buildModel.js) is unchanged: it still uses a 15 cm wall, a 2.1 m door head and a 0.9–2.1 m window. | 3 |
| W-10 | Viewer: load the generated level file and the machine models, within budget (VIEW-09) | Missing | | 3 |
| W-11 | Owner pages: the "generating" state, and machine model status | Missing | | 3 |
| W-12 | Build config for the GoalCert subdomain: API URL, Hub client id, content security policy | Missing | | 1 |
| W-13 | Move strings out of the code for translation; WCAG 2.1 AA pass on the status page and queue | Missing | | 5 |
| W-14 | Remove `/reset-password` links once Hub sign-in lands | Missing | The backend emails a link to a page that does not exist. | 1 |

---

## 3. iPhone app

| ID | Task | Status | Notes | Phase |
|---|---|---|---|---|
| I-01 | Raise the target to iOS 17 (project and plugin podspec) and remove the iOS 16 branches | Missing | Still 14.0 in `project.pbxproj` and `room_scan.podspec`. | 1 |
| I-02 | Real bundle id, signing team, app name and icon; TestFlight pipeline | Missing | Bundle id is `com.example.mobile`. | 1 · P0 |
| I-03 | Hub sign-in with `ASWebAuthenticationSession` and PKCE; tokens in the Keychain; remove the password screens | Missing | The session is held in memory only ([auth_session.dart](../mobile/lib/services/auth_session.dart)). | 1 · P0 |
| I-04 | Account picker | Missing | | 1 |
| I-05 | Offline start: cached session and facility list (APP-13) | Missing | | 1 |
| I-06 | Block non-LiDAR devices at launch (APP-01) | Missing | Only the New capture screen checks today. | 1 |
| I-07 | Sectioned scanning (RoomPlan multi-room) on one live outline, with the size limit | Missing | | 2 |
| I-08 | Record the scan mesh and keyframes, with faces blurred on the phone | Missing | | 2 |
| I-09 | Control-distance entry | Missing | | 2 |
| I-10 | Name machines, on detected objects or by hand | Done | `1316d60`: [equipment_capture_screen.dart](../mobile/lib/screens/equipment_capture_screen.dart), with tests | — |
| I-11 | 360° walk-around video per machine, with retake and resumable upload | Done | Same commit, plus [EquipmentVideoRecorder.swift](../mobile/packages/room_scan/ios/Classes/EquipmentVideoRecorder.swift). Plain video only; see I-12. | — |
| I-12 | Record the walk-around with ARKit, keeping each frame's camera position and LiDAR depth, and still saving a normal video | Missing | Needed for the measured model route (plan §7.2). Phase 0 compares it with Apple's Object Capture. | 4 · P0 for E-05 |
| I-13 | Live coverage guide during the walk-around | Partial | Only the simulated demo animates progress; a real guide needs I-12. | 4 |
| I-14 | Uploads resume after the app is killed, without signing in again | Missing | Needs I-03. | 1 |

---

## 4. Equipment 3D from the 360° video (plan §7)

| ID | Task | Status | Notes | Phase |
|---|---|---|---|---|
| E-01 | Phase 0 test: 5 machines (chrome, black rubber, against a wall, in a row, large) through both routes. Compare look, scale error, time and file size. | Missing | Decides O14. | 0 · P0 |
| E-02 | Legal review of TRELLIS.2's dependencies (nvdiffrast, nvdiffrec) for commercial use | Missing | nvdiffrast's licence allows research and evaluation only. Blocks production use (O13). | 0 · P0 |
| E-03 | TRELLIS.2 Docker image (CUDA 12.4 build stage, A10G and L4 targets) in ECR; weights copied into S3 | Missing | Replaces the RunPod kit. | 4 |
| E-04 | AWS Batch GPU environment on `g5.2xlarge` in Sydney, idling at zero | Missing | Request the GPU quota early (F-15). | 4 |
| E-05 | `asset.build` worker: frame selection, cut-out, model (measured or generated), scale to footprint, optimise, store | Missing | | 4 |
| E-06 | Model states and approval API: none → queued → building → awaiting review → approved or failed | Missing | `equipment_videos.status` has an unused `processing` value. | 4 |
| E-07 | "Same as EQ-xxx" reuse of one model for identical machines | Missing | | 4 |
| E-08 | Generator and viewer place approved models at their machines' positions | Missing | Pairs with B-40 and W-10. | 4 |
| E-09 | Download-size check with real machine models (VIEW-09 budget) | Missing | | 4 |
| E-10 | Decide how long videos and frames are kept, and include them in account removal | Missing | Removal already deletes every file on an account's captures; retention is undecided. | 5 |

---

## 5. Infrastructure: Flex AWS (plan §10)

| ID | Task | Status | Notes | Phase |
|---|---|---|---|---|
| F-01 | dev, staging and prod environments in `ap-southeast-2` | Missing | Nothing exists: no Dockerfile, infrastructure code or pipeline. | 1 · P0 |
| F-02 | CDK project and network stack (VPC, subnets, endpoints) | Missing | | 1 · P0 |
| F-03 | RDS MySQL 8.4, S3 buckets (captures, models, logs), KMS, lifecycle rules, CORS | Missing | | 1 |
| F-04 | SQS queues with dead-letter queues | Missing | | 1 |
| F-05 | ECS API and workers, load balancer, WAF | Missing | | 1 |
| F-06 | AWS Batch GPU environment | Missing | Same as E-04. | 4 |
| F-07 | CloudFront for models; web hosting for the GoalCert subdomain (O1) | Missing | | 1 |
| F-08 | DNS and certificates, including the GoalCert subdomain records | Missing | | 1 |
| F-09 | SES sending domain (SPF, DKIM, DMARC) and production access | Missing | | 1 |
| F-10 | Secrets Manager: database, JWT key, Hub client secret, Hub events secret | Missing | | 1 |
| F-11 | CloudWatch dashboards and alarms to SNS and Slack, including pipeline failure within 5 minutes | Missing | | 1 |
| F-12 | CodePipeline and CodeBuild from CodeCommit: backend, workers, web, infrastructure | Missing | Needs T-03 and O4. | 1 |
| F-13 | iPhone build pipeline (Xcode Cloud or fastlane) to TestFlight | Missing | | 1 |
| F-14 | Runbooks: deploy, rollback, restore, secret rotation, SES bounces | Missing | | 5 |
| F-15 | Service quota requests: GPU instances in Sydney, SES production access | Missing | Start early; approvals can take days. | 0 |
| F-16 | Residency check (plan §10.9): every service, the vision model and the GPU work in Sydney | Missing | | 1 |

---

## 6. GoalCert side (needs the GoalCert team)

| ID | Task | Status | Notes | Phase |
|---|---|---|---|---|
| H-01 | Create the Flex Gym organisation in the Hub | Missing | | 1 · P0 |
| H-02 | Register the product per environment: client id, web and iPhone callbacks, events URL, launch URL | Missing | First product on the Hub's SSO contract. | 1 · P0 |
| H-03 | Confirm the Hub is hosted in Australia (O11) | Missing | | 1 |
| H-04 | DNS records for the web subdomain and its certificate (O1, O2) | Missing | | 1 |
| H-05 | Mark the 23 September gym architecture doc superseded | Missing | It puts the backend inside the Hub. | 0 |
| H-06 | Request a Hub API for creating users, so adding a user is one step (O10) | Missing | | Later |

---

## 7. Product decisions and documents

| ID | Task | Status | Notes | Phase |
|---|---|---|---|---|
| P-01 | PRD addendum (plan §13) | Missing | Covers:<br>• machine naming, 360° video and 3D models<br>• iOS 17<br>• Hub sign-in<br>• the "generating" state<br>• the accuracy target | 0 |
| P-02 | Answer O1–O5 | Missing | Needed before Phase 1. | 0 · P0 |
| P-03 | Reference test set: 10 plans and 2 laser-measured gyms | Missing | Needed to measure accuracy at all. | 0 · P0 |
| P-04 | Set the accuracy target and size limit from Phase 0 data (O6) | Missing | | 0 |
| P-05 | Apple Developer account and the app's listed name (O9) | Missing | | 1 |
| P-06 | Price and timeline impact of the equipment 3D scope (O12) | Missing | | Before 4 |
