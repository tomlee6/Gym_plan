# Gym Floor Plan to 3D Walkthrough — Build and Deployment Plan

**Draft 2 · 8 October 2026**

Built from:

- PRD v1 (21 September 2026).
- An audit of this repository at commit `1316d60` (6 October, Thomas: equipment marking, 360° equipment video, measurements).
- The GoalCert Hub repository: its sign-in code and its 23 September gym architecture doc.
- The product owner's decisions of 8 October 2026.

This plan **supersedes** "GoalCert Gym Walkthrough Integration Architecture v1" (23 September 2026, in the goalcert-hub repository). That document put the gym backend inside the Hub. The decisions below put it in Flex AWS, and the Hub only handles sign-in.

---

## 1. Decisions

| # | Decision |
|---|---|
| D1 | One backend, in Flex's AWS, Sydney region (`ap-southeast-2`). All product data lives there: plans, scans, photos, frames, models and audit. |
| D2 | One web app with every screen: owner status and upload, reviewer queue and editor, admin, walkthrough and share links. It is served from a GoalCert subdomain and registered as a product in the GoalCert Hub. |
| D3 | The GoalCert Hub is the only login, for both the web app and the iPhone app. The Hub holds user accounts (name, email, password) and no product data. |
| D4 | One Hub organisation for all users. Gym customers are kept apart inside the Flex backend. |
| D5 | Reviewers and admins are Flex staff. |
| D6 | iOS 17 is the minimum. |
| D7 | The largest supported floor is the largest size that still meets the accuracy target. It is found by measurement (§5.3), not assumed. |
| D8 | Equipment: the floor scan gives each machine's position, and the surveyor or reviewer names its type. The 360° video recorded of each machine is converted into that machine's 3D model. **Converting the 360° video into a 3D model is confirmed in scope (8 October 2026).** |
| D9 | All equipment 3D processing, including TRELLIS.2, runs on AWS GPU instances in Sydney, not RunPod (§7.4). |

D4 and D5 also settle two conflicts the 23 September doc raised:

- **Users in several gym accounts (PRD ACC-01).** Memberships now live in the Flex backend, so the Hub's one-organisation-per-user rule no longer gets in the way.
- **Reviewers seeing every customer.** Reviewers are Flex staff with a Flex role, so no Hub impersonation is involved.

---

## 2. Where the code is today

| Area | State |
|---|---|
| Backend (`backend/`) | **Built:**<br>• sign-in, accounts and quota, resumable uploads to signed URLs<br>• reviewer queue (claim, save, approve, reject, revise), reviewer time<br>• audit log with CSV, account data removal, share links<br>• since `1316d60`: machines recorded on a capture, 360° video upload per machine, machines carried into the plan, room measurements stored on each version<br>**Not there:** plan reading runs inside the upload request, with no workers; emails are logged, not sent; nothing turns a video into 3D. |
| Web (`web/`) | **Built:**<br>• owner status, upload wizard with scale line, full 2D reviewer editor<br>• walkthrough (walk, joystick, overhead, measure, minimap, levels, disclaimer), admin, share viewer<br>• since `1316d60`: editor shows and edits wall length, height and thickness, opening height, sill and swing; names and turns machines; shows clearances; plays each machine's 360° video<br>**Not there:** the 3D viewer is unchanged, so it still ignores the new measurements and uses fixed heights. |
| iPhone (`mobile/`) | **Built:**<br>• live outline, coverage, override reason, tags, 4 photos, review screen, background resumable upload<br>• since `1316d60`: naming machines on detected objects or by hand, and a 360° walk-around video per machine<br>**Not there:** sign-in is held in memory only, the bundle id is still `com.example.mobile`, the target is still iOS 14, and it has never been built for a device. |
| Shared plan library | **Missing** (§2.1), and `1316d60` depends on it more. The backend does not start, the web does not build, and 15 of 17 test files fail. |
| Infrastructure | None: no Dockerfile, infrastructure code, CI pipeline or environments. |

### 2.1 The missing `shared/plan` library

**What it is.** The one library that both the backend and the web app use for the internal plan. `.gitignore` excludes it on purpose ("not part of this repository"), and it was never committed, including in `1316d60`. 17 files now import 34 functions from it. The original 21 are below. Thomas's commit added 13 more for the `gymplan/2` measurement format and machine names:

- **Format:** `FORMAT`, `FORMAT_V1`, `SUPPORTED_FORMATS`, `SOURCES`, `upgradePlan`.
- **Measurements:** `withMeasurements`, `roomMetrics`, `wallLength`, `wallAngleDeg`, `wallName`, `objectBounds`.
- **Machine names:** `EQUIPMENT_TYPES`, `equipmentLabel`.

The original 21:

| Group | Functions | Used for |
|---|---|---|
| Format | `emptyPlan`, `clonePlan`, `newElementId`, `OPENING_TYPES`, `TAG_TYPES`, `JOIN_TOLERANCE_M` | Creating and copying plans; the allowed opening and tag types |
| Reading | `planFromScan`, `planFromUpload` | Turning a scan's `scan.json` into a plan with confidence scores and flags; turning an uploaded drawing into an empty, scaled plan to trace |
| Rules | `validate`, `approvalBlockers` | Closed outline, no crossing walls, openings on walls, scale set; and why Approve is disabled |
| Facts | `summary`, `outline`, `canonicalJson` | Floor area and counts; the traced room outline (also the 3D floor); the stable JSON the approval hash is taken over |
| Geometry | `dist`, `lerp`, `project`, `direction`, `bounds`, `pointInPolygon`, `rectCorners`, `openingSegment` | Editor snapping and tools; 3D model building |

**Why it matters.** The reviewer editor disables Approve using exactly the rules the server enforces on approval, so the two can never disagree. That only works if both sides run the same code.

**Can we work without it?** Not as the code stands. It can be rewritten, though:

