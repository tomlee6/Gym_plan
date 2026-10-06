/**
 * CHANGE 2 and CHANGE 4: the gym equipment on a capture, and the 360 degree
 * video recorded for each machine.
 *
 *   POST   /v1/captures/:captureId/equipment                      mark machines
 *   GET    /v1/captures/:captureId/equipment                      what is marked
 *   PATCH  /v1/captures/:captureId/equipment/:equipmentId         correct one
 *   DELETE /v1/captures/:captureId/equipment/:equipmentId         remove one
 *   POST   /v1/captures/:captureId/equipment/:equipmentId/video   open an upload
 *   POST   .../video/complete                                     finish it
 *
 * The video reuses the capture's own chunked, signed-URL upload: the same
 * `capture_files` rows, the same multipart parts, the same resume. Nothing
 * here opens a second way to upload a file, and no video is ever sent
 * through a JSON body.
 *
 * A video is a reference asset hanging off a machine. It never carries
 * geometry: where a machine is comes from the LiDAR scan and the approved
 * plan, never from a video.
 */
import { Router } from 'express';
import { z } from 'zod';

import { config } from '../config.js';
import { many, one, pool, transaction } from '../db/pool.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { newId } from '../ids.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { StorageIncomplete, storage } from '../storage/index.js';
import { captureOr404, partCount, partTargets } from './capture-uploads.js';

export const router = Router();
router.use(requireAuth, requireRole('owner', 'surveyor'));

/** A 360 walk round one machine: minutes at most, not a feature film. */
export const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
export const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;
const VIDEO_TYPES = ['video/mp4', 'video/quicktime'];
const THUMBNAIL_TYPES = ['image/jpeg', 'image/png'];
/** Marking every machine in a large gym, with room to spare. */
const MAX_EQUIPMENT = 500;

const metres = z.number().finite().min(-10000).max(10000);
const size = z.number().finite().positive().max(30);

const equipmentBody = z.object({
  equipmentId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/, 'An equipment id may only use letters, digits, dot, dash and underscore.'),
  // Not an enum: the catalogue is extensible, so a gym may name a machine
  // this server has never heard of (CHANGE 2.1).
  type: z.string().min(1).max(60),
  name: z.string().min(1).max(120),
  x: metres.nullish(),
  z: metres.nullish(),
  elevationM: metres.nullish(),
  rotationDeg: z.number().finite().min(-360).max(360).nullish(),
  widthM: size.nullish(),
  depthM: size.nullish(),
  heightM: size.nullish(),
  confidence: z.number().min(0).max(1).nullish(),
  source: z.enum(['roomplan', 'surveyor', 'reviewer']).default('surveyor'),
});

const n = (v) => (v === null || v === undefined ? null : Number(v));

/** One equipment row as the app and the reviewer see it. */
function present(row, video) {
  return {
    equipmentId: row.equipment_id,
    type: row.type,
    name: row.name,
    position: row.position_x === null ? null : { x: n(row.position_x), z: n(row.position_z) },
    elevationM: n(row.elevation_m),
    rotationDeg: n(row.rotation_deg),
    widthM: n(row.width_m),
    depthM: n(row.depth_m),
    heightM: n(row.height_m),
    confidence: n(row.confidence),
    source: row.source,
    planObjectId: row.plan_object_id,
    video: video
      ? {
          videoId: video.id,
          status: video.status,
          durationSeconds: n(video.duration_seconds),
          hasThumbnail: Boolean(video.thumbnail_file_id),
          failureReason: video.failure_reason,
        }
      : null,
  };
}

/** Every machine on a capture, each with its video if it has one. */
export async function equipmentFor(db, captureId) {
  const rows = await many(
    db,
    'SELECT * FROM capture_equipment WHERE capture_id = ? ORDER BY equipment_id',
    [captureId],
  );
  if (!rows.length) return [];
  const videos = await many(db, 'SELECT * FROM equipment_videos WHERE capture_id = ?', [captureId]);
  const byEquipment = new Map(videos.map((v) => [v.equipment_id, v]));
  return rows.map((row) => present(row, byEquipment.get(row.id)));
}

/**
 * What the reviewer needs: every machine on a capture with the file ids of
 * its 360 video and poster frame, for the caller to sign (CHANGE 5).
 */
