/**
 * Facilities service: the gyms of the account the request acts in.
 */
import { Router } from 'express';

import { many, one, pool } from '../db/pool.js';
import { isId } from '../ids.js';
import { requireAccount, requireAuth } from '../middleware/auth.js';

export const router = Router();
router.use(requireAuth, requireAccount());

router.get('/', async (req, res) => {
  const facilities = await many(
    pool,
    'SELECT id, name FROM facilities WHERE account_id = ? ORDER BY name',
    [req.account.id],
  );
  res.json({ facilities, defaultFacilityId: facilities[0]?.id ?? null });
});

/** A facility in the caller's account, or null. */
export function facilityInAccount(db, accountId, facilityId) {
  if (!isId(facilityId)) return null;
  return one(db, 'SELECT id, name FROM facilities WHERE id = ? AND account_id = ?', [facilityId, accountId]);
}
