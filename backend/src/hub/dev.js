/**
 * A stand-in GoalCert Hub for local development and tests (HUB_DRIVER=dev).
 *
 * It behaves like the real one from the outside — an authorize page that
 * redirects back with a one-time code bound to the PKCE challenge, a token
 * endpoint that checks the client secret and the verifier, and RS256 ID
 * tokens verified against a JWKS — so the web app and the iPhone app run
 * the real sign-in flow against it. The signing key is made fresh each time
 * the process starts.
 *
 * The people it knows are the seeded demo users; anyone else can be added
 * on the authorize page by email, which is how an invite is tried locally.
 */
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';

import { Router } from 'express';
import jwt from 'jsonwebtoken';

import { safeEqual } from '../ids.js';

const CODE_TTL_MS = 5 * 60 * 1000;

/** The people the dev Hub knows from the start, matching the seed, with what the seed lets them do. */
export const DEV_HUB_PEOPLE = [
  { sub: 'hub|sam', email: 'sam.okafor@northgatefitness.com', name: 'Sam Okafor', role: 'Gym owner' },
  { sub: 'hub|lee', email: 'lee.tan@northgatefitness.com', name: 'Lee Tan', role: 'Surveyor' },
  { sub: 'hub|maya', email: 'maya.restrepo@flexmotion.app', name: 'Maya Restrepo', role: 'Flex reviewer' },
  { sub: 'hub|admin', email: 'admin@flexmotion.app', name: 'Jordan Kaur', role: 'Flex admin' },
];

const base64url = (buf) => Buffer.from(buf).toString('base64url');
export const challengeFor = (verifier) => base64url(createHash('sha256').update(verifier).digest());

export class DevHub {
  constructor({ issuer, clientId, clientSecret, orgId }) {
    this.issuer = issuer;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.orgId = orgId;
    this.kid = `dev-${randomBytes(4).toString('hex')}`;
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = privateKey;
    this.publicKey = publicKey;
    this.people = new Map(DEV_HUB_PEOPLE.map((p) => [p.sub, { ...p, emailVerified: true, org: orgId }]));
    this.codes = new Map();
  }

  /** Adds (or finds) a person by email, as signing up at the Hub would. */
  person({ email, name, emailVerified = true, org = this.orgId }) {
    const clean = String(email).trim().toLowerCase();
    const existing = [...this.people.values()].find((p) => p.email === clean);
    if (existing) return existing;
    const sub = `hub|${createHash('sha256').update(clean).digest('hex').slice(0, 16)}`;
    const p = { sub, email: clean, name: name || clean.split('@')[0], emailVerified, org };
    this.people.set(sub, p);
    return p;
  }

  /** What the authorize page does once someone is chosen: a one-time code. */
  issueCode({ sub, redirectUri, codeChallenge, nonce, clientId = this.clientId }) {
    const p = this.people.get(sub);
    if (!p) throw new Error('Unknown person');
    const code = randomBytes(24).toString('base64url');
    this.codes.set(code, {
      sub,
      redirectUri,
      codeChallenge,
      nonce,
      clientId,
      expires: Date.now() + CODE_TTL_MS,
      sid: `sid-${randomBytes(6).toString('hex')}`,
    });
    return code;
  }

  async exchange({ code, codeVerifier, redirectUri, clientId = this.clientId, clientSecret = this.clientSecret }) {
    const grant = this.codes.get(code);
    // A code works once, whatever happens next.
    this.codes.delete(code);
    if (
      !grant ||
      grant.expires < Date.now() ||
      grant.redirectUri !== redirectUri ||
      grant.clientId !== clientId ||
      !safeEqual(clientSecret, this.clientSecret) ||
      !codeVerifier ||
      challengeFor(codeVerifier) !== grant.codeChallenge
    ) {
      throw new Error('invalid_grant');
    }
    const p = this.people.get(grant.sub);
    const idToken = jwt.sign(
      {
        email: p.email,
        email_verified: p.emailVerified,
        name: p.name,
        org: p.org,
        nonce: grant.nonce,
        sid: grant.sid,
      },
      this.privateKey,
      {
        algorithm: 'RS256',
        keyid: this.kid,
        issuer: this.issuer,
        audience: this.clientId,
        subject: p.sub,
        expiresIn: 600,
      },
    );
    return { idToken };
  }

  async key(kid) {
    if (kid !== this.kid) throw new Error('Unknown key');
    return this.publicKey;
  }

  jwks() {
    return { keys: [{ ...this.publicKey.export({ format: 'jwk' }), kid: this.kid, use: 'sig', alg: 'RS256' }] };
  }
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const initials = (name) => {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts.at(-1)[0] : (parts[0]?.[0] ?? '?')).toUpperCase();
};

