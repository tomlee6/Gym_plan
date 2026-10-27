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
 *   invite({ email })                             -> optional: let this email sign in
 *
 * `cognito` is Amazon Cognito in Sydney; `oidc` talks to the GoalCert Hub;
 * `dev` is a stand-in served by this API under /dev-hub for local work and
 * tests (refused in production by config.js). Verifying the identity is the
 * same code for all of them.
 */
import jwt from 'jsonwebtoken';

import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { CognitoHub } from './cognito.js';
import { DevHub } from './dev.js';
import { OidcHub } from './oidc.js';

let instance;

const DRIVERS = { dev: DevHub, oidc: OidcHub, cognito: CognitoHub };

export function hub() {
  instance ??= new DRIVERS[config.hub.driver](config.hub);
  return instance;
}

/** Tests may swap in their own driver. */
export function setHub(driver) {
  instance = driver;
}

export const hubRejected = (msg = 'We could not confirm your sign-in. Try again.') =>
  new HttpError(401, msg, { code: 'hub_rejected' });

/**
 * Checks the Hub's ID token: its signature against the Hub's keys, then
 * issuer, audience, expiry, the nonce the client made for this sign-in,
 * and, when the Hub has organisations (HUB_ORG_ID), that the person belongs
 * to Flex Gym. A Cognito pool is Flex Gym's alone, so it has none. Returns
 * the identity claims.
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
  // Cognito signs access tokens with the same keys: only its ID token will do.
  if (claims.token_use !== undefined && claims.token_use !== 'id') throw hubRejected();
  const orgs = Array.isArray(claims.org) ? claims.org : [claims.org];
  if (config.hub.orgId && !orgs.includes(config.hub.orgId)) {
    throw new HttpError(403, 'Your sign-in is not part of Flex Gym.', { code: 'no_access' });
  }
  return {
    sub: claims.sub,
    email: String(claims.email ?? '').trim().toLowerCase(),
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    name: String(claims.name ?? claims.email ?? 'Flex Gym Scan user').trim().slice(0, 200),
    sid: typeof claims.sid === 'string' ? claims.sid.slice(0, 64) : null,
  };
}
