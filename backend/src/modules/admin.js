/**
 * Admin service: Next XR platform operations (PRD section 3, ACC-05..07).
 * Flex staff with the admin role only.
 *
 *   GET    /v1/admin/accounts                              every account, members, quota use
 *   POST   /v1/admin/accounts                              create one, inviting its first owner
 *   GET    /v1/admin/accounts/:id                          members, invites, facilities
 *   PATCH  /v1/admin/accounts/:id                          rename, set the monthly quota
 *   POST   /v1/admin/accounts/:id/invites                  invite an email with a role   B-05
 *   DELETE /v1/admin/accounts/:id/invites/:inviteId        revoke an open invite
 *   PATCH  /v1/admin/accounts/:id/members/:userId          change a member's role
 *   DELETE /v1/admin/accounts/:id/members/:userId          remove a member
 *   POST   /v1/admin/accounts/:id/facilities               add a gym
 *   POST   /v1/admin/accounts/:id/removal                  remove the account's data (a job)
 *   GET    /v1/admin/staff                                 staff, and people who could be
 *   PUT    /v1/admin/staff/:userId                         set a staff role               B-09
 *   GET    /v1/admin/audit                                 the audit log, newest first
 *   GET    /v1/admin/audit.csv                             the same, as CSV
 *   GET    /v1/admin/reviewers                             weekly median review time
 *
 * People are not created here with passwords any more (B-03, B-09): an
 * admin invites an email, and the first GoalCert sign-in with that verified
 * email becomes the member.
 */
import { Router } from 'express';
import { z } from 'zod';

import { audit } from '../audit.js';
import { config } from '../config.js';
import { many, one, pool, transaction } from '../db/pool.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { isId, newId } from '../ids.js';
import { enqueue, jobsCommitted } from '../jobs/index.js';
import { requireAuth, requireStaff } from '../middleware/auth.js';
import { invited } from '../notify.js';
import { revokeSessions } from './auth.js';
import { plansUsedThisMonth, ROLE_LABELS, STAFF_LABELS } from './profile.js';
import { median } from './review.js';

export const router = Router();
router.use(requireAuth, requireStaff('admin'));

const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: 'Enter a valid email address.' }).max(254));
const memberRole = z.enum(['owner', 'surveyor']);

const actor = (req) => ({ id: req.user.id });

async function accountOr404(db, id, { lock = false } = {}) {
  const account = isId(id) ? await one(db, `SELECT * FROM accounts WHERE id = ?${lock ? ' FOR UPDATE' : ''}`, [id]) : null;
  if (!account) throw notFound('This account does not exist.');
  return account;
}

function assertActive(account) {
  if (account.status !== 'active') throw conflict('This account’s data has been removed.');
}

async function accountSummary(db, account) {
  const counts = await one(
    db,
    `SELECT (SELECT COUNT(*) FROM memberships m JOIN users u ON u.id = m.user_id
             WHERE m.account_id = ? AND u.status = 'active') AS members,
            (SELECT COUNT(*) FROM facilities WHERE account_id = ?) AS facilities,
            (SELECT COUNT(*) FROM invites WHERE account_id = ? AND open_email IS NOT NULL
               AND expires_at > UTC_TIMESTAMP(3)) AS invites`,
    [account.id, account.id, account.id],
  );
  return {
    id: account.id,
    name: account.name,
    region: account.region,
    planQuota: account.plan_quota,
    plansUsed: await plansUsedThisMonth(db, account.id),
    members: Number(counts.members),
    // The old name, for screens that still say "users".
    users: Number(counts.members),
    facilities: Number(counts.facilities),
    openInvites: Number(counts.invites),
    status: account.status,
    createdAt: account.created_at,
    removedAt: account.removed_at,
  };
}

router.get('/accounts', async (_req, res) => {
  const accounts = await many(pool, 'SELECT * FROM accounts ORDER BY name');
  res.json({ accounts: await Promise.all(accounts.map((a) => accountSummary(pool, a))) });
});