export async function equipmentForReview(db, captureId) {
  const rows = await many(
    db,
    'SELECT * FROM capture_equipment WHERE capture_id = ? ORDER BY equipment_id',
    [captureId],
  );
  if (!rows.length) return [];
  const videos = await many(db, 'SELECT * FROM equipment_videos WHERE capture_id = ?', [captureId]);
  const byEquipment = new Map(videos.map((v) => [v.equipment_id, v]));
  return rows.map((row) => {
    const video = byEquipment.get(row.id);
    return {
      ...present(row, video),
      video: video
        ? {
            ...present(row, video).video,
            fileId: video.file_id,
            thumbnailFileId: video.thumbnail_file_id,
          }
        : null,
    };
  });
}

/**
 * What plan reading needs: each marked machine in the plan's own frame,
 * `(x, z)` becoming the plan's `[x, y]` (CHANGE 2.2).
 */
export async function equipmentForPlan(db, captureId) {
  const rows = await many(
    db,
    'SELECT * FROM capture_equipment WHERE capture_id = ? AND position_x IS NOT NULL ORDER BY equipment_id',
    [captureId],
  );
  return rows.map((row) => ({
    equipmentId: row.equipment_id,
    type: row.type,
    name: row.name,
    x: n(row.position_x),
    y: n(row.position_z),
    w: n(row.width_m),
    d: n(row.depth_m),
    heightM: n(row.height_m),
    elevationM: n(row.elevation_m),
    angle: row.rotation_deg === null ? 0 : (Number(row.rotation_deg) * Math.PI) / 180,
    confidence: n(row.confidence),
  }));
}

/** A capture that may still be added to. */
async function openCapture(db, req) {
  const capture = await captureOr404(db, req);
  if (capture.source === 'upload') {
    throw badRequest('An uploaded drawing has no equipment to record.');
  }
  return capture;
}

async function equipmentOr404(db, capture, equipmentId) {
  const row = await one(
    db,
    'SELECT * FROM capture_equipment WHERE capture_id = ? AND equipment_id = ?',
    [capture.id, equipmentId],
  );
  if (!row) throw notFound('This equipment is not on this capture.');
  return row;
}

/* ------------------------------------------------------------------ */
/* Marking equipment.                                                   */

/**
 * Records the machines on a capture. Sending the same equipment id again
 * replaces what it said, so the app may re-send its whole list after a lost
 * response without doubling anything up.
 */
router.post('/:captureId/equipment', async (req, res) => {
  const body = z
    .object({ equipment: z.array(equipmentBody).min(1).max(MAX_EQUIPMENT) })
    .parse(req.body);

  const ids = body.equipment.map((e) => e.equipmentId);
  if (new Set(ids).size !== ids.length) throw badRequest('Equipment ids must be unique.');

  const saved = await transaction(async (db) => {
    const capture = await openCapture(db, req);
    const existing = await many(
      db,
      'SELECT COUNT(*) AS n FROM capture_equipment WHERE capture_id = ?',
      [capture.id],
    );
    if (Number(existing[0].n) + body.equipment.length > MAX_EQUIPMENT + ids.length) {
      throw badRequest(`A capture may carry up to ${MAX_EQUIPMENT} pieces of equipment.`);
    }

    for (const e of body.equipment) {
      await db.query(
        `INSERT INTO capture_equipment
           (id, org_id, capture_id, equipment_id, type, name, position_x, position_z,
            elevation_m, rotation_deg, width_m, depth_m, height_m, confidence, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           type = VALUES(type), name = VALUES(name),
           position_x = VALUES(position_x), position_z = VALUES(position_z),
           elevation_m = VALUES(elevation_m), rotation_deg = VALUES(rotation_deg),
           width_m = VALUES(width_m), depth_m = VALUES(depth_m), height_m = VALUES(height_m),
           confidence = VALUES(confidence), source = VALUES(source)`,
        [
          newId('eqp'), capture.org_id, capture.id, e.equipmentId, e.type, e.name,
          e.x ?? null, e.z ?? null, e.elevationM ?? null, e.rotationDeg ?? null,
          e.widthM ?? null, e.depthM ?? null, e.heightM ?? null, e.confidence ?? null, e.source,
        ],
      );
    }
    return equipmentFor(db, capture.id);
  });

  res.status(201).json({ equipment: saved });
});