- Every function name and call site is known.
- [plan.test.js](../backend/test/plan.test.js), [measurements.test.js](../backend/test/measurements.test.js), [ops.test.js](../web/src/review/editor/ops.test.js), [measure.test.js](../web/src/review/editor/measure.test.js) and [buildModel.test.js](../web/src/viewer/buildModel.test.js) describe its behaviour.
- Most of the work is `planFromScan` and the `gymplan/2` measurements. The job is bigger since `1316d60`, which makes getting the original more valuable.
- Plan format v2 (§6) replaces the format and the scan reader anyway, so a rewrite is not wasted.

**Plan:**

1. Get it from its author this week and commit it, removing the `.gitignore` entry. It is product code.
2. If it has not arrived by the end of the week, start the v2 library (§6) directly and rebuild the v1 functions the current code needs on top of it.

---

## 3. Target architecture

```
 ┌──────────────┐  sign in   ┌───────────────────────────────────┐
 │ iPhone app   │───────────►│ GoalCert Hub  (hub.goal-cert.com)  │
 └──────┬───────┘            │ login page, user accounts, SSO     │
        │                    └─────────────────▲─────────────────┘
        │                                      │ sign in
        │                 ┌────────────────────┴───────────────┐
        │                 │ Web app (e.g. gym.goal-cert.com)    │
        │                 │ static files only, no data (§10.8)  │
        │                 └────────────────────┬───────────────┘
        │ API, signed uploads                  │ API
        ▼                                      ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ Flex AWS · ap-southeast-2 · all product data                 │
 │                                                              │
 │  API (ECS Fargate, behind ALB + WAF) ─── RDS MySQL            │
 │    ├─ SQS ─► workers: read scan · read drawing · generate 3D  │
 │    │         · build equipment model (GPU) · remove account   │
 │    ├─ S3: scans, mesh, frames, photos, drawings, models       │
 │    ├─ CloudFront: 3D files to the viewer (signed, short-lived)│
 │    └─ SES email · Secrets Manager · CloudWatch alarms         │
 └─────────────────────────────────────────────────────────────┘
 The Flex API exchanges Hub sign-in codes for identities, server to server.
```

---

## 4. Sign-in and tenancy

### 4.1 What the Hub already provides

Verified in `goalcert-hub/hub/backend/idp_routes.py` and `sso_idp.py`:

- **Sign-in page.** `GET /sso/authorize` supports PKCE (S256) and a nonce. A redirect URI must exactly match one registered for the product. Any string is accepted, including a custom app scheme.
- **Code exchange.** `POST /sso/token` swaps the one-time code for a signed identity. It needs the product's client secret, so only the Flex backend can call it.
- **The identity.** RS256-signed and valid for 60 seconds. It carries:
  - `sub` (the Hub user id), `email`, `email_verified` and `name`;
  - `org`, `seat` and `entitlement`;
  - `sid` (the Hub session id).
- **Supporting endpoints:** `GET /sso/keys` (public keys to verify the identity), `GET /sso/session/{sid}` (is the Hub session still alive) and `/sso/logout`.
- **Events.** HMAC-signed events go to a URL the product registers: `user.disabled`, `user.deleted`, `user.updated`, `user.enabled`, `session.revoked`, `org.disabled`, `entitlement.*` and `client.retired`.
- **Registration.** Products are registered on the Hub's Super Admin "Products & SSO" page.

**No product uses this contract yet.** We will be the first, so plan for finding gaps on the Hub side.

### 4.2 Sign-in flow (same for web and iPhone)

1. **Start.** The client creates a random state, nonce and PKCE verifier, then opens Hub `/sso/authorize`.
   - **Web:** a full-page redirect.
   - **iPhone:** `ASWebAuthenticationSession`, the system browser sheet.
2. **Sign in at the Hub.** A user who already has a Hub session comes straight back. Anyone else signs in on the Hub page, where the Hub's lockout and MFA apply.
3. **Callback.** The Hub redirects to our registered callback with a one-time code.
4. **Hand the code to our API.** The client posts `{code, verifier, redirectUri, nonce}` to the Flex API at `POST /v1/auth/hub`.
5. **Verify.** The Flex API calls `/sso/token` with the client secret and verifier, then checks:
   - the signature, issuer, audience, expiry and nonce;
   - that `org` is the Flex Gym Hub organisation.
6. **Issue Flex tokens.** The Flex API finds the user by Hub user id, or links a pending invite (§4.4). It then issues Flex tokens with the rotating refresh-token code that already exists in [auth.js](../backend/src/modules/auth.js).

Callbacks to register:

- **Web:** `https://<web subdomain>/auth/callback`.
- **iPhone:** a custom scheme such as `flexgymscan://auth/callback`. Confirm that the Hub's registration screen accepts it; the code path does.

### 4.3 Identity and tenancy in the Flex backend

**Today:** each user belongs to exactly one account (`users.org_id`) and has a password (`users.password_hash`) and one role (`users.role`).

**Target data model:**

| Table | Contents |
|---|---|
| `users` | `id`, `hub_user_id` (unique), `email`, `name`, `staff_role` (`reviewer` \| `admin` \| null), `active` |
| `memberships` | `user_id`, `account_id`, `role` (`owner` \| `surveyor`). A user may belong to several gym accounts. |
| `invites` | `email`, `account_id`, `role`, `invited_by`, `expires_at` |
| `refresh_tokens` | Gains `client` (`web` \| `ios`), device label, Hub session id and absolute expiry |

**Removed:**

- `password_hash`;
- the `password_resets` table;
- `/v1/auth/login` and `/v1/auth/password-reset*`.

**How requests are scoped:**

- The access token carries only the user id and staff role.
- Each request names the gym account it acts on, in an `X-Account-Id` header, and middleware checks the membership.
- Every module that reads `req.user.orgId` today changes. This is the largest backend change in Phase 1.
- Reviewers and admins (`staff_role`) see every account, as they do today.

**Testing.** The cross-tenant isolation test is extended: a user who belongs to accounts A and B sees B's data only while acting as B.

### 4.4 Adding a user

This takes two steps until the Hub offers an API for creating users (§14, O10):

