# API contract v2: Hub sign-in, accounts, jobs, plan format v3

This is the contract the backend, the web app and the iPhone app build
against after the task-plan rewrite (tasks B-01..B-10, C-01..C-16, D-*, E-*,
G-*). It replaces password sign-in completely.

## 1. Sign-in through the GoalCert Hub (B-01, B-06..B-08)

The Hub is an OpenID Connect provider. Flex Gym is a registered client of it.
Clients do the authorization-code flow with PKCE; only the backend holds the
client secret.

### `GET /v1/auth/hub/config` (no auth)

```json
{
  "authorizeUrl": "https://hub.goalcert.example/oauth/authorize",
  "clientId": "flex-gym-web",
  "scope": "openid profile email",
  "redirectUris": { "web": "https://gym.goalcert.example/auth/callback", "ios": "flexgymscan://auth/callback" }
}
```

The client:

1. makes `state` (random), `nonce` (random) and a PKCE `codeVerifier`
   (43–128 chars of `[A-Za-z0-9-._~]`), and `codeChallenge =
   base64url(sha256(codeVerifier))`;
2. opens `authorizeUrl?response_type=code&client_id=…&redirect_uri=…&scope=…&state=…&nonce=…&code_challenge=…&code_challenge_method=S256`
   (web: full-page redirect, keeping state/nonce/verifier in
   `sessionStorage`; iPhone: `ASWebAuthenticationSession` via
   `flutter_web_auth_2`, callback scheme `flexgymscan`);
3. on the callback checks `state`, then calls:

### `POST /v1/auth/hub` (no auth)

```json
{ "code": "…", "codeVerifier": "…", "redirectUri": "…", "nonce": "…",
  "client": "web" | "ios", "deviceLabel": "Sam's iPhone" }
```

The backend exchanges the code at the Hub token endpoint with the client
secret, verifies the ID token (signature against the Hub JWKS, `iss`, `aud`,
`exp`, `nonce`, and the `org` claim equal to the Flex Gym organisation),
links any open invite whose email matches a **verified** email on first
sign-in, and answers with Flex tokens:

```json
{
  "accessToken": "…", "refreshToken": "…", "expiresIn": 1800,
  "user": { "id": "0192…", "name": "Sam Okafor", "email": "sam@…", "initials": "SO",
            "staffRole": null | "reviewer" | "admin" },
  "accounts": [ { "id": "0192…", "name": "Northgate Group", "role": "owner" | "surveyor" } ]
}
```

Errors: `401 {code:'hub_rejected'}` (bad code / token), `403 {code:'no_access'}`
(signed in at the Hub, but no membership, no invite and no staff role).

### Sessions (B-06)

* `POST /v1/auth/refresh {refreshToken}` → same body as above (rotated).
  Reusing a rotated token revokes every session of that user.
* `POST /v1/auth/logout {refreshToken}` → 204.
* Web sessions: refresh token in the tab's `sessionStorage` only, 12 h
  absolute life. iPhone sessions: 60-day sliding refresh token kept in the
  Keychain (`flutter_secure_storage`), 180-day absolute life.
* A Hub `user.disabled` / `user.deleted` event revokes every session at once;
  the next refresh answers 401 and the client signs out.

### Dev Hub (local development and tests only)

With `HUB_DRIVER=dev` (refused when `NODE_ENV=production`) the backend serves
a stand-in Hub under `/dev-hub`: `GET /dev-hub/authorize` shows a list of
seeded people to sign in as and redirects back with a code, `POST
/dev-hub/token` and `GET /dev-hub/jwks` behave like the real Hub. The whole
flow above runs unchanged against it.

## 2. Accounts and memberships (B-04, B-05, B-09)

* A user belongs to any number of gym **accounts**, with role `owner` or
  `surveyor` in each. Flex staff have a `staffRole` (`reviewer` / `admin`) and
  see every account through the review and admin APIs.
* Every customer request names its account: header **`X-Account-Id: <id>`**.
  The backend checks the membership and answers `403 {code:'no_account'}`
  when the header is missing or the user is not a member.
  Routes that need it: `/v1/facilities`, `/v1/plans/**`, `/v1/captures/**`,
  `GET /v1/me` (optional there: adds the account block).
* `GET /v1/me` →

```json
{ "id": "…", "name": "…", "initials": "SO", "email": "…", "staffRole": null,
  "accounts": [ { "id": "…", "name": "Northgate Group", "role": "owner" } ],
  "account": { "id": "…", "name": "Northgate Group", "role": "owner", "roleLabel": "Owner & Surveyor",
               "facilityCount": 3, "defaultFacility": {"id":"…","name":"…"},
               "plansUsed": 6, "planQuota": 10 } | null,
  "settings": { "uploadOnMobileData": true, "warnBeforePhotos": true } }
```

  (`account` is present when `X-Account-Id` is sent.)