router.get('/:captureId/equipment', async (req, res) => {
  const capture = await captureOr404(pool, req);
  res.json({ equipment: await equipmentFor(pool, capture.id) });
});

router.patch('/:captureId/equipment/:equipmentId', async (req, res) => {
  const body = equipmentBody.partial().omit({ equipmentId: true }).parse(req.body);
  if (!Object.keys(body).length) throw badRequest('Nothing to change.');

  const updated = await transaction(async (db) => {
    const capture = await openCapture(db, req);
    const row = await equipmentOr404(db, capture, req.params.equipmentId);
    const columns = {
      type: body.type,
      name: body.name,
      position_x: body.x,
      position_z: body.z,
      elevation_m: body.elevationM,
      rotation_deg: body.rotationDeg,
      width_m: body.widthM,
      depth_m: body.depthM,
      height_m: body.heightM,
      confidence: body.confidence,
      source: body.source,
    };
    const sets = Object.entries(columns).filter(([, v]) => v !== undefined);
    if (sets.length) {
      await db.query(
        `UPDATE capture_equipment SET ${sets.map(([c]) => `${c} = ?`).join(', ')} WHERE id = ?`,
        [...sets.map(([, v]) => v), row.id],
      );
    }
    return equipmentFor(db, capture.id);
  });

  res.json({ equipment: updated });
});

router.delete('/:captureId/equipment/:equipmentId', async (req, res) => {
  await transaction(async (db) => {
    const capture = await openCapture(db, req);
    const row = await equipmentOr404(db, capture, req.params.equipmentId);
    // The video rows cascade; the stored files are left for data removal,
    // which is what clears an organisation's objects (ACC-07).
    await db.query('DELETE FROM capture_equipment WHERE id = ?', [row.id]);
  });
  res.status(204).end();
});

/* ------------------------------------------------------------------ */
/* The 360 degree video.                                                */

const videoBody = z.object({
  partSize: z.number().int().min(config.uploads.minPartSize).max(config.uploads.maxPartSize),
  bytes: z.number().int().min(1).max(MAX_VIDEO_BYTES),
  contentType: z.enum(VIDEO_TYPES),
  durationSeconds: z.number().finite().positive().max(3600).nullish(),
  // Taken on the phone while recording, so no server-side transcoding is
  // needed to show a poster frame (CHANGE 4.2).
  thumbnail: z
    .object({
      bytes: z.number().int().min(1).max(MAX_THUMBNAIL_BYTES),
      contentType: z.enum(THUMBNAIL_TYPES),
    })
    .nullish(),
});

const extensionFor = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

/**
 * Opens (or reopens) the upload for a machine's 360 video.
 *
 * Calling this again is how a retake works: the previous files are dropped
 * and a fresh multipart upload is started, so the reviewer only ever sees
 * the take the surveyor kept.
 */
