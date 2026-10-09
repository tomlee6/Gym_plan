/**
 * The GoalCert Hub: single sign-in for Flex Gym (B-01).
 *
 * The Hub is an OpenID Connect provider. Clients send the user there with
 * PKCE and bring back a one-time code; only this backend holds the client
 * secret, so only it can swap the code for the Hub's signed identity.
 *
 * A driver implements:
 *
 *   exchange({ code, codeVerifier, redirectUri }) -> { idToken }
 *   key(kid)                                      -> KeyObject to verify an ID token
 *
 * `oidc` talks to the real Hub; `dev` is a stand-in served by this API under
 * /dev-hub for local work and tests (refused in production by config.js).
 * Verifying the identity is the same code for both.
 */
import jwt from 'jsonwebtoken';

import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { DevHub } from './dev.js';
import { OidcHub } from './oidc.js';

let instance;

export function hub() {
  instance ??= config.hub.driver === 'dev' ? new DevHub(config.hub) : new OidcHub(config.hub);
  return instance;
}

/** Tests may swap in their own driver. */
export function setHub(driver) {
  instance = driver;
}

export const hubRejected = (msg = 'GoalCert could not confirm your sign-in. Try again.') =>
  new HttpError(401, msg, { code: 'hub_rejected' });

/**
 * Checks the Hub's ID token: its signature against the Hub's keys, then
 * issuer, audience, expiry, the nonce the client made for this sign-in,
 * and that the person belongs to the Flex Gym organisation. Returns the
 * identity claims.
 */
export async function verifyIdentity(idToken, { nonce }) {
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded?.header) throw hubRejected();
  let key;
  try {
    key = await hub().key(decoded.header.kid);
  } catch {
    throw hubRejected();
  }
  let claims;
  try {
    claims = jwt.verify(idToken, key, {
      algorithms: ['RS256', 'ES256'],
      issuer: config.hub.issuer,
      audience: config.hub.clientId,
      clockTolerance: 30,
    });
  } catch {
    throw hubRejected();
  }
  if (!nonce || claims.nonce !== nonce) throw hubRejected();
  if (!claims.sub || typeof claims.sub !== 'string' || claims.sub.length > 64) throw hubRejected();
  const orgs = Array.isArray(claims.org) ? claims.org : [claims.org];
  if (!orgs.includes(config.hub.orgId)) {
    throw new HttpError(403, 'Your GoalCert sign-in is not part of Flex Gym.', { code: 'no_access' });
  }
  return {
    sub: claims.sub,
    email: String(claims.email ?? '').trim().toLowerCase(),
    emailVerified: claims.email_verified === true,
    name: String(claims.name ?? claims.email ?? 'GoalCert user').trim().slice(0, 200),
    sid: typeof claims.sid === 'string' ? claims.sid.slice(0, 64) : null,
  };
}
