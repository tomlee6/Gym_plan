/** Installers and corrections from site (migration 007). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pool } from '../src/db/pool.js';
import { api, DEMO, login, useTestServer } from './helpers.js';

const ctx = useTestServer();
const INSTALLER = { email: 'ines.fitter@installs.example', name: 'Ines Fitter' };
const tokens = {};
const as = (who, method, path) => api(ctx)[method](path).set('Authorization', `Bearer ${tokens[who]}`);
const plan = DEMO.plans.ng1;

describe('corrections from site', () => {
  it('an admin invites an installer, who signs in to the account as one', async () => {
    tokens.admin = (await login(ctx, DEMO.admin)).accessToken;
    tokens.reviewer = (await login(ctx, DEMO.reviewer)).accessToken;
    tokens.owner = ctx.token;
    tokens.surveyor = (await login(ctx, DEMO.surveyor)).accessToken;
    await api(ctx)
      .post(`/v1/admin/accounts/${DEMO.account}/invites`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({ email: INSTALLER.email, role: 'installer' })
      .expect(201);
    const me = await login(ctx, INSTALLER);
    tokens.installer = me.accessToken;
    assert.deepEqual(
      me.accounts.filter((a) => a.id === DEMO.account).map((a) => a.role),
      ['installer'],
    );
  });

  it('an installer sees plans but cannot scan, upload or share', async () => {
    await as('installer', 'get', '/v1/plans').expect(200);
    await as('installer', 'get', `/v1/plans/${plan}/model`).expect(200);
    await as('installer', 'post', `/v1/plans/${plan}/share-links`).send({}).expect(403);
    await as('installer', 'get', '/v1/objects').expect(403);
    await as('installer', 'post', '/v1/captures/drawings').send({}).expect(403);
  });

  let model;
  let quotaBefore;
  it('refuses a correction on an old version, without a note, or from a surveyor', async () => {
    ({ body: model } = await as('installer', 'get', `/v1/plans/${plan}/model`).expect(200));
    assert.equal(model.versionId, DEMO.versions.ng1v2);
    quotaBefore = (await as('owner', 'get', '/v1/me').expect(200)).body;

    const send = (who, body) => as(who, 'post', `/v1/plans/${plan}/corrections`).send(body);
    await send('installer', { basedOnVersionId: DEMO.versions.ng1v1, plan: model.plan, note: 'Column is 40 cm further east.' }).expect(409);
    await send('installer', { basedOnVersionId: model.versionId, plan: model.plan, note: 'no' }).expect(400);
    await send('surveyor', { basedOnVersionId: model.versionId, plan: model.plan, note: 'Column is 40 cm further east.' }).expect(403);
    await send('installer', { basedOnVersionId: model.versionId, plan: { nonsense: true }, note: 'Column is 40 cm further east.' }).expect(400);
  });

  let correctionId;
  it('sends a correction to the reviewer queue as the next version, leaving the approved plan live', async () => {
    const corrected = structuredClone(model.plan);
    corrected.walls[0].b = [corrected.walls[0].b[0] + 0.4, corrected.walls[0].b[1]];
    const { body } = await as('installer', 'post', `/v1/plans/${plan}/corrections`)
      .send({ basedOnVersionId: model.versionId, plan: corrected, note: 'North wall runs 40 cm further than the plan shows.' })
      .expect(201);
    correctionId = body.id;
    assert.equal(body.version, 3);

    // Only one at a time.
    await as('owner', 'post', `/v1/plans/${plan}/corrections`)
      .send({ basedOnVersionId: model.versionId, plan: corrected, note: 'Another correction.' })
      .expect(409);

    // The walkthrough is still the approved version 2.
    const { body: still } = await as('owner', 'get', `/v1/plans/${plan}/model`).expect(200);
    assert.equal(still.version, 2);

    // Not counted against the monthly quota.
    const { body: after } = await as('owner', 'get', '/v1/me').expect(200);
    assert.deepEqual(after.account?.plansUsed ?? after.plansUsed, quotaBefore.account?.plansUsed ?? quotaBefore.plansUsed);

    const [[logged]] = await pool.query(`SELECT actor_name FROM audit_log WHERE action = 'CORRECTION_SUBMITTED' AND target_id = ?`, [plan]);
    assert.equal(logged.actor_name, INSTALLER.name);
  });

  it('shows the reviewer the note, as a flag that must be looked at', async () => {
    const { body: queue } = await as('reviewer', 'get', '/v1/review/queue').expect(200);
    const listed = (queue.versions ?? queue.queue ?? queue.items ?? []).find((v) => v.id === correctionId);
    assert.ok(listed, 'in the queue');
    assert.equal(listed.origin, 'correction');

    const { body: v } = await as('reviewer', 'get', `/v1/review/versions/${correctionId}`).expect(200);
    assert.deepEqual(v.correction, { note: 'North wall runs 40 cm further than the plan shows.', by: INSTALLER.name });
    const flag = v.plan.flags.find((f) => f.kind === 'site_correction');
    assert.equal(flag.status, 'open');
    assert.match(flag.detail, /40 cm/);
  });

  it('a rejected correction changes nothing, and a new one can then be sent', async () => {
    await as('reviewer', 'post', `/v1/review/versions/${correctionId}/start`).send({}).expect(204);
    await as('reviewer', 'post', `/v1/review/versions/${correctionId}/reject`).send({ reason: 'Other', note: 'Measured again: the plan was right.' }).expect(204);
    const { body: still } = await as('installer', 'get', `/v1/plans/${plan}/model`).expect(200);
    assert.equal(still.version, 2);
    assert.equal(still.versionId, DEMO.versions.ng1v2);

    const { body: again } = await as('installer', 'post', `/v1/plans/${plan}/corrections`)
      .send({ basedOnVersionId: still.versionId, plan: still.plan, note: 'Second try: door swings into the corridor.' })
      .expect(201);
    assert.equal(again.version, 4);
  });
});
