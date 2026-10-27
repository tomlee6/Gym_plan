/**
 * Review service: the reviewer queue and editor (PRD section 7).
 *
 *   GET  /v1/review/queue                    waiting versions and queue stats   REV-01
 *   GET  /v1/review/versions/:id             one version: plan, files, history
 *   POST /v1/review/versions/:id/start       claim it (opening claims it)       REV-02
 *   POST /v1/review/versions/:id/release     put it back in the queue           REV-02
 *   PUT  /v1/review/versions/:id/plan        save edits, validate               REV-04, REV-06
 *   POST /v1/review/versions/:id/activity    the reviewer is working            REV-10
 *   POST /v1/review/versions/:id/approve     freeze, hash, queue the 3D         REV-05..07, D-04
 *   POST /v1/review/versions/:id/reject      {reason, note}                     REV-08
 *   POST /v1/review/versions/:id/revise      new version of an approved plan    REV-09
 *   POST /v1/review/versions/:id/regenerate  try a failed generation again      GEN-05
 *
 * Reviewers and admins are Flex staff and see every account's queue. A
 * claimed version belongs to its reviewer until they decide or release it.
 * There is no automatic approval at any confidence.
 *
 * Approval freezes the plan and moves the version to `generating`: the
 * plan.generate job builds the 3D level, and only then does the version
 * become `ready` and the one before it `superseded`. A generation that
 * fails past its retries comes back to this queue as `generation_failed`
 * with the reason (E-02).
 */
import { createHash } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import {
  approvalBlockers,
  BEAM_KINDS,
  canonicalJson,
  COLUMN_SHAPES,
  FLOOR_FINISHES,
  HINGE_SIDES,
  LEVEL_CHANGE_KINDS,
  OPENING_KINDS,
  OPENING_TYPES,
  SOURCES,
  SPACE_KINDS,
  summary,
  SUPPORTED_FORMATS,
  TAG_TYPES,
  validate,
  VOID_KINDS,
  WALL_KINDS,
  withMeasurements,
} from '../../../shared/plan/index.js';
import { approvedModelsOn } from '../assets/walkthrough.js';
import { audit, planLabel } from '../audit.js';
import { config } from '../config.js';
import { many, one, pool, transaction } from '../db/pool.js';
import { conflict, notFound } from '../errors.js';
import { linkFields } from '../generator/links.js';
import { isId, newId } from '../ids.js';
import { enqueue, jobsCommitted } from '../jobs/index.js';
import { requireAuth, requireStaff } from '../middleware/auth.js';
import { planRejected } from '../notify.js';
import { storage } from '../storage/index.js';
import { equipmentForReview } from './equipment.js';
import { historyOf, REJECT_REASONS, timelineOf, walkthroughUrlFor } from './plans.js';

/** Long enough to pull a large USDZ over a slow link. */
const DOWNLOAD_TTL_SECONDS = 3600;
/** REV-10: gaps longer than this are idle and do not count. */
export const IDLE_SECONDS = 600;

/** The reason labels a reviewer chooses from, and their stored codes. */
export const REJECT_LABELS = Object.values(REJECT_REASONS);
const REJECT_CODES = Object.fromEntries(Object.entries(REJECT_REASONS).map(([code, label]) => [label, code]));

export const router = Router();
router.use(requireAuth, requireStaff('reviewer', 'admin'));

const WEEK = 'UTC_TIMESTAMP(3) - INTERVAL 7 DAY';
const DECIDED = `('recapture', 'generating', 'generation_failed', 'ready', 'superseded')`;
const APPROVED = `('generating', 'generation_failed', 'ready', 'superseded')`;

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function reviewerOf(row, me) {
  if (!row.reviewed_by) return null;
  return { id: row.reviewed_by, name: row.reviewer_name, isMe: row.reviewed_by === me };
}

/**
 * Why a version is back with a reviewer through no reviewer's doing: the
 * last error of its dead generation or reading job (E-02).
 */
