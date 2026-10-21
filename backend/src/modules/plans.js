/**
 * Plans service: the owner's status view (ACC-03), each plan's history,
 * the walkthrough model, and share links. Acts in the account named by
 * X-Account-Id.
 *
 *   GET    /v1/plans                    each plan at its newest version
 *   GET    /v1/plans/:id                detail, history, machines, share link
 *   GET    /v1/plans/:id/model          newest ready plan, for the viewer
 *   POST   /v1/plans/:id/share-links    a fresh view-only link (VIEW-07)
 *   DELETE /v1/plans/:id/share-links    revoke it
 *
 * Statuses (D-05): uploading → processing → in_review → generating → ready,
 * or recapture, generation_failed, superseded. The walkthrough follows the
 * newest ready version while a later one is reviewed or generated.
 *
 * Walkthrough links are built from PUBLIC_WEB_URL whenever they are shown,
 * never stored, so moving the web app to another domain leaves nothing
 * stale behind (C-04).
 *
 * Timestamps go out raw (ISO 8601, UTC); clients format them locally.
 */
import { Router } from 'express';
import { z } from 'zod';

import { approvedModelsOn } from '../assets/walkthrough.js';
import { audit, planEventsSql, planLabel } from '../audit.js';
import { config } from '../config.js';
import { many, one, pool, transaction } from '../db/pool.js';
import { conflict, notFound } from '../errors.js';
import { linkFields } from '../generator/links.js';
import { isId, newId, newToken, sha256 } from '../ids.js';
import { requireAccount, requireAuth } from '../middleware/auth.js';
import { initialsOf } from './auth.js';
import { equipmentFor } from './equipment.js';

export const router = Router();
router.use(requireAuth, requireAccount());

/** REV-08's reasons, as stored and as shown. */
export const REJECT_REASONS = {
  incomplete_coverage: 'Incomplete coverage',
  wrong_scale: 'Wrong scale',
  unreadable_source: 'Unreadable source',
  wrong_facility: 'Wrong facility or level',
  other: 'Other',
};

/** Each plan joined to its newest version, and its newest ready one. */
const LATEST = `
  SELECT p.id, p.level_number AS level, p.facility_id, f.name AS facility_name,
         v.id AS version_id, v.version_no AS version, v.status, v.submitted_at,
         COALESCE(d.input_type, c.source) AS input_type, c.coverage, c.override_reason,
         COALESCE(v.area_m2, c.area_m2) AS area_m2, v.review_started_at, v.reviewed_at,
         v.review_active_seconds, v.rejection_reason, v.reviewer_note, v.capture_id,
         v.updated_at, r.name AS reviewer_name, ready.version_no AS ready_version
  FROM plans p
  JOIN facilities f ON f.id = p.facility_id
  JOIN plan_versions v ON v.plan_id = p.id
   AND v.version_no = (SELECT MAX(version_no) FROM plan_versions WHERE plan_id = p.id)
  LEFT JOIN plan_versions ready ON ready.ready_plan_id = p.id
  LEFT JOIN captures c ON c.id = v.capture_id
  LEFT JOIN drawing_details d ON d.capture_id = v.capture_id
  LEFT JOIN users r ON r.id = v.reviewed_by
  WHERE p.account_id = ?`;

export function walkthroughUrlFor(planId) {
  return `${config.publicWebUrl}/plans/${planId}/walkthrough`;
}

export const shareUrlFor = (token) => `${config.publicWebUrl}/s/${token}`;

const decided = (status) => ['recapture', 'generating', 'generation_failed', 'ready', 'superseded'].includes(status);

function summary(row) {
  return {
    id: row.id,
    facilityId: row.facility_id,
    site: row.facility_name,
    level: row.level,
    status: row.status,
    version: row.version,
    inputType: row.input_type,
    submittedAt: row.submitted_at,
    reviewStartedAt: row.review_started_at,
    reviewedAt: row.reviewed_at,
    reviewerName: row.reviewer_name,
    rejectionReason: row.rejection_reason ? REJECT_REASONS[row.rejection_reason] : null,
    updatedAt: row.updated_at,
    // The walkthrough follows the newest ready version, even while a later
    // version is in review or being generated (GEN-06).
    walkthroughVersion: row.ready_version === null ? null : Number(row.ready_version),
  };
}

router.get('/', async (req, res) => {
  const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(req.query);
  const rows = await many(pool, `${LATEST} ORDER BY v.updated_at DESC LIMIT ?`, [req.account.id, limit]);
  res.json({ plans: rows.map(summary) });
});

