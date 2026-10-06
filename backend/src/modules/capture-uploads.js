/**
 * The pieces of the capture upload that more than one router needs: finding
 * a capture the caller owns, and handing out signed part URLs.
 *
 * These live here rather than in `captures.js` so the equipment router can
 * use the same upload path without the two modules importing each other.
 * There is one chunked, signed-URL upload in this service, and everything
 * that uploads a file goes through it.
 */
import { one } from '../db/pool.js';
import { notFound } from '../errors.js';
import { storage } from '../storage/index.js';

/** The capture named in the route, or 404 if it is not this customer's. */
export async function captureOr404(db, req, { lock = false } = {}) {
  const capture = await one(
    db,
    `SELECT * FROM captures WHERE id = ? AND org_id = ?${lock ? ' FOR UPDATE' : ''}`,
    [req.params.captureId, req.user.orgId],
  );
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
