/**
 * 3D object scans from the phone: one photo-textured USDZ model of a single
 * thing, built on the iPhone by Apple's Object Capture.
 *
 *   POST   /v1/objects                          register a scan, open its upload
 *   POST   /v1/objects/:objectId/uploads/refresh fresh part URLs
 *   POST   /v1/objects/:objectId/complete       finish the upload
 *   GET    /v1/objects                          the account's scans
 *   GET    /v1/objects/:objectId                one, with a download link
 *   DELETE /v1/objects/:objectId                remove one
 *
 * An object scan is not a capture: it makes no plan version and nothing
 * reviews it. It is kept per account and, when the app sends one, per
 * facility. The file goes up through the same chunked, signed-URL upload as
 * a capture's files; there is one file per scan, so its upload state is on
 * the scan's own row.
 */
import { Router } from 'express';
import { z } from 'zod';

import { audit } from '../audit.js';
import { config } from '../config.js';
import { many, one, pool, transaction } from '../db/pool.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { isId, newId } from '../ids.js';
import { requireAccount, requireAuth } from '../middleware/auth.js';
import { StorageIncomplete, storage } from '../storage/index.js';
import { allParts, partCount, partTargets } from './capture-uploads.js';
import { facilityInAccount } from './facilities.js';

export const router = Router();
router.use(requireAuth, requireAccount('owner', 'surveyor'));

/** Object Capture's full-detail models stay well under this. */
export const MAX_OBJECT_BYTES = 1024 * 1024 * 1024;
const OBJECT_TYPES = ['model/vnd.usdz+zip'];

const registerBody = z.object({
  name: z.string().trim().min(1).max(120),
  facilityId: z.string().min(1).max(64).optional(),
  bytes: z.number().int().min(1).max(MAX_OBJECT_BYTES),
  contentType: z.enum(OBJECT_TYPES),
  partSize: z.number().int().min(config.uploads.minPartSize).max(config.uploads.maxPartSize),
  photoCount: z.number().int().min(0).max(10000).optional(),
  scannedAt: z.string().datetime({ offset: true }).optional(),
});

function idempotencyKey(req) {
  const key = req.get('idempotency-key');
  if (!key || key.length > 100) throw badRequest('An Idempotency-Key header is required.');
  return key;
}

/** The scan named in the route, or 404 if it is not this account's. */
async function scanOr404(db, req, { lock = false } = {}) {
  const id = req.params.objectId;
  const scan = isId(id)
    ? await one(db, `SELECT * FROM object_scans WHERE id = ? AND account_id = ?${lock ? ' FOR UPDATE' : ''}`, [
        id,
        req.account.id,
      ])
    : null;
  if (!scan) throw notFound('This object scan does not exist.');
  return scan;
}

/** The scan's file, in the shape the shared upload helpers take. */
const fileOf = (scan) => ({
  id: scan.id,
  name: 'object.usdz',
  storage_key: scan.storage_key,
  upload_id: scan.upload_id,
  part_count: scan.part_count,
});

/** What the app and the web are told about a scan. */
async function present(scan, { download = false } = {}) {
  return {
    objectId: scan.id,
    name: scan.name,
    status: scan.status,
    facility: scan.facility_id ? { id: scan.facility_id, name: scan.facility_name ?? null } : null,
    bytes: Number(scan.bytes),
    photoCount: scan.photo_count ?? null,
    scannedBy: scan.user_name ?? null,
    scannedAt: scan.scanned_at ?? null,
    createdAt: scan.created_at,
    readyAt: scan.ready_at ?? null,
    ...(download && scan.status === 'ready'
      ? { downloadUrl: await storage().presignDownload(scan.storage_key) }
      : {}),
  };
}

const withNames = `SELECT o.*, f.name AS facility_name, u.name AS user_name
  FROM object_scans o
  LEFT JOIN facilities f ON f.id = o.facility_id
  LEFT JOIN users u ON u.id = o.user_id`;

