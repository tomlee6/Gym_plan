# Gym Plan web

The two web pages of Flex Gym Plan, in one React 19 + Vite app:

| Path                     | Page                                                              |
| ------------------------ | ----------------------------------------------------------------- |
| `/review`                | **Reviewer**: sign in, the queue, claim, approve or send back      |
| `/review/versions/:id`   | One plan version: floor plan, capture details, photos, files       |
| `/s/<token>`             | **Share viewer**: an approved walkthrough, read-only, no sign-in    |

## Run it

Needs Node 22+ and the backend running (`npm run dev` in `backend/`).

```sh
cd web
npm install
npm run dev          # http://localhost:3000
```

Port 3000 matches the backend's default `PUBLIC_WEB_URL`, so share links from
the app open here. In development Vite forwards `/v1/*` to the backend
(`GYM_PLAN_API`, default `http://localhost:8080`; see `.env.example`).

Reviewer demo account from the backend seed: `maya.restrepo@flexmotion.app` /
`review1234`. Gym owner accounts are refused on the reviewer pages.

## Reviewer pages

Follows the web prototype's reviewer screens (queue, approve, reject).

- **Queue**: waiting and claimed plans, oldest first, refreshed every 30 s.
  Stat tiles for waiting, oldest, your median review time this week (target
  under 15 min) and rejections. Flags come from the capture: outline not
  closed, finished early, weak walls, simulated scan. **Opening a plan claims
  it**; a plan another reviewer holds shows as *Taken*.
- **Plan version**: the floor plan drawn from the uploaded `scan.json`
  (RoomPlan's CapturedRoom; see `src/review/roomplan.js`), with walls
  coloured by confidence, doors, windows, equipment and the surveyor's tags;
  capture details; reference photos; downloads for the USDZ model, room data
  and photos. A running timer shows your time on the plan.
- **Approve**: checks (outline, coverage, early finish, tags), what the
  approval is recorded as, and an optional walkthrough link. 3D generation is
  not built yet, so the link is pasted in by hand.
- **Send back**: one of the prototype's reason codes plus a note, which the
  owner reads word for word in the app.
- **Release** puts a claimed plan back in the queue.

Sign-in uses the backend's `POST /v1/auth/login`. To move to GoalCert sign-in,
replace `signIn` in `src/review/client.js`; everything else uses the tokens it
returns. The access token is kept in memory and the refresh token in
`sessionStorage`, so a reload keeps you signed in and closing the tab signs
you out. Refresh tokens rotate, and the backend revokes a user's sessions if
an old one is reused, so the client never has two refreshes in flight.

## Share viewer

`/s/<token>` calls `GET /v1/share/:token` and shows the walkthrough in a
frame, with **Open in new tab** in case the walkthrough host refuses to be
framed, plus the plan details and the PRD's "Indicative only" caveat. Unknown,
expired or withdrawn links say so, and network failures offer a retry.

## Tests and build

```sh
npm test             # Vitest + Testing Library, backend faked in memory
npm run build        # static files in dist/
```

## Deploying

`dist/` is static. Serve `index.html` for every path (SPA fallback), and
either:

- reverse-proxy `/v1` to the backend on the same origin, or
- build with `VITE_API_URL=https://api.example` and set the backend's
  `PUBLIC_WEB_URL` to this site's origin, which is the only origin the
  backend allows cross-origin calls from.

The reviewer page downloads `scan.json` straight from storage. With the S3
driver, give the bucket a CORS rule allowing `GET` from `PUBLIC_WEB_URL`.

The pages set `noindex` and `no-referrer`, so share tokens stay out of search
engines and outgoing `Referer` headers.