/** The page's look: the web app's sign-in colours, so local work looks like the real thing. */
const STYLE = `
:root{--bg:#01060a;--line:#1d444f;--text:#fff;--muted:#7b8188;--accent:#00cab2;--accent-bg:#06232d}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:32px 16px;color:var(--text);
 background:radial-gradient(40rem 28rem at 0 0,rgba(0,202,178,.12),transparent 65%),var(--bg);
 font:14px/1.45 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{width:min(420px,100%)}
.brand b{display:block;font-size:19px;letter-spacing:-.4px}
.brand span{display:block;margin-top:4px;font-size:10px;font-weight:700;letter-spacing:2.6px;color:var(--accent)}
.card{margin-top:22px;padding:28px 24px 24px;border-radius:22px;border:1px solid #3f4a4d;
 background:linear-gradient(180deg,#070d15,#01060a);box-shadow:0 30px 80px rgba(0,0,0,.5)}
.dev{display:inline-block;padding:3px 10px;border-radius:999px;background:rgba(255,204,0,.12);color:#ffcc00;font-size:11px;font-weight:600}
h1{margin:12px 0 4px;font-size:26px;letter-spacing:-.6px}
p{margin:0;color:var(--muted);font-size:13.5px}
form{margin:0}
.people{display:grid;gap:8px;margin:20px 0 0}
.person{display:flex;align-items:center;gap:12px;width:100%;padding:10px 12px;border-radius:14px;border:1px solid var(--line);
 background:rgba(0,14,21,.6);color:var(--text);font:inherit;text-align:left;cursor:pointer}
.person:hover,.person:focus-visible{border-color:var(--accent);background:var(--accent-bg);outline:none}
.avatar{flex:none;display:grid;place-items:center;width:36px;height:36px;border-radius:50%;background:var(--accent-bg);color:var(--accent);font-size:13px;font-weight:700}
.who{flex:1;min-width:0}.who strong{display:block;font-weight:600}
.who small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:12px}
.role{flex:none;font-size:11px;color:var(--accent)}
h2{margin:24px 0 10px;padding-top:18px;border-top:1px solid rgba(57,57,57,.7);font-size:13px;font-weight:600;color:var(--muted)}
label{display:grid;gap:6px;margin-bottom:10px;font-size:12px;color:var(--muted)}
input{height:40px;padding:0 12px;border-radius:10px;border:1px solid var(--line);background:#000e15;color:var(--text);font:inherit}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
.go{width:100%;height:44px;margin-top:6px;border:0;border-radius:22px;background:var(--accent);color:var(--bg);font:inherit;font-weight:600;cursor:pointer}
.go:hover{filter:brightness(1.08)}
footer{margin-top:18px;text-align:center;font-size:11.5px;color:var(--muted)}
`;

/** The dev Hub's endpoints, mounted at /dev-hub when HUB_DRIVER=dev. */
export function devHubRouter(getHub) {
  const router = Router();

  router.get('/authorize', (req, res) => {
    const devHub = getHub();
    const q = req.query;
    if (q.response_type !== 'code' || q.client_id !== devHub.clientId || q.code_challenge_method !== 'S256') {
      return res.status(400).send('Bad authorize request: response_type=code, client_id and S256 PKCE are required.');
    }
    const hidden = ['redirect_uri', 'state', 'nonce', 'code_challenge']
      .map((k) => `<input type="hidden" name="${k}" value="${esc(q[k] ?? '')}">`)
      .join('');
    const people = [...devHub.people.values()]
      .map(
        (p) =>
          `<form method="post" action="choose">${hidden}<input type="hidden" name="sub" value="${esc(p.sub)}">` +
          `<button class="person"><span class="avatar">${esc(initials(p.name))}</span>` +
          `<span class="who"><strong>${esc(p.name)}</strong><small>${esc(p.email)}</small></span>` +
          `${p.role ? `<span class="role">${esc(p.role)}</span>` : ''}</button></form>`,
      )
      .join('');
    res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Flex Gym Scan (development)</title>
<style>${STYLE}</style>
<main>
<div class="brand"><b>FLEX</b><span>GYM SCAN</span></div>
<div class="card">
<span class="dev">Development only · not the real sign-in</span>
<h1>Sign in</h1>
<p>Choose who to sign in as. In AWS this is Cognito's page, with an email and password.</p>
<div class="people">${people}</div>
<h2>Someone else</h2>
<form method="post" action="choose">${hidden}
<label>Email <input name="email" type="email" required autocomplete="email"></label>
<label>Name <input name="name" autocomplete="name"></label>
<button class="go">Sign in</button></form>
</div>
<footer>Next XR · Flex 2.0</footer>
</main>
</html>`);
  });

  router.post('/choose', (req, res) => {
    const devHub = getHub();
    const b = req.body ?? {};
    const sub = b.sub || (b.email ? devHub.person({ email: b.email, name: b.name }).sub : null);
    if (!sub || !b.redirect_uri) return res.status(400).send('Choose someone.');
    const code = devHub.issueCode({
      sub,
      redirectUri: b.redirect_uri,
      codeChallenge: b.code_challenge,
      nonce: b.nonce,
    });
    const target = new URL(b.redirect_uri);
    target.searchParams.set('code', code);
    if (b.state) target.searchParams.set('state', b.state);
    res.redirect(302, target.toString());
  });

  router.post('/token', async (req, res) => {
    const b = req.body ?? {};
    const basic = (req.get('authorization') ?? '').replace(/^Basic\s+/i, '');
    const [id, secret] = basic ? Buffer.from(basic, 'base64').toString().split(':').map(decodeURIComponent) : [b.client_id, b.client_secret];
    try {
      const { idToken } = await getHub().exchange({
        code: b.code,
        codeVerifier: b.code_verifier,
        redirectUri: b.redirect_uri,
        clientId: id,
        clientSecret: secret,
      });
      res.json({ id_token: idToken, token_type: 'Bearer', expires_in: 600 });
    } catch {
      res.status(400).json({ error: 'invalid_grant' });
    }
  });

  router.get('/jwks', (_req, res) => res.json(getHub().jwks()));
  return router;
}
