/** Admin (ACC-05..07) and the audit log. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pool } from '../src/db/pool.js';
import { api, DEMO, login, useTestServer } from './helpers.js';

const ctx = useTestServer();
let admin;
const as = (method, path) => api(ctx)[method](path).set('Authorization', `Bearer ${admin}`);

describe('admin', () => {
  it('is for admins only', async () => {
    admin = (await login(ctx, DEMO.admin)).accessToken;
    await api(ctx).get('/v1/admin/accounts').set('Authorization', `Bearer ${ctx.token}`).expect(403);
    const { accessToken: reviewer } = await login(ctx, DEMO.reviewer);
    await api(ctx).get('/v1/admin/accounts').set('Authorization', `Bearer ${reviewer}`).expect(403);
  });

  it('lists accounts with users, gyms and quota use', async () => {
    const { body } = await as('get', '/v1/admin/accounts').expect(200);
    const northgate = body.accounts.find((a) => a.id === DEMO.org);
    assert.deepEqual(
      { users: northgate.users, facilities: northgate.facilities, plansUsed: northgate.plansUsed, planQuota: northgate.planQuota, operator: northgate.operator },
      { users: 1, facilities: 3, plansUsed: 6, planQuota: 10, operator: false },
    );
    assert.equal(body.accounts.find((a) => a.id === DEMO.flexOrg).operator, true);
  });

  let accountId;
  it('creates an account whose owner can sign in', async () => {
    const { body } = await as('post', '/v1/admin/accounts')
      .send({
        name: 'Kestrel Health Clubs',
        planQuota: 5,
        owner: { name: 'Priya Nair', email: 'Priya@Kestrel.example', password: 'kestrel-pass-1' },
      })
      .expect(201);
    accountId = body.id;
    assert.equal(body.planQuota, 5);
    assert.equal(body.users, 1);
    const owner = await login(ctx, { email: 'priya@kestrel.example', password: 'kestrel-pass-1' });
    assert.equal(owner.user.role, 'owner');

    // Emails are unique across every account.
    await as('post', `/v1/admin/accounts/${accountId}/users`)
      .send({ name: 'Dup', email: DEMO.owner.email, password: 'whatever-123' })
      .expect(409);
  });

  it('adds gyms and users, sets the quota, and removes users', async () => {
    await as('post', `/v1/admin/accounts/${accountId}/facilities`).send({ name: 'Kestrel Fitzroy' }).expect(201);
    await as('post', `/v1/admin/accounts/${accountId}/facilities`).send({ name: 'Kestrel Fitzroy' }).expect(409);
    const { body: added } = await as('post', `/v1/admin/accounts/${accountId}/users`)
      .send({ name: 'Sam Surveyor', email: 'sam@kestrel.example', role: 'surveyor', password: 'surveyor-1' })
      .expect(201);
    const surveyor = await login(ctx, { email: 'sam@kestrel.example', password: 'surveyor-1' });

    const patched = await as('patch', `/v1/admin/accounts/${accountId}`).send({ planQuota: 12 }).expect(200);
    assert.equal(patched.body.planQuota, 12);

    await as('delete', `/v1/admin/accounts/${accountId}/users/${added.id}`).expect(204);
    // Removed: cannot sign in, and the session cannot be refreshed.
    await api(ctx).post('/v1/auth/login').send({ email: 'sam@kestrel.example', password: 'surveyor-1' }).expect(401);
    await api(ctx).post('/v1/auth/refresh').send({ refreshToken: surveyor.refreshToken }).expect(401);

    const { body } = await as('get', `/v1/admin/accounts/${accountId}`).expect(200);
    assert.deepEqual(body.facilities.map((f) => f.name), ['Kestrel Fitzroy']);
    assert.deepEqual(body.users.map((u) => `${u.name} ${u.active}`), ['Priya Nair true', 'Sam Surveyor false']);
  });

  it('keeps an audit log that filters and exports as CSV', async () => {
    const { body } = await as('get', `/v1/admin/audit?orgId=${accountId}`).expect(200);
    const actions = body.entries.map((e) => e.action);
    for (const a of ['ACCOUNT_CREATED', 'USER_ADDED', 'FACILITY_ADDED', 'QUOTA_CHANGED', 'USER_REMOVED']) {
      assert.ok(actions.includes(a), `${a} is logged`);
    }
    assert.ok(body.entries.every((e) => e.actorName === 'Jordan Kaur'));
    const quota = body.entries.find((e) => e.action === 'QUOTA_CHANGED');
    assert.deepEqual(quota.detail, { from: 5, to: 12 });

    const paged = await as('get', '/v1/admin/audit?limit=2').expect(200);
    assert.equal(paged.body.entries.length, 2);
    const next = await as('get', `/v1/admin/audit?limit=2&before=${encodeURIComponent(new Date(paged.body.nextBefore).toISOString())}`).expect(200);
    assert.ok(!next.body.entries.some((e) => paged.body.entries.some((p) => p.id === e.id)));

    // A cell that would start a spreadsheet formula is defused.
    await as('patch', `/v1/admin/accounts/${accountId}`).send({ name: '=HYPERLINK("x")' }).expect(200);
    const csv = await as('get', `/v1/admin/audit.csv?orgId=${accountId}`).expect(200);
    assert.match(csv.headers['content-type'], /text\/csv/);
    const lines = csv.text.trim().split('\r\n');
    assert.equal(lines[0], 'time_utc,action,account_id,account,target_type,target_id,target,version,actor_id,actor,detail');
    assert.ok(lines.length >= 7);
    assert.ok(!/,=HYPERLINK/.test(csv.text), 'no cell begins with =');
    assert.match(csv.text, /'=HYPERLINK/);
  });

  it('shows reviewer time per reviewer', async () => {
    const { body } = await as('get', '/v1/admin/reviewers').expect(200);
    const maya = body.reviewers.find((r) => r.name === 'Maya Restrepo');
    assert.equal(maya.weeks.length, 8);
    assert.equal(maya.weeks[7].weeksAgo, 0);
    assert.equal(body.targets.scanSeconds, 900);
  });

  it('removes an account’s data but keeps the audit log, by id only', async () => {
    await as('post', `/v1/admin/accounts/${DEMO.org}/removal`).send({ confirmName: 'Northgate' }).expect(400);
    await as('post', `/v1/admin/accounts/${DEMO.flexOrg}/removal`)
      .send({ confirmName: 'Flex Motion Technologies' })
      .expect(400);

    const { body } = await as('post', `/v1/admin/accounts/${DEMO.org}/removal`)
      .send({ confirmName: 'Northgate Group' })
      .expect(200);
    assert.equal(body.removed.plans, 6);
    assert.equal(body.removed.users, 1);

    for (const table of ['plans', 'plan_versions', 'captures', 'facilities', 'users', 'share_links']) {
      const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id = ?`, [DEMO.org]);
      assert.equal(Number(n), 0, `${table} is empty`);
    }
    const [log] = await pool.query('SELECT * FROM audit_log WHERE org_id = ?', [DEMO.org]);
    assert.ok(log.length > 5, 'the log is kept');
    const old = log.filter((l) => l.action !== 'ACCOUNT_DATA_REMOVED');
    assert.ok(old.every((l) => l.target_label === null && l.actor_name === null), 'with identifiers only');
    assert.ok(old.some((l) => l.actor_id === DEMO.reviewer.id), 'approvals stay attributable by id');

    await api(ctx).post('/v1/auth/login').send({ email: DEMO.owner.email, password: DEMO.owner.password }).expect(401);
    await as('post', `/v1/admin/accounts/${DEMO.org}/removal`).send({ confirmName: 'x' }).expect(409);
  });
});
