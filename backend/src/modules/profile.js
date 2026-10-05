/**
 * Profile service: who is signed in, their organisation and quota, and
 * their capture settings.
 */
import { Router } from 'express';
import { z } from 'zod';

import { many, one, pool } from '../db/pool.js';
import { notFound } from '../errors.js';
import { requireAuth } from '../middleware/auth.js';
import { initialsOf } from './auth.js';

export const router = Router();
router.use(requireAuth);

/**
 * New plan versions this calendar month, which is what the quota counts. A
 * reviewer's revision of an approved plan (REV-09) is not the customer's.
 */
export async function plansUsedThisMonth(db, orgId) {
  const row = await one(
    db,
    `SELECT COUNT(*) AS n FROM plan_versions
     WHERE org_id = ? AND origin = 'capture'
       AND created_at >= DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-01')`,
    [orgId],
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

router.get('/', async (req, res) => {
  const { id, orgId } = req.user;
  const user = await one(
    pool,
    `SELECT u.id, u.name, u.email, u.role, u.role_label, u.default_facility_id,
            o.name AS org_name, o.plan_quota
     FROM users u JOIN organisations o ON o.id = u.org_id
     WHERE u.id = ? AND u.org_id = ?`,
    [id, orgId],
  );
  if (!user) throw notFound();

  const facilities = await many(
    pool,
    'SELECT id, name FROM facilities WHERE org_id = ? ORDER BY name',
    [orgId],
  );
  const defaultFacility =
    facilities.find((f) => f.id === user.default_facility_id) ?? facilities[0] ?? null;

  res.json({
    id: user.id,
    name: user.name,
    initials: initialsOf(user.name),
    email: user.email,
    role: user.role,
    roleLabel: user.role_label,
    organisation: user.org_name,
    facilityCount: facilities.length,
    defaultFacility,
    plansUsed: await plansUsedThisMonth(pool, orgId),
    planQuota: user.plan_quota,
    settings: await settingsOf(id),
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
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE upload_on_mobile_data = VALUES(upload_on_mobile_data),
                             warn_before_photos = VALUES(warn_before_photos)`,
    [req.user.id, next.uploadOnMobileData, next.warnBeforePhotos],
  );
  res.json(next);
});