async function planOr404(accountId, planId) {
  const row = isId(planId) ? await one(pool, `${LATEST} AND p.id = ?`, [accountId, planId]) : null;
  if (!row) throw notFound('This plan does not exist.');
  return row;
}

/**
 * The plan's live link. Only the token's hash is stored (D-06), so the URL
 * itself is shown once, when the link is made; after that the owner sees
 * that a link exists and when it expires, and makes a fresh one to copy.
 */
async function activeShareLink(db, planId) {
  const link = await one(
    db,
    `SELECT expires_at, created_at FROM share_links
     WHERE active_plan_id = ? AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP(3))`,
    [planId],
  );
  return link ? { url: null, expiresAt: link.expires_at, createdAt: link.created_at } : null;
}

/** Every version of a plan, newest first, with who did what and when (REV-09). */
export async function historyOf(db, planId) {
  const rows = await many(
    db,
    `SELECT v.id, v.version_no, v.status, v.origin, COALESCE(d.input_type, c.source) AS input_type,
            v.submitted_at, v.reviewed_at, v.superseded_at, v.rejection_reason, v.content_hash,
            v.created_at, r.name AS reviewer_name, u.name AS submitted_by
     FROM plan_versions v
     LEFT JOIN users r ON r.id = v.reviewed_by
     LEFT JOIN captures c ON c.id = v.capture_id
     LEFT JOIN drawing_details d ON d.capture_id = v.capture_id
     LEFT JOIN users u ON u.id = c.user_id
     WHERE v.plan_id = ?
     ORDER BY v.version_no DESC`,
    [planId],
  );
  return rows.map((v) => ({
    id: v.id,
    version: v.version_no,
    status: v.status,
    origin: v.origin,
    inputType: v.input_type,
    submittedBy: v.submitted_by,
    submittedAt: v.submitted_at,
    reviewerName: v.reviewer_name,
    reviewedAt: v.reviewed_at,
    supersededAt: v.superseded_at,
    rejectionReason: v.rejection_reason ? REJECT_REASONS[v.rejection_reason] : null,
    contentHash: v.content_hash,
    createdAt: v.created_at,
  }));
}

/** The plan's state changes from the audit log, oldest first (E-04). */
export async function timelineOf(db, planId) {
  const rows = await many(db, planEventsSql(), [planId]);
  return rows.map((e) => ({ action: e.action, at: e.created_at, actorName: e.actor_name, version: e.version_no }));
}

router.get('/:planId', async (req, res) => {
  const row = await planOr404(req.account.id, req.params.planId);
  const machines = row.capture_id ? await equipmentFor(pool, row.capture_id) : [];
  res.json({
    ...summary(row),
    areaM2: row.area_m2 === null ? null : Number(row.area_m2),
    coverage: row.coverage === null ? null : Number(row.coverage),
    overrideRecorded: Boolean(row.override_reason),
    review: row.reviewer_name
      ? {
          reviewer: { name: row.reviewer_name, initials: initialsOf(row.reviewer_name) },
          seconds: decided(row.status) ? row.review_active_seconds : null,
          note: row.reviewer_note,
        }
      : null,
    walkthroughUrl: row.ready_version === null ? null : walkthroughUrlFor(row.id),
    // Each machine and how far its 3D model has got (D-05).
    machines: machines.map((m) => ({ ref: m.equipmentId, name: m.name, type: m.type, modelStatus: m.modelStatus })),
    shareLink: await activeShareLink(pool, row.id),
    history: await historyOf(pool, row.id),
    timeline: await timelineOf(pool, row.id),
  });
});

/**
 * The newest ready version of a plan, for the 3D viewer, plus the
 * facility's other ready levels (VIEW-06). `accountId` null skips the
 * tenant check: only the share service passes it, having resolved a valid
 * token to exactly this plan.
 */