const FAILURE = `(SELECT j.last_error FROM jobs j
                  WHERE j.subject_id = v.id AND j.status = 'dead'
                  ORDER BY j.finished_at DESC LIMIT 1)`;

const VERSION_COLUMNS = `
  v.*, r.name AS reviewer_name, p.level_number AS level, p.facility_id, f.name AS facility,
  a.name AS organisation, c.source, COALESCE(d.input_type, c.source) AS input_type,
  c.coverage, c.floor_to_floor_m, c.outline_closed, c.override_reason, c.weak_wall_count, c.photo_count,
  c.scale_residual_mm, c.received_at, ${FAILURE} AS failure_reason,
  (SELECT COUNT(*) FROM capture_tags t WHERE t.capture_id = v.capture_id) AS tag_count`;

const VERSION_JOINS = `
  FROM plan_versions v
  JOIN plans p ON p.id = v.plan_id
  JOIN facilities f ON f.id = p.facility_id
  JOIN accounts a ON a.id = v.account_id
  LEFT JOIN captures c ON c.id = v.capture_id
  LEFT JOIN drawing_details d ON d.capture_id = v.capture_id
  LEFT JOIN users r ON r.id = v.reviewed_by`;

const num = (v) => (v === null || v === undefined ? null : Number(v));

router.get('/queue', async (req, res) => {
  // A version still being read has no plan yet, and is not ready for anyone.
  const rows = await many(
    pool,
    `SELECT ${VERSION_COLUMNS} ${VERSION_JOINS}
     WHERE (v.status IN ('processing', 'in_review') AND v.plan_json IS NOT NULL)
        OR v.status = 'generation_failed'
     ORDER BY COALESCE(v.submitted_at, v.created_at)`,
  );

  const mine = await many(
    pool,
    `SELECT review_active_seconds FROM plan_versions
     WHERE reviewed_by = ? AND status IN ${DECIDED} AND reviewed_at >= ${WEEK}`,
    [req.user.id],
  );
  const decided = await one(
    pool,
    `SELECT SUM(status IN ${APPROVED}) AS approved, SUM(status = 'recapture') AS rejected
     FROM plan_versions WHERE reviewed_at >= ${WEEK}`,
  );

  res.json({
    versions: rows.map((r) => ({
      id: r.id,
      planId: r.plan_id,
      version: r.version_no,
      status: r.status,
      origin: r.origin,
      facility: r.facility,
      organisation: r.organisation,
      level: r.level,
      submittedAt: r.submitted_at,
      source: r.source ?? null,
      inputType: r.input_type ?? null,
      coverage: num(r.coverage),
      closed: r.outline_closed === null ? null : Boolean(r.outline_closed),
      overrideReason: r.override_reason,
      weakWallCount: r.weak_wall_count,
      tagCount: r.capture_id ? Number(r.tag_count) : null,
      photoCount: r.photo_count,
      // Generated from plan_json (C-05), so the queue never parses plans.
      openFlags: r.plan_json ? r.open_flag_count : null,
      failureReason: r.failure_reason,
      reviewStartedAt: r.review_started_at,
      reviewer: reviewerOf(r, req.user.id),
    })),
    stats: {
      waiting: rows.length,
      unclaimed: rows.filter((r) => !r.reviewed_by).length,
      oldestSubmittedAt: rows[0]?.submitted_at ?? null,
      myMedianSecondsThisWeek: median(mine.map((m) => m.review_active_seconds)),
      myReviewsThisWeek: mine.length,
      approvedThisWeek: Number(decided.approved ?? 0),
      rejectedThisWeek: Number(decided.rejected ?? 0),
    },
  });
});

async function versionRow(db, id, { lock = false } = {}) {
  if (!isId(id)) return null;
  return one(db, `SELECT ${VERSION_COLUMNS} ${VERSION_JOINS} WHERE v.id = ?${lock ? ' FOR UPDATE' : ''}`, [id]);
}

