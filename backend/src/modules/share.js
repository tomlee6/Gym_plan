/**
 * Share service: what a share link (`PUBLIC_WEB_URL/s/<token>`) opens
 * (VIEW-07). The viewer calls this without signing in; the token is the only
 * credential, so an unknown, expired, revoked or no-longer-approved link
 * answers 404 and says nothing more. A link always opens the plan's newest
 * approved version (GEN-06).
 */
import { Router } from 'express';

import { one, pool } from '../db/pool.js';
import { notFound } from '../errors.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { modelFor } from './plans.js';

export const router = Router();

router.use(rateLimit({ windowMs: 60 * 1000, max: 60, key: (req) => `share:${req.ip}` }));

router.get('/:token', async (req, res) => {
  const link = await one(
    pool,
    `SELECT COALESCE(s.plan_id, v.plan_id) AS plan_id, s.expires_at
     FROM share_links s
     LEFT JOIN plan_versions v ON v.id = s.plan_version_id
     WHERE s.token = ? AND s.revoked_at IS NULL
       AND (s.expires_at IS NULL OR s.expires_at > UTC_TIMESTAMP(3))`,
    [req.params.token],
  );
  const model = link?.plan_id
    ? await modelFor(pool, null, link.plan_id, { withLevels: false })
    : null;
  if (!model) throw notFound('This link is no longer available.');

  res.set('Cache-Control', 'no-store').json({
    site: model.site,
    organisation: model.organisation,
    level: model.level,
    version: model.version,
    areaM2: model.areaM2,
    approvedAt: model.approvedAt,
    expiresAt: link.expires_at,
    plan: model.plan,
  });
});
