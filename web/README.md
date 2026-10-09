# Gym Plan web

The web pages of Flex Gym Scan, in one React 19 + Vite app:

| Path                          | Page                                                                  |
| ----------------------------- | --------------------------------------------------------------------- |
| `/login`, `/auth/callback`    | **Sign in** with GoalCert (every role)                                |
| `/plans`, `/plans/:id`        | **Owner**: each gym's plans, their state, machines, share links        |
| `/upload`                     | **Owner**: upload a drawing                                            |
| `/review`                     | **Reviewer**: the queue, claim, approve or send back                   |
| `/review/versions/:id`        | The plan editor: floor plan, capture details, photos, files            |
| `/admin`, `/admin/accounts/:id` | **Admin**: accounts, invites, members, facilities, data removal      |
| `/admin/staff`, `/admin/audit` | **Admin**: Flex staff roles, the audit log                            |
| `/s/<token>`                  | **Share viewer**: an approved walkthrough, read-only, no sign-in        |

## Run it

Needs Node 22+ and the backend running (`npm run dev` in `backend/`, with
`HUB_DRIVER=dev` for the stand-in GoalCert Hub).

```sh
cd web
npm install
npm run dev          # http://localhost:3000
```

Port 3000 matches the backend's default `PUBLIC_WEB_URL`, so share links and
the Hub's redirect back (`/auth/callback`) open here. In development Vite
forwards `/v1/*` (and `/dev-hub/*`) to the backend (`GYM_PLAN_API`, default
`http://localhost:8080`; see `.env.example`).

## Signing in (B-07)

There are no passwords in this app. **Sign in with GoalCert** does the
authorization-code flow with PKCE against the GoalCert Hub
(`backend/docs/api-contract-v2.md`, section 1):

