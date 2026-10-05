/**
 * Facilities service: the gyms the signed-in user can capture.
 */
import { Router } from 'express';

import { many, one, pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

export const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const facilities = await many(
    pool,
    'SELECT id, name FROM facilities WHERE org_id = ? ORDER BY name',
    [req.user.orgId],
  );
  const user = await one(pool, 'SELECT default_facility_id FROM users WHERE id = ?', [
    req.user.id,
  ]);
  res.json({
    facilities,
    defaultFacilityId: user?.default_facility_id ?? facilities[0]?.id ?? null,
  });
});

/** A facility in the caller's organisation, or null. */
export function facilityInOrg(db, orgId, facilityId) {
  return one(db, 'SELECT id, name FROM facilities WHERE id = ? AND org_id = ?', [
    facilityId,
    orgId,
  ]);
}