/** An open invite to `email` for `account`, emailed once committed. */
async function createInvite(db, req, account, { email: to, role }) {
  const open = await one(
    db,
    'SELECT id FROM invites WHERE account_id = ? AND open_email = ? AND expires_at > UTC_TIMESTAMP(3)',
    [account.id, to],
  );
  if (open) throw conflict(`${to} already has an open invite to this account.`);
  const member = await one(
    db,
    'SELECT 1 AS yes FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.account_id = ? AND u.email = ?',
    [account.id, to],
  );
  if (member) throw conflict(`${to} is already a member of this account.`);
  // An expired invite still holds the open slot: close it first.
  await db.query(
    'UPDATE invites SET revoked_at = UTC_TIMESTAMP(3) WHERE account_id = ? AND open_email = ?',
    [account.id, to],
  );
  const id = newId();
  const expiresAt = new Date(Date.now() + config.auth.inviteTtlDays * 86400000);
  await db.query(
    'INSERT INTO invites (id, account_id, email, role, invited_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, account.id, to, role, req.user.id, expiresAt],
  );
  await audit(db, {
    accountId: account.id,
    actor: actor(req),
    action: 'INVITE_SENT',
    target: { type: 'invite', id, label: to },
    detail: { role },
  });
  return { id, email: to, role, expiresAt, accountName: account.name };
}

router.post('/accounts', async (req, res) => {
  const body = z
    .object({
      name: z.string().trim().min(2).max(200),
      planQuota: z.number().int().min(0).max(10000),
      // Every account's data lives in Sydney (M-16).
      region: z.literal('ap-southeast-2').default('ap-southeast-2'),
      ownerEmail: email,
    })
    .parse(req.body);

  const { id, invite } = await transaction(async (db) => {
    if (await one(db, 'SELECT id FROM accounts WHERE name = ?', [body.name])) {
      throw conflict(`An account called ${body.name} already exists.`);
    }
    const accountId = newId();
    await db.query('INSERT INTO accounts (id, name, plan_quota, region) VALUES (?, ?, ?, ?)', [
      accountId,
      body.name,
      body.planQuota,
      body.region,
    ]);
    await audit(db, {
      accountId,
      actor: actor(req),
      action: 'ACCOUNT_CREATED',
      target: { type: 'account', id: accountId, label: body.name },
      detail: { planQuota: body.planQuota },
    });
    const account = await accountOr404(db, accountId);
    return { id: accountId, invite: await createInvite(db, req, account, { email: body.ownerEmail, role: 'owner' }) };
  });
  await invited(invite);
  res.status(201).json(await accountSummary(pool, await accountOr404(pool, id)));
});

router.get('/accounts/:id', async (req, res) => {
  const account = await accountOr404(pool, req.params.id);
  const members = await many(
    pool,
    `SELECT u.id, u.name, u.email, u.status, m.role, m.created_at FROM memberships m
     JOIN users u ON u.id = m.user_id WHERE m.account_id = ? ORDER BY u.status, u.name`,
    [account.id],
  );
  const invites = await many(
    pool,
    `SELECT id, email, role, expires_at, created_at FROM invites
     WHERE account_id = ? AND open_email IS NOT NULL ORDER BY created_at DESC`,
    [account.id],
  );
  const facilities = await many(
    pool,
    `SELECT f.id, f.name, f.created_at, COUNT(p.id) AS levels
     FROM facilities f LEFT JOIN plans p ON p.facility_id = f.id
     WHERE f.account_id = ? GROUP BY f.id ORDER BY f.name`,
    [account.id],
  );
  res.json({
    ...(await accountSummary(pool, account)),
    members: members.map((m) => ({
      userId: m.id,
      name: m.name,
      email: m.email,
      role: m.role,
      roleLabel: ROLE_LABELS[m.role],
      status: m.status,
      createdAt: m.created_at,
    })),
    invites: invites.map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      expiresAt: i.expires_at,
      expired: i.expires_at < new Date(),
      createdAt: i.created_at,
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
    const account = await accountOr404(db, req.params.id, { lock: true });
    assertActive(account);
    if (body.name !== undefined && body.name !== account.name) {
      if (await one(db, 'SELECT id FROM accounts WHERE name = ? AND id <> ?', [body.name, account.id])) {
        throw conflict(`An account called ${body.name} already exists.`);
      }
      await db.query('UPDATE accounts SET name = ? WHERE id = ?', [body.name, account.id]);
      await audit(db, {
        accountId: account.id,
        actor: actor(req),
        action: 'ACCOUNT_RENAMED',
        target: { type: 'account', id: account.id, label: body.name },
        detail: { from: account.name },
      });
    }
    if (body.planQuota !== undefined && body.planQuota !== account.plan_quota) {
      await db.query('UPDATE accounts SET plan_quota = ? WHERE id = ?', [body.planQuota, account.id]);
      await audit(db, {
        accountId: account.id,
        actor: actor(req),
        action: 'QUOTA_CHANGED',
        target: { type: 'account', id: account.id, label: body.name ?? account.name },
        detail: { from: account.plan_quota, to: body.planQuota },
      });
    }
  });
  res.json(await accountSummary(pool, await accountOr404(pool, req.params.id)));
});

