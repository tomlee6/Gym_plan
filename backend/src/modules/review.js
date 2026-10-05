/**
 * Review service: the reviewer queue and editor (PRD section 7).
 *
 *   GET  /v1/review/queue                   waiting versions and queue stats   REV-01
 *   GET  /v1/review/versions/:id            one version: plan, files, history
 *   POST /v1/review/versions/:id/start      claim it (opening claims it)       REV-02
 *   POST /v1/review/versions/:id/release    put it back in the queue           REV-02
 *   PUT  /v1/review/versions/:id/plan       save edits, validate               REV-04, REV-06
 *   POST /v1/review/versions/:id/activity   the reviewer is working            REV-10
 *   POST /v1/review/versions/:id/approve    freeze, hash, supersede            REV-05..07
 *   POST /v1/review/versions/:id/reject     {reason, note}                     REV-08
 *   POST /v1/review/versions/:id/revise     new version of an approved plan    REV-09
 *
 * Reviewers and admins are Flex staff and see every organisation's queue. A
 * claimed version belongs to its reviewer until they decide or release it.
 * There is no automatic approval at any confidence.
 */
import { createHash } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import {
  approvalBlockers,
  canonicalJson,
  OPENING_TYPES,
  summary,
  TAG_TYPES,
  validate,
} from '../../../shared/plan/index.js';
import { audit, planLabel } from '../audit.js';
import { many, one, pool, transaction } from '../db/pool.js';
import { conflict, notFound } from '../errors.js';
import { newId } from '../ids.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { planRejected, walkthroughReady } from '../notify.js';
import { storage } from '../storage/index.js';
import { historyOf, walkthroughUrlFor } from './plans.js';

/** Long enough to pull a large USDZ over a slow link. */
const DOWNLOAD_TTL_SECONDS = 3600;
/** REV-10: gaps longer than this are idle and do not count. */
export const IDLE_SECONDS = 600;

/** REV-08's reason codes. The owner sees the label and the note. */
export const REJECT_REASONS = [
  'Incomplete coverage',
  'Wrong scale',
  'Unreadable source',
  'Wrong facility or level',
  'Other',
];

export const router = Router();
router.use(requireAuth, requireRole('reviewer', 'admin'));

const WEEK = 'UTC_TIMESTAMP(3) - INTERVAL 7 DAY';

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

const openFlags = (plan) => (plan?.flags ?? []).filter((f) => f.status === 'open').length;

router.get('/queue', async (req, res) => {
  const rows = await many(
    pool,
    `SELECT v.id, v.plan_id, v.version, v.status, v.origin, v.input_type, v.submitted_at,
            v.coverage, v.override_reason, v.review_started_at, v.reviewed_by, v.plan_json,
            p.level, f.name AS facility, o.name AS organisation,
            c.source, c.metadata, r.name AS reviewer_name
     FROM plan_versions v
     JOIN plans p ON p.id = v.plan_id
     JOIN facilities f ON f.id = p.facility_id
     JOIN organisations o ON o.id = v.org_id
     LEFT JOIN captures c ON c.id = v.capture_id
     LEFT JOIN users r ON r.id = v.reviewed_by
     WHERE v.status IN ('processing', 'in_review')
     ORDER BY COALESCE(v.submitted_at, v.created_at)`,
  );

  const mine = await many(
    pool,
    `SELECT review_seconds FROM plan_versions
     WHERE reviewed_by = ? AND status IN ('ready', 'recapture', 'superseded')
       AND review_seconds IS NOT NULL AND reviewed_at >= ${WEEK}`,
    [req.user.id],
  );
  const decided = await one(
    pool,
    `SELECT SUM(status IN ('ready', 'superseded')) AS approved, SUM(status = 'recapture') AS rejected
     FROM plan_versions WHERE reviewed_at >= ${WEEK}`,
  );

  res.json({
    versions: rows.map((r) => {
      const m = r.metadata ?? {};
      return {
        id: r.id,
        planId: r.plan_id,
        version: r.version,
        status: r.status,
        origin: r.origin,
        facility: r.facility,
        organisation: r.organisation,
        level: r.level,
        submittedAt: r.submitted_at,
        source: r.source ?? null,
        inputType: r.input_type ?? r.source ?? null,
        coverage: r.coverage === null ? null : Number(r.coverage),
        closed: m.closed ?? null,
        overrideReason: r.override_reason,
        weakWallCount: m.weakWallCount ?? null,
        tagCount: Array.isArray(m.tags) ? m.tags.length : null,
        photoCount: m.photoCount ?? null,
        openFlags: r.plan_json ? openFlags(r.plan_json) : null,
        reviewStartedAt: r.review_started_at,
        reviewer: reviewerOf(r, req.user.id),
      };
    }),
    stats: {
      waiting: rows.length,
      unclaimed: rows.filter((r) => !r.reviewed_by).length,
      oldestSubmittedAt: rows[0]?.submitted_at ?? null,
      myMedianSecondsThisWeek: median(mine.map((m) => m.review_seconds)),
      myReviewsThisWeek: mine.length,
      approvedThisWeek: Number(decided.approved ?? 0),
      rejectedThisWeek: Number(decided.rejected ?? 0),
    },
  });
});