export async function modelFor(db, accountId, planId, { withLevels = true } = {}) {
  const row = await one(
    db,
    `SELECT p.id AS plan_id, p.level_number AS level, p.facility_id, f.name AS facility,
            a.name AS organisation, v.id AS version_id, v.version_no AS version, v.reviewed_at, v.capture_id,
            v.content_hash, v.plan_json, v.area_m2, r.name AS reviewer_name,
            g.status AS model_status, g.generator_version, g.glb_key, g.bytes AS model_bytes
     FROM plans p
     JOIN facilities f ON f.id = p.facility_id
     JOIN accounts a ON a.id = p.account_id
     JOIN plan_versions v ON v.ready_plan_id = p.id
     LEFT JOIN users r ON r.id = v.reviewed_by
     LEFT JOIN generated_models g ON g.plan_version_id = v.id AND g.status = 'ready'
     WHERE p.id = ?${accountId ? ' AND p.account_id = ?' : ''}
     ORDER BY g.created_at DESC LIMIT 1`,
    accountId ? [planId, accountId] : [planId],
  );
  if (!row) return null;

  const levels = withLevels
    ? await many(
        db,
        `SELECT p.id, p.level_number AS level FROM plans p
         WHERE p.facility_id = ? AND EXISTS (SELECT 1 FROM plan_versions v WHERE v.ready_plan_id = p.id)
         ORDER BY p.level_number`,
        [row.facility_id],
      )
    : [];

  return {
    planId: row.plan_id,
    site: row.facility,
    organisation: row.organisation,
    level: row.level,
    version: row.version,
    approvedAt: row.reviewed_at,
    approvedBy: row.reviewer_name,
    contentHash: row.content_hash,
    areaM2: row.area_m2 === null ? null : Number(row.area_m2),
    plan: row.plan_json,
    // The generated level (J-01, K-01). Until the generator stores a file,
    // `stored` is false and the viewer builds the 3D from `plan`. Once it
    // does, `url` is a signed link to the GLB, good until `urlExpiresAt` (M-07).
    generatedModel: row.model_status
      ? {
          generatorVersion: row.generator_version,
          stored: Boolean(row.glb_key),
          bytes: row.model_bytes === null ? null : Number(row.model_bytes),
          ...(row.glb_key ? await linkFields(row.glb_key) : { url: null, urlExpiresAt: null }),
        }
      : null,
    // The approved 3D model of each recorded machine, by its reference, for
    // the viewer to place on the plan's footprints (J-06).
    machineModels: await approvedModelsOn(db, row.capture_id),
    levels: levels.map((l) => ({ planId: l.id, level: l.level })),
  };
}

router.get('/:planId/model', async (req, res) => {
  if (!isId(req.params.planId)) throw notFound('This plan has no approved walkthrough yet.');
  const model = await modelFor(pool, req.account.id, req.params.planId);
  if (!model) throw notFound('This plan has no approved walkthrough yet.');
  res.json(model);
});

/**
 * Makes the plan's view-only link. There is one live link per plan (C-09):
 * making a new one revokes the old, which is also how an owner gets a URL
 * to copy again, since the old one's token was never kept.
 */
router.post('/:planId/share-links', async (req, res) => {
  const { expiresInDays } = z
    .object({ expiresInDays: z.number().int().min(1).max(365).optional() })
    .parse(req.body ?? {});
  const row = await planOr404(req.account.id, req.params.planId);
  if (row.ready_version === null) throw conflict('Only an approved walkthrough can be shared.');

  const link = await transaction(async (db) => {
    await one(db, 'SELECT id FROM plans WHERE id = ? FOR UPDATE', [row.id]);
    const [revoked] = await db.query(
      'UPDATE share_links SET revoked_at = UTC_TIMESTAMP(3) WHERE active_plan_id = ?',
      [row.id],
    );
    const token = newToken(18);
    const expires = expiresInDays ? new Date(Date.now() + expiresInDays * 86400000) : null;
    await db.query(
      `INSERT INTO share_links (id, account_id, plan_id, token_hash, created_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [newId(), req.account.id, row.id, sha256(token), req.user.id, expires],
    );
    await audit(db, {
      accountId: req.account.id,
      actor: { id: req.user.id },
      action: revoked.affectedRows ? 'SHARE_LINK_REPLACED' : 'SHARE_LINK_CREATED',
      target: { type: 'plan', id: row.id, label: planLabel(row.facility_name, row.level) },
    });
    return { url: shareUrlFor(token), expiresAt: expires, createdAt: new Date() };
  });
  res.status(201).json(link);
});

router.delete('/:planId/share-links', async (req, res) => {
  const row = await planOr404(req.account.id, req.params.planId);
  await transaction(async (db) => {
    const [result] = await db.query(
      `UPDATE share_links SET revoked_at = UTC_TIMESTAMP(3) WHERE active_plan_id = ? AND account_id = ?`,
      [row.id, req.account.id],
    );
    if (result.affectedRows) {
      await audit(db, {
        accountId: req.account.id,
        actor: { id: req.user.id },
        action: 'SHARE_LINK_REVOKED',
        target: { type: 'plan', id: row.id, label: planLabel(row.facility_name, row.level) },
      });
    }
  });
  res.status(204).end();
});
