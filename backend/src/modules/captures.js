/**
 * Captures service: how a scan from the app, or a drawing uploaded on the
 * web, reaches the platform (mobile/docs/upload-api.md).
 *
 *   POST /v1/captures                          register a scan, idempotently
 *   POST /v1/captures/drawings                 register an uploaded drawing
 *   POST /v1/captures/:id/uploads              open multipart uploads
 *   POST /v1/captures/:id/uploads/refresh      fresh part URLs
 *   POST /v1/captures/:id/complete             assemble, confirm receipt
 *
 * Every route acts in the account named by X-Account-Id (B-04).
 *
 * Registering adds a new version to the facility level's plan
 * ("uploading"). Confirming receipt moves the version to "processing" and
 * queues plan reading as a job (E-03): the request no longer waits for it,
 * and a reading that fails is retried and, at worst, handed to a reviewer.
 *
 * What the app reports about the scan is kept in typed columns and rows
 * (C-06): coverage, the closed outline, the override reason, tags and the
 * laser-measured control distances.
 */
import { Router } from 'express';
import { z } from 'zod';

import { dist } from '../../../shared/plan/index.js';
import { audit, planLabel } from '../audit.js';
import { config } from '../config.js';
import { many, one, pool, transaction } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { newId } from '../ids.js';
import { enqueue, jobsCommitted } from '../jobs/index.js';
import { requireAccount, requireAuth } from '../middleware/auth.js';
import { storage } from '../storage/index.js';
import { allParts, captureOr404, completeFiles, partCount, partTargets } from './capture-uploads.js';
import { facilityInAccount } from './facilities.js';
import { plansUsedThisMonth } from './profile.js';

export const router = Router();
router.use(requireAuth, requireAccount('owner', 'surveyor'));

const TAG_TYPES = ['ceiling', 'fireExit', 'mirror', 'power', 'stair'];
/** UPL-01: drawings up to 50 MB. */
export const MAX_DRAWING_BYTES = 50 * 1024 * 1024;
const DRAWING_TYPES = ['pdf', 'dwg', 'jpg', 'png'];

const metresPoint = z.tuple([z.number().finite().min(-10000).max(10000), z.number().finite().min(-10000).max(10000)]);

const registerBody = z.object({
  facilityId: z.string().min(1).optional(),
  // Older app builds send the name; kept so they keep working.
  facilityName: z.string().min(1).optional(),
  level: z.number().int().min(-5).max(200),
  floorToFloorM: z.number().min(2).max(12),
  source: z.enum(['lidar', 'simulated']),
  coverage: z.number().min(0).max(1),
  closed: z.boolean(),
  overrideReason: z.string().max(500).nullish(),
  areaM2: z.number().min(0).max(100000).nullish(),
  durationSeconds: z.number().int().min(0),
  photoCount: z.number().int().min(0).max(65535),
  weakWallCount: z.number().int().min(0).max(65535).optional(),
  tags: z
    .array(
      z.object({
        type: z.enum(TAG_TYPES),
        x: z.number(),
        y: z.number(),
        heightM: z.number().positive().nullish(),
      }),
    )
    .max(500),
  // F-03: laser-measured distances between two marked points on the scan.
  controlDistances: z
    .array(z.object({ a: metresPoint, b: metresPoint, measuredM: z.number().positive().max(1000) }))
    .max(50)
    .default([]),
  capturedAt: z.iso.datetime({ offset: true }).optional(),
});

const point = z.tuple([z.number().min(0), z.number().min(0)]);

/** An owner's drawing (UPL-01..03). Scale is required except for DWG. */
const drawingBody = z
  .object({
    facilityId: z.string().min(1),
    level: z.number().int().min(-5).max(200),
    ceilingHeightM: z.number().min(2).max(12).optional(),
    inputType: z.enum(DRAWING_TYPES),
    originalName: z.string().trim().min(1).max(200),
    bytes: z.number().int().min(1).max(MAX_DRAWING_BYTES),
    page: z.number().int().min(1).max(65535).optional(),
    pageCount: z.number().int().min(1).max(65535).optional(),
    imageWidth: z.number().int().min(1).max(20000).optional(),
    imageHeight: z.number().int().min(1).max(20000).optional(),
    scale: z.object({ a: point, b: point, lengthM: z.number().min(0.1).max(1000) }).nullish(),
  })
  .refine((b) => b.inputType === 'dwg' || b.scale, {
    message: 'Draw a line over a known dimension to set the scale.',
    path: ['scale'],
  })
  .refine((b) => !b.scale || Math.hypot(b.scale.a[0] - b.scale.b[0], b.scale.a[1] - b.scale.b[1]) >= 10, {
    message: 'The scale line is too short. Drag its ends further apart.',
    path: ['scale'],
  });