router.post('/accounts/:id/invites', async (req, res) => {
  const body = z.object({ email, role: memberRole }).parse(req.body);
  const invite = await transaction(async (db) => {
    const account = await accountOr404(db, req.params.id, { lock: true });
    assertActive(account);
    return createInvite(db, req, account, body);
  });
  await invited(invite);
  res.status(201).json({ id: invite.id, expiresAt: invite.expiresAt });
});

router.delete('/accounts/:id/invites/:inviteId', async (req, res) => {
  await transaction(async (db) => {
    const account = await accountOr404(db, req.params.id);
    const invite = isId(req.params.inviteId)
      ? await one(db, 'SELECT * FROM invites WHERE id = ? AND account_id = ? FOR UPDATE', [req.params.inviteId, account.id])
      : null;
    if (!invite) throw notFound('This invite does not exist.');
    if (invite.accepted_at || invite.revoked_at) return;
    await db.query('UPDATE invites SET revoked_at = UTC_TIMESTAMP(3) WHERE id = ?', [invite.id]);
    await audit(db, {
      accountId: account.id,
      actor: actor(req),
      action: 'INVITE_REVOKED',
      target: { type: 'invite', id: invite.id, label: invite.email },
    });
  });
  res.status(204).end();
});

async function membershipOr404(db, accountId, userId) {
  const m = isId(userId)
    ? await one(
        db,
        `SELECT m.*, u.name, u.email FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.account_id = ? AND m.user_id = ? FOR UPDATE`,
        [accountId, userId],
      )
    : null;
  if (!m) throw notFound('This person is not a member of this account.');
  return m;
}

router.patch('/accounts/:id/members/:userId', async (req, res) => {
  const { role } = z.object({ role: memberRole }).strict().parse(req.body);
  await transaction(async (db) => {
    const account = await accountOr404(db, req.params.id, { lock: true });
    assertActive(account);
    const m = await membershipOr404(db, account.id, req.params.userId);
    if (m.role === role) return;
    await db.query('UPDATE memberships SET role = ? WHERE account_id = ? AND user_id = ?', [role, account.id, m.user_id]);
    await audit(db, {
      accountId: account.id,
      actor: actor(req),
      action: 'MEMBER_ROLE_CHANGED',
      target: { type: 'user', id: m.user_id, label: `${m.name} <${m.email}>` },
      detail: { from: m.role, to: role },
    });
  });
  res.status(204).end();
});

router.delete('/accounts/:id/members/:userId', async (req, res) => {
  await transaction(async (db) => {
    const account = await accountOr404(db, req.params.id, { lock: true });
    const m = await membershipOr404(db, account.id, req.params.userId);
    // Removed rather than disabled: captures and approvals stay attributable
    // through the user row, which other accounts may still use.
    await db.query('DELETE FROM memberships WHERE account_id = ? AND user_id = ?', [account.id, m.user_id]);
    const others = await one(db, 'SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?', [m.user_id]);
    const staff = await one(db, 'SELECT staff_role FROM users WHERE id = ?', [m.user_id]);
    // Nowhere left to act: end their sessions now rather than at the next refresh.
    if (!Number(others.n) && !staff.staff_role) await revokeSessions(db, m.user_id);
    await audit(db, {
      accountId: account.id,
      actor: actor(req),
      action: 'MEMBER_REMOVED',
      target: { type: 'user', id: m.user_id, label: `${m.name} <${m.email}>` },
      detail: { role: m.role },
    });
  });
  res.status(204).end();
});