1. **In our admin screen**, a Flex admin invites the email address and chooses the gym account and role. This creates an invite.
2. **In the Hub**, the same person is added to the Flex Gym organisation. A Flex admin with org-admin rights in the Hub does this.

**On first sign-in**, the Hub's verified email matches the invite and we store the Hub user id. From then on, email is never used for matching again. A Hub user whose email is unverified, or who has no invite, sees "Ask your Flex contact for access".

### 4.5 Session lifetimes and sign-out

| Client | Flex access token | Flex refresh token | Hub user disabled or deleted | Hub session ends |
|---|---|---|---|---|
| Web | 30 min, in memory | Tab session only (`sessionStorage`), rotating | Revoked at once (event) | Next refresh is refused |
| iPhone | 30 min | 60 days, in the Keychain, rotating (O5) | Revoked at once (event) | Stays signed in, so field work and offline start keep working (O5) |

Hub events arrive at `POST /v1/hub/events`, which verifies the HMAC. Signing out of the web app also calls Hub `/sso/logout`.

### 4.6 Share links

`/s/<token>` on the web app needs no sign-in. The API resolves the token to the newest approved version.

Change from today: store the token **hashed**. It is stored in plain text at the moment. Links keep their expiry and revocation. The isolation test must prove the share route cannot serve any other plan.

### 4.7 What we register in the Hub (one client per environment)

- **Identity:** name, `client_id`, kind `tenant`.
- **URLs:** redirect URIs (web and iPhone), post-logout URI, events URL, launch URL (the web app) and health URL (`/health` on the API).
- **Signing:** RS256, 60-second identity lifetime.

---

## 5. Floor scan to 2D plan

### 5.1 How it works today

**On the phone** ([RoomScanner.swift](../mobile/packages/room_scan/ios/Classes/RoomScanner.swift)):

