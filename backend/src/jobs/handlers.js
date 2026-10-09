/**
 * What each kind of background job does. Imported once by the API and the
 * worker, which registers every handler.
 *
 *   scan.read, drawing.read  plan reading for a received capture (E-03)
 *   plan.generate            the 3D level for an approved version (D-04)
 *   account.remove           an account's rows and stored objects (E-06)
 *   retention                raw files to cold storage after approval (E-05)
 *
 * asset.build (machine models) belongs to the 3D team and registers itself
 * the same way.
 *
 * Every handler may run more than once for the same job — after a crash, or
 * a duplicate queue delivery — so each checks the state it expects first
 * and does nothing when the work is already done.
 */
import { emptyPlan, summary } from '../../../shared/plan/index.js';
import { audit, planLabel } from '../audit.js';
import { config } from '../config.js';
import { many, one, pool, transaction } from '../db/pool.js';
import { newId } from '../ids.js';
import { planReadyForReview, walkthroughReady } from '../notify.js';
import { readCapturePlan, unreadableFlag } from '../reading.js';
import { storage } from '../storage/index.js';
import { enqueue, PermanentJobError, registerHandler } from './index.js';

async function versionFor(db, id, { lock = false } = {}) {
  return one(
    db,
    `SELECT v.*, p.level_number AS level, f.name AS facility
     FROM plan_versions v JOIN plans p ON p.id = v.plan_id JOIN facilities f ON f.id = p.facility_id
     WHERE v.id = ?${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
}

const planTarget = (v) => ({ type: 'plan', id: v.plan_id, label: planLabel(v.facility, v.level) });

/* ------------------------------------------------------------------ */
/* Plan reading (E-03).                                                 */

/** Stores a read plan on a version that is still waiting for one. */
async function storePlan(v, plan, { action, detail, scaleResidualMm = null }) {
  const stored = await transaction(async (db) => {
    const [res] = await db.query(
      `UPDATE plan_versions SET plan_json = ? WHERE id = ? AND status = 'processing' AND plan_json IS NULL`,
      [JSON.stringify(plan), v.id],
    );
    if (!res.affectedRows) return false;
    if (scaleResidualMm !== null) {
      await db.query('UPDATE captures SET scale_residual_mm = ? WHERE id = ?', [scaleResidualMm, v.capture_id]);
    }
    await audit(db, { accountId: v.account_id, actor: null, action, target: planTarget(v), version: v.version_no, detail });
    return true;
  });
  if (stored) {
    await planReadyForReview(pool, { label: planLabel(v.facility, v.level), versionId: v.id });
  }
}

const readPlanJob = {
  async run(job) {
    const v = await versionFor(pool, job.subject_id);
    if (!v || v.status !== 'processing' || v.plan_json || !v.capture_id) return;
    const { plan, scaleResidualMm } = await readCapturePlan(pool, v.capture_id);
    const facts = summary(plan);
    await storePlan(v, plan, {
      action: 'PLAN_PRODUCED',
      detail: { walls: facts.walls, flags: facts.openFlags },
      scaleResidualMm,
    });
  },

  /**
   * Reading failed past its retries (E-02, RDR-08): the version goes to the
   * reviewer queue anyway, with an empty plan and a flag saying why, so a
   * person can trace it or send it back. Nothing is lost silently.
   */
  async onDead(job, err) {
    const v = await versionFor(pool, job.subject_id);
    if (!v || v.status !== 'processing' || v.plan_json) return;
    const plan = emptyPlan({ scale: { source: v.capture_id ? 'scan' : 'drawn' } });
    plan.flags.push(
      unreadableFlag(
        `Plan reading failed after ${job.attempts} attempts: ${String(err?.message ?? err).slice(0, 300)}. ` +
          'Trace the plan from the photos or the drawing, or reject it as an unreadable source.',
      ),
    );
    await storePlan(v, plan, { action: 'READING_FAILED', detail: { error: String(err?.message ?? err).slice(0, 500) } });
  },
};

registerHandler('scan.read', readPlanJob);
registerHandler('drawing.read', readPlanJob);

/* ------------------------------------------------------------------ */
/* 3D generation (D-04).                                                */

/**
 * The generator: `(version) -> { glbKey, bytes, triangleCount }`. The 3D
 * team's worker (J-01) replaces it with `setGenerator`. Until then the
 * placeholder stores no file and the viewer builds the level in the
 * browser from the approved plan, as it always has.
 */
let generator = async () => {
  if (config.generator.driver !== 'placeholder') {
    throw new PermanentJobError(`No 3D generator is installed for GENERATOR_DRIVER=${config.generator.driver}.`);
  }
  return { glbKey: null, bytes: null, triangleCount: null };
};

export function setGenerator(fn) {
  generator = fn;
}

registerHandler('plan.generate', {
  async run(job) {
    const v = await versionFor(pool, job.subject_id);
    if (!v || v.status !== 'generating') return;
    const version = config.generator.version;
    await pool.query(
      `INSERT INTO generated_models (id, account_id, plan_version_id, generator_version, content_hash, status)
       VALUES (?, ?, ?, ?, ?, 'building') AS fresh
       ON DUPLICATE KEY UPDATE status = 'building', failure_reason = NULL, content_hash = fresh.content_hash`,
      [newId(), v.account_id, v.id, version, v.content_hash],
    );

    const out = await generator(v);

    const done = await transaction(async (db) => {
      const locked = await versionFor(db, v.id, { lock: true });
      if (locked.status !== 'generating') return false;
      await db.query(
        `UPDATE generated_models
         SET status = 'ready', glb_key = ?, bytes = ?, triangle_count = ?, finished_at = UTC_TIMESTAMP(3)
         WHERE plan_version_id = ? AND generator_version = ?`,
        [out.glbKey ?? null, out.bytes ?? null, out.triangleCount ?? null, v.id, version],
      );
      // Earlier ready (and failed) versions are superseded, never edited
      // (REV-09) — before this one becomes ready, as only one may be.
      const older = await many(
        db,
        `SELECT id, version_no FROM plan_versions
         WHERE plan_id = ? AND status IN ('ready', 'generation_failed') AND version_no < ? FOR UPDATE`,
        [v.plan_id, v.version_no],
      );
      for (const o of older) {
        await db.query(
          `UPDATE plan_versions SET status = 'superseded', superseded_at = UTC_TIMESTAMP(3) WHERE id = ?`,
          [o.id],
        );
        await audit(db, {
          accountId: v.account_id,
          actor: null,
          action: 'SUPERSEDED',
          target: planTarget(v),
          version: o.version_no,
          detail: { by: v.version_no },
        });
      }
      await db.query(`UPDATE plan_versions SET status = 'ready' WHERE id = ?`, [v.id]);
      await audit(db, {
        accountId: v.account_id,
        actor: null,
        action: 'GENERATED',
        target: planTarget(v),
        version: v.version_no,
        detail: { generatorVersion: version, stored: Boolean(out.glbKey) },
      });
      return true;
    });

    if (done) {
      await walkthroughReady(pool, { accountId: v.account_id, label: planLabel(v.facility, v.level), planId: v.plan_id });
    }
  },

  /** GEN-05: a generation that keeps failing goes back to the reviewer queue. */
  async onDead(job, err) {
    const reason = String(err?.message ?? err).slice(0, 500);
    await transaction(async (db) => {
      const v = await versionFor(db, job.subject_id, { lock: true });
      if (!v || v.status !== 'generating') return;
      await db.query(
        `UPDATE generated_models SET status = 'failed', failure_reason = ?, finished_at = UTC_TIMESTAMP(3)
         WHERE plan_version_id = ? AND generator_version = ?`,
        [reason, v.id, config.generator.version],
      );
      await db.query(`UPDATE plan_versions SET status = 'generation_failed' WHERE id = ?`, [v.id]);
      await audit(db, {
        accountId: v.account_id,
        actor: null,
        action: 'GENERATION_FAILED',
        target: planTarget(v),
        version: v.version_no,
        detail: { reason },
      });
    });
  },
});

/* ------------------------------------------------------------------ */
/* Account removal (ACC-07, E-06).                                      */

/**
 * Removes an account's data. Stored objects go first — scans, frames,
 * videos, generated levels and machine models — then the rows, in an order
 * that never leaves a child row pointing at a deleted parent (A-05: the old
 * removal deleted captures while machines and videos still referenced
 * them). A failure anywhere retries the whole job; deleting an object that
 * is already gone is not an error, so the retry picks up where it stopped.
 * The audit log is kept, with identifiers only.
 */
async function removeAccount(job) {
  const accountId = job.subject_id;
  const account = await one(pool, 'SELECT * FROM accounts WHERE id = ?', [accountId]);
  if (!account || account.removed_at) return;

  const keys = [
    ...(await many(
      pool,
      `SELECT cf.storage_key AS k, cf.upload_id, cf.status FROM capture_files cf
       JOIN captures c ON c.id = cf.capture_id WHERE c.account_id = ?`,
      [accountId],
    )),
    ...(await many(pool, `SELECT glb_key AS k FROM generated_models WHERE account_id = ? AND glb_key IS NOT NULL`, [accountId])),
    ...(await many(pool, `SELECT glb_key AS k FROM machine_models WHERE account_id = ? AND glb_key IS NOT NULL`, [accountId])),
  ];
  for (const f of keys) {
    if (f.status === 'uploading') await storage().abort(f.k, f.upload_id);
    else await storage().delete(f.k);
  }

  const tally = await transaction(async (db) => {
    const count = async (sql) => Number((await one(db, sql, [accountId])).n);
    const removed = {
      plans: await count('SELECT COUNT(*) AS n FROM plans WHERE account_id = ?'),
      versions: await count('SELECT COUNT(*) AS n FROM plan_versions WHERE account_id = ?'),
      captures: await count('SELECT COUNT(*) AS n FROM captures WHERE account_id = ?'),
      machines: await count('SELECT COUNT(*) AS n FROM machines WHERE account_id = ?'),
      files: keys.length,
      members: await count('SELECT COUNT(*) AS n FROM memberships WHERE account_id = ?'),
    };
    // People whose only access was this account go with it.
    const leaving = await many(
      db,
      `SELECT u.id FROM users u JOIN memberships m ON m.user_id = u.id AND m.account_id = ?
       WHERE u.staff_role IS NULL
         AND NOT EXISTS (SELECT 1 FROM memberships o WHERE o.user_id = u.id AND o.account_id <> ?)`,
      [accountId, accountId],
    );
    removed.users = leaving.length;

    const del = (sql) => db.query(sql, [accountId]);
    await del('DELETE FROM share_links WHERE account_id = ?');
    await del('DELETE FROM generated_models WHERE account_id = ?');
    await del('DELETE FROM machine_models WHERE account_id = ?');
    // Machines and their videos before the captures and files they point at.
    await del('DELETE mv FROM machine_videos mv JOIN machines m ON m.id = mv.machine_id WHERE m.account_id = ?');
    await del('UPDATE machines SET same_as_machine_id = NULL WHERE account_id = ?');
    await del('DELETE FROM machines WHERE account_id = ?');
    await del('UPDATE plan_versions SET based_on_version_id = NULL WHERE account_id = ?');
    await del('DELETE FROM plan_versions WHERE account_id = ?');
    await del('DELETE cf FROM capture_files cf JOIN captures c ON c.id = cf.capture_id WHERE c.account_id = ?');
    // Tags, control distances and drawing details cascade with the capture.
    await del('DELETE FROM captures WHERE account_id = ?');
    await del('DELETE FROM plans WHERE account_id = ?');
    await del('DELETE FROM facilities WHERE account_id = ?');
    await del('DELETE FROM equipment_types WHERE account_id = ?');
    await del('DELETE FROM invites WHERE account_id = ?');
    await del('DELETE FROM memberships WHERE account_id = ?');
    if (leaving.length) await db.query('DELETE FROM users WHERE id IN (?)', [leaving.map((u) => u.id)]);
    await del(`UPDATE jobs SET payload = NULL WHERE account_id = ? AND status <> 'running'`);
    // The log keeps identifiers only: readable labels and names go.
    await del('UPDATE audit_log SET target_label = NULL, actor_name = NULL, detail = NULL WHERE account_id = ?');
    await db.query(
      `UPDATE accounts SET name = ?, status = 'removed', removed_at = UTC_TIMESTAMP(3) WHERE id = ?`,
      [`Removed account ${accountId}`, accountId],
    );
    await audit(db, {
      accountId,
      actor: job.payload?.actorId ? { id: job.payload.actorId } : null,
      action: 'ACCOUNT_DATA_REMOVED',
      target: { type: 'account', id: accountId, label: null },
      detail: removed,
    });
    return removed;
  });
  return tally;
}

registerHandler('account.remove', { run: removeAccount });

/* ------------------------------------------------------------------ */
/* Retention (E-05).                                                    */

/** The raw capture files that go cold; drawings, thumbnails and the plan stay hot. */
const COLD_KINDS = ['model', 'room', 'mesh', 'keyframes', 'photo', 'video', 'frames'];
const RETENTION_BATCH = 500;

registerHandler('retention', {
  async run() {
    const files = await many(
      pool,
      `SELECT DISTINCT cf.id, cf.storage_key FROM capture_files cf
       JOIN plan_versions v ON v.capture_id = cf.capture_id
       WHERE cf.status = 'stored' AND cf.archived_at IS NULL AND cf.kind IN (?)
         AND v.status IN ('ready', 'superseded')
         AND v.reviewed_at < UTC_TIMESTAMP(3) - INTERVAL ? DAY
       LIMIT ?`,
      [COLD_KINDS, config.jobs.retentionDays, RETENTION_BATCH],
    );
    for (const f of files) {
      await storage().archive(f.storage_key);
      await pool.query('UPDATE capture_files SET archived_at = UTC_TIMESTAMP(3) WHERE id = ?', [f.id]);
    }
    // A full batch means there is more: carry on in a fresh job.
    if (files.length === RETENTION_BATCH) {
      await enqueue(pool, { kind: 'retention', subjectId: newId(), dedupeKey: `more:${files.at(-1).id}` });
    }
  },
});

/** Today's retention sweep, queued once a day by the worker. */
export function queueDailyRetention(db = pool, day = new Date().toISOString().slice(0, 10)) {
  return enqueue(db, { kind: 'retention', subjectId: newId(), dedupeKey: `day:${day}` });
}
