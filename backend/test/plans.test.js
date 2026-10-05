import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { config } from '../src/config.js';
import { api, createOtherTenant, DEMO, login, useTestServer } from './helpers.js';

const ctx = useTestServer();
const get = (path) => api(ctx).get(path).set('Authorization', `Bearer ${ctx.token}`);
const post = (path) => api(ctx).post(path).set('Authorization', `Bearer ${ctx.token}`);

describe('profile', () => {
  it('describes the user, organisation and quota', async () => {
    const { body } = await get('/v1/me').expect(200);
    assert.equal(body.name, 'Sam Okafor');
    assert.equal(body.initials, 'SO');
    assert.equal(body.roleLabel, 'Owner & Surveyor');
    assert.equal(body.organisation, 'Northgate Group');
    assert.equal(body.facilityCount, 3);
    assert.deepEqual(body.defaultFacility, { id: DEMO.facilities.northgate, name: 'Northgate Fitness' });
    // Version 1 of Level 1 was last month; the other six count.
    assert.equal(body.plansUsed, 6);
    assert.equal(body.planQuota, 10);
    assert.deepEqual(body.settings, { uploadOnMobileData: true, warnBeforePhotos: true });
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
    await api(ctx)
      .patch('/v1/me/settings')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ darkMode: true })
      .expect(400);
  });
});

describe('facilities', () => {
  it('lists the organisation’s gyms with the default first choice', async () => {
    const { body } = await get('/v1/facilities').expect(200);
    assert.deepEqual(
      body.facilities.map((f) => f.name),
      ['Eastbrook Athletic Club', 'Northgate Fitness', 'Riverside Gym'],
    );
    assert.equal(body.defaultFacilityId, DEMO.facilities.northgate);
  });
});

describe('plans', () => {
  it('lists every plan at its newest version, most recent first', async () => {
    const { body } = await get('/v1/plans').expect(200);
    assert.equal(body.plans.length, 6);
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
    const level1 = body.plans.find((p) => p.id === 'plan_ng1');
    assert.equal(level1.version, 2);
    assert.ok(level1.reviewedAt);
  });

  it('limits the list for the home screen', async () => {
    const { body } = await get('/v1/plans?limit=3').expect(200);
    assert.equal(body.plans.length, 3);
  });

  it('gives a rejected plan’s reason and reviewer note', async () => {
    const { body } = await get('/v1/plans/plan_rv0').expect(200);
    assert.equal(body.status, 'recapture');
    assert.equal(body.rejectionReason, 'Incomplete coverage');
    assert.match(body.review.note, /north-east corner/);
    assert.deepEqual(body.review.reviewer, { name: 'Maya Restrepo', initials: 'MR' });
    assert.equal(body.coverage, 0.71);
    assert.equal(body.overrideRecorded, true);
  });

  it('gives a ready plan’s area, version and walkthrough', async () => {
    const { body } = await get('/v1/plans/plan_ng1').expect(200);
    assert.equal(body.status, 'ready');
    assert.equal(body.version, 2);
    assert.equal(body.areaM2, 384);
    assert.equal(body.review.seconds, 680);
    assert.equal(body.walkthroughUrl, `${config.publicWebUrl}/plans/plan_ng1/walkthrough`);
    assert.equal(body.shareLink, null);
    // REV-09: version 1 was superseded when version 2 was approved.
    assert.deepEqual(
      body.history.map((h) => `v${h.version} ${h.status}`),
      ['v2 ready', 'v1 superseded'],
    );
    assert.equal(body.history[0].reviewerName, 'Maya Restrepo');
  });

  it('serves the newest approved plan for the walkthrough, with its levels', async () => {
    const { body } = await get('/v1/plans/plan_ng1/model').expect(200);
    assert.equal(body.version, 2);
    assert.match(body.contentHash, /^[0-9a-f]{64}$/);
    assert.ok(body.plan.walls.length >= 4);
    assert.equal(body.plan.ceilingHeightM, 3.18);
    // Level 1 is Northgate's only approved level; Level 2 is in review.
    assert.deepEqual(body.levels, [{ planId: 'plan_ng1', level: 1 }]);
    await get('/v1/plans/plan_ng2/model').expect(404);
  });

  it('creates one share link for a ready plan and reuses it', async () => {
    const first = await post('/v1/plans/plan_ng1/share-links').send({}).expect(201);
    assert.match(first.body.url, /\/s\/[\w-]{20,}$/);
    const again = await post('/v1/plans/plan_ng1/share-links').send({}).expect(200);
    assert.equal(again.body.url, first.body.url);
    const detail = await get('/v1/plans/plan_ng1').expect(200);
    assert.equal(detail.body.shareLink.url, first.body.url);
  });

  it('opens a share link without signing in', async () => {
    const { body: link } = await post('/v1/plans/plan_ng1/share-links').send({}).expect(200);
    const token = link.url.split('/s/')[1];
    const { body, headers } = await api(ctx)
      .get(`/v1/share/${token}`)
      .set('Origin', config.publicWebUrl)
      .expect(200);
    assert.equal(headers['access-control-allow-origin'], config.publicWebUrl);
    assert.equal(body.site, 'Northgate Fitness');
    assert.equal(body.level, 1);
    assert.equal(body.version, 2);
    assert.ok(body.plan.walls.length >= 4, 'the walkthrough model comes with the link');
    await api(ctx).get('/v1/share/not-a-real-token').expect(404);
  });

  it('revokes a share link, and a new one can be made', async () => {
    const { body: link } = await post('/v1/plans/plan_ng1/share-links').send({}).expect(200);
    const token = link.url.split('/s/')[1];
    await api(ctx).delete('/v1/plans/plan_ng1/share-links').set('Authorization', `Bearer ${ctx.token}`).expect(204);
    await api(ctx).get(`/v1/share/${token}`).expect(404);
    const detail = await get('/v1/plans/plan_ng1').expect(200);
    assert.equal(detail.body.shareLink, null);
    const fresh = await post('/v1/plans/plan_ng1/share-links').send({}).expect(201);
    assert.notEqual(fresh.body.url, link.url);
  });

  it('refuses to share a plan that is not approved', async () => {
    const res = await post('/v1/plans/plan_rv0/share-links').send({}).expect(409);
    assert.match(res.body.message, /approved/);
  });

  it('never shows one customer another’s plans', async () => {
    const other = await createOtherTenant();
    const { accessToken } = await login(ctx, other);
    const theirs = (path) => api(ctx).get(path).set('Authorization', `Bearer ${accessToken}`);

    assert.deepEqual((await theirs('/v1/plans').expect(200)).body.plans, []);
    // Not 403: do not even confirm the plan exists.
    await theirs('/v1/plans/plan_ng1').expect(404);
    await theirs('/v1/plans/plan_ng1/model').expect(404);
    await api(ctx)
      .delete('/v1/plans/plan_ng1/share-links')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(404);
    await api(ctx)
      .post('/v1/plans/plan_ng1/share-links')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({})
      .expect(404);
    const facilities = await theirs('/v1/facilities').expect(200);
    assert.deepEqual(facilities.body.facilities.map((f) => f.name), ['Other Gym']);
  });
});