router.post('/:captureId/equipment/:equipmentId/video', async (req, res) => {
  const body = videoBody.parse(req.body);

  const result = await transaction(async (db) => {
    const capture = await openCapture(db, req);
    const equipment = await equipmentOr404(db, capture, req.params.equipmentId);

    const previous = await one(db, 'SELECT * FROM equipment_videos WHERE equipment_id = ? FOR UPDATE', [
      equipment.id,
    ]);
    if (previous) {
      // A retake: the old parts are abandoned and the rows replaced.
      await db.query('DELETE FROM capture_files WHERE capture_id = ? AND equipment_id = ?', [
        capture.id,
        equipment.id,
      ]);
      await db.query('DELETE FROM equipment_videos WHERE id = ?', [previous.id]);
    }

    const wanted = [
      { kind: 'video', bytes: body.bytes, contentType: body.contentType, label: '360' },
      ...(body.thumbnail
        ? [{ kind: 'thumbnail', bytes: body.thumbnail.bytes, contentType: body.thumbnail.contentType, label: 'thumbnail' }]
        : []),
    ];

    const files = [];
    for (const f of wanted) {
      const ext = extensionFor[f.contentType];
      // The structured path CHANGE 4.3 asks for, under the organisation so
      // one customer's objects can never be read by another.
      const name = `equipment/${equipment.equipment_id}/${f.kind}/${f.label}.${ext}`;
      const key = `orgs/${capture.org_id}/captures/${capture.id}/${name}`;
      const uploadId = await storage().createMultipart(key, f.contentType);
      const row = {
        id: newId('file'),
        name,
        storage_key: key,
        upload_id: uploadId,
        part_count: partCount(f.bytes, body.partSize),
      };
      await db.query(
        `INSERT INTO capture_files
           (id, capture_id, equipment_id, name, kind, bytes, content_type, part_size, part_count,
            storage_key, upload_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.id, capture.id, equipment.id, name, f.kind, f.bytes, f.contentType, body.partSize,
          row.part_count, key, uploadId],
      );
      files.push({ kind: f.kind, row });
    }

    const videoId = newId('vid');
    await db.query(
      `INSERT INTO equipment_videos
         (id, org_id, capture_id, equipment_id, file_id, thumbnail_file_id, duration_seconds, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'uploading')`,
      [
        videoId, capture.org_id, capture.id, equipment.id,
        files.find((f) => f.kind === 'video').row.id,
        files.find((f) => f.kind === 'thumbnail')?.row.id ?? null,
        body.durationSeconds ?? null,
      ],
    );
    await db.query(`UPDATE captures SET status = 'uploading' WHERE id = ? AND status = 'registered'`, [
      capture.id,
    ]);

    return {
      videoId,
      status: 'uploading',
      files: await Promise.all(
        files.map(async ({ kind, row }) => ({
          kind,
          ...(await partTargets(row, [...Array(Number(row.part_count))].map((_, i) => i + 1))),
        })),
      ),
    };
  });

  res.status(201).json(result);
});

/**
 * Finishes the video upload. Parts that never arrived are reported back the
 * way the capture's own completion reports them, so the app resends exactly
 * those and asks again rather than starting over (APP-10).
 */
router.post('/:captureId/equipment/:equipmentId/video/complete', async (req, res) => {
  z.object({}).passthrough().parse(req.body ?? {});
  const capture = await captureOr404(pool, req);
  const equipment = await equipmentOr404(pool, capture, req.params.equipmentId);
  const video = await one(pool, 'SELECT * FROM equipment_videos WHERE equipment_id = ?', [equipment.id]);
  if (!video) throw notFound('No video has been started for this equipment.');
  if (video.status === 'ready') return res.json({ videoId: video.id, status: 'ready' });

  const files = await many(pool, 'SELECT * FROM capture_files WHERE capture_id = ? AND equipment_id = ?', [
    capture.id,
    equipment.id,
  ]);
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
    await pool.query(`UPDATE equipment_videos SET status = 'uploading' WHERE id = ?`, [video.id]);
    return res.json({ videoId: video.id, status: 'incomplete', missing });
  }

  /*
   * The thumbnail came from the phone and the video is kept as recorded, so
   * there is nothing to transcode and the video is ready as soon as it has
   * landed. The 'processing' state exists for a transcoding step that is
   * not built; plan reading never waits on any of this (CHANGE 4.2).
   */
  await pool.query(`UPDATE equipment_videos SET status = 'ready' WHERE id = ?`, [video.id]);
  res.json({ videoId: video.id, status: 'ready' });
});

/** Fresh signed part URLs for a video upload that outlived its last set. */
router.post('/:captureId/equipment/:equipmentId/video/uploads/refresh', async (req, res) => {
  const body = z
    .object({ fileId: z.string().min(1).max(64), parts: z.array(z.number().int().min(1)).min(1).max(10000) })
    .parse(req.body);
  const capture = await captureOr404(pool, req);
  const equipment = await equipmentOr404(pool, capture, req.params.equipmentId);
  const file = await one(
    pool,
    'SELECT * FROM capture_files WHERE id = ? AND capture_id = ? AND equipment_id = ?',
    [body.fileId, capture.id, equipment.id],
  );
  if (!file) throw notFound('This file is not part of this video.');
  if (file.status === 'stored') throw conflict('This file has already been stored.');
  res.json(await partTargets(file, body.parts));
});
