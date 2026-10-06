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
 * Registering adds a new version to the facility level's plan
 * ("uploading"). Confirming receipt runs plan reading and moves the version
 * to "processing": plan produced, waiting in the reviewer queue.
 */
import { Router } from 'express';
import { z } from 'zod';

import { planFromScan, planFromUpload, summary } from '../../../shared/plan/index.js';
import { audit, planLabel } from '../audit.js';
import { config } from '../config.js';
import { many, one, pool, transaction } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { newId } from '../ids.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { planReadyForReview } from '../notify.js';
import { StorageIncomplete, storage } from '../storage/index.js';
import { captureOr404, partCount, partTargets } from './capture-uploads.js';
import { equipmentForPlan } from './equipment.js';
import { facilityInOrg } from './facilities.js';
import { plansUsedThisMonth } from './profile.js';

export const router = Router();
router.use(requireAuth, requireRole('owner', 'surveyor'));

const TAG_TYPES = ['ceiling', 'fireExit', 'mirror', 'power', 'stair'];
/** UPL-01: drawings up to 50 MB. */
export const MAX_DRAWING_BYTES = 50 * 1024 * 1024;
const DRAWING_TYPES = ['pdf', 'dwg', 'jpg', 'png'];

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
  photoCount: z.number().int().min(0),
  weakWallCount: z.number().int().min(0).optional(),
  tags: z
    .array(
      z.object({
        type: z.enum(TAG_TYPES),
        x: z.number(),
        y: z.number(),
        heightM: z.number().nullish(),
      }),
    )
    .max(500),
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
    page: z.number().int().min(1).optional(),
    pageCount: z.number().int().min(1).optional(),
    imageWidth: z.number().int().min(1).max(20000).optional(),
    imageHeight: z.number().int().min(1).max(20000).optional(),
    scale: z
      .object({ a: point, b: point, lengthM: z.number().min(0.1).max(1000) })
      .nullish(),
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
 * level's plan, inside the quota. Returns the capture id.
 */
