import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before } from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { migrate, resetDatabase } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { DEMO, seed } from '../src/db/seed.js';
import { challengeFor } from '../src/hub/dev.js';
import { hub } from '../src/hub/index.js';
import { newId } from '../src/ids.js';
import { setStorage } from '../src/storage/index.js';
import { LocalStorage } from '../src/storage/local.js';

export { DEMO };

/**
 * Gives each test file a fresh, seeded database and a temp storage folder,
 * and signs in as the demo owner through the dev Hub. Returns an object
 * whose fields (`app`, `storage`, `token`, `account`) are filled in before
 * the tests run.
 *
 * Test files should read `ctx.token` rather than signing in from their own
 * `before` hook: hooks at a file's top level do not reliably run after this
 * one.
 */
export function useTestServer() {
  const ctx = { app: null, storage: null, dir: null, token: null, account: DEMO.account };

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

/**
 * Requests against the app. Each one names the demo account in
 * X-Account-Id unless the test sets its own; staff routes ignore it.
 */
export function api(ctx) {
  const agent = request(ctx.app);
  const wrap = (method) => (url) => agent[method](url).set('X-Account-Id', ctx.account);
  return {
    get: wrap('get'),
    post: wrap('post'),
    put: wrap('put'),
    patch: wrap('patch'),
    delete: wrap('delete'),
    options: wrap('options'),
    // No account header at all.
    raw: agent,
  };
}

/** The PKCE bits a client makes before sending someone to the Hub. */
export function pkce() {
  const codeVerifier = randomBytes(32).toString('base64url');
  return { codeVerifier, codeChallenge: challengeFor(codeVerifier), nonce: randomBytes(12).toString('base64url') };
}

/**
 * Signs in through the dev Hub exactly as the web app or the phone does:
 * a one-time code bound to a PKCE challenge, then POST /v1/auth/hub.
 * `who` is a seeded person (`{ sub }`) or anyone, by email.
 */
export async function hubCode(who, { client = 'web' } = {}) {
  const person = who.sub ? hub().people.get(who.sub) : hub().person(who);
  const p = pkce();
  const redirectUri = client === 'web' ? config.hub.webRedirectUri : config.hub.iosRedirectUri;
  const code = hub().issueCode({ sub: person.sub, redirectUri, codeChallenge: p.codeChallenge, nonce: p.nonce });
  return { code, codeVerifier: p.codeVerifier, nonce: p.nonce, redirectUri, client };
}

export async function login(ctx, who = DEMO.owner, { client = 'web', expect = 200 } = {}) {
  const res = await request(ctx.app).post('/v1/auth/hub').send(await hubCode(who, { client })).expect(expect);
  return res.body;
}

/** A second customer, for tenant-isolation checks. */
export async function createOtherTenant() {
  const other = {
    id: newId(),
    accountId: newId(),
    facilityId: newId(),
    sub: 'hub|olu',
    email: 'owner@othergym.example',
    name: 'Olu Other',
  };
  hub().people.set(other.sub, { sub: other.sub, email: other.email, name: other.name, emailVerified: true, org: config.hub.orgId });
  await pool.query(`INSERT INTO accounts (id, name) VALUES (?, 'Other Gym Co')`, [other.accountId]);
  await pool.query(`INSERT INTO facilities (id, account_id, name) VALUES (?, ?, 'Other Gym')`, [other.facilityId, other.accountId]);
  await pool.query(`INSERT INTO users (id, hub_user_id, email, name) VALUES (?, ?, ?, ?)`, [
    other.id,
    other.sub,
    other.email,
    other.name,
  ]);
  await pool.query(`INSERT INTO memberships (account_id, user_id, role) VALUES (?, ?, 'owner')`, [other.accountId, other.id]);
  return other;
}

/** Sends a part to a local-storage URL the API handed out. */
export function putPart(ctx, url, bytes) {
  const u = new URL(url);
  return request(ctx.app)
    .put(u.pathname + u.search)
    .set('Content-Type', 'application/octet-stream')
    .send(bytes);
}
