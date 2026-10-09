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

/** The people the dev Hub knows from the start, matching the seed. */
export const DEV_HUB_PEOPLE = [
  { sub: 'hub|sam', email: 'sam.okafor@northgatefitness.com', name: 'Sam Okafor' },
  { sub: 'hub|lee', email: 'lee.tan@northgatefitness.com', name: 'Lee Tan' },
  { sub: 'hub|maya', email: 'maya.restrepo@flexmotion.app', name: 'Maya Restrepo' },
  { sub: 'hub|admin', email: 'admin@flexmotion.app', name: 'Jordan Kaur' },
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
          `<button>${esc(p.name)} <small>${esc(p.email)}</small></button></form>`,
      )
      .join('');
    res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GoalCert (development)</title>
<style>body{font:16px system-ui;max-width:28rem;margin:2rem auto;padding:0 1rem}button{display:block;width:100%;text-align:left;padding:.7rem;margin:.3rem 0}small{color:#555;display:block}</style>
<h1>GoalCert Hub — development</h1>
<p>Not the real Hub. Choose who to sign in as.</p>
${people}
<h2>Someone else</h2>
<form method="post" action="choose">${hidden}
<label>Email <input name="email" type="email" required></label>
<label>Name <input name="name"></label>
<button>Sign in</button></form>`);
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
