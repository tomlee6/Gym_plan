/**
 * Plans service: the owner's status view (ACC-03), each plan's history,
 * the walkthrough model, and share links.
 *
 *   GET    /v1/plans                    each plan at its newest version
 *   GET    /v1/plans/:id                detail, history, share link
 *   GET    /v1/plans/:id/model          newest approved plan, for the viewer
 *   POST   /v1/plans/:id/share-links    view-only link (VIEW-07), reused
 *   DELETE /v1/plans/:id/share-links    revoke it
 *
 * Timestamps go out raw (ISO 8601, UTC); clients format them locally.
 */
import { Router } from 'express';
import { z } from 'zod';

import { audit, planLabel } from '../audit.js';
import { config } from '../config.js';
import { many, one, pool, transaction } from '../db/pool.js';
import { conflict, notFound } from '../errors.js';
import { newId, newToken } from '../ids.js';
import { requireAuth } from '../middleware/auth.js';
import { initialsOf } from './auth.js';

export const router = Router();
router.use(requireAuth);

/** Each plan joined to its newest version, and when it last had an approved one. */
const LATEST = `
  SELECT p.id, p.level, p.facility_id, f.name AS facility_name,
         v.id AS version_id, v.version, v.status, v.input_type, v.submitted_at, v.coverage,
         v.override_reason, v.area_m2, v.review_started_at, v.reviewed_at,
         v.review_seconds, v.rejection_reason, v.reviewer_note,
         v.updated_at, r.name AS reviewer_name,
         (SELECT MAX(rv.version) FROM plan_versions rv
           WHERE rv.plan_id = p.id AND rv.status = 'ready') AS ready_version
  FROM plans p
  JOIN facilities f ON f.id = p.facility_id
  JOIN plan_versions v ON v.plan_id = p.id
   AND v.version = (SELECT MAX(version) FROM plan_versions WHERE plan_id = p.id)
  LEFT JOIN users r ON r.id = v.reviewed_by
  WHERE p.org_id = ?`;

export function walkthroughUrlFor(planId) {
  return `${config.publicWebUrl}/plans/${planId}/walkthrough`;
}

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
    rejectionReason: row.rejection_reason,
    updatedAt: row.updated_at,
    // The walkthrough follows the newest approved version, even while a
    // later version is in review (GEN-06).
    walkthroughVersion: row.ready_version === null ? null : Number(row.ready_version),
  };
}

router.get('/', async (req, res) => {
  const { limit } = z
    .object({ limit: z.coerce.number().int().min(1).max(200).default(100) })
    .parse(req.query);
  const rows = await many(pool, `${LATEST} ORDER BY v.updated_at DESC LIMIT ?`, [
    req.user.orgId,
    limit,
  ]);
  res.json({ plans: rows.map(summary) });
});

async function planOr404(orgId, planId) {
  const row = await one(pool, `${LATEST} AND p.id = ?`, [orgId, planId]);
  if (!row) throw notFound('This plan does not exist.');
  return row;
}

async function activeShareLink(db, planId) {
  const link = await one(
    db,
    `SELECT token, expires_at, created_at FROM share_links
     WHERE plan_id = ? AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP(3))
     ORDER BY created_at DESC LIMIT 1`,
    [planId],
  );
  return link
    ? { url: `${config.publicWebUrl}/s/${link.token}`, expiresAt: link.expires_at, createdAt: link.created_at }
    : null;
}

/** Every version of a plan, newest first, with who did what and when (REV-09). */
export async function historyOf(db, planId) {
  const rows = await many(
    db,
    `SELECT v.id, v.version, v.status, v.origin, v.input_type, v.submitted_at, v.reviewed_at,
            v.superseded_at, v.rejection_reason, v.content_hash, v.created_at,
            r.name AS reviewer_name, c.user_id, u.name AS submitted_by
     FROM plan_versions v
     LEFT JOIN users r ON r.id = v.reviewed_by
     LEFT JOIN captures c ON c.id = v.capture_id
     LEFT JOIN users u ON u.id = c.user_id
     WHERE v.plan_id = ?
     ORDER BY v.version DESC`,
    [planId],
  );
  return rows.map((v) => ({
    id: v.id,
    version: v.version,
    status: v.status,
    origin: v.origin,
    inputType: v.input_type,
    submittedBy: v.submitted_by,
    submittedAt: v.submitted_at,
    reviewerName: v.reviewer_name,
    reviewedAt: v.reviewed_at,
    supersededAt: v.superseded_at,
    rejectionReason: v.rejection_reason,
    contentHash: v.content_hash,
    createdAt: v.created_at,
  }));
}

