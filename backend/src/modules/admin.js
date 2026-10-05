/**
 * Admin service: Next XR platform operations (PRD section 3, ACC-05..07).
 *
 *   GET    /v1/admin/accounts                          every account, users, quota use
 *   POST   /v1/admin/accounts                          create one, with its first owner
 *   GET    /v1/admin/accounts/:id                      users and facilities
 *   PATCH  /v1/admin/accounts/:id                      rename, set the monthly quota
 *   POST   /v1/admin/accounts/:id/users                add a user
 *   DELETE /v1/admin/accounts/:id/users/:userId        remove (deactivate) a user
 *   POST   /v1/admin/accounts/:id/facilities           add a gym
 *   POST   /v1/admin/accounts/:id/removal              remove the account's data
 *   GET    /v1/admin/audit                             the audit log, newest first
 *   GET    /v1/admin/audit.csv                         the same, as CSV
 *   GET    /v1/admin/reviewers                         weekly median review time
 */
import { Router } from 'express';
import { z } from 'zod';

import { audit } from '../audit.js';
import { many, one, pool, transaction } from '../db/pool.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { newId } from '../ids.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { storage } from '../storage/index.js';
import { hashPassword } from './auth.js';
import { plansUsedThisMonth } from './profile.js';
import { median } from './review.js';

export const router = Router();
router.use(requireAuth, requireRole('admin'));

const ROLE_LABELS = {
  owner: 'Owner & Surveyor',
  surveyor: 'Surveyor',
  reviewer: 'Reviewer',
  admin: 'Platform admin',
};

const newUser = z.object({
  name: z.string().trim().min(2).max(200),
  email: z.email().max(254).transform((e) => e.toLowerCase()),
  role: z.enum(['owner', 'surveyor', 'reviewer', 'admin']).default('owner'),
  password: z.string().min(8, 'Passwords need at least 8 characters.').max(200),
});

const actor = (req) => ({ id: req.user.id });

async function accountOr404(db, id, { lock = false } = {}) {
  const org = await one(db, `SELECT * FROM organisations WHERE id = ?${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!org) throw notFound('This account does not exist.');
  return org;
}

async function accountSummary(db, org) {
  const counts = await one(
    db,
    `SELECT (SELECT COUNT(*) FROM users WHERE org_id = ? AND active = 1) AS users,
            (SELECT COUNT(*) FROM facilities WHERE org_id = ?) AS facilities,
            (SELECT COUNT(*) FROM users WHERE org_id = ? AND role IN ('reviewer', 'admin')) AS staff`,
    [org.id, org.id, org.id],
  );
  return {
    id: org.id,
    name: org.name,
    region: org.region,
    planQuota: org.plan_quota,
    plansUsed: await plansUsedThisMonth(db, org.id),
    users: Number(counts.users),
    facilities: Number(counts.facilities),
    // The operator's own account holds reviewers and admins, not gyms.
    operator: Number(counts.staff) > 0,
    createdAt: org.created_at,
    dataRemovedAt: org.data_removed_at,
  };
}

router.get('/accounts', async (_req, res) => {
  const orgs = await many(pool, 'SELECT * FROM organisations ORDER BY name');
  res.json({ accounts: await Promise.all(orgs.map((o) => accountSummary(pool, o))) });
});

async function insertUser(db, orgId, u) {
  if (await one(db, 'SELECT id FROM users WHERE email = ?', [u.email])) {
    throw conflict(`${u.email} already has an account.`);
  }
  const id = newId('usr');
  await db.query(
    `INSERT INTO users (id, org_id, email, password_hash, name, role, role_label)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, orgId, u.email, await hashPassword(u.password), u.name, u.role, ROLE_LABELS[u.role]],
  );
  return id;
}

router.post('/accounts', async (req, res) => {
  const body = z
    .object({
      name: z.string().trim().min(2).max(200),
      planQuota: z.number().int().min(0).max(10000),
      region: z.string().trim().min(2).max(100).default('Australia (Sydney)'),
      owner: newUser,
    })
    .parse(req.body);

  const id = await transaction(async (db) => {
    const orgId = newId('org');
    await db.query('INSERT INTO organisations (id, name, plan_quota, region) VALUES (?, ?, ?, ?)', [
      orgId,
      body.name,
      body.planQuota,
      body.region,
    ]);
    const userId = await insertUser(db, orgId, { ...body.owner, role: 'owner' });
    await audit(db, {
      orgId,
      actor: actor(req),
      action: 'ACCOUNT_CREATED',
      target: { type: 'account', id: orgId, label: body.name },
      detail: { planQuota: body.planQuota },
    });
    await audit(db, {
      orgId,
      actor: actor(req),
      action: 'USER_ADDED',
      target: { type: 'user', id: userId, label: `${body.owner.name} <${body.owner.email}>` },
      detail: { role: 'owner' },
    });
    return orgId;
  });
  res.status(201).json(await accountSummary(pool, await accountOr404(pool, id)));
});