/** Which plan object carries each machine reference, if any. */
function placedRefs(plan) {
  const refs = new Map();
  for (const o of plan?.objects ?? []) if (o.equipment?.equipmentId) refs.set(o.equipment.equipmentId, o.id);
  return refs;
}

/**
 * One version with what the reviewer works from: the plan, the capture's
 * facts, a short-lived download URL for each file (model, room data,
 * photos, mesh and keyframes, the uploaded drawing), its machines, and the
 * plan's version history.
 */
router.get('/versions/:id', async (req, res) => {
  const v = await versionRow(pool, req.params.id);
  if (!v) throw notFound();

  // This version's own generated level, whatever came of it, so the reviewer
  // can open it from the editor (K-06), not only the newest ready one.
  const model = await one(
    pool,
    `SELECT status, generator_version, glb_key, bytes, failure_reason FROM generated_models
     WHERE plan_version_id = ? ORDER BY created_at DESC LIMIT 1`,
    [v.id],
  );

  const files = v.capture_id
    ? await many(
        pool,
        `SELECT id, name, kind, bytes, content_type, storage_key FROM capture_files
         WHERE capture_id = ? AND status = 'stored' ORDER BY kind, name`,
        [v.capture_id],
      )
    : [];
  const s = storage();
  const plan = v.plan_json;
  const signed = new Map(
    await Promise.all(files.map(async (f) => [f.id, await s.presignDownload(f.storage_key, DOWNLOAD_TTL_SECONDS)])),
  );
  const equipment = v.capture_id ? await equipmentForReview(pool, v.capture_id) : [];
  const placed = placedRefs(plan);
  const videoFileIds = new Set(equipment.flatMap((e) => [e.video?.fileId, e.video?.thumbnailFileId, e.video?.framesFileId]));
  const tags = v.capture_id
    ? await many(pool, 'SELECT type, x, y, height_m FROM capture_tags WHERE capture_id = ? ORDER BY id', [v.capture_id])
    : [];
  const controls = v.capture_id
    ? await many(pool, 'SELECT ax, ay, bx, `by`, measured_m, scanned_m FROM control_distances WHERE capture_id = ? ORDER BY id', [
        v.capture_id,
      ])
    : [];

  res.json({
    id: v.id,
    planId: v.plan_id,
    version: v.version_no,
    status: v.status,
    origin: v.origin,
    basedOnVersionId: v.based_on_version_id,
    facility: v.facility,
    organisation: v.organisation,
    level: v.level,
    submittedAt: v.submitted_at,
    receivedAt: v.received_at ?? null,
    coverage: num(v.coverage),
    overrideReason: v.override_reason,
    areaM2: num(v.area_m2),
    reviewer: reviewerOf(v, req.user.id),
    reviewStartedAt: v.review_started_at,
    activeSeconds: v.review_active_seconds,
    reviewedAt: v.reviewed_at,
    reviewSeconds: v.reviewed_at ? v.review_active_seconds : null,
    rejectionReason: v.rejection_reason ? REJECT_REASONS[v.rejection_reason] : null,
    reviewerNote: v.reviewer_note,
    contentHash: v.content_hash,
    failureReason: v.failure_reason,
    walkthroughUrl: v.status === 'ready' ? walkthroughUrlFor(v.plan_id) : null,
    generatedModel: model
      ? {
          status: model.status,
          generatorVersion: model.generator_version,
          stored: Boolean(model.glb_key),
          bytes: num(model.bytes),
          failureReason: model.failure_reason,
          ...(model.glb_key && model.status === 'ready' ? await linkFields(model.glb_key) : { url: null, urlExpiresAt: null }),
        }
      : null,
    // The approved 3D model of each recorded machine, for the walkthrough to place (J-06).
    machineModels: await approvedModelsOn(pool, v.capture_id),
    source: v.source ?? null,
    inputType: v.input_type ?? null,
    // What the app reported, from the typed capture columns (C-06).
    capture: v.capture_id
      ? {
          floorToFloorM: num(v.floor_to_floor_m),
          coverage: num(v.coverage),
          closed: v.outline_closed === null ? null : Boolean(v.outline_closed),
          overrideReason: v.override_reason,
          weakWallCount: v.weak_wall_count,
          photoCount: v.photo_count,
          scaleResidualMm: num(v.scale_residual_mm),
          tags: tags.map((t) => ({ type: t.type, x: num(t.x), y: num(t.y), heightM: num(t.height_m) })),
          controlDistances: controls.map((c) => ({
            a: [num(c.ax), num(c.ay)],
            b: [num(c.bx), num(c.by)],
            measuredM: num(c.measured_m),
            scannedM: num(c.scanned_m),
          })),
        }
      : null,
    plan,
    planRevision: v.plan_revision,
    planSavedAt: v.plan_saved_at,
    issues: plan ? validate(plan) : [],
    blockers: plan ? approvalBlockers(plan) : ['No plan has been produced for this version.'],
    rejectReasons: REJECT_LABELS,
    history: await historyOf(pool, v.plan_id),
    timeline: await timelineOf(pool, v.plan_id),
    urlsExpireAt: new Date(Date.now() + DOWNLOAD_TTL_SECONDS * 1000),
    /*
     * Every machine on the capture, placed or not (D-03): one the surveyor
     * added without a position is listed for the reviewer to place (H-02),
     * and its 360 video is here either way.
     */
    equipment: equipment.map((e) => ({
      ...e,
      placed: e.position !== null || placed.has(e.equipmentId),
      planObjectId: placed.get(e.equipmentId) ?? null,
      video: e.video
        ? {
            videoId: e.video.videoId,
            status: e.video.status,
            durationSeconds: e.video.durationSeconds,
            // Null until the upload has landed, so the player knows to wait.
            url: signed.get(e.video.fileId) ?? null,
            thumbnailUrl: signed.get(e.video.thumbnailFileId) ?? null,
            framesUrl: signed.get(e.video.framesFileId) ?? null,
          }
        : null,
    })),
    files: files.map((f) => {
      const machine = videoFileIds.has(f.id)
        ? equipment.find((e) => [e.video?.fileId, e.video?.thumbnailFileId, e.video?.framesFileId].includes(f.id))
        : null;
      return {
        id: f.id,
        name: f.name,
        kind: f.kind,
        bytes: Number(f.bytes),
        contentType: f.content_type,
        equipmentId: machine?.equipmentId ?? null,
        url: signed.get(f.id),
      };
    }),
  });
});

