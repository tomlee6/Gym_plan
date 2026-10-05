import express from 'express';

import { config } from './config.js';
import { pool } from './db/pool.js';
import { errorHandler, notFound } from './errors.js';
import { cors } from './middleware/cors.js';
import { router as admin } from './modules/admin.js';
import { router as auth } from './modules/auth.js';
import { router as captures } from './modules/captures.js';
import { router as facilities } from './modules/facilities.js';
import { router as localStorage } from './modules/local-storage.js';
import { router as plans } from './modules/plans.js';
import { router as profile } from './modules/profile.js';
import { router as review } from './modules/review.js';
import { router as share } from './modules/share.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Behind a load balancer, so req.ip is the client, not the proxy.
  app.set('trust proxy', 1);

  // Part uploads stream raw bytes, so they are mounted before the JSON
  // parser can touch the body.
  if (config.storage.driver === 'local') {
    app.use('/storage/local', localStorage);
  }

  app.use('/v1', cors);
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  });

  app.use('/v1/auth', auth);
  app.use('/v1/me', profile);
  app.use('/v1/facilities', facilities);
  app.use('/v1/plans', plans);
  app.use('/v1/captures', captures);
  app.use('/v1/review', review);
  app.use('/v1/share', share);
  app.use('/v1/admin', admin);

  app.use((_req, _res, next) => next(notFound()));
  app.use(errorHandler);
  return app;
}
