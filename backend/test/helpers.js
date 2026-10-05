import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before } from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { hashPassword } from '../src/modules/auth.js';
import { migrate, resetDatabase } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { DEMO, seed } from '../src/db/seed.js';
import { setStorage } from '../src/storage/index.js';
import { LocalStorage } from '../src/storage/local.js';

export { DEMO };

/**
 * Gives each test file a fresh, seeded database and a temp storage folder,
 * and signs in as the demo owner. Returns an object whose fields (`app`,
 * `storage`, `token`) are filled in before the tests run.
 *
 * Test files should read `ctx.token` rather than signing in from their own
 * `before` hook: hooks at a file's top level do not reliably run after this
 * one.
 */
export function useTestServer() {
  const ctx = { app: null, storage: null, dir: null, token: null };

  before(async () => {
    if (!config.db.database.endsWith('_test')) {
      throw new Error(`Refusing to run tests against ${config.db.database}`);
    }
    await resetDatabase();
    await migrate({ log: () => {} });
    await seed();
    ctx.dir = await mkdtemp(path.join(tmpdir(), 'gymplan-storage-'));
    ctx.storage = new LocalStorage({
      dir: ctx.dir,
      secret: config.storage.signingSecret,
      publicUrl: config.publicApiUrl,
    });
    setStorage(ctx.storage);
    ctx.app = createApp();
    ctx.token = (await login(ctx)).accessToken;
  });

  after(async () => {
    await pool.end();
    if (ctx.dir) await rm(ctx.dir, { recursive: true, force: true });
  });

  return ctx;
}

export function api(ctx) {
  return request(ctx.app);
}

export async function login(ctx, who = DEMO.owner) {
  const res = await api(ctx)
    .post('/v1/auth/login')
    .send({ email: who.email, password: who.password })
    .expect(200);
  return res.body;
}

/** A second customer, for tenant-isolation checks. */
export async function createOtherTenant() {
  const user = {
    id: 'usr_other',
    email: 'owner@othergym.example',
    password: 'other-pass-123',
  };
  await pool.query(`INSERT INTO organisations (id, name) VALUES ('org_other', 'Other Gym Co')`);
  await pool.query(
    `INSERT INTO facilities (id, org_id, name) VALUES ('fac_other', 'org_other', 'Other Gym')`,
  );
  await pool.query(
    `INSERT INTO users (id, org_id, email, password_hash, name, role, role_label)
     VALUES (?, 'org_other', ?, ?, 'Olu Other', 'owner', 'Owner')`,
    [user.id, user.email, await hashPassword(user.password)],
  );
  return user;
}

/** Sends a part to a local-storage URL the API handed out. */
export function putPart(ctx, url, bytes) {
  const u = new URL(url);
  return api(ctx)
    .put(u.pathname + u.search)
    .set('Content-Type', 'application/octet-stream')
    .send(bytes);
}