async function registerCapture(db, req, { facility, level, key, source, inputType, metadata, version }) {
  // Lock the organisation row so two captures cannot both take the last
  // slot of the quota.
  const org = await one(db, 'SELECT plan_quota FROM organisations WHERE id = ? FOR UPDATE', [
    req.user.orgId,
  ]);
  if ((await plansUsedThisMonth(db, req.user.orgId)) >= org.plan_quota) {
    throw forbidden(
      `Your plan allows ${org.plan_quota} plans a month and they are used up. ` +
        'Talk to your account owner about more.',
    );
  }

  let plan = await one(db, 'SELECT id FROM plans WHERE facility_id = ? AND level = ?', [
    facility.id,
    level,
  ]);
  if (!plan) {
    plan = { id: newId('plan') };
    await db.query('INSERT INTO plans (id, org_id, facility_id, level) VALUES (?, ?, ?, ?)', [
      plan.id,
      req.user.orgId,
      facility.id,
      level,
    ]);
  }

  const id = newId('cap');
  await db.query(
    `INSERT INTO captures (id, org_id, user_id, facility_id, level, idempotency_key, source, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, req.user.orgId, req.user.id, facility.id, level, key, source, JSON.stringify(metadata)],
  );

  const latest = await one(
    db,
    'SELECT COALESCE(MAX(version), 0) AS v FROM plan_versions WHERE plan_id = ? FOR UPDATE',
    [plan.id],
  );
  const versionNumber = Number(latest.v) + 1;
  await db.query(
    `INSERT INTO plan_versions
       (id, org_id, plan_id, version, status, capture_id, input_type, coverage, override_reason, area_m2)
     VALUES (?, ?, ?, ?, 'uploading', ?, ?, ?, ?, ?)`,
    [
      newId('pv'),
      req.user.orgId,
      plan.id,
      versionNumber,
      id,
      inputType,
      version.coverage ?? null,
      version.overrideReason ?? null,
      version.areaM2 ?? null,
    ],
  );
  await audit(db, {
    orgId: req.user.orgId,
    actor: { id: req.user.id },
    action: 'CAPTURED',
    target: { type: 'plan', id: plan.id, label: planLabel(facility.name, level) },
    version: versionNumber,
    detail: { input: inputType },
  });
  return id;
}

/** The same key returns the same capture: a retry after a lost response. */
async function earlierCapture(req, key) {
  return one(pool, 'SELECT id FROM captures WHERE user_id = ? AND idempotency_key = ?', [
    req.user.id,
    key,
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
      ? await facilityInOrg(db, req.user.orgId, body.facilityId)
      : await one(db, 'SELECT id, name FROM facilities WHERE org_id = ? AND name = ?', [
          req.user.orgId,
          body.facilityName ?? '',
        ]);
    if (!facility) throw badRequest('Choose one of your facilities.');
    return registerCapture(db, req, {
      facility,
      level: body.level,
      key,
      source: body.source,
      inputType: body.source,
      metadata: body,
      version: body,
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
    const facility = await facilityInOrg(db, req.user.orgId, body.facilityId);
    if (!facility) throw badRequest('Choose one of your facilities.');
    return registerCapture(db, req, {
      facility,
      level: body.level,
      key,
      source: 'upload',
      inputType: body.inputType,
      metadata: body,
      version: {},
    });
  });

  res.status(201).json({ captureId });
});

const fileBody = z.object({
  name: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9._-]+$/, 'File names may only use letters, digits, dot, dash and underscore.'),
  kind: z.enum(['model', 'room', 'photo', 'source', 'source_image']),
  bytes: z.number().int().min(0).max(config.uploads.maxFileBytes),
  contentType: z.string().min(1).max(100),
});

/** Which file kinds each kind of capture may carry. */
const KINDS = {
  lidar: ['model', 'room', 'photo'],
  simulated: ['model', 'room', 'photo'],
  upload: ['source', 'source_image'],
};



router.post('/:captureId/uploads', async (req, res) => {
  const body = z
    .object({
      partSize: z
        .number()
        .int()
        .min(config.uploads.minPartSize)
        .max(config.uploads.maxPartSize),
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
    if (capture.source === 'upload' && f.bytes > MAX_DRAWING_BYTES) {
      throw badRequest('Drawings can be up to 50 MB.');
    }
  }

  const results = [];
  for (const f of body.files) {
    let file = await one(pool, 'SELECT * FROM capture_files WHERE capture_id = ? AND name = ?', [
      capture.id,
      f.name,
    ]);
    if (file && (file.bytes !== f.bytes || file.part_size !== body.partSize)) {
      throw conflict(`${f.name} was already opened with a different size.`);
    }
    if (!file) {
      const key = `orgs/${capture.org_id}/captures/${capture.id}/${f.name}`;
      const uploadId = await storage().createMultipart(key, f.contentType);
      file = {
        id: newId('file'),
        name: f.name,
        storage_key: key,
        upload_id: uploadId,
        part_count: partCount(f.bytes, body.partSize),
      };
      await pool.query(
        `INSERT INTO capture_files
           (id, capture_id, name, kind, bytes, content_type, part_size, part_count, storage_key, upload_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [file.id, capture.id, f.name, f.kind, f.bytes, f.contentType, body.partSize,
          file.part_count, key, uploadId],
      );
    }
    results.push(
      await partTargets(file, [...Array(Number(file.part_count))].map((_, i) => i + 1)),
    );
  }

  await pool.query(`UPDATE captures SET status = 'uploading' WHERE id = ? AND status = 'registered'`, [
    capture.id,
  ]);
  res.json({ files: results });
});

