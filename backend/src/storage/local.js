/**
 * Local-disk storage for development and tests.
 *
 * Mimics S3 multipart closely enough that the app cannot tell the
 * difference: part URLs point back at this API (`PUT /storage/local/...`),
 * carry an expiry and an HMAC signature, and answer 403 once expired, just
 * like a stale S3 presigned URL.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { StorageIncomplete } from './errors.js';

const UPLOAD_ID = /^[A-Za-z0-9_-]{16,64}$/;

export class LocalStorage {
  constructor({ dir, secret, publicUrl, urlTtlSeconds = 6 * 3600 }) {
    this.dir = path.resolve(dir);
    this.secret = secret;
    this.publicUrl = publicUrl;
    this.urlTtlSeconds = urlTtlSeconds;
  }

  #pending(uploadId) {
    if (!UPLOAD_ID.test(uploadId)) throw new Error('Bad upload id');
    return path.join(this.dir, '.multipart', uploadId);
  }

  #object(key) {
    const full = path.resolve(this.dir, key);
    // Keys come from the server, but never let one escape the root.
    if (!full.startsWith(this.dir + path.sep)) throw new Error('Bad storage key');
    return full;
  }

  #sign(uploadId, partNumber, expires) {
    return createHmac('sha256', this.secret)
      .update(`${uploadId}|${partNumber}|${expires}`)
      .digest('base64url');
  }

  async createMultipart(key) {
    const uploadId = randomBytes(18).toString('base64url');
    const dir = this.#pending(uploadId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'key'), key);
    return uploadId;
  }

  async presignPart(_key, uploadId, partNumber, ttlSeconds = this.urlTtlSeconds) {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = this.#sign(uploadId, partNumber, expires);
    return `${this.publicUrl}/storage/local/${uploadId}/${partNumber}?expires=${expires}&sig=${sig}`;
  }

  /** Checks a part URL's signature and expiry. */
  verify(uploadId, partNumber, expires, sig) {
    if (!UPLOAD_ID.test(uploadId)) return false;
    const exp = Number(expires);
    if (!Number.isInteger(exp) || exp < Date.now() / 1000) return false;
    const want = Buffer.from(this.#sign(uploadId, partNumber, exp));
    const got = Buffer.from(String(sig ?? ''));
    return want.length === got.length && timingSafeEqual(want, got);
  }

  /** Stores one part from a request stream. Returns its ETag. */
  async putPart(uploadId, partNumber, stream, { maxBytes }) {
    const dir = this.#pending(uploadId);
    await stat(dir); // Throws if the upload is unknown or already finished.
    const target = path.join(dir, `${partNumber}.part`);
    const partial = `${target}.tmp-${randomBytes(4).toString('hex')}`;
    const hash = createHash('md5');
    let size = 0;

    stream.on('data', (chunk) => {
      size += chunk.length;
      hash.update(chunk);
      if (size > maxBytes) stream.destroy(new Error('Part too large'));
    });
    try {
      await pipeline(stream, createWriteStream(partial));
    } catch (err) {
      await rm(partial, { force: true });
      throw err;
    }
    // A retried part replaces the earlier attempt, as in S3.
    await rename(partial, target);
    return `"${hash.digest('hex')}"`;
  }

  async complete(key, uploadId, { partCount, bytes }) {
    // Already assembled by an earlier call whose response was lost.
    try {
      if ((await stat(this.#object(key))).size === bytes) return;
    } catch {
      // Not assembled yet.
    }

    const dir = this.#pending(uploadId);
    let total = 0;
    const missing = [];
    for (let n = 1; n <= partCount; n++) {
      try {
        total += (await stat(path.join(dir, `${n}.part`))).size;
      } catch {
        missing.push(n);
      }
    }
    if (missing.length) {
      throw new StorageIncomplete(`${missing.length} part(s) of ${key} have not arrived.`, missing);
    }
    if (total !== bytes) {
      // Some part is short, but not which: have them all sent again.
      throw new StorageIncomplete(
        `${key} is ${total} bytes; expected ${bytes}.`,
        [...Array(partCount)].map((_, i) => i + 1),
      );
    }

    const target = this.#object(key);
    await mkdir(path.dirname(target), { recursive: true });
    const out = createWriteStream(`${target}.assembling`);
    for (let n = 1; n <= partCount; n++) {
      await pipeline(createReadStream(path.join(dir, `${n}.part`)), out, { end: false });
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    await rename(`${target}.assembling`, target);
    await rm(dir, { recursive: true, force: true });
  }

  /** True once `complete` has assembled the object. */
  async exists(key) {
    try {
      await stat(this.#object(key));
      return true;
    } catch {
      return false;
    }
  }

  read(key) {
    return readFile(this.#object(key));
  }

  /** Stores a whole object the server produced itself (a generated model). */
  async write(key, body) {
    const target = this.#object(key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(`${target}.writing`, body);
    await rename(`${target}.writing`, target);
  }

  /** Removes a stored object; a missing one is not an error. */
  async delete(key) {
    await rm(this.#object(key), { force: true });
  }

  /** Removes every object under a folder (`prefix` ends in `/`). */
  async deleteFolder(prefix) {
    if (!prefix.endsWith('/')) throw new Error('A folder to delete must end in /');
    await rm(this.#object(prefix), { recursive: true, force: true });
  }

  /** A short-lived URL to GET a stored object, like an S3 presigned GetObject. */
  presignDownload(key, ttlSeconds = 3600) {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const k = Buffer.from(key).toString('base64url');
    const sig = this.#sign(`get:${k}`, 0, expires);
    return `${this.publicUrl}/storage/local/objects/${k}?expires=${expires}&sig=${sig}`;
  }

  /** Checks a download URL and returns the object's path on disk, or null. */
  verifyDownload(encodedKey, expires, sig) {
    const exp = Number(expires);
    if (!Number.isInteger(exp) || exp < Date.now() / 1000) return null;
    const want = Buffer.from(this.#sign(`get:${encodedKey}`, 0, exp));
    const got = Buffer.from(String(sig ?? ''));
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    return this.#object(Buffer.from(encodedKey, 'base64url').toString());
  }

  async abort(_key, uploadId) {
    await rm(this.#pending(uploadId), { recursive: true, force: true });
  }

  /** Cold storage has no local equivalent: the file stays where it is. */
  async archive(key) {
    await stat(this.#object(key));
  }
}
