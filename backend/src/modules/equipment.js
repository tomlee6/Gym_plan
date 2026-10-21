/**
 * The gym machines on a capture, and the 360 degree video recorded for
 * each (CHANGE 2, CHANGE 4).
 *
 *   POST   /v1/captures/:captureId/equipment                   mark machines
 *   GET    /v1/captures/:captureId/equipment                   what is marked
 *   PATCH  /v1/captures/:captureId/equipment/:ref              correct one
 *   DELETE /v1/captures/:captureId/equipment/:ref              remove one
 *   POST   /v1/captures/:captureId/equipment/:ref/video        open an upload
 *   POST   .../video/complete                                  finish it
 *   POST   .../video/uploads/refresh                           fresh part URLs
 *
 * The API still calls a machine's reference `equipmentId` (e.g. EQ-001),
 * as the app does; in the database it is `machines.ref`, and every column
 * ending in _id is a foreign key.
 *
 * A machine's type is stored once in equipment_types (C-07): the global
 * list plus an account's own, so "treadmill", "Treadmill" and "tread mill"
 * are one type rather than three spellings.
 *
 * The video reuses the capture's own chunked, signed-URL upload. A retake
 * replaces the previous take's rows, deletes its stored objects and aborts
 * its unfinished upload (D-02), so nothing of it is left behind.
 *
 * Rule (C-07): these rows are the surveyor's original record; the approved
 * plan is the truth about where a machine is; 3D models attach to the
 * machine row.
 */
import { Router } from 'express';
import { z } from 'zod';

import { equipmentLabel } from '../../../shared/plan/index.js';
import { buildOnArrival } from '../assets/index.js';
import { config } from '../config.js';
import { many, one, pool, transaction } from '../db/pool.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { newId } from '../ids.js';
import { requireAccount, requireAuth } from '../middleware/auth.js';
import { storage } from '../storage/index.js';
import { allParts, captureOr404, completeFiles, discardObjects, partCount, partTargets } from './capture-uploads.js';

export const router = Router();
router.use(requireAuth, requireAccount('owner', 'surveyor'));

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
    .max(16)
    .regex(/^[A-Za-z0-9._-]+$/, 'An equipment id may only use letters, digits, dot, dash and underscore.'),
  // Any name: an account may use a machine type the global list lacks.
  type: z.string().trim().min(1).max(60),
  name: z.string().min(1).max(120),
  x: metres.nullish(),
  z: metres.nullish(),
  elevationM: metres.nullish(),
  rotationDeg: z.number().finite().min(-360).max(360).nullish(),
  widthM: size.nullish(),
  depthM: size.nullish(),
  heightM: size.nullish(),
  confidence: z.number().min(0).max(1).nullish(),
  source: z.enum(['roomplan', 'mesh', 'surveyor', 'reviewer']).default('surveyor'),
});

const n = (v) => (v === null || v === undefined ? null : Number(v));

/** "Tread mill", "treadmill" and "TREADMILL" all become "treadmill". */
export const typeKey = (text) => String(text).toLowerCase().replace(/[^a-z0-9]/g, '');

/** "leg press" → "legPress", the shape of the global list's codes. */
function codeFor(text) {
  const raw = String(text).trim();
  // Already one word, maybe camelCase ("plateLoadedHipThrust"): keep it.
  if (/^[A-Za-z][A-Za-z0-9]*$/.test(raw)) return (raw[0].toLowerCase() + raw.slice(1)).slice(0, 40);
  const words = String(text).trim().split(/[^A-Za-z0-9]+/).filter(Boolean);
  const code = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('');
  return code.slice(0, 40) || 'equipment';
}

/**
 * The equipment type for what the surveyor typed: the account's own or the
 * global one that matches, else a new type for this account.
 */
export async function equipmentTypeFor(db, accountId, text) {
  const key = typeKey(text);
  const known = await many(
    db,
    `SELECT id, code, label, account_id FROM equipment_types
     WHERE account_id IS NULL OR account_id = ? ORDER BY account_id IS NULL`,
    [accountId],
  );
  const match = known.find((t) => typeKey(t.code) === key || typeKey(t.label) === key);
  if (match) return match;
  const type = { id: newId(), code: codeFor(text), label: String(text).trim().slice(0, 80) };
  await db.query(
    `INSERT INTO equipment_types (id, account_id, code, label) VALUES (?, ?, ?, ?) AS fresh
     ON DUPLICATE KEY UPDATE label = equipment_types.label`,
    [type.id, accountId, type.code, type.label],
  );
  return one(db, `SELECT id, code, label FROM equipment_types WHERE scope = ? AND code = ?`, [accountId, type.code]);
}