router.get('/accounts/:id', async (req, res) => {
  const org = await accountOr404(pool, req.params.id);
  const users = await many(
    pool,
    `SELECT id, name, email, role, role_label, active, created_at FROM users
     WHERE org_id = ? ORDER BY active DESC, name`,
    [org.id],
  );
  const facilities = await many(
    pool,
    `SELECT f.id, f.name, f.created_at, COUNT(p.id) AS levels
     FROM facilities f LEFT JOIN plans p ON p.facility_id = f.id
     WHERE f.org_id = ? GROUP BY f.id ORDER BY f.name`,
    [org.id],
  );
  res.json({
    ...(await accountSummary(pool, org)),
    users: users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      roleLabel: u.role_label,
      active: Boolean(u.active),
      createdAt: u.created_at,
    })),
    facilities: facilities.map((f) => ({ id: f.id, name: f.name, levels: Number(f.levels), createdAt: f.created_at })),
  });
});

router.patch('/accounts/:id', async (req, res) => {
  const body = z
    .object({
      name: z.string().trim().min(2).max(200).optional(),
      planQuota: z.number().int().min(0).max(10000).optional(),
    })
    .strict()
    .parse(req.body);

  await transaction(async (db) => {
    const org = await accountOr404(db, req.params.id, { lock: true });
    if (org.data_removed_at) throw conflict('This account’s data has been removed.');
    if (body.name !== undefined && body.name !== org.name) {
      await db.query('UPDATE organisations SET name = ? WHERE id = ?', [body.name, org.id]);
      await audit(db, {
        orgId: org.id,
        actor: actor(req),
        action: 'ACCOUNT_RENAMED',
        target: { type: 'account', id: org.id, label: body.name },
        detail: { from: org.name },
      });
    }
    if (body.planQuota !== undefined && body.planQuota !== org.plan_quota) {
      await db.query('UPDATE organisations SET plan_quota = ? WHERE id = ?', [body.planQuota, org.id]);
      await audit(db, {
        orgId: org.id,
        actor: actor(req),
        action: 'QUOTA_CHANGED',
        target: { type: 'account', id: org.id, label: body.name ?? org.name },
        detail: { from: org.plan_quota, to: body.planQuota },
      });
    }
  });
  res.json(await accountSummary(pool, await accountOr404(pool, req.params.id)));
});

router.post('/accounts/:id/users', async (req, res) => {
  const body = newUser.parse(req.body);
  const userId = await transaction(async (db) => {
    const org = await accountOr404(db, req.params.id, { lock: true });
    if (org.data_removed_at) throw conflict('This account’s data has been removed.');
    const id = await insertUser(db, org.id, body);
    await audit(db, {
      orgId: org.id,
      actor: actor(req),
      action: 'USER_ADDED',
      target: { type: 'user', id, label: `${body.name} <${body.email}>` },
      detail: { role: body.role },
    });
    return id;
  });
  res.status(201).json({ id: userId });
});

router.delete('/accounts/:id/users/:userId', async (req, res) => {
  await transaction(async (db) => {
    const user = await one(db, 'SELECT * FROM users WHERE id = ? AND org_id = ? FOR UPDATE', [
      req.params.userId,
      req.params.id,
    ]);
    if (!user) throw notFound('This user does not exist.');
    if (user.id === req.user.id) throw badRequest('You cannot remove yourself.');
    if (!user.active) return;
    // Deactivated rather than deleted: approvals and captures stay attributable.
    await db.query('UPDATE users SET active = 0 WHERE id = ?', [user.id]);
    await db.query(
      'UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL',
      [user.id],
    );
    await audit(db, {
      orgId: user.org_id,
      actor: actor(req),
      action: 'USER_REMOVED',
      target: { type: 'user', id: user.id, label: `${user.name} <${user.email}>` },
    });
  });
  res.status(204).end();
});