/** Locks a version, checks its status and that no one else has claimed it. */
async function claimable(db, req, allowed) {
  const v = await versionRow(db, req.params.id, { lock: true });
  if (!v) throw notFound();
  if (!allowed.includes(v.status)) throw conflict(`This version is ${v.status.replace('_', ' ')}.`);
  if (v.status === 'in_review' && v.reviewed_by && v.reviewed_by !== req.user.id) {
    throw conflict(`${v.reviewer_name ?? 'Another reviewer'} is reviewing this plan.`);
  }
  return v;
}

/** Only the reviewer who claimed a version may change or decide it. */
async function mine(db, req) {
  const v = await claimable(db, req, ['in_review']);
  if (v.reviewed_by !== req.user.id) throw conflict('Claim this plan before changing it.');
  return v;
}

/** Adds the time since the last activity, unless it was idle (REV-10). */
const ACCRUE = `
  review_active_seconds = review_active_seconds + IF(
    review_last_activity_at IS NOT NULL
      AND TIMESTAMPDIFF(SECOND, review_last_activity_at, UTC_TIMESTAMP(3)) <= ${IDLE_SECONDS},
    TIMESTAMPDIFF(SECOND, review_last_activity_at, UTC_TIMESTAMP(3)), 0),
  review_last_activity_at = UTC_TIMESTAMP(3)`;