/**
 * Creates the capture and a new "uploading" version of the facility
 * level's plan, inside the quota. `details(db, captureId)` writes the
 * capture's own facts. Returns the capture id.
 */
async function registerCapture(db, req, { facility, level, key, source, row, details }) {
  const accountId = req.account.id;
  // Lock the account row so two captures cannot both take the last slot.
  const account = await one(db, 'SELECT plan_quota FROM accounts WHERE id = ? FOR UPDATE', [accountId]);
  if ((await plansUsedThisMonth(db, accountId)) >= account.plan_quota) {
    throw forbidden(
      `Your plan allows ${account.plan_quota} plans a month and they are used up. ` +
        'Talk to your account owner about more.',
    );
  }

  let plan = await one(db, 'SELECT id FROM plans WHERE facility_id = ? AND level_number = ?', [facility.id, level]);
  if (!plan) {
    plan = { id: newId() };
    await db.query('INSERT INTO plans (id, account_id, facility_id, level_number) VALUES (?, ?, ?, ?)', [
      plan.id,
      accountId,
      facility.id,
      level,
    ]);
  }

  const id = newId();
  await db.query(
    `INSERT INTO captures
       (id, account_id, user_id, idempotency_key, source, floor_to_floor_m, coverage, outline_closed,
        override_reason, area_m2, duration_s, photo_count, weak_wall_count, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, accountId, req.user.id, key, source,
      row.floorToFloorM ?? null, row.coverage ?? null, row.closed ?? null, row.overrideReason ?? null,
      row.areaM2 ?? null, row.durationSeconds ?? null, row.photoCount ?? null, row.weakWallCount ?? null,
      row.capturedAt ? new Date(row.capturedAt) : null,
    ],
  );
  await details(db, id);

  const latest = await one(
    db,
    'SELECT COALESCE(MAX(version_no), 0) AS v FROM plan_versions WHERE plan_id = ? FOR UPDATE',
    [plan.id],
  );
  const versionNumber = Number(latest.v) + 1;
  await db.query(
    `INSERT INTO plan_versions (id, account_id, plan_id, version_no, status, capture_id)
     VALUES (?, ?, ?, ?, 'uploading', ?)`,
    [newId(), accountId, plan.id, versionNumber, id],
  );
  await audit(db, {
    accountId,
    actor: { id: req.user.id },
    action: 'CAPTURED',
    target: { type: 'plan', id: plan.id, label: planLabel(facility.name, level) },
    version: versionNumber,
    detail: { input: row.inputType ?? source },
  });
  return id;
}

/** The same key returns the same capture: a retry after a lost response. */
async function earlierCapture(req, key) {
  return one(pool, 'SELECT id FROM captures WHERE user_id = ? AND idempotency_key = ? AND account_id = ?', [
    req.user.id,
    key,
    req.account.id,
  ]);
}

function idempotencyKey(req) {
  const key = req.get('idempotency-key');
  if (!key || key.length > 100) throw badRequest('An Idempotency-Key header is required.');
  return key;
}

router.post('/', async (req, res) => {
  const key = idempotencyKey(req);
  const body = registerBody.parse(req.body);

  if (body.source === 'simulated' && !config.uploads.allowSimulatedScans) {
    throw badRequest('Simulated scans are not accepted. Scan with a LiDAR iPhone.');
  }

  const earlier = await earlierCapture(req, key);
  if (earlier) return res.status(200).json({ captureId: earlier.id });

  const captureId = await transaction(async (db) => {
    const facility = body.facilityId
      ? await facilityInAccount(db, req.account.id, body.facilityId)
      : await one(db, 'SELECT id, name FROM facilities WHERE account_id = ? AND name = ?', [
          req.account.id,
          body.facilityName ?? '',
        ]);
    if (!facility) throw badRequest('Choose one of your facilities.');
    return registerCapture(db, req, {
      facility,
      level: body.level,
      key,
      source: body.source,
      row: body,
      details: async (db2, id) => {
        for (const t of body.tags) {
          await db2.query('INSERT INTO capture_tags (id, capture_id, type, x, y, height_m) VALUES (?, ?, ?, ?, ?, ?)', [
            newId(), id, t.type, t.x, t.y, t.type === 'ceiling' ? (t.heightM ?? null) : null,
          ]);
        }
        for (const c of body.controlDistances) {
          const scanned = dist(c.a, c.b);
          if (scanned < 0.1) throw badRequest('A control distance needs its two ends apart.');
          await db2.query(
            `INSERT INTO control_distances (id, capture_id, ax, ay, bx, \`by\`, measured_m, scanned_m)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [newId(), id, c.a[0], c.a[1], c.b[0], c.b[1], c.measuredM, scanned],
          );
        }
      },
    });
  });

  res.status(201).json({ captureId });
});

router.post('/drawings', async (req, res) => {
  const key = idempotencyKey(req);
  const body = drawingBody.parse(req.body);

  const earlier = await earlierCapture(req, key);
  if (earlier) return res.status(200).json({ captureId: earlier.id });

  const captureId = await transaction(async (db) => {
    const facility = await facilityInAccount(db, req.account.id, body.facilityId);
    if (!facility) throw badRequest('Choose one of your facilities.');
    return registerCapture(db, req, {
      facility,
      level: body.level,
      key,
      source: 'upload',
      row: { inputType: body.inputType },
      details: (db2, id) =>
        db2.query(
          `INSERT INTO drawing_details
             (capture_id, input_type, original_name, page, page_count, image_width_px, image_height_px,
              scale_ax, scale_ay, scale_bx, scale_by, scale_length_m, ceiling_height_m)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id, body.inputType, body.originalName, body.page ?? null, body.pageCount ?? null,
            body.imageWidth ?? null, body.imageHeight ?? null,
            body.scale?.a[0] ?? null, body.scale?.a[1] ?? null, body.scale?.b[0] ?? null, body.scale?.b[1] ?? null,
            body.scale?.lengthM ?? null, body.ceilingHeightM ?? null,
          ],
        ),
    });
  });

  res.status(201).json({ captureId });
});

