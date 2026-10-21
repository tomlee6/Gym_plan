# Gym Plan backend

Node.js + MySQL API for Flex Gym Plan: the iOS scan app, and the web module
(owner status and uploads, reviewer editor, walkthrough, admin). Express 5,
`mysql2`, `zod`.

The plan format, plan reading and validation live in `../shared/plan/` and
are used by both this backend and the web app, so the editor and the server
always agree on what a valid plan is.

## Run it

Needs Node 22+ and Docker.

```sh
cd backend
npm install
npm run db:up        # MySQL 8.4 in Docker on port 3317 (gymplan + gymplan_test)
cp .env.example .env # then set JWT_SECRET and STORAGE_SIGNING_SECRET
npm run db:migrate   # one baseline: migrations/001_baseline.sql
npm run db:seed      # demo data, see below
npm run dev          # the API, http://localhost:8080
npm run dev:worker   # background jobs: plan reading, 3D generation, removal, retention
```

Sign-in goes through Amazon Cognito in Sydney (`HUB_DRIVER=cognito`): its
managed sign-in page holds passwords, "forgot password" and MFA, and an
admin's invite creates the person there. Everything else about a person
(name, accounts, roles, invites, sessions) stays in this database. Locally
`HUB_DRIVER=dev` serves a stand-in Hub at `/dev-hub`, so the web app and the
phone run the real flow, and its page lists the seeded people:

| Who           | Access                                                       | Web home  |
| ------------- | ------------------------------------------------------------ | --------- |
| Sam Okafor    | owner at Northgate Group, surveyor at Kestrel Health Clubs   | `/plans`  |
| Lee Tan       | surveyor at Northgate Group                                  | `/plans`  |
| Maya Restrepo | Flex reviewer                                                | `/review` |
| Jordan Kaur   | Flex platform admin                                          | `/admin`  |

Anyone else can be signed in by email on the dev Hub page; they get in once
an admin has invited that email to an account. See `docs/api-contract-v2.md`
for sign-in, `X-Account-Id`, plan states and plan format 3, and
`../docs/runbooks/` for running it in AWS.

Every seeded version carries a plan read from a synthetic scan, so the
editor and the walkthrough have something to show.

Point the app at it:

```sh
cd mobile
flutter run --dart-define=GYM_PLAN_API=http://<this computer's LAN IP>:8080
```

(`http://10.0.2.2:8080` from the Android emulator; `localhost` from the iOS
simulator.) Set `PUBLIC_API_URL` in `.env` to the same address, since the
local storage driver hands out upload URLs built from it.

## Tests

```sh
npm test
```

