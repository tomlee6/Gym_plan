import express from 'express';

import { config } from './config.js';
import { pool } from './db/pool.js';
import { errorHandler, notFound } from './errors.js';
import { hub } from './hub/index.js';
import { devHubRouter } from './hub/dev.js';
import './jobs/handlers.js';
import './generator/index.js';
import './assets/index.js';
import { cors } from './middleware/cors.js';
import { router as admin } from './modules/admin.js';
import { router as auth } from './modules/auth.js';
import { router as captures } from './modules/captures.js';
import { router as equipment } from './modules/equipment.js';
import { router as facilities } from './modules/facilities.js';
import { router as hubEvents } from './modules/hub-events.js';
import { router as localStorage } from './modules/local-storage.js';
import { router as machineModels } from './modules/machine-models.js';
import { router as plans } from './modules/plans.js';
import { router as profile } from './modules/profile.js';
import { router as review } from './modules/review.js';
import { router as share } from './modules/share.js';

/**
 * The API. Request rate limits (sign-in, share links, overall) are applied
 * in front of it by AWS WAF (D-10), which counts across every server; an
 * in-memory counter here would only ever see one of them.
 */
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Behind a load balancer, so req.ip is the client, not the proxy.
  app.set('trust proxy', 1);

  // Part uploads stream raw bytes, and Hub events are signed over their raw
  // bytes, so both are mounted before the JSON parser can touch the body.
  if (config.storage.driver === 'local') {
    app.use('/storage/local', localStorage);
  }
  app.use('/v1/hub', hubEvents);

  app.use('/v1', cors);
  app.use(express.json({ limit: '1mb' }));

  // The stand-in Hub, for local work and tests only (config.js refuses it in production).
  if (config.hub.driver === 'dev') {
    app.use('/dev-hub', express.urlencoded({ extended: false }), devHubRouter(hub));
  }

  app.get('/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  });

  app.use('/v1/auth', auth);
  app.use('/v1/me', profile);
  app.use('/v1/facilities', facilities);
  app.use('/v1/plans', plans);
  app.use('/v1/captures', captures);
  // Equipment and its 360 video hang off a capture, so they share its path.
  app.use('/v1/captures', equipment);
  app.use('/v1/review', review);
  // Machine models (L-07) share the reviewer's path and its staff-only rule.
  app.use('/v1/review', machineModels);
  app.use('/v1/share', share);
  app.use('/v1/admin', admin);

  app.use((_req, _res, next) => next(notFound()));
  app.use(errorHandler);
  return app;
}