const target = (v) => ({ type: 'plan', id: v.plan_id, label: planLabel(v.facility, v.level) });

router.post('/versions/:id/start', async (req, res) => {
  await transaction(async (db) => {
    const v = await claimable(db, req, ['processing', 'in_review']);
    if (!v.plan_json) throw conflict('This plan is still being read.');
    if (v.reviewed_by === req.user.id && v.status === 'in_review') {
      await db.query(`UPDATE plan_versions SET ${ACCRUE} WHERE id = ?`, [v.id]);
      return;
    }
    await db.query(
      `UPDATE plan_versions
       SET status = 'in_review', review_started_at = COALESCE(review_started_at, UTC_TIMESTAMP(3)),
           reviewed_by = ?, review_last_activity_at = UTC_TIMESTAMP(3)
       WHERE id = ?`,
      [req.user.id, v.id],
    );
    await audit(db, { accountId: v.account_id, actor: { id: req.user.id }, action: 'CLAIMED', target: target(v), version: v.version_no });
  });
  res.status(204).end();
});

router.post('/versions/:id/release', async (req, res) => {
  await transaction(async (db) => {
    const v = await mine(db, req);
    await db.query(
      `UPDATE plan_versions
       SET ${ACCRUE}, status = 'processing', reviewed_by = NULL, review_started_at = NULL,
           review_last_activity_at = NULL
       WHERE id = ?`,
      [v.id],
    );
    await audit(db, { accountId: v.account_id, actor: { id: req.user.id }, action: 'RELEASED', target: target(v), version: v.version_no });
  });
  res.status(204).end();
});

router.post('/versions/:id/activity', async (req, res) => {
  await transaction(async (db) => {
    const v = await mine(db, req);
    await db.query(`UPDATE plan_versions SET ${ACCRUE} WHERE id = ?`, [v.id]);
  });
  res.status(204).end();
});

/* ------------------------------------------------------------------ */
/* Saving the reviewer's edits.                                         */

const id = z.string().min(1).max(64);
const num$ = z.number().finite();
const pt = z.tuple([num$, num$]);
const ring = z.array(pt).max(500);

/*
 * A measurement the scan never recorded, which the reviewer may also clear:
 * absent, null and a real number are all allowed, and null means "unknown"
 * rather than zero. Never defaulted to a number, so an unmeasured value can
 * never be mistaken for a measured one (CHANGE 1).
 */
const measure = (schema) => schema.nullish();

const equipment = z
  .object({
    equipmentId: z.string().min(1).max(64),
    // Any name: an account may use a type the global list lacks.
    type: z.string().min(1).max(60),
    name: z.string().min(1).max(120),
  })
  .nullish();

/*
 * Every format is accepted: a version read before format 3 is still edited
 * and saved as it was, and is not rewritten into the new format. The
 * format 3 fields (G-02..G-06) are optional, so an older plan saves without
 * gaining any of them.
 */
