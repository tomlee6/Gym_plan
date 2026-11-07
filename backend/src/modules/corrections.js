/**
 * Corrections from site (migration 007): an installer (or the owner) finds
 * that the approved plan and the room differ, corrects the plan on a
 * tablet, and sends it with a note saying what was wrong.
 *
 *   POST /v1/plans/:planId/corrections   { basedOnVersionId, plan, note }
 *
 * The correction becomes the plan's next version, waiting in the reviewer
 * queue like a new scan. Nothing changes for anyone until a reviewer
 * approves it: the approved version stays the live plan and walkthrough,
 * and is superseded only when the corrected one is approved and built. A
 * rejected correction leaves it as it was.
 *
 * The note travels as an open flag on the plan, so it cannot be approved
 * until a reviewer has looked at what the installer said. Like a reviewer's
 * revision, a correction does not count against the monthly quota.
 */
import { Router } from 'express';
import { z } from 'zod';

import { approvalBlockers, newElementId, withMeasurements } from '../../../shared/plan/index.js';
import { audit, planLabel } from '../audit.js';
import { one, pool, transaction } from '../db/pool.js';
import { conflict, notFound } from '../errors.js';
import { isId, newId } from '../ids.js';
import { requireAccount, requireAuth } from '../middleware/auth.js';
import { planReadyForReview } from '../notify.js';
import { planBody } from './review.js';

export const router = Router();
router.use(requireAuth, requireAccount('owner', 'installer'));

const body = z.object({
  basedOnVersionId: z.string().refine(isId, 'Unknown version.'),
  plan: planBody,
  note: z.string().trim().min(5, 'Say what was wrong, in a few words.').max(1000),
});

router.post('/:planId/corrections', async (req, res) => {
  if (!isId(req.params.planId)) throw notFound('This plan does not exist.');
  const b = body.parse(req.body);

  const created = await transaction(async (db) => {
    const plan = await one(
      db,
      `SELECT p.id, p.level_number AS level, f.name AS facility
         FROM plans p JOIN facilities f ON f.id = p.facility_id
        WHERE p.id = ? AND p.account_id = ? FOR UPDATE`,
      [req.params.planId, req.account.id],
    );
    if (!plan) throw notFound('This plan does not exist.');

    const ready = await one(db, `SELECT * FROM plan_versions WHERE plan_id = ? AND status = 'ready' FOR UPDATE`, [plan.id]);
    if (!ready) throw conflict('Only an approved plan can be corrected.');
    if (ready.id !== b.basedOnVersionId) {
      throw conflict('The plan has been updated since you opened it. Open it again and make the correction on the latest version.');
    }
    // One waiting at a time. A version sent back (recapture) is decided and
    // does not block; the new one is still numbered after it.
    const newer = await one(
      db,
      `SELECT version_no, origin FROM plan_versions
        WHERE plan_id = ? AND version_no > ? AND status <> 'recapture'
        ORDER BY version_no DESC LIMIT 1`,
      [plan.id, ready.version_no],
    );
    if (newer) {
      throw conflict(
        `Version ${newer.version_no} of this plan is already waiting for review${newer.origin === 'correction' ? ' (a correction from site)' : ''}. Send yours once it is decided.`,
      );
    }

    // Measurements are worked out here, never taken from the client.
    const corrected = withMeasurements(b.plan);
    corrected.flags = [
      ...(corrected.flags ?? []).filter((f) => f.status === 'open'),
      {
        id: newElementId('f'),
        kind: 'site_correction',
        elementId: null,
        title: 'Correction from site',
        detail: b.note,
        status: 'open',
      },
    ];

    const { last } = await one(db, 'SELECT MAX(version_no) AS last FROM plan_versions WHERE plan_id = ?', [plan.id]);
    const versionNo = Number(last) + 1;
    const id = newId();
    await db.query(
      `INSERT INTO plan_versions
         (id, account_id, plan_id, version_no, status, capture_id, origin, based_on_version_id,
          submitted_at, plan_json, plan_saved_at, plan_saved_by, correction_note, corrected_by)
       VALUES (?, ?, ?, ?, 'processing', ?, 'correction', ?, UTC_TIMESTAMP(3), ?, UTC_TIMESTAMP(3), ?, ?, ?)`,
      [id, req.account.id, plan.id, versionNo, ready.capture_id, ready.id, JSON.stringify(corrected), req.user.id, b.note, req.user.id],
    );
    const label = planLabel(plan.facility, plan.level);
    await audit(db, {
      accountId: req.account.id,
      actor: { id: req.user.id },
      action: 'CORRECTION_SUBMITTED',
      target: { type: 'plan', id: plan.id, label },
      version: versionNo,
      detail: { from: ready.version_no, role: req.account.role },
    });
    return { id, version: versionNo, label, blockers: approvalBlockers(corrected) };
  });

  await planReadyForReview(pool, { label: `${created.label} (correction from site)`, versionId: created.id });
  res.status(201).json({ id: created.id, version: created.version });
});
