/**
 * The pieces of the capture upload that more than one router needs: finding
 * a capture the caller's account owns, handing out signed part URLs, and
 * finishing a set of multipart files.
 *
 * These live here rather than in `captures.js` so the equipment router can
 * use the same upload path without the two modules importing each other.
 * There is one chunked, signed-URL upload in this service, and everything
 * that uploads a file goes through it.
 */
import { one, pool } from '../db/pool.js';
import { notFound } from '../errors.js';
import { isId } from '../ids.js';
import { StorageIncomplete, storage } from '../storage/index.js';

/** The capture named in the route, or 404 if it is not this account's. */
export async function captureOr404(db, req, { lock = false } = {}) {
  const id = req.params.captureId;
  const capture = isId(id)
    ? await one(db, `SELECT * FROM captures WHERE id = ? AND account_id = ?${lock ? ' FOR UPDATE' : ''}`, [
        id,
        req.account.id,
      ])
    : null;
  if (!capture) throw notFound('This capture does not exist.');
  return capture;
}

export function partCount(bytes, partSize) {
  return Math.max(1, Math.ceil(bytes / partSize));
}

/** Signed URLs for the named parts of one file. */
export async function partTargets(file, numbers) {
  const s = storage();
  return {
    name: file.name,
    fileId: file.id,
    parts: await Promise.all(
      numbers.map(async (n) => ({ number: n, url: await s.presignPart(file.storage_key, file.upload_id, n) })),
    ),
  };
}

/** Every part number of a file, for its first set of URLs. */
export const allParts = (file) => [...Array(Number(file.part_count))].map((_, i) => i + 1);

/**
 * Assembles each file that has not been stored yet. Returns the parts that
 * never arrived, per file; the app resends exactly these and asks again,
 * so this is an ordinary answer rather than an error.
 */
export async function completeFiles(files) {
  const missing = [];
  for (const file of files) {
    if (file.status === 'stored') continue;
    try {
      await storage().complete(file.storage_key, file.upload_id, {
        partCount: Number(file.part_count),
        bytes: Number(file.bytes),
      });
    } catch (err) {
      if (!(err instanceof StorageIncomplete)) throw err;
      missing.push({ fileId: file.id, parts: err.missing });
      continue;
    }
    await pool.query(`UPDATE capture_files SET status = 'stored' WHERE id = ?`, [file.id]);
    file.status = 'stored';
  }
  return missing;
}

/**
 * Removes files' stored objects, or abandons their unfinished uploads. Run
 * after the rows are gone; a failure is logged, since an object without a
 * row is unreachable and the account removal job sweeps the rest.
 */
export async function discardObjects(files) {
  for (const f of files) {
    try {
      if (f.status === 'stored') await storage().delete(f.storage_key);
      else await storage().abort(f.storage_key, f.upload_id);
    } catch (err) {
      console.error(`Could not discard ${f.storage_key}:`, err);
    }
  }
}