/** Machines with their type, video and newest 3D model status. */
async function machineRows(db, captureId) {
  return many(
    db,
    `SELECT m.*, t.code AS type_code, t.label AS type_label,
            v.id AS video_id, v.status AS video_status, v.duration_s, v.video_file_id,
            v.thumbnail_file_id, v.frames_file_id,
            (SELECT mm.status FROM machine_models mm WHERE mm.machine_id = m.id
             ORDER BY mm.created_at DESC LIMIT 1) AS model_status
     FROM machines m
     LEFT JOIN equipment_types t ON t.id = m.equipment_type_id
     LEFT JOIN machine_videos v ON v.machine_id = m.id
     WHERE m.capture_id = ? ORDER BY m.ref`,
    [captureId],
  );
}

/** One machine as the app and the reviewer see it. */
function present(row) {
  return {
    equipmentId: row.ref,
    type: row.type_code ?? 'equipment',
    typeLabel: row.type_label ?? equipmentLabel(row.type_code),
    name: row.name,
    position: row.x === null ? null : { x: n(row.x), z: n(row.y) },
    elevationM: n(row.elevation_m),
    rotationDeg: n(row.rotation_deg),
    widthM: n(row.width_m),
    depthM: n(row.depth_m),
    heightM: n(row.height_m),
    confidence: n(row.confidence),
    source: row.source,
    modelStatus: row.model_status ?? 'none',
    video: row.video_id
      ? {
          videoId: row.video_id,
          status: row.video_status,
          durationSeconds: n(row.duration_s),
          hasThumbnail: Boolean(row.thumbnail_file_id),
        }
      : null,
  };
}

/** Every machine on a capture, each with its video if it has one. */
export async function equipmentFor(db, captureId) {
  return (await machineRows(db, captureId)).map(present);
}

/**
 * What the reviewer needs: every machine — placed or not (D-03) — with the
 * file ids of its 360 video and poster frame, for the caller to sign.
 */
export async function equipmentForReview(db, captureId) {
  return (await machineRows(db, captureId)).map((row) => ({
    ...present(row),
    machineId: row.id,
    video: row.video_id
      ? {
          ...present(row).video,
          fileId: row.video_file_id,
          thumbnailFileId: row.thumbnail_file_id,
          framesFileId: row.frames_file_id,
        }
      : null,
  }));
}

/**
 * What plan reading needs: each machine with a position, in the plan's own
 * frame, `(x, z)` becoming the plan's `[x, y]` (CHANGE 2.2). One the
 * surveyor added by hand without a position has nowhere to go yet; the
 * reviewer places it (D-03, H-02).
 */
