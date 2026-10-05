import { createHash, randomBytes } from 'node:crypto';

/** A prefixed random id, e.g. `plan_7Fh2k…`. 20 bytes of randomness. */
export function newId(prefix) {
  return `${prefix}_${randomBytes(15).toString('base64url')}`;
}

/** An opaque secret for tokens and share links. */
export function newToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}