Runs against the `gymplan_test` database (dropped and recreated per file), on
a real MySQL, with no database mocking. Covers sign-in and token rotation,
password reset, profile and settings, plans and history, share links and
revocation, scan and drawing uploads (including missing and expired parts,
and the web app's CORS), plan reading, the editor's save/approve/reject/
revise rules, idle-aware review time, the monthly quota, admin accounts and
data removal, the audit log and its CSV, and tenant isolation.
`test/plan.test.js` covers the shared plan library without a database.

## Plan lifecycle

PRD section 4. The mobile app reads the same `status` values.

| `status`     | Set by                                  | Owner sees                               |
| ------------ | --------------------------------------- | ---------------------------------------- |
| `uploading`  | a capture or drawing is registered      | Received                                 |
| `processing` | upload confirmed; plan reading done     | Processing complete, awaiting review     |
| `in_review`  | a reviewer opens (claims) it            | In review                                |
| `recapture`  | rejected with a reason code and note    | Needs recapture + reason                 |
| `ready`      | approved: plan frozen, hash recorded    | Ready + walkthrough                      |
| `superseded` | a newer version of the level approved   | (history only)                           |

Plan reading (`shared/plan/reading.js`) turns a scan's `scan.json`
(RoomPlan) into the internal plan with a confidence per element and flags for
anything under 0.6. An uploaded drawing gets an empty plan scaled from the
owner's line, with the drawing as the underlay the reviewer traces. There is
no automatic approval at any confidence.

The walkthrough is built in the browser from the approved plan (GEN-01:
the same plan always gives the same model), so approving makes it available
at once.

## Services

| Module                     | Routes             | What it does                                                        |
| -------------------------- | ------------------ | ------------------------------------------------------------------- |
| `modules/auth.js`          | `/v1/auth/*`       | Sign-in, refresh (rotating), sign-out, password reset               |
| `modules/profile.js`       | `/v1/me`           | Who is signed in, organisation, quota, capture settings             |
| `modules/facilities.js`    | `/v1/facilities`   | The gyms the user can capture                                       |
| `modules/plans.js`         | `/v1/plans`        | Owner status, history, walkthrough model, share links               |
| `modules/captures.js`      | `/v1/captures`     | Scan and drawing uploads (`mobile/docs/upload-api.md`), plan reading |
| `modules/review.js`        | `/v1/review`       | Queue, editor save, claim/release, approve, reject, revise          |
| `modules/admin.js`         | `/v1/admin`        | Accounts, users, quota, data removal, audit log, reviewer time      |
| `modules/share.js`         | `/v1/share`        | Resolves a share link (no sign-in)                                  |
| `modules/local-storage.js` | `/storage/local`   | Part uploads and signed downloads when `STORAGE_DRIVER=local`       |

### Auth

- `POST /v1/auth/login` `{email, password}` → `{accessToken, refreshToken, expiresIn, user}`
- `POST /v1/auth/refresh` `{refreshToken}` → a new pair. Refresh tokens rotate;
  reusing an old one revokes every session for that user.
- `POST /v1/auth/logout` `{refreshToken}` → 204
- `POST /v1/auth/password-reset` `{email}` → 202 whether or not the account
  exists. `POST /v1/auth/password-reset/confirm` `{token, password}` → 204.

Access tokens are JWTs valid for 30 minutes. Everything else needs
`Authorization: Bearer <accessToken>`. Roles: `owner`, `surveyor` (a
customer account), `reviewer`, `admin` (Flex staff, every account).

### Profile and facilities

- `GET /v1/me` → name, initials, role, role label, organisation, facility
  count, default facility, `plansUsed` / `planQuota` this month, `settings`
- `PATCH /v1/me/settings` `{uploadOnMobileData?, warnBeforePhotos?}`
- `GET /v1/facilities` → `{facilities: [{id, name}], defaultFacilityId}`

### Plans (owner)

- `GET /v1/plans?limit=` → each plan at its newest version, most recently
  changed first: `{id, facilityId, site, level, status, version, inputType,
  submittedAt, reviewStartedAt, reviewedAt, reviewerName, rejectionReason,
  updatedAt, walkthroughVersion}`. `walkthroughVersion` is the newest
  approved version, so the walkthrough stays available while a later
  version is in review.
- `GET /v1/plans/:id` → the above plus `areaM2`, `coverage`,
  `overrideRecorded`, `review {reviewer, seconds, note}`, `walkthroughUrl`
  (the web walkthrough), `shareLink`, and `history` (every version with who
  submitted and reviewed it, when, and its content hash).
- `GET /v1/plans/:id/model` → the newest approved plan for the viewer, with
  `contentHash` and the facility's approved `levels`.
- `POST /v1/plans/:id/share-links` → `{url, expiresAt}`; reuses an active
  link. `DELETE /v1/plans/:id/share-links` revokes it.

### Captures

Scans from the app: see [`mobile/docs/upload-api.md`](../mobile/docs/upload-api.md).
Drawings from the web: `POST /v1/captures/drawings` (with `Idempotency-Key`)
`{facilityId, level, ceilingHeightM?, inputType: pdf|dwg|jpg|png,
originalName, bytes ≤ 50 MB, page?, pageCount?, imageWidth?, imageHeight?,
scale: {a, b, lengthM} | null}`. The scale line is in the image's pixels
and is required except for DWG. Then the same `uploads` / `complete` calls,
with files of kind `source` (the original, kept unchanged) and, for a PDF,
`source_image` (the chosen page as PNG). Confirming receipt runs plan
reading and puts the version in the reviewer queue.

### Review (reviewers and admins)

- `GET /v1/review/queue` → `{versions, stats}`, oldest first, with input type,
  coverage, open flags, capture flags and who holds each.
- `GET /v1/review/versions/:id` → the version, its `plan`, `planRevision`,
  `issues` (validation), `blockers` (why Approve is disabled), `history`,
  `rejectReasons`, capture metadata, and signed download URLs for its files.
- `POST …/start` claims it; `POST …/release` puts it back. A version someone
  else holds answers 409 to every change.
- `PUT …/plan` `{plan, revision}` saves the reviewer's edits; a stale
  `revision` is refused (409) rather than overwriting.
- `POST …/activity` — the reviewer is working. Review time counts only gaps of
  10 minutes or less between activity (REV-10).
- `POST …/approve` — only with no validation issues and no open flags;
  records a SHA-256 of the canonical plan, makes the version read-only and
  supersedes the previous approved version.
- `POST …/reject` `{reason, note}` — reason is one of `Incomplete coverage`,
  `Wrong scale`, `Unreadable source`, `Wrong facility or level`, `Other`.
- `POST …/revise` — a new version of an approved plan (REV-09), claimed by
  you. It does not use the customer's quota.

### Admin

- `GET/POST /v1/admin/accounts`, `GET/PATCH /v1/admin/accounts/:id` — accounts,
  quota and usage.
- `POST /v1/admin/accounts/:id/users`, `DELETE …/users/:userId` (deactivates
  and revokes sessions), `POST …/facilities`.
- `POST /v1/admin/accounts/:id/removal` `{confirmName}` — ACC-07: deletes
  plans, scans, files and users; the audit log is kept with identifiers only.
- `GET /v1/admin/audit?orgId&action&from&to&before&limit` and
  `GET /v1/admin/audit.csv` — the audit log (ACC-06). CSV cells that could
  start a spreadsheet formula are escaped.
- `GET /v1/admin/reviewers` — each reviewer's weekly median over 8 weeks.

### Share links

`GET /v1/share/:token` needs no sign-in: it is what the web viewer at
`PUBLIC_WEB_URL/s/<token>` calls. Returns the site, level, version, area,
approval date and the approved `plan` for an active link, and 404 for an
unknown, expired or revoked one.

## CORS

Only `PUBLIC_WEB_URL` may call the API from a browser. `/storage/local`
answers the same origin's preflight, so the web app can PUT drawing parts
and read scan files. With `STORAGE_DRIVER=s3`, give the bucket a CORS rule
allowing `GET` and `PUT` from `PUBLIC_WEB_URL`, exposing `ETag`.

## Email

Notifications (ACC-04) go out on: plan ready for review (reviewers), plan
rejected and walkthrough ready (owners). `mailer.js` logs them outside
production until a mail provider (GoalCert notifications) is connected.

## Data

`migrations/001_init.sql`, `002_review_admin.sql`. Every customer row has
`org_id`, and every customer query filters on the caller's organisation;
another customer's data answers 404, never 403. Passwords are
bcrypt-hashed; refresh and reset tokens are stored as SHA-256 hashes. The
audit log has no foreign keys so it outlives removed accounts.

## Storage

`STORAGE_DRIVER=local` keeps files under `STORAGE_LOCAL_DIR` and serves
HMAC-signed, expiring upload and download URLs from this API: for
development and tests. `STORAGE_DRIVER=s3` uses S3 multipart with presigned
URLs and server-side encryption; set `S3_BUCKET`, `S3_REGION` and AWS
credentials.

## Not built yet

- **Automatic reading of uploaded drawings (RDR-05) and DWG layers
  (RDR-04).** Drawings are traced by the reviewer over the uploaded image. A
  DWG cannot be previewed in the browser, so it is drawn in metres from the
  owner's other information, or rejected as an unreadable source.
- **Sending email.** Messages are logged, not sent.
- **Rate limits** are per process, in memory. Move them to a shared store
  before running more than one instance.