router.post('/accounts/:id/facilities', async (req, res) => {
  const { name } = z.object({ name: z.string().trim().min(2).max(200) }).parse(req.body);
  const id = await transaction(async (db) => {
    const account = await accountOr404(db, req.params.id, { lock: true });
    assertActive(account);
    if (await one(db, 'SELECT id FROM facilities WHERE account_id = ? AND name = ?', [account.id, name])) {
      throw conflict(`${name} already exists in this account.`);
    }
    const facilityId = newId();
    await db.query('INSERT INTO facilities (id, account_id, name) VALUES (?, ?, ?)', [facilityId, account.id, name]);
    await audit(db, {
      accountId: account.id,
      actor: actor(req),
      action: 'FACILITY_ADDED',
      target: { type: 'facility', id: facilityId, label: name },
    });
    return facilityId;
  });
  res.status(201).json({ id });
});

/**
 * ACC-07: plans, scans, models and files are deleted; members whose only
 * access was this account are removed; the audit log is kept with
 * identifiers only. The admin types the account name to confirm. The work
 * runs as the account.remove job (D-08, E-06); the account is closed to
 * everyone at once, while the job finishes in the background.
 */
router.post('/accounts/:id/removal', async (req, res) => {
  const { confirmName } = z.object({ confirmName: z.string() }).parse(req.body);
  const jobId = await transaction(async (db) => {
    const account = await accountOr404(db, req.params.id, { lock: true });
    if (account.status !== 'active') throw conflict('This account’s data has already been removed.');
    if (confirmName.trim() !== account.name) throw badRequest('Type the account name exactly to confirm.');
    await db.query(`UPDATE accounts SET status = 'removed' WHERE id = ?`, [account.id]);
    await audit(db, {
      accountId: account.id,
      actor: actor(req),
      action: 'ACCOUNT_REMOVAL_STARTED',
      target: { type: 'account', id: account.id, label: account.name },
    });
    return enqueue(db, { kind: 'account.remove', subjectId: account.id, accountId: account.id, payload: { actorId: req.user.id } });
  });
  await jobsCommitted();
  res.status(202).json({ jobId });
});

/* ------------------------------------------------------------------ */
/* Staff roles (B-09).                                                  */

router.get('/staff', async (_req, res) => {
  const users = await many(
    pool,
    `SELECT id, name, email, staff_role, status FROM users ORDER BY staff_role IS NULL, name`,
  );
  res.json({
    staff: users
      .filter((u) => u.staff_role)
      .map((u) => ({ id: u.id, name: u.name, email: u.email, staffRole: u.staff_role, staffLabel: STAFF_LABELS[u.staff_role], status: u.status })),
    // Anyone who has signed in may be made staff.
    users: users.filter((u) => !u.staff_role && u.status === 'active').map((u) => ({ id: u.id, name: u.name, email: u.email })),
  });
});

router.put('/staff/:userId', async (req, res) => {
  const { staffRole } = z.object({ staffRole: z.enum(['reviewer', 'admin']).nullable() }).strict().parse(req.body);
  await transaction(async (db) => {
    const user = isId(req.params.userId)
      ? await one(db, 'SELECT * FROM users WHERE id = ? FOR UPDATE', [req.params.userId])
      : null;
    if (!user) throw notFound('This person has not signed in to Flex Gym Scan yet.');
    if (user.id === req.user.id && staffRole !== 'admin') throw badRequest('You cannot take away your own admin role.');
    if ((user.staff_role ?? null) === staffRole) return;
    await db.query('UPDATE users SET staff_role = ? WHERE id = ?', [staffRole, user.id]);
    // The role travels in the access token: end sessions so it takes effect now.
    await revokeSessions(db, user.id);
    await audit(db, {
      accountId: null,
      actor: actor(req),
      action: 'STAFF_ROLE_CHANGED',
      target: { type: 'user', id: user.id, label: `${user.name} <${user.email}>` },
      detail: { from: user.staff_role, to: staffRole },
    });
  });
  res.status(204).end();
});