export async function equipmentForPlan(db, captureId) {
  const rows = (await machineRows(db, captureId)).filter((row) => row.x !== null);
  return rows.map((row) => ({
    equipmentId: row.ref,
    type: row.type_code ?? 'equipment',
    name: row.name,
    x: n(row.x),
    y: n(row.y),
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
  if (capture.source === 'upload') throw badRequest('An uploaded drawing has no equipment to record.');
  return capture;
}

async function machineOr404(db, capture, ref, { lock = false } = {}) {
  const row = await one(db, `SELECT * FROM machines WHERE capture_id = ? AND ref = ?${lock ? ' FOR UPDATE' : ''}`, [
    capture.id,
    ref,
  ]);
  if (!row) throw notFound('This equipment is not on this capture.');
  return row;
}

/** The files of a machine's video, for discarding them. */
function videoFiles(db, video) {
  const ids = [video.video_file_id, video.thumbnail_file_id, video.frames_file_id].filter(Boolean);
  return ids.length ? many(db, `SELECT * FROM capture_files WHERE id IN (?)`, [ids]) : [];
}

/** Deletes a machine's video rows; returns its files, for discarding after commit. */
async function dropVideo(db, machineId) {
  const video = await one(db, 'SELECT * FROM machine_videos WHERE machine_id = ? FOR UPDATE', [machineId]);
  if (!video) return [];
  const files = await videoFiles(db, video);
  await db.query('DELETE FROM machine_videos WHERE id = ?', [video.id]);
  if (files.length) await db.query('DELETE FROM capture_files WHERE id IN (?)', [files.map((f) => f.id)]);
  return files;
}

/* ------------------------------------------------------------------ */
/* Marking equipment.                                                   */

/**
 * Records the machines on a capture. Sending the same equipment id again
 * replaces what it said, so the app may re-send its whole list after a lost
 * response without doubling anything up.
 */
router.post('/:captureId/equipment', async (req, res) => {
  const body = z.object({ equipment: z.array(equipmentBody).min(1).max(MAX_EQUIPMENT) }).parse(req.body);

  const ids = body.equipment.map((e) => e.equipmentId);
  if (new Set(ids).size !== ids.length) throw badRequest('Equipment ids must be unique.');

  const saved = await transaction(async (db) => {
    const capture = await openCapture(db, req);
    const existing = await many(db, 'SELECT ref FROM machines WHERE capture_id = ?', [capture.id]);
    const fresh = ids.filter((id) => !existing.some((e) => e.ref === id)).length;
    if (existing.length + fresh > MAX_EQUIPMENT) {
      throw badRequest(`A capture may carry up to ${MAX_EQUIPMENT} pieces of equipment.`);
    }

    for (const e of body.equipment) {
      const type = await equipmentTypeFor(db, capture.account_id, e.type);
      await db.query(
        `INSERT INTO machines
           (id, account_id, capture_id, ref, equipment_type_id, name, x, y, elevation_m, rotation_deg,
            width_m, depth_m, height_m, confidence, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) AS fresh
         ON DUPLICATE KEY UPDATE
           equipment_type_id = fresh.equipment_type_id, name = fresh.name, x = fresh.x, y = fresh.y,
           elevation_m = fresh.elevation_m, rotation_deg = fresh.rotation_deg, width_m = fresh.width_m,
           depth_m = fresh.depth_m, height_m = fresh.height_m, confidence = fresh.confidence,
           source = fresh.source`,
        [
          newId(), capture.account_id, capture.id, e.equipmentId, type.id, e.name,
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

router.patch('/:captureId/equipment/:ref', async (req, res) => {
  const body = equipmentBody.partial().omit({ equipmentId: true }).parse(req.body);
  if (!Object.keys(body).length) throw badRequest('Nothing to change.');

  const updated = await transaction(async (db) => {
    const capture = await openCapture(db, req);
    const row = await machineOr404(db, capture, req.params.ref, { lock: true });
    const columns = {
      equipment_type_id: body.type === undefined ? undefined : (await equipmentTypeFor(db, capture.account_id, body.type)).id,
      name: body.name,
      x: body.x,
      y: body.z,
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
      await db.query(`UPDATE machines SET ${sets.map(([c]) => `${c} = ?`).join(', ')} WHERE id = ?`, [
        ...sets.map(([, v]) => v),
        row.id,
      ]);
    }
    return equipmentFor(db, capture.id);
  });

  res.json({ equipment: updated });
});

router.delete('/:captureId/equipment/:ref', async (req, res) => {
  const files = await transaction(async (db) => {
    const capture = await openCapture(db, req);
    const row = await machineOr404(db, capture, req.params.ref, { lock: true });
    const dropped = await dropVideo(db, row.id);
    await db.query('DELETE FROM machine_models WHERE machine_id = ?', [row.id]);
    await db.query('DELETE FROM machines WHERE id = ?', [row.id]);
    return dropped;
  });
  await discardObjects(files);
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
 * Calling this again is how a retake works: the previous take's rows are
 * replaced, and once that has committed its stored objects are deleted and
 * its unfinished upload aborted (D-02), so the reviewer only ever sees the
 * take the surveyor kept and storage holds nothing of the others. Each take
 * has its own object keys, so the new upload is never touched.
 */
router.post('/:captureId/equipment/:ref/video', async (req, res) => {
  const body = videoBody.parse(req.body);

  const { result, discarded } = await transaction(async (db) => {
    const capture = await openCapture(db, req);
    const machine = await machineOr404(db, capture, req.params.ref, { lock: true });
    const dropped = await dropVideo(db, machine.id);

    const videoId = newId();
    const wanted = [
      { kind: 'video', bytes: body.bytes, contentType: body.contentType, label: '360' },
      ...(body.thumbnail
        ? [{ kind: 'thumbnail', bytes: body.thumbnail.bytes, contentType: body.thumbnail.contentType, label: 'thumbnail' }]
        : []),
    ];

    const files = [];
    for (const f of wanted) {
      const name = `equipment/${machine.ref}/${videoId}/${f.label}.${extensionFor[f.contentType]}`;
      // Under the account, so one customer's objects can never be read by another.
      const key = `accounts/${capture.account_id}/captures/${capture.id}/${name}`;
      const uploadId = await storage().createMultipart(key, f.contentType);
      const row = { id: newId(), name, storage_key: key, upload_id: uploadId, part_count: partCount(f.bytes, body.partSize) };
      await db.query(
        `INSERT INTO capture_files
           (id, capture_id, name, kind, bytes, content_type, part_size, part_count, storage_key, upload_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.id, capture.id, name, f.kind, f.bytes, f.contentType, body.partSize, row.part_count, key, uploadId],
      );
      files.push({ kind: f.kind, row });
    }

    await db.query(
      `INSERT INTO machine_videos (id, machine_id, video_file_id, thumbnail_file_id, duration_s, status)
       VALUES (?, ?, ?, ?, ?, 'uploading')`,
      [
        videoId,
        machine.id,
        files.find((f) => f.kind === 'video').row.id,
        files.find((f) => f.kind === 'thumbnail')?.row.id ?? null,
        body.durationSeconds ?? null,
      ],
    );
    await db.query(`UPDATE captures SET status = 'uploading' WHERE id = ? AND status = 'registered'`, [capture.id]);

    return {
      discarded: dropped,
      result: {
        videoId,
        status: 'uploading',
        files: await Promise.all(files.map(async ({ kind, row }) => ({ kind, ...(await partTargets(row, allParts(row))) }))),
      },
    };
  });

  await discardObjects(discarded);
  res.status(201).json(result);
});

async function videoOf(db, capture, ref) {
  const machine = await machineOr404(db, capture, ref);
  const video = await one(db, 'SELECT * FROM machine_videos WHERE machine_id = ?', [machine.id]);
  if (!video) throw notFound('No video has been started for this equipment.');
  return video;
}

/**
 * Finishes the video upload. Parts that never arrived are reported back the
 * way the capture's own completion reports them, so the app resends exactly
 * those and asks again rather than starting over (APP-10).
 */
router.post('/:captureId/equipment/:ref/video/complete', async (req, res) => {
  z.object({}).passthrough().parse(req.body ?? {});
  const capture = await captureOr404(pool, req);
  const video = await videoOf(pool, capture, req.params.ref);
  if (video.status === 'ready') return res.json({ videoId: video.id, status: 'ready' });

  const missing = await completeFiles(await videoFiles(pool, video));
  if (missing.length) return res.json({ videoId: video.id, status: 'incomplete', missing });

  // The thumbnail came from the phone and the video is kept as recorded,
  // so it is ready as soon as it has landed (CHANGE 4.2).
  await pool.query(`UPDATE machine_videos SET status = 'ready' WHERE id = ?`, [video.id]);
  // The machine's 3D model is built from it, when that is switched on (L-05).
  await buildOnArrival(video.machine_id);
  res.json({ videoId: video.id, status: 'ready' });
});

/** Fresh signed part URLs for a video upload that outlived its last set. */
router.post('/:captureId/equipment/:ref/video/uploads/refresh', async (req, res) => {
  const body = z
    .object({ fileId: z.string().min(1).max(64), parts: z.array(z.number().int().min(1)).min(1).max(10000) })
    .parse(req.body);
  const capture = await captureOr404(pool, req);
  const video = await videoOf(pool, capture, req.params.ref);
  const file = (await videoFiles(pool, video)).find((f) => f.id === body.fileId);
  if (!file) throw notFound('This file is not part of this video.');
  if (file.status === 'stored') throw conflict('This file has already been stored.');
  if (body.parts.some((p) => p > file.part_count)) throw badRequest('Unknown part number.');
  res.json(await partTargets(file, body.parts));
});