const planBody = z.object({
  format: z.enum(SUPPORTED_FORMATS),
  units: z.literal('m').nullish(),
  // Derived on the server from the geometry, so whatever arrives is ignored.
  room: z.unknown().nullish(),
  scale: z.object({
    source: z.enum(['scan', 'line', 'drawn']),
    a: pt.nullish(),
    b: pt.nullish(),
    lengthM: z.number().positive().nullish(),
    metresPerPixel: z.number().positive().nullish(),
    // What the control distances did to a scan (F-05), kept as read.
    control: z.object({}).passthrough().nullish(),
  }),
  underlay: z
    .object({
      fileId: z.string().max(64).nullish(),
      widthPx: z.number().int().positive().nullish(),
      heightPx: z.number().int().positive().nullish(),
      metresPerPixel: z.number().positive().nullish(),
    })
    .nullish(),
  ceilingHeightM: num$,
  spaces: z
    .array(
      z.object({
        id,
        name: z.string().max(100).nullish(),
        kind: z.enum(SPACE_KINDS).nullish(),
        points: ring,
        floorFinish: z.enum(FLOOR_FINISHES).nullish(),
        ceilingHeightM: measure(num$),
        ceilingZones: z.array(z.object({ id, points: ring, heightM: measure(num$) })).max(100).default([]),
      }),
    )
    .max(500)
    .optional(),
  walls: z
    .array(
      z.object({
        id,
        a: pt,
        b: pt,
        confidence: z.number().min(0).max(1),
        mirror: z.boolean(),
        // CHANGE 1.2. `lengthM` and `angleDeg` are derived and recomputed.
        lengthM: measure(num$),
        angleDeg: measure(num$),
        heightM: measure(z.number().positive().max(20)),
        thicknessM: measure(z.number().positive().max(2)),
        source: z.enum(SOURCES).nullish(),
        kind: z.enum(WALL_KINDS).nullish(),
        curveM: measure(num$),
        mirrors: z
          .array(z.object({ id, fromM: num$, toM: num$, bottomM: num$, topM: num$ }))
          .max(50)
          .optional(),
      }),
    )
    .max(3000),
  openings: z
    .array(
      z.object({
        id,
        wallId: id.nullable(),
        type: z.enum(OPENING_TYPES),
        offset: num$,
        width: z.number().positive(),
        confidence: z.number().min(0).max(1),
        // CHANGE 1.3, 1.4.
        heightM: measure(z.number().positive().max(10)),
        sillHeightM: measure(num$),
        angleDeg: measure(num$),
        swing: z.enum(['left', 'right', 'inward', 'outward']).nullish(),
        source: z.enum(SOURCES).nullish(),
        kind: z.enum(OPENING_KINDS).nullish(),
        leaves: z.union([z.literal(1), z.literal(2)]).nullish(),
        hinge: z.enum(HINGE_SIDES).nullish(),
        swingInto: id.nullish(),
      }),
    )
    .max(3000),
  columns: z
    .array(
      z.object({
        id,
        x: num$,
        y: num$,
        w: z.number().positive(),
        d: z.number().positive(),
        angle: num$,
        shape: z.enum(COLUMN_SHAPES).nullish(),
        heightM: measure(z.number().positive().max(20)),
      }),
    )
    .max(3000),
  beams: z
    .array(z.object({ id, kind: z.enum(BEAM_KINDS).nullish(), points: ring, bottomM: measure(num$) }))
    .max(500)
    .optional(),
  levelChanges: z
    .array(
      z.object({
        id,
        kind: z.enum(LEVEL_CHANGE_KINDS).nullish(),
        points: ring,
        heightM: measure(num$),
        rampAngleDeg: measure(num$),
      }),
    )
    .max(500)
    .optional(),
  voids: z
    .array(z.object({ id, kind: z.enum(VOID_KINDS).nullish(), points: ring, railHeightM: measure(num$) }))
    .max(500)
    .optional(),
  objects: z
    .array(
      z.object({
        id,
        x: num$,
        y: num$,
        w: z.number().positive(),
        d: z.number().positive(),
        angle: num$,
        heightM: z.number().positive().max(12),
        category: z.string().max(40).optional(),
        confidence: z.number().min(0).max(1),
        // CHANGE 1.5, 2.4.
        elevationM: measure(num$),
        equipment,
        source: z.enum(SOURCES).nullish(),
        // Format 3 (G-06).
        facingDeg: measure(num$),
        modelRef: z.string().max(64).nullish(),
        sameAs: id.nullish(),
      }),
    )
    .max(3000),
  zones: z.array(z.object({ id, points: z.array(pt).max(200) })).max(500),
  tags: z.array(z.object({ id, type: z.enum(TAG_TYPES), x: num$, y: num$, heightM: num$.nullish() })).max(1000),
  flags: z
    .array(
      z.object({
        id,
        kind: z.string().max(40),
        elementId: id.nullable(),
        title: z.string().max(200),
        detail: z.string().max(1000),
        status: z.enum(['open', 'resolved']),
        resolution: z.enum(['confirmed', 'edited', 'deleted']).nullish(),
      }),
    )
    .max(3000),
});