1. `GET /v1/auth/hub/config` gives the Hub's `authorizeUrl`, `clientId`,
   `scope` and `redirectUris.web` (default: this origin's `/auth/callback`).
2. The page makes `state`, `nonce` and a PKCE verifier with WebCrypto, keeps
   them in this tab's `sessionStorage`, and redirects the whole page to the
   Hub with the S256 challenge.
3. The Hub sends the browser back to `/auth/callback?code=…&state=…`. The
   page checks `state`, then `POST /v1/auth/hub {code, codeVerifier,
   redirectUri, nonce, client: 'web'}`; the backend holds the client secret,
   verifies the ID token and answers with Flex tokens, the user and their
   accounts.
4. `403 no_access` (signed in at the Hub, but not invited anywhere) and
   `401 hub_rejected` are explained in plain words with **Sign in again**.

With the dev Hub (`HUB_DRIVER=dev`) the same flow shows a list of seeded
people to sign in as.

The access token is kept in memory and the refresh token in the tab's
`sessionStorage` (B-06: web sessions are tab-only), so a reload keeps you
signed in and closing the tab signs you out. Refresh tokens rotate, and the
backend revokes a user's sessions if an old one is reused, so the client
never has two refreshes in flight.

### Roles and accounts

- `user.staffRole` (`reviewer` / `admin`) opens the review and admin areas;
  admins start on `/admin`, reviewers on `/review`.
- Everyone else works in a gym **account** with role `owner` or `surveyor`
  and starts on `/plans`. Customer calls (`/v1/plans`, `/v1/captures`,
  `/v1/facilities`, `/v1/me`) carry `X-Account-Id`. Someone in several
  accounts gets an account switcher at the top of the sidebar; switching
  reloads every page for the new account. The choice is kept per tab and
  defaults to the first account.

## Owner pages

- **My plans**: every gym and level, each plan's state in the PRD's words —
  *Received*, *Processing complete, awaiting review*, *In review*, *Building
  walkthrough* (approved, model being generated), *Ready*, *Needs
  recapture*. A version whose 3D build failed is shown to the owner as *In
  review*: Flex fixes it. Each plan lists its machines and how many 3D
  models are ready.
- **A plan**: the walkthrough and its share link, the machines with each
  one's 3D model state, and the version history.

## Reviewer pages

- **Queue**: waiting and claimed plans, oldest first, refreshed every 30 s,
  with stat tiles and flags from the capture. Versions whose 3D generation
  failed come back here with their `failureReason`. **Opening a plan claims
  it**; a plan another reviewer holds shows as *Taken*.
- **Plan editor**: draw and correct walls, openings, spaces, columns,
  machines and the rest of the plan format (`gymplan/3`), with undo, autosave
  and validation; approve or send back.

## Admin pages (B-09)

- **Accounts**: create one with a name, quota, region and the owner's email
  (they get an invite). Each account lists its members (change role,
  remove), its open invites (invite by email and role, revoke), its gyms,
  and removal of all its data, which runs as a background job.
- **Staff**: who is a reviewer or platform admin. A person must have signed
  in with GoalCert once before they can be made staff.

## Translation and accessibility (H-04)

User-facing words on the owner status pages and the reviewer queue come from
`src/lib/i18n.js` (`t(key, vars)`, with plurals and an English fallback).
To add a language, add a dictionary of the same shape to `LOCALES` there and
call `setLocale`. Those pages are built to WCAG 2.1 AA: headings and
landmarks, table captions and column headers, states in words as well as
colour, visible focus, live regions for loading and errors, text at 4.5:1 or
more.

## Tests and build

```sh
npm test             # Vitest + Testing Library, backend faked in memory
npm run build        # static files in dist/
```

## Build settings (H-05)

All optional, read at build time (see `.env.example`):

| Variable                 | Use                                                                    |
| ------------------------ | ---------------------------------------------------------------------- |
| `VITE_API_URL`           | The backend's URL when it is on another origin. Unset: same origin.    |
| `VITE_HUB_CLIENT_ID`     | Overrides the Hub client id from `/v1/auth/hub/config`.                |
| `VITE_HUB_AUTHORIZE_URL` | Overrides the Hub authorize URL from `/v1/auth/hub/config`.            |
| `VITE_CSP_CONNECT_SRC`   | Extra origins (space-separated) for the CSP's `connect-src`.           |

## Deploying

`dist/` is static. Serve `index.html` for every path (SPA fallback, which
includes `/auth/callback`), and either:

- reverse-proxy `/v1` to the backend on the same origin, or
- build with `VITE_API_URL=https://api.example` and set the backend's
  `PUBLIC_WEB_URL` to this site's origin, which is the only origin the
  backend allows cross-origin calls from.

Register `https://<this site>/auth/callback` as the web redirect URI of the
Flex Gym client at the GoalCert Hub, and give the backend the same value as
`redirectUris.web`.

The reviewer page downloads `scan.json`, the scan mesh and keyframes straight
from storage. With the S3 driver, give the bucket a CORS rule allowing `GET`
from `PUBLIC_WEB_URL`.

The pages set `noindex` and `no-referrer`, so share tokens stay out of search
engines and outgoing `Referer` headers.

### Content-Security-Policy

`csp.json` is the policy. `npm run build` writes it into `dist/index.html`
as a `<meta http-equiv="Content-Security-Policy">` (not in development: Vite's
hot reload needs inline scripts). A `<meta>` policy cannot carry
`frame-ancestors`, so the CloudFront response headers policy for the GoalCert
subdomain must **also** send it as a header. With
`VITE_API_URL=https://api.gym.goalcert.example`, the header is:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; connect-src 'self' blob: data: https://api.gym.goalcert.example https://*.amazonaws.com https://*.cloudfront.net; img-src 'self' data: blob: https:; media-src https: blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

Print it for your own settings with:

```sh
node -e "import('./vite.config.js').then(m => console.log(m.cspFor(process.env, { header: true })))"
```

Notes: `connect-src` covers the API, signed S3 URLs (scans, meshes,
keyframes, uploads) and CloudFront-served models; narrow the wildcards to
your bucket and distribution domains if you can. `img-src https:` and
`media-src https:` allow signed photo, keyframe and 360° video URLs. The
Google Fonts origins are there for the Inter stylesheet in `index.html`;
drop them if the font is self-hosted. The Hub sign-in is a top-level
navigation, which CSP does not restrict.