/* ------------------------------------------------------------------ */
/* Audit log.                                                           */

const auditQuery = z.object({
  accountId: z.string().max(40).optional(),
  // The old name, still accepted.
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
  const accountId = q.accountId ?? q.orgId;
  if (accountId) filter('l.account_id = ?', accountId);
  if (q.action) filter('l.action = ?', q.action);
  if (q.from) filter('l.created_at >= ?', new Date(q.from));
  if (q.to) filter('l.created_at < ?', new Date(q.to));
  if (q.before) filter('l.created_at < ?', new Date(q.before));
  const rows = await many(
    pool,
    `SELECT l.*, a.name AS account FROM audit_log l
     LEFT JOIN accounts a ON a.id = l.account_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY l.created_at DESC, l.id DESC LIMIT ?`,
    [...params, limit],
  );
  return rows.map((l) => ({
    id: l.id,
    at: l.created_at,
    accountId: l.account_id,
    account: l.account,
    organisation: l.account,
    actorId: l.actor_user_id,
    actorName: l.actor_name,
    action: l.action,
    targetType: l.target_type,
    targetId: l.target_id,
    targetLabel: l.target_label,
    version: l.version_no,
    detail: l.detail,
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
      [e.at, e.action, e.accountId, e.organisation, e.targetType, e.targetId, e.targetLabel, e.version, e.actorId, e.actorName, e.detail]
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
    `SELECT id, name, staff_role, status FROM users WHERE staff_role IN ('reviewer', 'admin') ORDER BY name`,
  );
  const WEEKS = 8;
  // The reviewer-time index (reviewed_by, reviewed_at) serves this (C-10).
  const rows = await many(
    pool,
    `SELECT v.reviewed_by, v.review_active_seconds, v.reviewed_at, c.source
     FROM plan_versions v LEFT JOIN captures c ON c.id = v.capture_id
     WHERE v.reviewed_by IS NOT NULL
       AND v.status IN ('recapture', 'generating', 'generation_failed', 'ready', 'superseded')
       AND v.reviewed_at >= UTC_TIMESTAMP(3) - INTERVAL ${WEEKS * 7} DAY`,
  );
  const now = Date.now();
  const weekOf = (d) => Math.floor((now - new Date(d).getTime()) / (7 * 86400000));
  const isScan = (s) => s === 'lidar' || s === 'simulated';

  res.json({
    targets: { scanSeconds: 15 * 60, uploadSeconds: 10 * 60 },
    reviewers: reviewers.map((r) => {
      const mine = rows.filter((x) => x.reviewed_by === r.id);
      const thisWeek = mine.filter((x) => weekOf(x.reviewed_at) === 0);
      const secs = (list) => list.map((x) => x.review_active_seconds);
      return {
        id: r.id,
        name: r.name,
        roleLabel: STAFF_LABELS[r.staff_role],
        active: r.status === 'active',
        thisWeek: {
          reviews: thisWeek.length,
          medianSeconds: median(secs(thisWeek)),
          scanMedianSeconds: median(secs(thisWeek.filter((x) => isScan(x.source)))),
          uploadMedianSeconds: median(secs(thisWeek.filter((x) => !isScan(x.source)))),
        },
        // Oldest first, so a chart reads left to right.
        weeks: [...Array(WEEKS)].map((_, i) => {
          const w = WEEKS - 1 - i;
          const inWeek = mine.filter((x) => weekOf(x.reviewed_at) === w);
          return { weeksAgo: w, reviews: inWeek.length, medianSeconds: median(secs(inWeek)) };
        }),
      };
    }),
  });
});