router.put('/versions/:id/plan', async (req, res) => {
  const body = z.object({ plan: planBody, revision: z.number().int().min(0) }).parse(req.body);
  /*
   * Derived measurements are recomputed from the geometry the reviewer sent,
   * never trusted from the client: wall lengths and the room box must always
   * describe the points actually being saved (CHANGE 1.1). The version's
   * measurement columns follow by themselves (C-05).
   */
  const plan = withMeasurements(body.plan);

  const saved = await transaction(async (db) => {
    const v = await mine(db, req);
    if (v.plan_revision !== body.revision) {
      throw conflict('This plan was saved from somewhere else. Reload to see the latest version.');
    }
    await db.query(
      `UPDATE plan_versions
       SET ${ACCRUE}, plan_json = ?, plan_revision = plan_revision + 1,
           plan_saved_at = UTC_TIMESTAMP(3), plan_saved_by = ?
       WHERE id = ?`,
      [JSON.stringify(plan), req.user.id, v.id],
    );
    // "Corrected" (PRD section 4): recorded once, on the first save.
    if (!v.plan_saved_at) {
      await audit(db, { accountId: v.account_id, actor: { id: req.user.id }, action: 'CORRECTED', target: target(v), version: v.version_no });
    }
    return { revision: v.plan_revision + 1 };
  });

  res.json({
    revision: saved.revision,
    savedAt: new Date(),
    issues: validate(plan),
    blockers: approvalBlockers(plan),
    summary: summary(plan),
  });
});

/* ------------------------------------------------------------------ */
/* Decisions.                                                           */

/** Queues the 3D level for a version (D-04). One job per version and generator. */
function queueGeneration(db, v) {
  return enqueue(db, {
    kind: 'plan.generate',
    subjectId: v.id,
    accountId: v.account_id,
    dedupeKey: `${v.id}:${config.generator.version}`,
  });
}

router.post('/versions/:id/approve', async (req, res) => {
  z.object({}).passthrough().parse(req.body ?? {});
  const approved = await transaction(async (db) => {
    const v = await mine(db, req);
    if (!v.plan_json) throw conflict('There is no plan to approve.', { blockers: ['No plan has been produced.'] });
    const blockers = approvalBlockers(v.plan_json);
    if (blockers.length) throw conflict('This plan cannot be approved yet.', { blockers });
    const busy = await one(db, 'SELECT version_no FROM plan_versions WHERE generating_plan_id = ? AND id <> ?', [
      v.plan_id,
      v.id,
    ]);
    if (busy) throw conflict(`Version ${busy.version_no} of this plan is still being generated. Try again shortly.`);

    const hash = createHash('sha256').update(canonicalJson(v.plan_json)).digest('hex');
    await db.query(
      `UPDATE plan_versions
       SET ${ACCRUE}, status = 'generating', reviewed_at = UTC_TIMESTAMP(3), content_hash = ?
       WHERE id = ?`,
      [hash, v.id],
    );
    await audit(db, {
      accountId: v.account_id,
      actor: { id: req.user.id },
      action: 'APPROVED',
      target: target(v),
      version: v.version_no,
      detail: { contentHash: hash },
    });
    await queueGeneration(db, v);
    return { ...v, contentHash: hash };
  });
  await jobsCommitted();

  const now = await one(pool, 'SELECT status FROM plan_versions WHERE id = ?', [approved.id]);
  res.json({ contentHash: approved.contentHash, status: now.status, walkthroughUrl: walkthroughUrlFor(approved.plan_id) });
});