router.post('/accounts/:id/facilities', async (req, res) => {
  const { name } = z.object({ name: z.string().trim().min(2).max(200) }).parse(req.body);
  const id = await transaction(async (db) => {
    const org = await accountOr404(db, req.params.id, { lock: true });
    if (org.data_removed_at) throw conflict('This account’s data has been removed.');
    if (await one(db, 'SELECT id FROM facilities WHERE org_id = ? AND name = ?', [org.id, name])) {
      throw conflict(`${name} already exists in this account.`);
    }
    const facilityId = newId('fac');
    await db.query('INSERT INTO facilities (id, org_id, name) VALUES (?, ?, ?)', [facilityId, org.id, name]);
    await audit(db, {
      orgId: org.id,
      actor: actor(req),
      action: 'FACILITY_ADDED',
      target: { type: 'facility', id: facilityId, label: name },
    });
    return facilityId;
  });
  res.status(201).json({ id });
});

/**
 * ACC-07: plans, scans, models and files are deleted; users are removed;
 * the audit log is kept with identifiers only. The admin types the account
 * name to confirm.
 */
router.post('/accounts/:id/removal', async (req, res) => {
  const { confirmName } = z.object({ confirmName: z.string() }).parse(req.body);
  const org = await accountOr404(pool, req.params.id);
  if (org.data_removed_at) throw conflict('This account’s data has already been removed.');
  if (confirmName.trim() !== org.name) throw badRequest('Type the account name exactly to confirm.');
  const staff = await one(
    pool,
    `SELECT COUNT(*) AS n FROM users WHERE org_id = ? AND role IN ('reviewer', 'admin')`,
    [org.id],
  );
  if (Number(staff.n) > 0) throw badRequest('The operator account cannot be removed.');

  const files = await many(
    pool,
    `SELECT cf.storage_key FROM capture_files cf JOIN captures c ON c.id = cf.capture_id WHERE c.org_id = ?`,
    [org.id],
  );

  const removed = await transaction(async (db) => {
    const locked = await accountOr404(db, org.id, { lock: true });
    if (locked.data_removed_at) throw conflict('This account’s data has already been removed.');
    const count = async (sql) => Number((await one(db, sql, [org.id])).n);
    const tally = {
      plans: await count('SELECT COUNT(*) AS n FROM plans WHERE org_id = ?'),
      versions: await count('SELECT COUNT(*) AS n FROM plan_versions WHERE org_id = ?'),
      captures: await count('SELECT COUNT(*) AS n FROM captures WHERE org_id = ?'),
      files: files.length,
      users: await count('SELECT COUNT(*) AS n FROM users WHERE org_id = ?'),
    };

    await db.query('DELETE FROM share_links WHERE org_id = ?', [org.id]);
    await db.query(
      'DELETE cf FROM capture_files cf JOIN captures c ON c.id = cf.capture_id WHERE c.org_id = ?',
      [org.id],
    );
    await db.query('DELETE FROM plan_versions WHERE org_id = ?', [org.id]);
    await db.query('DELETE FROM captures WHERE org_id = ?', [org.id]);
    await db.query('DELETE FROM plans WHERE org_id = ?', [org.id]);
    await db.query('UPDATE users SET default_facility_id = NULL WHERE org_id = ?', [org.id]);
    await db.query('DELETE FROM facilities WHERE org_id = ?', [org.id]);
    await db.query(
      `DELETE rt FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id WHERE u.org_id = ?`,
      [org.id],
    );
    await db.query(
      `DELETE pr FROM password_resets pr JOIN users u ON u.id = pr.user_id WHERE u.org_id = ?`,
      [org.id],
    );
    // A removed customer's users may have reviewed nothing, but keep the
    // rows' ids out of other tables before deleting them.
    await db.query('DELETE FROM users WHERE org_id = ?', [org.id]);
    // The log keeps identifiers only: readable labels and names go.
    await db.query(
      'UPDATE audit_log SET target_label = NULL, actor_name = NULL, detail = NULL WHERE org_id = ?',
      [org.id],
    );
    await db.query(
      `UPDATE organisations SET name = ?, data_removed_at = UTC_TIMESTAMP(3) WHERE id = ?`,
      [`Removed account ${org.id}`, org.id],
    );
    await audit(db, {
      orgId: org.id,
      actor: actor(req),
      action: 'ACCOUNT_DATA_REMOVED',
      target: { type: 'account', id: org.id, label: null },
      detail: tally,
    });
    return tally;
  });

  // Files go once the rows that point at them are gone. A failure here is
  // logged; the objects are unreachable without their rows.
  let failed = 0;
  for (const f of files) {
    try {
      await storage().delete(f.storage_key);
    } catch (err) {
      failed++;
      console.error(`Could not delete ${f.storage_key}:`, err);
    }
  }
  res.json({ removed, filesNotDeleted: failed });
});

/* ------------------------------------------------------------------ */
/* Audit log.                                                           */