async function versionRow(db, id, { lock = false } = {}) {
  return one(
    db,
    `SELECT v.*, r.name AS reviewer_name, p.level, p.facility_id, f.name AS facility,
            o.name AS organisation, c.source, c.metadata, c.received_at
     FROM plan_versions v
     JOIN plans p ON p.id = v.plan_id
     JOIN facilities f ON f.id = p.facility_id
     JOIN organisations o ON o.id = v.org_id
     LEFT JOIN captures c ON c.id = v.capture_id
     LEFT JOIN users r ON r.id = v.reviewed_by
     WHERE v.id = ?${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
}

/**
 * One version with what the reviewer works from: the plan, the capture's
 * metadata, a short-lived download URL for each file (model, room data,
 * photos, the uploaded drawing), and the plan's version history.
 */
router.get('/versions/:id', async (req, res) => {
  const v = await versionRow(pool, req.params.id);
  if (!v) throw notFound();

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

  res.json({
    id: v.id,
    planId: v.plan_id,
    version: v.version,
    status: v.status,
    origin: v.origin,
    basedOnVersionId: v.based_on_version_id,
    facility: v.facility,
    organisation: v.organisation,
    level: v.level,
    submittedAt: v.submitted_at,
    receivedAt: v.received_at ?? null,
    coverage: v.coverage === null ? null : Number(v.coverage),
    overrideReason: v.override_reason,
    areaM2: v.area_m2 === null ? null : Number(v.area_m2),
    reviewer: reviewerOf(v, req.user.id),
    reviewStartedAt: v.review_started_at,
    activeSeconds: v.review_active_seconds,
    reviewedAt: v.reviewed_at,
    reviewSeconds: v.review_seconds,
    rejectionReason: v.rejection_reason,
    reviewerNote: v.reviewer_note,
    contentHash: v.content_hash,
    walkthroughUrl: v.status === 'ready' ? walkthroughUrlFor(v.plan_id) : null,
    source: v.source ?? null,
    inputType: v.input_type ?? v.source ?? null,
    capture: v.metadata ?? null,
    plan,
    planRevision: v.plan_revision,
    planSavedAt: v.plan_saved_at,
    issues: plan ? validate(plan) : [],
    blockers: plan ? approvalBlockers(plan) : ['No plan has been produced for this version.'],
    rejectReasons: REJECT_REASONS,
    history: await historyOf(pool, v.plan_id),
    urlsExpireAt: new Date(Date.now() + DOWNLOAD_TTL_SECONDS * 1000),
    files: await Promise.all(
      files.map(async (f) => ({
        id: f.id,
        name: f.name,
        kind: f.kind,
        bytes: Number(f.bytes),
        contentType: f.content_type,
        url: await s.presignDownload(f.storage_key, DOWNLOAD_TTL_SECONDS),
      })),
    ),
  });
});

/** Locks a version, checks its status and that no one else has claimed it. */
async function claimable(db, req, allowed) {
  const v = await versionRow(db, req.params.id, { lock: true });
  if (!v) throw notFound();
  if (!allowed.includes(v.status)) {
    throw conflict(`This version is ${v.status.replace('_', ' ')}.`);
  }
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
    await audit(db, { orgId: v.org_id, actor: { id: req.user.id }, action: 'CLAIMED', target: target(v), version: v.version });
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
    await audit(db, { orgId: v.org_id, actor: { id: req.user.id }, action: 'RELEASED', target: target(v), version: v.version });
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
const num = z.number().finite();
const pt = z.tuple([num, num]);

const planBody = z.object({
  format: z.literal('gymplan/1'),
  scale: z.object({
    source: z.enum(['scan', 'line', 'drawn']),
    a: pt.nullish(),
    b: pt.nullish(),
    lengthM: z.number().positive().nullish(),
    metresPerPixel: z.number().positive().nullish(),
  }),
  underlay: z
    .object({
      fileId: z.string().max(64).nullish(),
      widthPx: z.number().int().positive().nullish(),
      heightPx: z.number().int().positive().nullish(),
      metresPerPixel: z.number().positive().nullish(),
    })
    .nullish(),
  ceilingHeightM: num,
  walls: z
    .array(z.object({ id, a: pt, b: pt, confidence: z.number().min(0).max(1), mirror: z.boolean() }))
    .max(3000),
  openings: z
    .array(
      z.object({
        id,
        wallId: id.nullable(),
        type: z.enum(OPENING_TYPES),
        offset: num,
        width: z.number().positive(),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(3000),
  columns: z
    .array(z.object({ id, x: num, y: num, w: z.number().positive(), d: z.number().positive(), angle: num }))
    .max(3000),
  objects: z
    .array(
      z.object({
        id,
        x: num,
        y: num,
        w: z.number().positive(),
        d: z.number().positive(),
        angle: num,
        heightM: z.number().positive().max(12),
        category: z.string().max(40).optional(),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(3000),
  zones: z.array(z.object({ id, points: z.array(pt).max(200) })).max(500),
  tags: z
    .array(z.object({ id, type: z.enum(TAG_TYPES), x: num, y: num, heightM: num.nullish() }))
    .max(1000),
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
  const plan = body.plan;

  const saved = await transaction(async (db) => {
    const v = await mine(db, req);
    if (v.plan_revision !== body.revision) {
      throw conflict('This plan was saved from somewhere else. Reload to see the latest version.');
    }
    const facts = summary(plan);
    await db.query(
      `UPDATE plan_versions
       SET ${ACCRUE}, plan_json = ?, plan_revision = plan_revision + 1,
           plan_saved_at = UTC_TIMESTAMP(3), plan_saved_by = ?, area_m2 = COALESCE(?, area_m2)
       WHERE id = ?`,
      [JSON.stringify(plan), req.user.id, facts.areaM2, v.id],
    );
    // "Corrected" (PRD section 4): recorded once, on the first save.
    if (!v.plan_saved_at) {
      await audit(db, { orgId: v.org_id, actor: { id: req.user.id }, action: 'CORRECTED', target: target(v), version: v.version });
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

router.post('/versions/:id/approve', async (req, res) => {
  z.object({}).passthrough().parse(req.body ?? {});
  const approved = await transaction(async (db) => {
    const v = await mine(db, req);
    if (!v.plan_json) throw conflict('There is no plan to approve.', { blockers: ['No plan has been produced.'] });
    const blockers = approvalBlockers(v.plan_json);
    if (blockers.length) throw conflict('This plan cannot be approved yet.', { blockers });

    const hash = createHash('sha256').update(canonicalJson(v.plan_json)).digest('hex');
    const area = summary(v.plan_json).areaM2;
    await db.query(
      `UPDATE plan_versions
       SET ${ACCRUE}, status = 'ready', reviewed_at = UTC_TIMESTAMP(3), content_hash = ?,
           walkthrough_url = ?, area_m2 = COALESCE(?, area_m2)
       WHERE id = ?`,
      [hash, walkthroughUrlFor(v.plan_id), area, v.id],
    );
    await db.query(`UPDATE plan_versions SET review_seconds = review_active_seconds WHERE id = ?`, [v.id]);
    await audit(db, {
      orgId: v.org_id,
      actor: { id: req.user.id },
      action: 'APPROVED',
      target: target(v),
      version: v.version,
      detail: { contentHash: hash },
    });

    // Earlier approved versions are superseded, never edited (REV-09).
    const older = await many(
      db,
      `SELECT id, version FROM plan_versions WHERE plan_id = ? AND status = 'ready' AND version < ?`,
      [v.plan_id, v.version],
    );
    for (const o of older) {
      await db.query(
        `UPDATE plan_versions SET status = 'superseded', superseded_at = UTC_TIMESTAMP(3) WHERE id = ?`,
        [o.id],
      );
      await audit(db, {
        orgId: v.org_id,
        actor: { id: req.user.id },
        action: 'SUPERSEDED',
        target: target(v),
        version: o.version,
        detail: { by: v.version },
      });
    }
    return { ...v, contentHash: hash };
  });

  await walkthroughReady(pool, {
    orgId: approved.org_id,
    label: planLabel(approved.facility, approved.level),
    planId: approved.plan_id,
  });
  res.json({ contentHash: approved.contentHash, walkthroughUrl: walkthroughUrlFor(approved.plan_id) });
});

router.post('/versions/:id/reject', async (req, res) => {
  const body = z
    .object({
      reason: z.enum(REJECT_REASONS, { message: `Choose a reason: ${REJECT_REASONS.join(', ')}.` }),
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
      [body.reason, body.note, v.id],
    );
    await db.query(`UPDATE plan_versions SET review_seconds = review_active_seconds WHERE id = ?`, [v.id]);
    await audit(db, {
      orgId: v.org_id,
      actor: { id: req.user.id },
      action: 'REJECTED',
      target: target(v),
      version: v.version,
      detail: { reason: body.reason },
    });
    return v;
  });

  await planRejected(pool, {
    orgId: rejected.org_id,
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
 * read-only and is superseded when the new one is approved.
 */
router.post('/versions/:id/revise', async (req, res) => {
  const created = await transaction(async (db) => {
    const v = await versionRow(db, req.params.id, { lock: true });
    if (!v) throw notFound();
    if (v.status !== 'ready') throw conflict('Only an approved version can be revised.');
    const newer = await one(
      db,
      `SELECT version, status FROM plan_versions WHERE plan_id = ? AND version > ? ORDER BY version DESC LIMIT 1`,
      [v.plan_id, v.version],
    );
    if (newer) {
      throw conflict(`Version ${newer.version} of this plan already exists (${newer.status.replace('_', ' ')}).`);
    }

    const plan = { ...v.plan_json, flags: [] };
    const nextId = newId('pv');
    await db.query(
      `INSERT INTO plan_versions
         (id, org_id, plan_id, version, status, capture_id, input_type, origin, based_on_version_id,
          submitted_at, coverage, override_reason, area_m2, review_started_at, reviewed_by,
          review_last_activity_at, plan_json, plan_saved_at, plan_saved_by)
       VALUES (?, ?, ?, ?, 'in_review', ?, ?, 'revision', ?, UTC_TIMESTAMP(3), ?, ?, ?,
               UTC_TIMESTAMP(3), ?, UTC_TIMESTAMP(3), ?, UTC_TIMESTAMP(3), ?)`,
      [
        nextId, v.org_id, v.plan_id, v.version + 1, v.capture_id, v.input_type, v.id,
        v.coverage, v.override_reason, v.area_m2, req.user.id, JSON.stringify(plan), req.user.id,
      ],
    );
    await audit(db, {
      orgId: v.org_id,
      actor: { id: req.user.id },
      action: 'REVISED',
      target: target(v),
      version: v.version + 1,
      detail: { from: v.version },
    });
    return nextId;
  });
  res.status(201).json({ id: created });
});
