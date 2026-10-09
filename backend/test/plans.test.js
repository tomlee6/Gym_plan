/** Profile, facilities, the owner's plans, share links and tenant isolation (B-04, B-10, D-05, D-06). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { api, createOtherTenant, DEMO, login, useTestServer } from './helpers.js';

const ctx = useTestServer();
const get = (path) => api(ctx).get(path).set('Authorization', `Bearer ${ctx.token}`);
const post = (path) => api(ctx).post(path).set('Authorization', `Bearer ${ctx.token}`);
const P = DEMO.plans;

describe('profile', () => {
  it('describes the user, their accounts, and the current account’s quota', async () => {
    const { body } = await get('/v1/me').expect(200);
    assert.equal(body.name, 'Sam Okafor');
    assert.equal(body.initials, 'SO');
    assert.equal(body.staffRole, null);
    assert.deepEqual(body.accounts.map((a) => `${a.name}:${a.role}`), ['Kestrel Health Clubs:surveyor', 'Northgate Group:owner']);
    assert.equal(body.account.name, 'Northgate Group');
    assert.equal(body.account.roleLabel, 'Owner & Surveyor');
    assert.equal(body.account.facilityCount, 3);
    assert.deepEqual(body.account.defaultFacility, { id: DEMO.facilities.eastbrook, name: 'Eastbrook Athletic Club' });
    // Version 1 of Level 1 was last month; the other six count.
    assert.equal(body.account.plansUsed, 6);
    assert.equal(body.account.planQuota, 10);
    assert.deepEqual(body.settings, { uploadOnMobileData: true, warnBeforePhotos: true });
  });

  it('works without an account named, and in the other account', async () => {
    const bare = await api(ctx).raw.get('/v1/me').set('Authorization', `Bearer ${ctx.token}`).expect(200);
    assert.equal(bare.body.account, null);
    const kestrel = await get('/v1/me').set('X-Account-Id', DEMO.kestrel).expect(200);
    assert.equal(kestrel.body.account.role, 'surveyor');
    assert.equal(kestrel.body.account.roleLabel, 'Surveyor');
  });

  it('saves capture settings', async () => {
    const { body } = await api(ctx)
      .patch('/v1/me/settings')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ warnBeforePhotos: false })
      .expect(200);
    assert.deepEqual(body, { uploadOnMobileData: true, warnBeforePhotos: false });
    const me = await get('/v1/me').expect(200);
    assert.equal(me.body.settings.warnBeforePhotos, false);
  });

  it('rejects unknown settings', async () => {
    await api(ctx).patch('/v1/me/settings').set('Authorization', `Bearer ${ctx.token}`).send({ darkMode: true }).expect(400);
  });
});

describe('facilities', () => {
  it('lists the account’s gyms', async () => {
    const { body } = await get('/v1/facilities').expect(200);
    assert.deepEqual(body.facilities.map((f) => f.name), ['Eastbrook Athletic Club', 'Northgate Fitness', 'Riverside Gym']);
    assert.equal(body.defaultFacilityId, DEMO.facilities.eastbrook);
  });

  it('needs the account named, and a membership in it', async () => {
    const none = await api(ctx).raw.get('/v1/facilities').set('Authorization', `Bearer ${ctx.token}`).expect(403);
    assert.equal(none.body.code, 'no_account');
    await get('/v1/facilities').set('X-Account-Id', 'not-an-id').expect(403);
    const other = await createOtherTenant();
    await get('/v1/facilities').set('X-Account-Id', other.accountId).expect(403);
  });
});

describe('plans', () => {
  it('lists every plan at its newest version, most recent first', async () => {
    const { body } = await get('/v1/plans').expect(200);
    assert.deepEqual(
      body.plans.map((p) => `${p.site} ${p.level} ${p.status}`),
      [
        'Riverside Gym 1 processing',
        'Northgate Fitness 3 uploading',
        'Northgate Fitness 2 in_review',
        'Northgate Fitness 1 ready',
        'Riverside Gym 0 recapture',
        'Eastbrook Athletic Club 0 ready',
      ],
    );
    const level1 = body.plans.find((p) => p.id === P.ng1);
    assert.equal(level1.version, 2);
    assert.equal(level1.walkthroughVersion, 2);
    assert.ok(level1.reviewedAt);
  });

  it('limits the list for the home screen', async () => {
    const { body } = await get('/v1/plans?limit=3').expect(200);
    assert.equal(body.plans.length, 3);
  });

  it('gives a rejected plan’s reason and reviewer note', async () => {
    const { body } = await get(`/v1/plans/${P.rv0}`).expect(200);
    assert.equal(body.status, 'recapture');
    assert.equal(body.rejectionReason, 'Incomplete coverage');
    assert.match(body.review.note, /north-east corner/);
    assert.deepEqual(body.review.reviewer, { name: 'Maya Restrepo', initials: 'MR' });
    assert.equal(body.coverage, 0.71);
    assert.equal(body.overrideRecorded, true);
  });

  it('gives a ready plan’s area, version, walkthrough and history', async () => {
    const { body } = await get(`/v1/plans/${P.ng1}`).expect(200);
    assert.equal(body.status, 'ready');
    assert.equal(body.version, 2);
    assert.equal(body.areaM2, 384);
    assert.equal(body.review.seconds, 680);
    // Built from configuration when shown, never stored (C-04, D-05).
    assert.equal(body.walkthroughUrl, `${config.publicWebUrl}/plans/${P.ng1}/walkthrough`);
    assert.equal(body.shareLink, null);
    assert.deepEqual(body.history.map((h) => `v${h.version} ${h.status}`), ['v2 ready', 'v1 superseded']);
    assert.equal(body.history[0].reviewerName, 'Maya Restrepo');
    // The audit log is the plan's timeline (E-04).
    assert.deepEqual(
      body.timeline.map((e) => `${e.action} v${e.version}`),
      ['CAPTURED v1', 'APPROVED v1', 'GENERATED v1', 'CAPTURED v2', 'APPROVED v2', 'SUPERSEDED v1', 'GENERATED v2'],
    );
  });

  it('shows each machine and its 3D model status (D-05)', async () => {
    const { body } = await get(`/v1/plans/${P.ng2}`).expect(200);
    assert.deepEqual(
      body.machines.map((m) => `${m.ref} ${m.type} ${m.modelStatus}`),
      ['EQ-001 treadmill awaiting_review', 'EQ-002 legPress none', 'EQ-003 bench none'],
    );
  });

  it('serves the newest ready plan for the walkthrough, with its levels', async () => {
    const { body } = await get(`/v1/plans/${P.ng1}/model`).expect(200);
    assert.equal(body.version, 2);
    assert.match(body.contentHash, /^[0-9a-f]{64}$/);
    assert.ok(body.plan.walls.length >= 4);
    assert.equal(body.plan.ceilingHeightM, 3.18);
    assert.deepEqual(body.generatedModel, { generatorVersion: 'browser-0', stored: false, bytes: null });
    // Level 1 is Northgate's only ready level; Level 2 is in review.
    assert.deepEqual(body.levels, [{ planId: P.ng1, level: 1 }]);
    await get(`/v1/plans/${P.ng2}/model`).expect(404);
  });

  it('makes share links whose token is stored only as a hash (D-06)', async () => {
    const first = await post(`/v1/plans/${P.ng1}/share-links`).send({}).expect(201);
    assert.match(first.body.url, /\/s\/[\w-]{20,}$/);
    const token = first.body.url.split('/s/')[1];
    const [rows] = await pool.query('SELECT token_hash FROM share_links WHERE plan_id = ?', [P.ng1]);
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].token_hash, token);
    assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);

    // The URL cannot be shown again; the owner sees that a link exists.
    const detail = await get(`/v1/plans/${P.ng1}`).expect(200);
    assert.equal(detail.body.shareLink.url, null);
    assert.ok(detail.body.shareLink.createdAt);

    // A fresh link replaces it: one live link per plan.
    const second = await post(`/v1/plans/${P.ng1}/share-links`).send({}).expect(201);
    assert.notEqual(second.body.url, first.body.url);
    await api(ctx).raw.get(`/v1/share/${token}`).expect(404);
  });

  it('opens a share link without signing in', async () => {
    const { body: link } = await post(`/v1/plans/${P.ng1}/share-links`).send({}).expect(201);
    const token = link.url.split('/s/')[1];
    const { body, headers } = await api(ctx).raw.get(`/v1/share/${token}`).set('Origin', config.publicWebUrl).expect(200);
    assert.equal(headers['access-control-allow-origin'], config.publicWebUrl);
    assert.equal(body.site, 'Northgate Fitness');
    assert.equal(body.level, 1);
    assert.equal(body.version, 2);
    assert.ok(body.plan.walls.length >= 4, 'the walkthrough model comes with the link');
    await api(ctx).raw.get('/v1/share/not-a-real-token-at-all').expect(404);
  });

  it('revokes a share link', async () => {
    const { body: link } = await post(`/v1/plans/${P.ng1}/share-links`).send({}).expect(201);
    const token = link.url.split('/s/')[1];
    await api(ctx).delete(`/v1/plans/${P.ng1}/share-links`).set('Authorization', `Bearer ${ctx.token}`).expect(204);
    await api(ctx).raw.get(`/v1/share/${token}`).expect(404);
    assert.equal((await get(`/v1/plans/${P.ng1}`).expect(200)).body.shareLink, null);
  });

  it('refuses to share a plan that is not approved', async () => {
    const res = await post(`/v1/plans/${P.rv0}/share-links`).send({}).expect(409);
    assert.match(res.body.message, /approved/);
  });
});

describe('tenant isolation (B-10)', () => {
  it('never shows one customer another’s plans', async () => {
    const other = (await pool.query(`SELECT id AS accountId FROM accounts WHERE name = 'Other Gym Co'`))[0][0];
    const { accessToken } = await login(ctx, { sub: 'hub|olu' });
    const theirs = (method, path) =>
      api(ctx)[method](path).set('Authorization', `Bearer ${accessToken}`).set('X-Account-Id', other.accountId);

    assert.deepEqual((await theirs('get', '/v1/plans').expect(200)).body.plans, []);
    // Not 403: do not even confirm the plan exists.
    await theirs('get', `/v1/plans/${P.ng1}`).expect(404);
    await theirs('get', `/v1/plans/${P.ng1}/model`).expect(404);
    await theirs('delete', `/v1/plans/${P.ng1}/share-links`).expect(404);
    await theirs('post', `/v1/plans/${P.ng1}/share-links`).send({}).expect(404);
    const facilities = await theirs('get', '/v1/facilities').expect(200);
    assert.deepEqual(facilities.body.facilities.map((f) => f.name), ['Other Gym']);
  });

  it('a person in accounts A and B sees B’s data only while acting in B', async () => {
    const inKestrel = await get('/v1/plans').set('X-Account-Id', DEMO.kestrel).expect(200);
    assert.deepEqual(inKestrel.body.plans, []);
    await get(`/v1/plans/${P.ng1}`).set('X-Account-Id', DEMO.kestrel).expect(404);
    const facilities = await get('/v1/facilities').set('X-Account-Id', DEMO.kestrel).expect(200);
    assert.deepEqual(facilities.body.facilities.map((f) => f.name), ['Kestrel Fitzroy']);
    // A surveyor in Kestrel cannot register a capture against a Northgate gym from there.
    const res = await api(ctx)
      .post('/v1/captures/drawings')
      .set('Authorization', `Bearer ${ctx.token}`)
      .set('X-Account-Id', DEMO.kestrel)
      .set('Idempotency-Key', 'iso-1')
      .send({ facilityId: DEMO.facilities.northgate, level: 1, inputType: 'dwg', originalName: 'a.dwg', bytes: 10 })
      .expect(400);
    assert.match(res.body.message, /your facilities/);
  });

  it('a share link can never reach another plan', async () => {
    const { body: link } = await post(`/v1/plans/${P.eb0}/share-links`).send({}).expect(201);
    const token = link.url.split('/s/')[1];
    const shared = await api(ctx).raw.get(`/v1/share/${token}`).expect(200);
    assert.equal(shared.body.site, 'Eastbrook Athletic Club');
    // Nothing on the share route takes a plan id, and a link of one plan
    // stays that plan's even after another plan's link is made.
    await post(`/v1/plans/${P.ng1}/share-links`).send({}).expect(201);
    assert.equal((await api(ctx).raw.get(`/v1/share/${token}`).expect(200)).body.site, 'Eastbrook Athletic Club');
    await api(ctx).raw.get(`/v1/share/${token}/../${P.ng1}`).expect(404);
  });
});