router.post('/:captureId/uploads/refresh', async (req, res) => {
  const body = z
    .object({
      files: z
        .array(z.object({ fileId: z.string().min(1), parts: z.array(z.number().int().min(1)).min(1) }))
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

/**
 * Plan reading (PRD section 6): the internal plan for a received capture.
 * A room file that cannot be read yields an empty plan and a flag, never a
 * failed upload: the reviewer can still trace or reject it.
 */
async function readPlan(capture, files) {
  const metadata = capture.metadata ?? {};
  if (capture.source === 'upload') {
    const image =
      files.find((f) => f.kind === 'source_image') ??
      (['jpg', 'png'].includes(metadata.inputType) ? files.find((f) => f.kind === 'source') : null);
    return planFromUpload({ ...metadata, imageFileId: image?.id ?? null });
  }

  const roomFile = files.find((f) => f.kind === 'room');
  let room = null;
  let problem = null;
  if (roomFile) {
    try {
      room = JSON.parse((await storage().read(roomFile.storage_key)).toString('utf8'));
    } catch {
      problem = 'The room data in scan.json could not be read.';
    }
  }
  /*
   * The machines the surveyor marked are read in with the room, so the 2D
   * plan carries where each one is (CHANGE 2.1). They are part of the same
   * capture, and arrive in the same coordinate frame as the walls.
   */
  const equipment = await equipmentForPlan(pool, capture.id);
  const plan = planFromScan(room, { ...metadata, equipment });
  if (problem) {
    plan.flags.push({
      id: newId('f'),
      kind: 'unreadable',
      elementId: null,
      title: 'Room data unreadable',
      detail: `${problem} Trace the plan from the photos, or reject it as an unreadable source.`,
      status: 'open',
    });
  }
  return plan;
}

router.post('/:captureId/complete', async (req, res) => {
  const capture = await captureOr404(pool, req);
  if (capture.status === 'received') return res.json({ status: 'received' });

  const files = await many(pool, 'SELECT * FROM capture_files WHERE capture_id = ?', [capture.id]);
  const metadata = capture.metadata;
  if (capture.source === 'lidar' && !files.some((f) => f.kind === 'model')) {
    throw badRequest('A LiDAR capture needs its 3D model.');
  }
  if (capture.source === 'upload' && !files.some((f) => f.kind === 'source')) {
    throw badRequest('Upload the drawing itself before submitting.');
  }

  // Parts that never arrived, per file. The app resends exactly these and
  // asks again, so this is an ordinary answer rather than an error.
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
  }
  if (missing.length) {
    return res.json({ status: 'incomplete', missing });
  }

  const plan = await readPlan(capture, files);
  const facts = summary(plan);

  const version = await transaction(async (db) => {
    await db.query(
      `UPDATE captures SET status = 'received', received_at = UTC_TIMESTAMP(3) WHERE id = ?`,
      [capture.id],
    );
    const v = await one(
      db,
      `SELECT v.id, v.version, v.plan_id, v.area_m2, f.name AS facility, p.level
       FROM plan_versions v JOIN plans p ON p.id = v.plan_id JOIN facilities f ON f.id = p.facility_id
       WHERE v.capture_id = ? AND v.status = 'uploading' FOR UPDATE`,
      [capture.id],
    );
    if (!v) return null;
    /*
     * The overall room measurements are copied onto the row so the owner's
     * list and the reviewer queue can show a plan's size without reading
     * its JSON (CHANGE 1.1). `plan_json` remains the source of truth; these
     * are refreshed from it whenever the plan is written.
     */
    await db.query(
      `UPDATE plan_versions
       SET status = 'processing', submitted_at = UTC_TIMESTAMP(3), plan_json = ?,
           plan_format = ?, area_m2 = ?, width_m = ?, length_m = ?, perimeter_m = ?,
           elevation_m = ?, wall_count = ?, opening_count = ?, object_count = ?,
           equipment_count = ?
       WHERE id = ?`,
      [
        JSON.stringify(plan),
        plan.format ?? null,
        v.area_m2 ?? facts.areaM2,
        facts.widthM,
        facts.lengthM,
        facts.perimeterM,
        plan.room?.elevationM ?? null,
        facts.walls,
        facts.openings,
        facts.objects,
        facts.equipment,
        v.id,
      ],
    );
    await audit(db, {
      orgId: capture.org_id,
      actor: null,
      action: 'PLAN_PRODUCED',
      target: { type: 'plan', id: v.plan_id, label: planLabel(v.facility, v.level) },
      version: v.version,
      detail: { walls: facts.walls, flags: facts.openFlags },
    });
    return v;
  });

  if (version) {
    await planReadyForReview(pool, {
      label: planLabel(version.facility, version.level),
      versionId: version.id,
    });
  }
  res.json({ status: 'received', photoCount: metadata?.photoCount ?? 0 });
});
