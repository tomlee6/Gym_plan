/**
 * The random values of a GoalCert Hub sign-in (B-07): `state` ties the
 * callback to the tab that started it, `nonce` ties the ID token to this
 * sign-in, and the PKCE verifier proves the code is redeemed by whoever
 * asked for it. The Hub only ever sees the verifier's SHA-256 (S256).
 */

/** Characters RFC 7636 allows in a code verifier (unreserved URL characters). */
const UNRESERVED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

function webCrypto() {
  const c = globalThis.crypto;
  if (!c?.getRandomValues || !c?.subtle) {
    throw new Error('This browser cannot sign in securely. Update it, or use a different browser.');
  }
  return c;
}

/**
 * A random string of `length` unreserved characters. 66 characters do not
 * divide 256 evenly, so bytes past the last whole multiple are re-drawn
 * rather than wrapped, which would favour the first few characters.
 */
export function randomString(length = 64) {
  const crypto = webCrypto();
  const limit = 256 - (256 % UNRESERVED.length);
  let out = '';
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const b of bytes) {
      if (b < limit) out += UNRESERVED[b % UNRESERVED.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/** base64url without padding, as PKCE and JWTs use it. */
export function base64url(bytes) {
  let binary = '';
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The S256 code challenge for a verifier: base64url(sha256(verifier)). */
export async function codeChallenge(verifier) {
  const digest = await webCrypto().subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(digest);
}