router.post('/', async (req, res) => {
  const key = idempotencyKey(req);
  const body = registerBody.parse(req.body);

  // A retry after a lost response: the same scan, with fresh part URLs
  // while it is still uploading.
  const earlier = await one(pool, 'SELECT * FROM object_scans WHERE user_id = ? AND idempotency_key = ? AND account_id = ?', [
    req.user.id,
    key,
    req.account.id,
  ]);
  if (earlier) {
    if (earlier.status === 'ready') return res.json({ objectId: earlier.id, status: 'ready' });
    return res.json({ objectId: earlier.id, status: 'uploading', file: await partTargets(fileOf(earlier), allParts(earlier)) });
  }

  let facilityId = null;
  if (body.facilityId) {
    const facility = await facilityInAccount(pool, req.account.id, body.facilityId);
    if (!facility) throw notFound('This facility does not exist.');
    facilityId = facility.id;
  }

  const id = newId();
  // Under the account, so one customer's objects can never be read by another.
  const storageKey = `accounts/${req.account.id}/objects/${id}/object.usdz`;
  const uploadId = await storage().createMultipart(storageKey, body.contentType);
  const row = {
    id,
    storage_key: storageKey,
    upload_id: uploadId,
    part_count: partCount(body.bytes, body.partSize),
  };
  await pool.query(
    `INSERT INTO object_scans
       (id, account_id, facility_id, user_id, idempotency_key, name, photo_count, bytes, content_type,
        part_size, part_count, storage_key, upload_id, scanned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      req.account.id,
      facilityId,
      req.user.id,
      key,
      body.name,
      body.photoCount ?? null,
      body.bytes,
      body.contentType,
      body.partSize,
      row.part_count,
      storageKey,
      uploadId,
      body.scannedAt ? new Date(body.scannedAt) : null,
    ],
  );
  res.status(201).json({ objectId: id, status: 'uploading', file: await partTargets(fileOf(row), allParts(row)) });
});

/** Fresh signed part URLs for an upload that outlived its last set. */
router.post('/:objectId/uploads/refresh', async (req, res) => {
  const body = z.object({ parts: z.array(z.number().int().min(1)).min(1).max(10000) }).parse(req.body);
  const scan = await scanOr404(pool, req);
  if (scan.status === 'ready') throw conflict('This object scan has already been stored.');
  if (body.parts.some((p) => p > scan.part_count)) throw badRequest('Unknown part number.');
  res.json(await partTargets(fileOf(scan), body.parts));
});

/**
 * Finishes the upload. Parts that never arrived are reported back the way
 * a capture's completion reports them, so the app resends exactly those
 * and asks again.
 */
router.post('/:objectId/complete', async (req, res) => {
  z.object({}).passthrough().parse(req.body ?? {});
  const scan = await scanOr404(pool, req);
  if (scan.status === 'ready') return res.json({ objectId: scan.id, status: 'ready' });

  try {
    await storage().complete(scan.storage_key, scan.upload_id, {
      partCount: Number(scan.part_count),
      bytes: Number(scan.bytes),
    });
  } catch (err) {
    if (!(err instanceof StorageIncomplete)) throw err;
    return res.json({ objectId: scan.id, status: 'incomplete', missing: [{ fileId: scan.id, parts: err.missing }] });
  }

  await transaction(async (db) => {
    const [r] = await db.query(
      `UPDATE object_scans SET status = 'ready', ready_at = UTC_TIMESTAMP(3) WHERE id = ? AND status = 'uploading'`,
      [scan.id],
    );
    if (r.affectedRows) {
      await audit(db, {
        accountId: scan.account_id,
        actor: { id: req.user.id },
        action: 'OBJECT_SCANNED',
        target: { type: 'object', id: scan.id, label: scan.name },
        detail: { bytes: Number(scan.bytes), photoCount: scan.photo_count ?? null },
      });
    }
  });
  res.json({ objectId: scan.id, status: 'ready' });
});

/** The account's stored scans, newest first; optionally one facility's. */
router.get('/', async (req, res) => {
  const q = z.object({ facilityId: z.string().min(1).max(64).optional() }).parse(req.query);
  const rows = await many(
    pool,
    `${withNames} WHERE o.account_id = ? AND o.status = 'ready'${q.facilityId ? ' AND o.facility_id = ?' : ''}
     ORDER BY o.created_at DESC LIMIT 500`,
    q.facilityId ? [req.account.id, q.facilityId] : [req.account.id],
  );
  res.json({ objects: await Promise.all(rows.map((r) => present(r))) });
});

router.get('/:objectId', async (req, res) => {
  await scanOr404(pool, req);
  const scan = await one(pool, `${withNames} WHERE o.id = ?`, [req.params.objectId]);
  res.json(await present(scan, { download: true }));
});

/** Removes a scan and its file, or abandons its unfinished upload. */
router.delete('/:objectId', async (req, res) => {
  const scan = await transaction(async (db) => {
    const s = await scanOr404(db, req, { lock: true });
    await db.query('DELETE FROM object_scans WHERE id = ?', [s.id]);
    await audit(db, {
      accountId: s.account_id,
      actor: { id: req.user.id },
      action: 'OBJECT_REMOVED',
      target: { type: 'object', id: s.id, label: s.name },
    });
    return s;
  });
  // After the row is gone: an object without a row is unreachable, and the
  // account removal job sweeps anything a failure here leaves.
  try {
    if (scan.status === 'ready') await storage().delete(scan.storage_key);
    else await storage().abort(scan.storage_key, scan.upload_id);
  } catch (err) {
    console.error(`Could not discard ${scan.storage_key}:`, err);
  }
  res.status(204).end();
});
