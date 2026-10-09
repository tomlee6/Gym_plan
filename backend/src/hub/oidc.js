/**
 * The real GoalCert Hub over OpenID Connect: the token endpoint with the
 * client secret, and the Hub's published signing keys (JWKS).
 */
import { createPublicKey } from 'node:crypto';

const KEYS_TTL_MS = 10 * 60 * 1000;

export class OidcHub {
  constructor({ tokenUrl, jwksUrl, clientId, clientSecret }, { fetch = globalThis.fetch } = {}) {
    this.tokenUrl = tokenUrl;
    this.jwksUrl = jwksUrl;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.fetch = fetch;
    this.keys = new Map();
    this.keysAt = 0;
  }

  async exchange({ code, codeVerifier, redirectUri }) {
    const res = await this.fetch(this.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(
          `${encodeURIComponent(this.clientId)}:${encodeURIComponent(this.clientSecret)}`,
        ).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
        client_id: this.clientId,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || typeof body?.id_token !== 'string') {
      throw new Error(`Hub token endpoint answered ${res.status}`);
    }
    return { idToken: body.id_token };
  }

  /** The Hub's key with this id, refetching the set when it is unknown or stale. */
  async key(kid) {
    const fresh = Date.now() - this.keysAt < KEYS_TTL_MS;
    if (!fresh || !this.keys.has(kid)) await this.#loadKeys();
    const key = this.keys.get(kid) ?? (this.keys.size === 1 && !kid ? [...this.keys.values()][0] : null);
    if (!key) throw new Error(`Unknown Hub signing key ${kid}`);
    return key;
  }

  async #loadKeys() {
    // Do not hammer the Hub when a forged token names a made-up key.
    if (Date.now() - this.keysAt < 30000 && this.keys.size) return;
    const res = await this.fetch(this.jwksUrl, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Hub JWKS answered ${res.status}`);
    const { keys = [] } = await res.json();
    this.keys = new Map(
      keys
        .filter((k) => k.use !== 'enc')
        .map((k) => [k.kid ?? null, createPublicKey({ key: k, format: 'jwk' })]),
    );
    this.keysAt = Date.now();
  }
}