const auditQuery = z.object({
  orgId: z.string().max(40).optional(),
  action: z.string().max(40).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  before: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

async function auditRows(q, limit) {
  const where = [];
  const params = [];
  const filter = (sql, value) => {
    where.push(sql);
    params.push(value);
  };
  if (q.orgId) filter('a.org_id = ?', q.orgId);
  if (q.action) filter('a.action = ?', q.action);
  if (q.from) filter('a.created_at >= ?', new Date(q.from));
  if (q.to) filter('a.created_at < ?', new Date(q.to));
  if (q.before) filter('a.created_at < ?', new Date(q.before));
  const rows = await many(
    pool,
    `SELECT a.*, o.name AS organisation FROM audit_log a
     LEFT JOIN organisations o ON o.id = a.org_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
    [...params, limit],
  );
  return rows.map((a) => ({
    id: a.id,
    at: a.created_at,
    orgId: a.org_id,
    organisation: a.organisation,
    actorId: a.actor_id,
    actorName: a.actor_name,
    action: a.action,
    targetType: a.target_type,
    targetId: a.target_id,
    targetLabel: a.target_label,
    version: a.version,
    detail: a.detail,
  }));
}

router.get('/audit', async (req, res) => {
  const q = auditQuery.parse(req.query);
  const entries = await auditRows(q, q.limit + 1);
  const more = entries.length > q.limit;
  const page = entries.slice(0, q.limit);
  const actions = await many(pool, 'SELECT DISTINCT action FROM audit_log ORDER BY action');
  res.json({
    entries: page,
    nextBefore: more ? page[page.length - 1].at : null,
    actions: actions.map((a) => a.action),
  });
});

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value);
  // Spreadsheet formula injection: never let a cell start a formula.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.get('/audit.csv', async (req, res) => {
  const q = auditQuery.omit({ limit: true, before: true }).parse(req.query);
  const entries = await auditRows(q, 100000);
  const header = ['time_utc', 'action', 'account_id', 'account', 'target_type', 'target_id', 'target', 'version', 'actor_id', 'actor', 'detail'];
  const lines = [header.join(',')];
  for (const e of entries) {
    lines.push(
      [e.at, e.action, e.orgId, e.organisation, e.targetType, e.targetId, e.targetLabel, e.version, e.actorId, e.actorName, e.detail]
        .map(csvCell)
        .join(','),
    );
  }
  res
    .set('Content-Type', 'text/csv; charset=utf-8')
    .set('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`)
    .send(`${lines.join('\r\n')}\r\n`);
});

/* ------------------------------------------------------------------ */
/* Reviewer time (REV-10), visible to the operator.                     */

router.get('/reviewers', async (_req, res) => {
  const reviewers = await many(
    pool,
    `SELECT id, name, role_label, active FROM users WHERE role IN ('reviewer', 'admin') ORDER BY name`,
  );
  const WEEKS = 8;
  const rows = await many(
    pool,
    `SELECT reviewed_by, review_seconds, reviewed_at, input_type FROM plan_versions
     WHERE reviewed_by IS NOT NULL AND review_seconds IS NOT NULL
       AND status IN ('ready', 'recapture', 'superseded')
       AND reviewed_at >= UTC_TIMESTAMP(3) - INTERVAL ${WEEKS * 7} DAY`,
  );
  const now = Date.now();
  const weekOf = (d) => Math.floor((now - new Date(d).getTime()) / (7 * 86400000));
  const isScan = (t) => t === 'lidar' || t === 'simulated';

  res.json({
    targets: { scanSeconds: 15 * 60, uploadSeconds: 10 * 60 },
    reviewers: reviewers.map((r) => {
      const mine = rows.filter((x) => x.reviewed_by === r.id);
      const thisWeek = mine.filter((x) => weekOf(x.reviewed_at) === 0);
      return {
        id: r.id,
        name: r.name,
        roleLabel: r.role_label,
        active: Boolean(r.active),
        thisWeek: {
          reviews: thisWeek.length,
          medianSeconds: median(thisWeek.map((x) => x.review_seconds)),
          scanMedianSeconds: median(thisWeek.filter((x) => isScan(x.input_type)).map((x) => x.review_seconds)),
          uploadMedianSeconds: median(thisWeek.filter((x) => !isScan(x.input_type)).map((x) => x.review_seconds)),
        },
        // Oldest first, so a chart reads left to right.
        weeks: [...Array(WEEKS)].map((_, i) => {
          const w = WEEKS - 1 - i;
          const inWeek = mine.filter((x) => weekOf(x.reviewed_at) === w);
          return { weeksAgo: w, reviews: inWeek.length, medianSeconds: median(inWeek.map((x) => x.review_seconds)) };
        }),
      };
    }),
  });
});