1. Apple RoomPlan keeps a live model of the room. Each wall is a flat rectangle with a position, rotation, width, height and confidence; doors, windows and objects work the same way.
2. **Flattening drops the height.**
   - A wall becomes a line from its centre, half its width each way, keeping only floor coordinates ([lines 275–282](../mobile/packages/room_scan/ios/Classes/RoomScanner.swift#L275-L282)).
   - An object becomes its four floor corners ([285–291](../mobile/packages/room_scan/ios/Classes/RoomScanner.swift#L285-L291)).
3. **Coverage** is wall confidence weighted by length, multiplied by the share of wall ends that meet another wall within 30 cm ([305–341](../mobile/packages/room_scan/ios/Classes/RoomScanner.swift#L305-L341)).
4. **On Finish**, the app exports `scan.usdz` and `scan.json`, which hold every wall, door, window and object with its height ([128–162](../mobile/packages/room_scan/ios/Classes/RoomScanner.swift#L128-L162)).

**One capture per level.** The app runs exactly one capture per level ([line 69](../mobile/packages/room_scan/ios/Classes/RoomScanner.swift#L69)), and nothing is recorded as video.

**On the server**, `planFromScan` (in the missing library; behaviour taken from its tests):

- snaps near-miss corners so the outline closes;
- attaches doors and windows to their walls;
- takes the ceiling height from a tag and marks the mirror wall;
- flags anything it is unsure of.

**Lost on the way:** opening heights and sill heights, and each wall's own height. The plan keeps only an opening's position and width along its wall ([review.js:325–336](../backend/src/modules/review.js#L325-L336)).

### 5.2 Larger floors

Apple's guidance for one RoomPlan capture is a room of about 9 × 9 m. On iOS 17 the approach is:

- **Scan in sections.** Several RoomPlan captures run in one continuous ARKit session and are merged with `StructureBuilder`, Apple's multi-room API. The app guides the surveyor section by section on one live outline.
- **Record the LiDAR mesh in the same session.** This is ARKit scene reconstruction with surface classes, plus one keyframe about every second with its camera position. They give us:
  - equipment boxes and types (§5.4);
  - the reviewer's underlay (REV-03);
  - a cross-check of RoomPlan's walls.
- **Control distances.** The surveyor laser-measures two or more long distances and marks their ends in the app. The server corrects the scale and reports the remaining error on every plan, so the reviewer sees it.

**Phase 0 must confirm:**

1. RoomPlan sections merge correctly on an open floor with no dividing walls.
2. RoomPlan and mesh recording can run in one session at an acceptable frame rate and battery cost.

**Fallback** if open-floor merging fails: read walls from the mesh on the server, slicing at a fixed height as PRD RDR-03 describes.

### 5.3 Finding the size limit

1. **Prepare.** Use two real gyms with laser-measured ground truth (the PRD's reference set), with at least 10 control distances each, including long diagonals.
2. **Scan growing areas:** one section (about 9 × 9 m), two sections, four, then the whole floor.
3. **Measure** the error on every control distance for each scan.
4. **Set the limit:** the largest area at which 95% of distances are within the accuracy target.
5. **Enforce it in the app.** The live extent is shown; past the limit, the app requires a new section before the surveyor can finish.

**Accuracy target.** The PRD asks for ±30 mm on 400 m². Phone tracking error over long distances is likely to exceed that. The product owner sets the final number from the Phase 0 data (O6). The limit is never relaxed below that target (D7).

### 5.4 Equipment position and type from the scan

- **Position and footprint** come from RoomPlan objects, plus boxes around clusters of mesh standing on the floor. The mesh boxes catch machines that RoomPlan's household object types miss.
- **Type, already built in `1316d60`:**
  - After the scan, the surveyor names each machine, either on an object RoomPlan found (keeping its measured footprint, height and bearing) or by hand.
  - Names come from a starter list that also accepts any new type.
  - The reviewer can name, turn or flag machines in the editor.
- **Type, to add:** for each box, the worker crops the keyframes that see it, and a vision model suggests a type. Naming then becomes a one-tap confirmation instead of typing.
- **Gap.** A machine added by hand has no position. It is left out of the plan ([equipment.js:144](../backend/src/modules/equipment.js#L144)), so the reviewer never sees it or its video. The reviewer needs a way to place it.
- **Low-confidence types** are flagged, and the reviewer clears them like any other flag (REV-05).
- **Privacy.** Faces are blurred on the phone with Apple Vision face detection before frames are saved. Frames are visible only in the reviewer editor and are kept for the same time as raw scans.
- **PRD change needed.** This reverses the PRD non-goal "Recognising what a piece of equipment is" (§13).

### 5.5 App changes for scanning

- Raise the deployment target to iOS 17; update the plugin podspec and remove the iOS 16 branches.
- Sectioned scanning on one live outline, with the extent limit enforced.
- Mesh and keyframe recording with face blur, uploaded as extra capture files.
- Control-distance entry.
- Tap-to-type for equipment.
- Block non-LiDAR devices at launch (APP-01), not only on the New capture screen.

---

## 6. Plan format v2

**Principle:** the plan carries everything needed to build the 3D. Defaults are used only to fill gaps, and every default is flagged.

**Already started in `1316d60`** (inside the missing `shared/plan`). Thomas's `gymplan/2` already has:

- **Walls:** height, thickness (left blank unless measured), length, bearing and source.
- **Openings:** height, sill and swing.
- **Objects:** height off the floor and machine name and type.
- **Plan:** overall room figures, an upgrade from v1, and measurement validation.

The spec below extends that format rather than replacing it. Still to add: spaces and per-space ceilings, wall kind, curves and mirror spans, opening kinds and hinge, beams, level changes, stair and lift outlines, column shape, and each machine's model and facing.

```
format: "gymplan/2"          all lengths in metres, floor-plane coordinates as today
level:      floorToFloorM
scale, underlay              as today
spaces:     id, name, kind (gym_floor | studio | changing | reception | office | store | corridor | other),
            polygon, floorFinish, ceiling { heightM, zones: [{ polygon, heightM }] }
walls:      id, a, b, arc?, thicknessM, heightM (null = to ceiling), kind (exterior | interior | partition | glass),
            mirrorSpans: [{ from, to, bottomM, topM }], confidence, source
openings:   id, wallId, kind (door | double_door | sliding_door | roller_shutter | opening | window | fixed_glazing),
            offset, width, sillM, headM, hinge (start | end), swingInto (spaceId), confidence, source
columns:    id, shape (rect | round), x, y, w, d, angle, heightM
beams:      id, polygon, bottomM                     (bulkheads, dropped beams)
levelChanges: id, polygon, heightM, kind (step | platform | ramp), rampDirection?
verticals:  id, kind (stair | lift | void), polygon, rail
equipment:  id, x, y, w, d, angle, heightM, facingDeg, type | null, typeConfidence, assetId | null, source
tags, zones, flags           as today; new flag kinds: equipment_type, default_used, asset_mismatch
```

`source` records where each element came from: `scan`, `mesh`, `reader` or `reviewer`.

**New validation rules** (port the ideas in the Hub's `validatePlan.mjs`):

- Spaces tile the area inside the outline, with no gaps or overlaps.
- Each opening fits its wall's length and height, and sill < head ≤ wall height.
- Every door joins two spaces, or a space and the outside.
- Equipment, columns and verticals lie inside a space and do not cross walls.
- Warning only: equipment taller than the ceiling.

**Converting v1 plans.** Existing plans convert using the current defaults (15 cm walls, 2.1 m door head, 0.9–2.1 m windows, one space equal to the outline). The conversion adds informational `default_used` flags, which do not block plans that are already approved.

**Where v2 lands:** the shared library, the scan reader, the reviewer editor, the validator, the generator and the viewer.

**New editor tools:**

- draw and split spaces; set a space's name, kind and ceiling;
- set wall thickness, height and kind;
- set an opening's kind, sill, head, hinge and swing;
- mirror spans, level changes, stair and lift outlines;
- equipment type, model choice, and rotation in 90° steps.

---

## 7. Equipment 3D models from the 360° video

**Scope:** confirmed by the product owner on 8 October 2026 (D8). The PRD does not mention it: its only images are up to 4 reviewer photos (APP-08), equipment is a plain box (APP-06, GEN-02), and recognition and catalogues are listed as non-goals. A PRD change is needed (§13).

### 7.1 What already exists (`1316d60`)

**On the phone:**

- After the room scan, the surveyor names each machine ([equipment_capture_screen.dart](../mobile/lib/screens/equipment_capture_screen.dart)).
- For each machine they record a 360° walk-around video, with a poster frame taken on the phone. A retake replaces the earlier video.
- The video is a plain camera recording (`AVCaptureSession`, preset `.high`, [EquipmentVideoRecorder.swift](../mobile/packages/room_scan/ios/Classes/EquipmentVideoRecorder.swift)). It has **no camera positions and no LiDAR depth**, and it is recorded after the scan ends because ARKit holds the camera during it.

**Upload and storage:**

- Through the same resumable, signed-URL upload as the scan.
- Stored under `orgs/<org>/captures/<capture>/equipment/<id>/` ([equipment.js](../backend/src/modules/equipment.js)).

**Reviewer:** each machine's video plays in the editor.

**Not built:** anything that turns the video into 3D. The code says plainly that the video "never carries geometry". The `processing` status on `equipment_videos` is reserved for a step that does not exist.

**Bug:** the recorder adds the microphone ([EquipmentVideoRecorder.swift:107–112](../mobile/packages/room_scan/ios/Classes/EquipmentVideoRecorder.swift#L107-L112)), but `Info.plist` has no microphone usage description. iOS ends an app that reads the microphone without one, so the first recording on a real iPhone will close the app. The fix: drop audio, which also keeps members' voices out of stored videos.

### 7.2 Capture changes

- **Record the walk-around with ARKit instead of a plain camera.**
  - Each frame keeps its camera position and LiDAR depth. That gives real scale and known viewpoints, which measured reconstruction needs; black and shiny machines defeat position-finding from plain video.
  - A normal video is still saved for the reviewer.
  - The scan has finished by then, so ARKit is free. Phase 0 compares this with Apple's Object Capture guided mode.
- **Coverage guide:** show how far round the machine the surveyor has walked and which heights are missing. Today only the simulated demo has this.
- **No audio** (fixes the bug above).

### 7.3 Building the model (GPU worker, `asset.build` job)

1. **Frames:** pick sharp frames spread around the orbit, roughly 60–150.
2. **Cut-out:** separate the machine from floor, walls and people, using a segmentation model and the machine's scanned footprint box.
3. **Model.** Two routes; Phase 0 decides which is primary:
   - **Measured:** reconstruct from the positioned frames and depth. The shape and size are real, but gaps appear where the video never looked.
   - **Generated:** TRELLIS.2 from the best frame. It is fast and complete-looking, but the shape is invented from one image: TRELLIS.2 accepts a **single image only**, so the rest of the video is not used.
4. **Scale and align** to the scanned footprint (width, depth, height) and facing. Never stretch: if the sizes disagree by more than a set margin, raise a flag.
5. **Optimise for the viewer:** reduce to a polygon budget, make 2–3 levels of detail, and compress (glTF with meshopt or Draco, KTX2 textures). Store it in S3 under its content hash.
6. **Approve:** the reviewer sees the model beside the 360° video and approves it (look, scale, front). Nothing unapproved reaches a walkthrough.
7. **Place:** the generator puts each approved model at its machine's plan position. No model means a plain box, as today.

**Model states**, per machine: none → queued → building → awaiting review → approved, or failed with a reason.

**Identical machines:** the reviewer can mark one machine "same as EQ-003" so one model is reused (instancing). This saves GPU time and download size. Whether approved models are also reused across gyms is decision O7.

### 7.4 Running TRELLIS.2 on AWS instead of RunPod

Yes. It is required anyway, because RunPod would move customer images out of Australia (§10.9).

- **GPU:** `g5.2xlarge`, with one NVIDIA A10G (24 GB), 8 vCPU and 32 GiB RAM. The plan first chose `g6e.xlarge` (one 48 GB L40S, as the RunPod kit recommends), but AWS does not offer G6e in Sydney (`ap-southeast-2`). 24 GB is TRELLIS.2's stated minimum: enough at the default settings, with little room (`docs/trellis2-before-deployment.md`, section 4).
- **Packaging:** build one Docker image.
  - A CUDA 12.4 build stage compiles flash-attn, nvdiffrast, cumesh, o-voxel and flexgemm for the A10G and the L4 (`TORCH_CUDA_ARCH_LIST=8.6;8.9`).
  - A slim runtime stage goes to ECR.
  - The TRELLIS.2-4B weights are copied once from Hugging Face into our S3 bucket; each job copies them to local disk.
  - This replaces the RunPod network volume: the 20–40 minute compile happens once per release, not per session.
- **Running it:** an AWS Batch GPU environment in Sydney with a minimum of 0 vCPUs, so it costs nothing while idle.
  - Each `asset.build` job is a Batch job: S3 frame keys in, GLB to S3 out, completion message back on SQS.
  - A gym's machines run back to back on one warm instance.
  - The Gradio web UI from the RunPod kit is not used.
- **Start-up:** a cold start (instance launch plus image pull) takes minutes, which is fine for a background job.
- **Cost:** AWS lists `g5.2xlarge` at $1.5758 an hour on demand in Sydney. You pay only while jobs run; Spot instances cost less. The full costs are in `docs/deployment-guide.md` (5.13).
- **Quota:** AWS accounts usually need a quota increase before they can launch GPU instances. Request it for Sydney early.
- **Licence, blocking production:**
  - TRELLIS.2's code and weights are MIT.
  - It depends on nvdiffrast, whose NVIDIA licence allows research and evaluation only, "not for any direct or indirect monetary gain". nvdiffrec has its own licence that also needs reading.
  - Flex Gym is a paid service, so get a legal review before TRELLIS.2 runs in production (O13). Removing or replacing those dependencies may be needed. Evaluation in Phase 0 is fine.

### 7.5 Risks

- Chrome and black rubber reconstruct poorly.
- Machines in rows, or against walls, cannot be walked around fully.
- Generated models can look right and be wrong, which is why every one needs approval.
- Models add to the walkthrough's download size.
- The TRELLIS.2 licence (above).

Phase 0 tests five machines that cover these cases, through both routes.

---

## 8. 3D generation and the walkthrough

**Today:** the browser builds the 3D on every open from the v1 plan, with fixed heights ([buildModel.js](../web/src/viewer/buildModel.js), [scene.js](../web/src/viewer/scene.js)).

**Target:**

- **One file per approved version.** The generate worker builds the architecture from plan v2:
  - walls at their true thickness and height;
  - openings cut at real sills and heads, with door leaves and glazing;
  - floors and ceilings per space;
  - level changes, and stair and lift voids with rails;
  - mirror spans.

  Alongside it goes a placement list for equipment models.
- **Same input, same file (GEN-01).** Files are stored under a key built from the approved plan's hash and the generator version. A generator upgrade writes a new file.
- **Viewer.** It loads the level file and the equipment models through CloudFront, using signed, short-lived links, and caches equipment models across levels. Collision is still computed from the plan data.
- **Budget (VIEW-09).**
  - Files: 25 MB or less per level, equipment included.
  - First load: under 8 s at 25 Mbps.
  - Frame rate: 30 fps on a 2022 laptop and a 2021 iPad.

  CI measures this on a reference gym.
- **Starting point.** `buildModel.js` is pure data with no three.js, so it moves into the worker as the base of the generator.
- **New state.** Add "Generating" between Approved and Ready (PRD §4 "Approved, generating walkthrough"). If generation fails, the plan goes to the reviewer queue with the machine reason (GEN-05).

---

## 9. Processing pipeline

**Today:** plan reading runs inside the upload request ([captures.js:437](../backend/src/modules/captures.js#L437)), and approval makes a plan Ready instantly ([review.js:422](../backend/src/modules/review.js#L422)).

| Job | Trigger | Does | Runs on |
|---|---|---|---|
| `scan.read` | Scan upload confirmed | Merges sections; reads walls, openings and equipment boxes from `scan.json` and the mesh; applies control distances; crops keyframes; suggests types; validates. Produces a v2 plan with flags. | CPU worker |
| `drawing.read` | Drawing upload confirmed | Prepares the underlay; later, automatic wall detection (RDR-05) | CPU worker |
| `plan.generate` | Approval | Builds the level file and equipment placements | CPU worker |
| `asset.build` | Machine capture confirmed | Reconstructs and optimises the model | GPU worker |
| `account.remove` | Admin request (ACC-07) | Deletes rows and S3 objects; keeps audit rows with ids only | CPU worker |
| `retention` | Daily | Moves raw scans to cold storage 90 days after approval | Scheduled task |

**How jobs run:**

- **Reliable queueing.** The API writes the job row and its queue message together, using an outbox table. A sweeper re-queues any message that was lost.
- **Safe to rerun.** Workers are idempotent, so running a job twice does no harm.
- **Retries and failures.** Jobs retry with backoff. Past the limit, the message goes to a dead-letter queue and the plan lands in the reviewer queue with the reason (RDR-08, GEN-05).
- **State events.** Every state change writes a timestamped row (PRD §9 observability).
- **Alarms.** The oldest message being older than its target, any dead-letter message, or a high job failure rate alerts the operator within 5 minutes.
- **Targets (PRD §9).** At the 95th percentile, per 1,000 m²: reading under 5 minutes, generation under 10 minutes. Workers scale on queue depth.

---

## 10. Deployment in Flex AWS

### 10.1 Accounts and environments

- Three environments: **dev**, **staging** and **prod**.
- Ideally these are separate accounts in a Flex AWS Organization; at minimum, separate isolated stacks.
- Everything runs in `ap-southeast-2`.
- Each environment has its own Hub client, redirect URIs and web subdomain.

### 10.2 Services

| Need | AWS service | Notes |
|---|---|---|
| API | ECS Fargate, 2+ tasks, behind an Application Load Balancer | Node 22 container, non-root, `/health` check |
| Workers | ECS Fargate services, one per queue | Scale on queue depth |
| GPU worker | AWS Batch on `g5.2xlarge` (NVIDIA A10G) | Scales to zero when idle; equipment models and TRELLIS.2 only (§7.4) |
| Database | RDS for MySQL **8.4 LTS**, Multi-AZ in prod | MySQL 8.0 is out of support in 2026. Move local Docker and tests to 8.4. |
| Queues | SQS, each with a dead-letter queue | |
| Files | S3 | §10.4 |
| 3D delivery | CloudFront with Origin Access Control and signed URLs | |
| Email | SES | §10.7 |
| Secrets | Secrets Manager and KMS | §10.5 |
| Edge | Route 53, ACM certificates, AWS WAF | |
| Monitoring | CloudWatch logs, metrics and alarms, SNS, Slack via AWS Chatbot | §10.6 |

### 10.3 Network

- A VPC across 2 Availability Zones, 3 in prod.
- Public subnets hold only the load balancer and NAT; ECS tasks and RDS sit in private subnets.
- VPC endpoints for S3, SQS, ECR, Secrets Manager and CloudWatch Logs cut NAT traffic.

### 10.4 Data and storage

**RDS:**

- Encrypted with KMS; 14 days of automated backups with point-in-time restore; private access only.
- Migrations run as a one-off ECS task before each release.

**S3 buckets:**

- `captures`: scans, mesh, frames, photos and drawings. Private, SSE-KMS, versioned. A deny-overwrite policy protects source drawings (UPL-04).
- `models`: generated level files and equipment models. Private, served only through CloudFront.
- `logs`.

**Lifecycle rules:**

- Raw scan files move to Glacier Instant Retrieval 90 days after approval; the worker tags them at approval.
- Incomplete multipart uploads are aborted after 7 days.

**CORS:**

- The `captures` bucket accepts `PUT` from the web origin (drawing uploads) and exposes `ETag`.
- The CloudFront model distribution allows `GET` from the web origin.

### 10.5 Security

- **No long-lived keys.** ECS uses task roles, and CI deploys with assumed roles.
- **Secrets Manager** holds the database credentials (rotating), the JWT signing key, the Hub client secret and the Hub events secret.
- **WAF** on the load balancer, with managed rule sets plus rate limits on `/v1/auth/*` and `/v1/share/*`. This replaces today's in-memory limiter, which does not work across instances.
- **TLS and CORS.** TLS everywhere, and browser calls are accepted only from the web origin.
- **Production config:** `ALLOW_SIMULATED_SCANS=false`, `STORAGE_DRIVER=s3`, `NODE_ENV=production`.
- **Isolation tests in CI.** The tenant-isolation test and the share-link negative test run in CI against a real MySQL.

### 10.6 Observability

- **Logs:** structured JSON with request ids, sent to CloudWatch.
- **Dashboards:**
  - API latency and errors;
  - queue depth and age;
  - job durations;
  - weekly reviewer time.
- **Alarms** go through SNS to email and Slack:
  - 5xx rate;
  - queue age;
  - any dead-letter message;
  - RDS storage and CPU;
  - certificate expiry.

### 10.7 Email

- SES in `ap-southeast-2`, with a sending domain on Flex's domain and SPF, DKIM and DMARC set up.
- Request SES production access early; new accounts start in a restricted sandbox.
- Messages sent: the three PRD notifications (ACC-04) plus invites.

### 10.8 Hosting the web app on the GoalCert subdomain

The web build is static files with no data. There are two ways to serve it (O1):

- **A (recommended):** S3 and CloudFront in Flex AWS. GoalCert adds a DNS record for the subdomain and the certificate-validation record. All deployment stays in Flex AWS.
- **B:** S3 and CloudFront in GoalCert's AWS. Our pipeline uploads each build through a role GoalCert grants.

**Either way:**

- **Routing:** every path falls back to `index.html`.
- **Content Security Policy:** allows only the Flex API, the CloudFront model domain and the Hub.
- **Build-time config:** the API URL, the Hub client id and the authorize URL.
- **Caching:** long cache for hashed assets, no cache for `index.html`.

### 10.9 Data residency checklist

PRD §9 requires all customer data to stay in Australia, with no third-party analytics.

- [ ] Every AWS service in `ap-southeast-2`, including SES, backups and logs.
- [ ] The vision model for equipment types is hosted in Australia (for example a model on Amazon Bedrock in Sydney, if one is available, or self-hosted on the GPU worker). Not an overseas API.
- [ ] Equipment-model GPU work, including TRELLIS.2, runs on AWS in Sydney (§7.4), not RunPod.
- [ ] The Hub, which holds names and emails, is hosted in Australia (O11).
- [ ] If cross-region disaster recovery is wanted, use Melbourne (`ap-southeast-4`).

### 10.10 Infrastructure as code

Use AWS CDK in TypeScript, the same language as the backend (O3). Stacks:

- `network`, `data`, `queues`, `compute`;
- `edge` (load balancer, WAF, CloudFront, certificates, DNS);
- `email`, `observability`, `pipeline`.

### 10.11 Build and release

- **Source:** this repository's remote is AWS CodeCommit in `ap-southeast-2`. CodePipeline and CodeBuild run in Flex's tooling account, with cross-account source access if the repository sits in another account (O4).
- **Backend and workers:**
  1. Run unit tests and MySQL integration tests.
  2. Build the Docker image and push it to ECR.
  3. Run the migration task.
  4. Deploy to ECS as a rolling update that rolls back on failure.
  5. Smoke-test `/health`.
- **Web:** test, build per environment, upload to S3, invalidate `index.html`.
- **Infrastructure:** `cdk diff` on every change; `cdk deploy` on merge. Prod deploys need a manual approval.
- **iPhone:**
  - A macOS build (Xcode Cloud, or a Mac runner with fastlane), signed with the Apple Developer account, then TestFlight.
  - Config per environment: API URL, Hub client id, callback scheme.
  - Any iPhone build needs a Mac with Xcode; the current Windows PC cannot build the app.

### 10.12 Runbooks

Write runbooks for: deploy, rollback, database restore, secret rotation (Hub client secret, events secret, JWT key) and SES bounce handling.

---

## 11. Work by stream

Task-level status, checked against the code, is tracked in [tasklist.md](tasklist.md).

### Backend

| ID | Work |
|---|---|
| B1 | Commit `shared/plan`, or rebuild it (§2.1); get the suites green in CI |
| B2 | Hub sign-in:<br>• the exchange endpoint, key caching and the events endpoint<br>• remove passwords<br>• users, memberships and invites migration<br>• `X-Account-Id` middleware across every module<br>• isolation tests |
| B3 | Job pipeline: outbox, SQS and worker process. Move plan reading out of the request; add state events; send dead letters to the reviewer queue |
| B4 | Plan v2 library: format, validator, v1-to-v2 converter |
| B5 | Scan reader v2: sections, mesh, control distances, equipment boxes, keyframe crops, type suggestions |
| B6 | Generator: plan v2 to a level file plus placements; storage keyed by hash; the Generating state |
| B7 | Equipment models: the `asset.build` job (measured route and TRELLIS.2 route), model states, "same as" reuse, approval API. Video intake already exists. |
| B8 | Email through SES: the PRD notifications and invites |
| B9 | Hardening: hashed share tokens, WAF limits, production config checks, retention job, account removal as a job |

### Web

| ID | Work |
|---|---|
| W1 | Sign-in through the Hub: login page, callback route, account switcher |
| W2 | Admin: invites instead of passwords; memberships per account; staff roles |
| W3 | Editor: plan v2 properties and tools; equipment type confirmation; model choice; mesh underlay and keyframes |
| W4 | Viewer: load the generated file and equipment models, within the budgets in §8 |
| W5 | Equipment model review screen |
| W6 | Owner pages: the Generating state; machine capture status |
| W7 | Go-live: move strings out of the code for translation; WCAG 2.1 AA pass on the status page and queue (PRD §9) |

### iPhone

| ID | Work |
|---|---|
| I1 | iOS 17 target, real bundle id, signing, TestFlight pipeline |
| I2 | Hub sign-in (`ASWebAuthenticationSession` with PKCE); tokens in the Keychain; account picker; cached facilities for offline start (APP-13) |
| I3 | Block non-LiDAR devices at launch (APP-01) |
| I4 | Sectioned scanning on one live outline, with the extent limit |
| I5 | Mesh and keyframe recording with face blur, uploaded as capture files |
| I6 | Control-distance entry |
| I7 | Tap-to-type for equipment |
| I8 | 360° walk-around recorded with ARKit (camera positions and depth), with a coverage guide and no audio. The plain-video mode and its upload already exist. |
| I9 | Uploads resume after the app is killed, without signing in again (needs I2) |

### Infrastructure

| ID | Work |
|---|---|
| F1 | Accounts and environments, CDK skeleton, network |
| F2 | RDS, S3, KMS, SQS |
| F3 | ECS (API, workers, GPU capacity), load balancer, WAF, CloudFront, DNS and certificates, including the GoalCert subdomain records |
| F4 | SES, Secrets Manager, dashboards and alarms |
| F5 | Pipelines for backend, web, infrastructure and iPhone |
| F6 | Runbooks (§10.12) |

---

## 12. Phases

Each phase ends with a demonstration on staging. Dates are set once the team size is known.

### Phase 0 — Prove (time-boxed)

**Work:**

- `shared/plan` in the repository, all three test suites green, and the app running on a LiDAR iPhone against a local backend. This needs a Mac.
- **Scan test:** sections plus mesh on a real large gym, producing an error-versus-size curve (§5.3).
- **Sign-in test:** a dev client registered in the Hub; web and iPhone sign in end to end against the Flex backend.
- **Equipment test:** five machines through Object Capture, server photogrammetry and TRELLIS.2. Compare look, scale error, processing time and file size.
- **Vision test:** type suggestions on scan keyframes, from a model hosted in Australia.

**Exit:**

- O1–O6 and O8 answered;
- accuracy target and size limit set;
- equipment approach chosen.

### Phase 1 — Foundation

**Work:** F1–F5 (dev and staging), B1–B3, B8, W1–W2, I1–I3 and I9.

**Exit:**

- A user invited by a Flex admin signs in on web and iPhone with their Hub account.
- They upload a drawing, a worker reads it, and it is reviewed and approved on staging.
- The isolation test is green.
- A forced job failure raises an alarm within 5 minutes.

### Phase 2 — Plan v2 and large scans

**Work:** B4, B5, W3 and I4–I7.

**Exit:** a whole gym floor larger than 9 × 9 m, scanned in sections, reaches review as a v2 plan with equipment positions and suggested types, and a reviewer completes it.

### Phase 3 — Generated 3D

**Work:** B6, W4 and W6.

**Exit:** an approved plan becomes a generated walkthrough within the PRD's times, and meets the VIEW-09 budgets with plain equipment boxes.

### Phase 4 — Equipment models

**Work:** B7, W5 and I8.

**Exit:** machines captured with the 360° mode appear as real models in the walkthrough, still within budget.

### Phase 5 — Go-live

**Work:**

- prod environment, B9, W7 and F6;
- TestFlight builds on the customer's devices;
- the reference test set run end to end;
- owner and reviewer user guides;
- the PRD §11 release criteria.

Phases 3 and 4 can overlap with Phase 2 once the v2 format is frozen.

---

## 13. PRD changes needed

**Platform and dependencies (§1 "Why us", §10):** GoalCert provides sign-in only. Tenancy, audit, notifications and storage are built into the Flex backend.

**Non-goals (§2):**

- Drop "Recognising what a piece of equipment is".
- Add equipment 3D models.
- Decide whether a shared equipment library counts as the excluded "equipment catalogue" (O7).

**App requirements:**

- **APP-01:** iOS 17 minimum, replacing "current and previous major".
- **APP-02:** sign in with the GoalCert Hub account through the system browser.
- **New APP items:** sectioned scanning, control distances, keyframes with face blur, equipment type tagging, machine capture mode.

**Plan reading and generation:**

- **RDR-01, RDR-03:** plan v2 contents, equipment type, the mesh.
- **GEN-02, GEN-03:** real heights and thicknesses, door leaves, glazing, spaces, equipment models.

**Plan states (§4):** add "Generating".

**Non-functional (§9):**

- The accuracy target and size limit come from Phase 0 data.
- Residency covers vision and GPU processing.
- Privacy covers keyframes and machine captures.

**ACC-05:** users are added by invite plus a Hub account; the product holds no passwords.

---

## 14. Open decisions

| # | Question | Recommendation | Needed by |
|---|---|---|---|
| O1 | Where the web app's static files are hosted | Flex AWS, with GoalCert DNS (§10.8 A) | Phase 1 |
| O2 | Web subdomain and API domain names | e.g. `gym.goal-cert.com`, `api.<flex domain>` | Phase 1 |
| O3 | Infrastructure-as-code tool | CDK in TypeScript | Phase 1 |
| O4 | Which AWS account holds the CodeCommit repository and pipelines | A Flex tooling account | Phase 1 |
| O5 | iPhone refresh lifetime, and whether a Hub sign-out also signs the phone out | 60 days; only disable or delete signs the phone out | Phase 1 |
| O6 | Accuracy target | Set from Phase 0 data | End of Phase 0 |
| O7 | Reuse of approved machine models across gyms, beyond "same as" within one capture | Start per capture; consider a Flex-curated shared library later, which the PRD calls a catalogue | Phase 4 |
| O8 | Vision model and GPU hosting in Australia | Bedrock in Sydney if a suitable model is available there; otherwise self-hosted | Phase 0 |
| O9 | Apple Developer account and the app's listed name | Already a PRD open question | Phase 1 |
| O10 | A Hub API for creating users, removing the two-step invite | Request it from GoalCert | Phase 5 |
| O11 | The Hub's hosting region (it holds names and emails) | Must be Australia | Phase 1 |
| O12 | Price and timeline impact of the equipment scope | — | Before Phase 4 |
| O13 | Commercial use of TRELLIS.2, given that nvdiffrast's licence is research and evaluation only (nvdiffrec to check) | Legal review; plan to replace those parts if refused | Before Phase 4 production use |
| O14 | Primary model route: measured reconstruction or TRELLIS.2 | Decide from the Phase 0 five-machine test | End of Phase 0 |

---

## 15. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| The accuracy target cannot be met at gym scale | Small size limit, more sections per gym | Measure in Phase 0; control distances; set a target the data supports |
| RoomPlan sections do not merge on open floors | Large gyms unsupported | Read walls from the mesh on the server |
| Gym machines reconstruct poorly (chrome, black rubber) | Models look wrong | TRELLIS.2 fallback, reviewer approval, plain box as last resort |
| First product on the Hub's sign-in contract | Hub gaps block sign-in | Sign-in test in Phase 0; a named GoalCert contact for fixes |
| Two-step user setup confuses admins | Support load | Clear invite screen; request a Hub API (O10) |
| The membership change touches every backend module | Regressions | Isolation tests first; staged rollout |
| Vision or GPU processing outside Australia | Breaches the PRD's residency rule | §10.9 checklist |
| Equipment models make the walkthrough heavy | Slow first load | Levels of detail, compression, instancing, a budget check in CI |
| `shared/plan` never arrives | No working baseline | The rewrite path in §2.1 |
| TRELLIS.2 cannot be used commercially as it stands | Generated route unavailable | Legal review (O13); measured route; replace the restricted dependencies |
| The plain 360° video carries no depth or camera positions | Measured reconstruction is weak or impossible | Record the walk-around with ARKit (§7.2) |