### Admin API (staff `admin` only)

| Method | Path | Body / result |
| --- | --- | --- |
| GET | `/v1/admin/accounts` | `{accounts:[{id,name,region,planQuota,plansUsed,members,facilities,status,createdAt,removedAt}]}` |
| POST | `/v1/admin/accounts` | `{name, planQuota, region?, ownerEmail}` → 201 account (owner gets an invite) |
| GET | `/v1/admin/accounts/:id` | account + `members:[{userId,name,email,role,status,createdAt}]`, `invites:[{id,email,role,expiresAt,createdAt}]`, `facilities` |
| PATCH | `/v1/admin/accounts/:id` | `{name?, planQuota?}` |
| POST | `/v1/admin/accounts/:id/invites` | `{email, role}` → 201 `{id}`; 409 if an open invite exists |
| DELETE | `/v1/admin/accounts/:id/invites/:inviteId` | 204 |
| PATCH | `/v1/admin/accounts/:id/members/:userId` | `{role}` |
| DELETE | `/v1/admin/accounts/:id/members/:userId` | 204 (membership removed; sessions kept for other accounts) |
| POST | `/v1/admin/accounts/:id/facilities` | `{name}` → 201 |
| POST | `/v1/admin/accounts/:id/removal` | `{confirmName}` → 202 `{jobId}`; removal runs as a background job |
| GET | `/v1/admin/staff` | `{staff:[{id,name,email,staffRole,status}], users:[{id,name,email}]}` |
| PUT | `/v1/admin/staff/:userId` | `{staffRole: 'reviewer'|'admin'|null}` |
| GET | `/v1/admin/audit`, `/v1/admin/audit.csv`, `/v1/admin/reviewers` | unchanged (query `accountId` replaces `orgId`) |

## 3. Plan status (D-04, D-05)

`plan_versions.status`: `uploading → processing → in_review → generating →
ready` (or `recapture`, `generation_failed`, `superseded`).

* `processing` with no plan yet = the scan is being read (a `scan.read` /
  `drawing.read` job); the reviewer queue only lists versions that have a plan.
* Approval moves the version to **`generating`** and queues `plan.generate`.
  When the generated model is stored the version becomes `ready` and the
  previous ready version `superseded`.
* `generation_failed` versions go back to the reviewer queue with
  `failureReason` (E-02).
* Owner plan list/detail adds `machines:[{ref,name,type,modelStatus}]` and
  `walkthroughUrl` is built from `PUBLIC_WEB_URL` at read time.

## 4. Plan format `gymplan/3` (G-02..G-08)

Additive over `gymplan/2`; every new field is nullable. `gymplan/1` and
`gymplan/2` plans stay readable; `upgradePlan` converts them and adds one
`default_filled` flag per kind of default it had to fill in.

```js
spaces:   [{ id, name, kind, points, floorFinish, ceilingHeightM, ceilingZones: [{ id, points, heightM }] }]
          // kind: gym_floor|studio|changing|reception|office|corridor|storage|other
          // floorFinish: rubber|timber|turf|carpet|tile|concrete|null
walls[]:  + kind: exterior|interior|partition|glass|null
          + curveM: null | number      // signed sagitta: arc midpoint offset from the chord, left of a→b positive
          + mirrors: [{ id, fromM, toM, bottomM, topM }]   // `mirror` stays, true when mirrors is non-empty
openings[]: + kind: single_door|double_door|sliding_door|roller_shutter|window|fixed_glazing|opening
            + leaves: 1|2|null, hinge: left|right|null, swingInto: spaceId|null
            (`type` stays door|window|opening and is derived from `kind`)
columns[]: + shape: rect|round, heightM: null (full height) | number
beams:    [{ id, kind: beam|bulkhead, points, bottomM }]
levelChanges: [{ id, kind: step|platform|ramp, points, heightM, rampAngleDeg: null|number }]
voids:    [{ id, kind: stair|lift|void, points, railHeightM: null|number }]
objects[]: + facingDeg: null|number    // the machine's front, degrees anticlockwise from +x
           + modelRef: null|string     // machine_models id once approved
           + sameAs: null|objectId     // reuse that machine's model
```

Validation v3 (G-07): when spaces exist they must cover the floor outline
without gaps or overlaps (1% tolerance), openings fit their wall's length and
height, a door joins two different spaces (when there are two or more
spaces), machines and columns sit inside a space.
