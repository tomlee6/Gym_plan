/**
 * Share service: what a share link (`PUBLIC_WEB_URL/s/<token>`) opens
 * (VIEW-07). The viewer calls this without signing in; the token is the
 * only credential, and only its SHA-256 is stored (D-06), so a copy of the
 * database cannot open anyone's walkthrough. An unknown, expired, revoked
 * or no-longer-ready link answers 404 and says nothing more. A link always
 * opens its plan's newest ready version (GEN-06), and never any other plan.
 *
 * Request rate limits are enforced in front of the API by AWS WAF (D-10).
 */
import { Router } from 'express';

import { one, pool } from '../db/pool.js';
import { notFound } from '../errors.js';
import { sha256 } from '../ids.js';
import { modelFor } from './plans.js';

export const router = Router();

const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

router.get('/:token', async (req, res) => {
  const link = TOKEN.test(req.params.token)
    ? await one(
        pool,
        `SELECT plan_id, account_id, expires_at FROM share_links
         WHERE token_hash = ? AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP(3))`,
        [sha256(req.params.token)],
      )
    : null;
  // Scoped to the link's own account and plan, so it can reach nothing else.
  const model = link ? await modelFor(pool, link.account_id, link.plan_id, { withLevels: false }) : null;
  if (!model) throw notFound('This link is no longer available.');

  res.set('Cache-Control', 'no-store').json({
    site: model.site,
    organisation: model.organisation,
    level: model.level,
    version: model.version,
    areaM2: model.areaM2,
    approvedAt: model.approvedAt,
    expiresAt: link.expires_at,
    generatedModel: model.generatedModel,
    plan: model.plan,
  });
});