router.get('/:planId', async (req, res) => {
  const row = await planOr404(req.user.orgId, req.params.planId);
  res.json({
    ...summary(row),
    areaM2: row.area_m2 === null ? null : Number(row.area_m2),
    coverage: row.coverage === null ? null : Number(row.coverage),
    overrideRecorded: Boolean(row.override_reason),
    review: row.reviewer_name
      ? {
          reviewer: { name: row.reviewer_name, initials: initialsOf(row.reviewer_name) },
          seconds: row.review_seconds,
          note: row.reviewer_note,
        }
      : null,
    walkthroughUrl: row.ready_version === null ? null : walkthroughUrlFor(row.id),
    shareLink: await activeShareLink(pool, row.id),
    history: await historyOf(pool, row.id),
  });
});

/**
 * The newest approved version of a plan, ready for the 3D viewer, plus the
 * facility's other approved levels (VIEW-06). `orgId` null skips the tenant
 * check: only the share service passes it, having resolved a valid token.
 */
export async function modelFor(db, orgId, planId, { withLevels = true } = {}) {
  const row = await one(
    db,
    `SELECT p.id AS plan_id, p.level, p.facility_id, p.org_id, f.name AS facility,
            o.name AS organisation, v.version, v.reviewed_at, v.content_hash, v.plan_json,
            v.area_m2, r.name AS reviewer_name
     FROM plans p
     JOIN facilities f ON f.id = p.facility_id
     JOIN organisations o ON o.id = p.org_id
     JOIN plan_versions v ON v.plan_id = p.id AND v.status = 'ready'
      AND v.version = (SELECT MAX(version) FROM plan_versions
                       WHERE plan_id = p.id AND status = 'ready')
     LEFT JOIN users r ON r.id = v.reviewed_by
     WHERE p.id = ?${orgId ? ' AND p.org_id = ?' : ''}`,
    orgId ? [planId, orgId] : [planId],
  );
  if (!row) return null;

  const levels = withLevels
    ? await many(
        db,
        `SELECT p.id, p.level FROM plans p
         WHERE p.facility_id = ? AND EXISTS
           (SELECT 1 FROM plan_versions v WHERE v.plan_id = p.id AND v.status = 'ready')
         ORDER BY p.level`,
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
    levels: levels.map((l) => ({ planId: l.id, level: l.level })),
  };
}

router.get('/:planId/model', async (req, res) => {
  const model = await modelFor(pool, req.user.orgId, req.params.planId);
  if (!model) throw notFound('This plan has no approved walkthrough yet.');
  res.json(model);
});

router.post('/:planId/share-links', async (req, res) => {
  const { expiresInDays } = z
    .object({ expiresInDays: z.number().int().min(1).max(365).optional() })
    .parse(req.body ?? {});
  const row = await planOr404(req.user.orgId, req.params.planId);
  if (row.ready_version === null) {
    throw conflict('Only an approved walkthrough can be shared.');
  }

  const result = await transaction(async (db) => {
    // Serialise per plan so two clicks make one link.
    await one(db, 'SELECT id FROM plans WHERE id = ? FOR UPDATE', [row.id]);
    const existing = await activeShareLink(db, row.id);
    if (existing) return { status: 200, body: existing };

    const token = newToken(18);
    const expires = expiresInDays ? new Date(Date.now() + expiresInDays * 86400000) : null;
    await db.query(
      `INSERT INTO share_links (id, org_id, plan_id, token, created_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [newId('sl'), req.user.orgId, row.id, token, req.user.id, expires],
    );
    await audit(db, {
      orgId: req.user.orgId,
      actor: { id: req.user.id },
      action: 'SHARE_LINK_CREATED',
      target: { type: 'plan', id: row.id, label: planLabel(row.facility_name, row.level) },
    });
    return {
      status: 201,
      body: { url: `${config.publicWebUrl}/s/${token}`, expiresAt: expires, createdAt: new Date() },
    };
  });
  res.status(result.status).json(result.body);
});

router.delete('/:planId/share-links', async (req, res) => {
  const row = await planOr404(req.user.orgId, req.params.planId);
  await transaction(async (db) => {
    const [result] = await db.query(
      `UPDATE share_links SET revoked_at = UTC_TIMESTAMP(3)
       WHERE plan_id = ? AND org_id = ? AND revoked_at IS NULL`,
      [row.id, req.user.orgId],
    );
    if (result.affectedRows) {
      await audit(db, {
        orgId: req.user.orgId,
        actor: { id: req.user.id },
        action: 'SHARE_LINK_REVOKED',
        target: { type: 'plan', id: row.id, label: planLabel(row.facility_name, row.level) },
      });
    }
  });
  res.status(204).end();
});
