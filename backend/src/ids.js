import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

let lastMs = 0;
let sequence = 0;

/**
 * A UUIDv7 (RFC 9562), the primary key of every table (C-02).
 *
 * The first 48 bits are the Unix time in milliseconds, so ids sort by when
 * they were made and inserts land at the end of each index instead of at
 * random places in it. Within one millisecond a 12-bit counter keeps them
 * in order; the rest is random, so ids stay unguessable.
 */
export function newId() {
  let ms = Date.now();
  if (ms <= lastMs) {
    sequence = (sequence + 1) & 0xfff;
    // The counter wrapped within one millisecond: borrow the next one.
    if (sequence === 0) lastMs += 1;
    ms = lastMs;
  } else {
    lastMs = ms;
    sequence = randomBytes(2).readUInt16BE() & 0x7ff;
  }
  const bytes = randomBytes(16);
  bytes.writeUIntBE(ms, 0, 6);
  bytes[6] = 0x70 | (sequence >> 8);
  bytes[7] = sequence & 0xff;
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Is `value` shaped like one of our ids? Checked before it reaches a query. */
export function isId(value) {
  return typeof value === 'string' && UUID.test(value);
}

/** An opaque secret for tokens and share links. */
export function newToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** Constant-time comparison of two strings. */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