router.post('/versions/:id/regenerate', async (req, res) => {
  await transaction(async (db) => {
    const v = await claimable(db, req, ['generation_failed']);
    await db.query(`UPDATE plan_versions SET status = 'generating' WHERE id = ?`, [v.id]);
    await audit(db, { accountId: v.account_id, actor: { id: req.user.id }, action: 'GENERATION_RETRIED', target: target(v), version: v.version_no });
    await queueGeneration(db, v);
  });
  await jobsCommitted();
  const now = await one(pool, 'SELECT status FROM plan_versions WHERE id = ?', [req.params.id]);
  res.json({ status: now.status });
});

router.post('/versions/:id/reject', async (req, res) => {
  const body = z
    .object({
      reason: z.enum(REJECT_LABELS, { message: `Choose a reason: ${REJECT_LABELS.join(', ')}.` }),
      note: z.string().trim().min(3).max(4000),
    })
    .parse(req.body);
  const rejected = await transaction(async (db) => {
    const v = await mine(db, req);
    await db.query(
      `UPDATE plan_versions
       SET ${ACCRUE}, status = 'recapture', reviewed_at = UTC_TIMESTAMP(3),
           rejection_reason = ?, reviewer_note = ?
       WHERE id = ?`,
      [REJECT_CODES[body.reason], body.note, v.id],
    );
    await audit(db, {
      accountId: v.account_id,
      actor: { id: req.user.id },
      action: 'REJECTED',
      target: target(v),
      version: v.version_no,
      detail: { reason: body.reason },
    });
    return v;
  });

  await planRejected(pool, {
    accountId: rejected.account_id,
    label: planLabel(rejected.facility, rejected.level),
    reason: body.reason,
    note: body.note,
    planId: rejected.plan_id,
  });
  res.status(204).end();
});

/**
 * A change to an approved plan (REV-09): a new version, claimed by the
 * reviewer, starting from the approved plan. The approved version stays
 * read-only and is superseded when the new one is ready. A version whose
 * generation failed may be revised too, to fix what the generator choked on.
 */
router.post('/versions/:id/revise', async (req, res) => {
  const created = await transaction(async (db) => {
    const v = await versionRow(db, req.params.id, { lock: true });
    if (!v) throw notFound();
    if (!['ready', 'generation_failed'].includes(v.status)) throw conflict('Only an approved version can be revised.');
    const newer = await one(
      db,
      `SELECT version_no, status FROM plan_versions WHERE plan_id = ? AND version_no > ? ORDER BY version_no DESC LIMIT 1`,
      [v.plan_id, v.version_no],
    );
    if (newer) {
      throw conflict(`Version ${newer.version_no} of this plan already exists (${newer.status.replace('_', ' ')}).`);
    }

    const plan = { ...v.plan_json, flags: [] };
    const nextId = newId();
    await db.query(
      `INSERT INTO plan_versions
         (id, account_id, plan_id, version_no, status, capture_id, origin, based_on_version_id,
          submitted_at, review_started_at, reviewed_by, review_last_activity_at, plan_json,
          plan_saved_at, plan_saved_by)
       VALUES (?, ?, ?, ?, 'in_review', ?, 'revision', ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), ?,
               UTC_TIMESTAMP(3), ?, UTC_TIMESTAMP(3), ?)`,
      [nextId, v.account_id, v.plan_id, v.version_no + 1, v.capture_id, v.id, req.user.id, JSON.stringify(plan), req.user.id],
    );
    await audit(db, {
      accountId: v.account_id,
      actor: { id: req.user.id },
      action: 'REVISED',
      target: target(v),
      version: v.version_no + 1,
      detail: { from: v.version_no },
    });
    return nextId;
  });
  res.status(201).json({ id: created });
});