/** Which file kinds each kind of capture may carry. */
const KINDS = {
  lidar: ['model', 'room', 'photo', 'mesh', 'keyframes'],
  simulated: ['model', 'room', 'photo', 'mesh', 'keyframes'],
  upload: ['source', 'source_image'],
};

const fileBody = z.object({
  name: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/, 'File names may only use letters, digits, dot, dash and underscore.')
    .refine((n) => !n.split('/').includes('..'), 'File names may only use letters, digits, dot, dash and underscore.'),
  kind: z.enum(['model', 'room', 'photo', 'source', 'source_image', 'mesh', 'keyframes']),
  bytes: z.number().int().min(0).max(config.uploads.maxFileBytes),
  contentType: z.string().min(1).max(100),
});

router.post('/:captureId/uploads', async (req, res) => {
  const body = z
    .object({
      partSize: z.number().int().min(config.uploads.minPartSize).max(config.uploads.maxPartSize),
      files: z.array(fileBody).min(1).max(config.uploads.maxFilesPerCapture),
    })
    .parse(req.body);

  const capture = await captureOr404(pool, req);
  if (capture.status === 'received') throw conflict('This capture has already been received.');

  const names = body.files.map((f) => f.name);
  if (new Set(names).size !== names.length) throw badRequest('File names must be unique.');
  for (const f of body.files) {
    if (!KINDS[capture.source].includes(f.kind)) {
      throw badRequest(`A ${capture.source} capture cannot carry a ${f.kind} file.`);
    }
    // Only keyframe images live in a folder: keyframes/<file>.
    if (f.name.includes('/') && !(f.kind === 'keyframes' && f.name.startsWith('keyframes/'))) {
      throw badRequest('File names may only use letters, digits, dot, dash and underscore.');
    }
    if (capture.source === 'upload' && f.bytes > MAX_DRAWING_BYTES) {
      throw badRequest('Drawings can be up to 50 MB.');
    }
  }
  // A resend reopens files it already has, so only new names count.
  const known = new Set(
    (await many(pool, 'SELECT name FROM capture_files WHERE capture_id = ?', [capture.id])).map((k) => k.name),
  );
  const fresh = body.files.filter((f) => !known.has(f.name)).length;
  if (known.size + fresh > config.uploads.maxFilesPerCapture) {
    throw badRequest(`A capture may carry up to ${config.uploads.maxFilesPerCapture} files.`);
  }

  const results = [];
  for (const f of body.files) {
    let file = await one(pool, 'SELECT * FROM capture_files WHERE capture_id = ? AND name = ?', [capture.id, f.name]);
    if (file && (Number(file.bytes) !== f.bytes || Number(file.part_size) !== body.partSize)) {
      throw conflict(`${f.name} was already opened with a different size.`);
    }
    if (!file) {
      const key = `accounts/${capture.account_id}/captures/${capture.id}/${f.name}`;
      const uploadId = await storage().createMultipart(key, f.contentType);
      file = {
        id: newId(),
        name: f.name,
        storage_key: key,
        upload_id: uploadId,
        part_count: partCount(f.bytes, body.partSize),
      };
      await pool.query(
        `INSERT INTO capture_files
           (id, capture_id, name, kind, bytes, content_type, part_size, part_count, storage_key, upload_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [file.id, capture.id, f.name, f.kind, f.bytes, f.contentType, body.partSize, file.part_count, key, uploadId],
      );
    }
    results.push(await partTargets(file, allParts(file)));
  }

  await pool.query(`UPDATE captures SET status = 'uploading' WHERE id = ? AND status = 'registered'`, [capture.id]);
  res.json({ files: results });
});

router.post('/:captureId/uploads/refresh', async (req, res) => {
  const body = z
    .object({
      files: z
        .array(z.object({ fileId: z.string().min(1).max(64), parts: z.array(z.number().int().min(1)).min(1) }))
        .min(1),
    })
    .parse(req.body);

  const capture = await captureOr404(pool, req);
  const files = await many(pool, 'SELECT * FROM capture_files WHERE capture_id = ?', [capture.id]);

  const results = [];
  for (const wanted of body.files) {
    const file = files.find((f) => f.id === wanted.fileId);
    if (!file) throw notFound('Unknown file.');
    if (wanted.parts.some((n) => n > file.part_count)) throw badRequest('Unknown part number.');
    results.push(await partTargets(file, wanted.parts));
  }
  res.json({ files: results });
});

router.post('/:captureId/complete', async (req, res) => {
  const capture = await captureOr404(pool, req);
  if (capture.status === 'received') return res.json({ status: 'received', photoCount: capture.photo_count ?? 0 });

  // A machine's video files belong to the machine, and finish on their own.
  const files = await many(
    pool,
    `SELECT * FROM capture_files WHERE capture_id = ? AND kind NOT IN ('video', 'thumbnail', 'frames')`,
    [capture.id],
  );
  if (capture.source === 'lidar' && !files.some((f) => f.kind === 'model')) {
    throw badRequest('A LiDAR capture needs its 3D model.');
  }
  if (capture.source === 'upload' && !files.some((f) => f.kind === 'source')) {
    throw badRequest('Upload the drawing itself before submitting.');
  }

  const missing = await completeFiles(files);
  if (missing.length) return res.json({ status: 'incomplete', missing });

  await transaction(async (db) => {
    const [received] = await db.query(
      `UPDATE captures SET status = 'received', received_at = UTC_TIMESTAMP(3) WHERE id = ? AND status <> 'received'`,
      [capture.id],
    );
    if (!received.affectedRows) return;
    const v = await one(
      db,
      `SELECT id FROM plan_versions WHERE capture_id = ? AND status = 'uploading' FOR UPDATE`,
      [capture.id],
    );
    if (!v) return;
    await db.query(
      `UPDATE plan_versions SET status = 'processing', submitted_at = UTC_TIMESTAMP(3) WHERE id = ?`,
      [v.id],
    );
    // Plan reading runs as a job (E-03), queued in this same transaction.
    await enqueue(db, {
      kind: capture.source === 'upload' ? 'drawing.read' : 'scan.read',
      subjectId: v.id,
      accountId: capture.account_id,
    });
  });
  await jobsCommitted();

  res.json({ status: 'received', photoCount: capture.photo_count ?? 0 });
});
