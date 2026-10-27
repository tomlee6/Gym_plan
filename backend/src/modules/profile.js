/**
 * Profile service: who is signed in, the accounts they act in, the current
 * account's quota, and their capture settings.
 *
 *   GET   /v1/me             with X-Account-Id, adds that account's details
 *   PATCH /v1/me/settings
 */
import { Router } from 'express';
import { z } from 'zod';

import { many, one, pool } from '../db/pool.js';
import { HttpError, notFound } from '../errors.js';
import { isId } from '../ids.js';
import { membershipOf, requireAuth } from '../middleware/auth.js';
import { accountsOf, initialsOf } from './auth.js';

export const router = Router();
router.use(requireAuth);

/** How a membership role reads on screen (was users.role_label, C-04). */
export const ROLE_LABELS = { owner: 'Owner & Surveyor', surveyor: 'Surveyor' };
export const STAFF_LABELS = { reviewer: 'Reviewer', admin: 'Platform admin' };

/**
 * New plan versions this calendar month, which is what the quota counts. A
 * reviewer's revision of an approved plan (REV-09) is not the customer's.
 */
export async function plansUsedThisMonth(db, accountId) {
  const row = await one(
    db,
    `SELECT COUNT(*) AS n FROM plan_versions
     WHERE account_id = ? AND origin = 'capture'
       AND created_at >= DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-01')`,
    [accountId],
  );
  return Number(row.n);
}

async function settingsOf(userId) {
  const row = await one(pool, 'SELECT * FROM user_settings WHERE user_id = ?', [userId]);
  return {
    uploadOnMobileData: row ? Boolean(row.upload_on_mobile_data) : true,
    warnBeforePhotos: row ? Boolean(row.warn_before_photos) : true,
  };
}

/** The account block of /v1/me, for the account named in X-Account-Id. */
async function accountBlock(userId, accountId) {
  if (!isId(accountId)) throw new HttpError(403, 'You do not have access to this account.', { code: 'no_account' });
  const m = await membershipOf(pool, userId, accountId);
  if (!m) throw new HttpError(403, 'You do not have access to this account.', { code: 'no_account' });
  const account = await one(pool, 'SELECT plan_quota FROM accounts WHERE id = ?', [accountId]);
  const facilities = await many(pool, 'SELECT id, name FROM facilities WHERE account_id = ? ORDER BY name', [
    accountId,
  ]);
  return {
    id: m.id,
    name: m.name,
    role: m.role,
    roleLabel: ROLE_LABELS[m.role],
    facilityCount: facilities.length,
    defaultFacility: facilities[0] ?? null,
    plansUsed: await plansUsedThisMonth(pool, accountId),
    planQuota: account.plan_quota,
  };
}

router.get('/', async (req, res) => {
  const user = await one(pool, `SELECT * FROM users WHERE id = ? AND status = 'active'`, [req.user.id]);
  if (!user) throw notFound();
  const accountId = req.get('x-account-id');
  const account = accountId ? await accountBlock(user.id, accountId) : null;

  res.json({
    id: user.id,
    name: user.name,
    initials: initialsOf(user.name),
    email: user.email,
    staffRole: user.staff_role,
    staffLabel: user.staff_role ? STAFF_LABELS[user.staff_role] : null,
    accounts: await accountsOf(pool, user.id),
    account,
    // Kept flat as well, for app builds that read the old profile shape.
    ...(account && {
      role: account.role,
      roleLabel: account.roleLabel,
      organisation: account.name,
      facilityCount: account.facilityCount,
      defaultFacility: account.defaultFacility,
      plansUsed: account.plansUsed,
      planQuota: account.planQuota,
    }),
    settings: await settingsOf(user.id),
  });
});

router.patch('/settings', async (req, res) => {
  const body = z
    .object({
      uploadOnMobileData: z.boolean().optional(),
      warnBeforePhotos: z.boolean().optional(),
    })
    .strict()
    .parse(req.body);

  const current = await settingsOf(req.user.id);
  const next = { ...current, ...body };
  await pool.query(
    `INSERT INTO user_settings (user_id, upload_on_mobile_data, warn_before_photos)
     VALUES (?, ?, ?) AS fresh
     ON DUPLICATE KEY UPDATE upload_on_mobile_data = fresh.upload_on_mobile_data,
                             warn_before_photos = fresh.warn_before_photos`,
    [req.user.id, next.uploadOnMobileData, next.warnBeforePhotos],
  );
  res.json(next);
});
