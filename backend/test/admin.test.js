/** Admin (ACC-05..07, B-09, D-08), the audit log, and account removal (A-05, E-06). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pool } from '../src/db/pool.js';
import { sentMail } from '../src/mailer.js';
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

  it('lists accounts with members, gyms and quota use', async () => {
    const { body } = await as('get', '/v1/admin/accounts').expect(200);
    const northgate = body.accounts.find((a) => a.id === DEMO.account);
    assert.deepEqual(
      { members: northgate.members, facilities: northgate.facilities, plansUsed: northgate.plansUsed, planQuota: northgate.planQuota, region: northgate.region },
      { members: 2, facilities: 3, plansUsed: 6, planQuota: 10, region: 'ap-southeast-2' },
    );
  });

  let accountId;
  it('creates an account and invites its first owner, who joins on first sign-in', async () => {
    sentMail.length = 0;
    const { body } = await as('post', '/v1/admin/accounts')
      .send({ name: 'Harbour Gyms', planQuota: 5, ownerEmail: 'Priya@Harbour.example' })
      .expect(201);
    accountId = body.id;
    assert.equal(body.openInvites, 1);
    assert.equal(body.members, 0);
    assert.equal(sentMail.length, 1);
    assert.match(sentMail[0].text, /invited to Harbour Gyms as an owner/);

    const owner = await login(ctx, { email: 'priya@harbour.example', name: 'Priya Nair' });
    assert.deepEqual(owner.accounts.map((a) => `${a.name}:${a.role}`), ['Harbour Gyms:owner']);
  });

  it('invites, changes roles and removes members', async () => {
    await as('post', `/v1/admin/accounts/${accountId}/facilities`).send({ name: 'Harbour Docklands' }).expect(201);
    await as('post', `/v1/admin/accounts/${accountId}/facilities`).send({ name: 'Harbour Docklands' }).expect(409);

    const { body: invite } = await as('post', `/v1/admin/accounts/${accountId}/invites`)
      .send({ email: 'sam@harbour.example', role: 'surveyor' })
      .expect(201);
    // One open invite per email per account.
    await as('post', `/v1/admin/accounts/${accountId}/invites`).send({ email: 'SAM@harbour.example', role: 'owner' }).expect(409);
    // A revoked invite can no longer be taken.
    await as('delete', `/v1/admin/accounts/${accountId}/invites/${invite.id}`).expect(204);
    await login(ctx, { email: 'sam@harbour.example' }, { expect: 403 });

    await as('post', `/v1/admin/accounts/${accountId}/invites`).send({ email: 'sam@harbour.example', role: 'surveyor' }).expect(201);
    const surveyor = await login(ctx, { email: 'sam@harbour.example' });

    const patched = await as('patch', `/v1/admin/accounts/${accountId}`).send({ planQuota: 12 }).expect(200);
    assert.equal(patched.body.planQuota, 12);

    await as('patch', `/v1/admin/accounts/${accountId}/members/${surveyor.user.id}`).send({ role: 'owner' }).expect(204);
    let { body } = await as('get', `/v1/admin/accounts/${accountId}`).expect(200);
    assert.deepEqual(body.members.map((m) => `${m.name} ${m.role}`).sort(), ['Priya Nair owner', 'sam owner']);

    await as('delete', `/v1/admin/accounts/${accountId}/members/${surveyor.user.id}`).expect(204);
    // Their only account is gone: the session cannot be refreshed.
    await api(ctx).raw.post('/v1/auth/refresh').send({ refreshToken: surveyor.refreshToken }).expect(401);
    ({ body } = await as('get', `/v1/admin/accounts/${accountId}`).expect(200));
    assert.deepEqual(body.facilities.map((f) => f.name), ['Harbour Docklands']);
    assert.deepEqual(body.members.map((m) => m.name), ['Priya Nair']);
  });

  it('sets staff roles', async () => {
    const { body } = await as('get', '/v1/admin/staff').expect(200);
    assert.deepEqual(body.staff.map((s) => `${s.name}:${s.staffRole}`), ['Jordan Kaur:admin', 'Maya Restrepo:reviewer']);
    const priya = body.users.find((u) => u.name === 'Priya Nair');
    await as('put', `/v1/admin/staff/${priya.id}`).send({ staffRole: 'reviewer' }).expect(204);
    const { accessToken } = await login(ctx, { email: 'priya@harbour.example' });
    await api(ctx).get('/v1/review/queue').set('Authorization', `Bearer ${accessToken}`).expect(200);
    await as('put', `/v1/admin/staff/${priya.id}`).send({ staffRole: null }).expect(204);
    // An admin cannot demote themselves.
    await as('put', `/v1/admin/staff/${DEMO.admin.id}`).send({ staffRole: null }).expect(400);
  });

  it('keeps an audit log that filters and exports as CSV', async () => {
    const { body } = await as('get', `/v1/admin/audit?accountId=${accountId}`).expect(200);
    const actions = body.entries.map((e) => e.action);
    for (const a of ['ACCOUNT_CREATED', 'INVITE_SENT', 'INVITE_REVOKED', 'INVITE_ACCEPTED', 'FACILITY_ADDED', 'QUOTA_CHANGED', 'MEMBER_ROLE_CHANGED', 'MEMBER_REMOVED']) {
      assert.ok(actions.includes(a), `${a} is logged`);
    }
    const quota = body.entries.find((e) => e.action === 'QUOTA_CHANGED');
    assert.deepEqual(quota.detail, { from: 5, to: 12 });
    assert.equal(quota.actorName, 'Jordan Kaur');

    const paged = await as('get', '/v1/admin/audit?limit=2').expect(200);
    assert.equal(paged.body.entries.length, 2);
    const next = await as('get', `/v1/admin/audit?limit=2&before=${encodeURIComponent(new Date(paged.body.nextBefore).toISOString())}`).expect(200);
    assert.ok(!next.body.entries.some((e) => paged.body.entries.some((p) => p.id === e.id)));

    // A cell that would start a spreadsheet formula is defused.
    await as('patch', `/v1/admin/accounts/${accountId}`).send({ name: '=HYPERLINK("x")' }).expect(200);
    const csv = await as('get', `/v1/admin/audit.csv?accountId=${accountId}`).expect(200);
    assert.match(csv.headers['content-type'], /text\/csv/);
    const lines = csv.text.trim().split('\r\n');
    assert.equal(lines[0], 'time_utc,action,account_id,account,target_type,target_id,target,version,actor_id,actor,detail');
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

  it('removes an account with machines and videos, keeping the audit log by id only (A-05)', async () => {
    // The demo account has machines, a 360 video, a machine model and a
    // generated level: exactly what the old removal tripped over.
    const [[before]] = await pool.query('SELECT COUNT(*) AS n FROM machines WHERE account_id = ?', [DEMO.account]);
    assert.ok(Number(before.n) >= 3);

    await as('post', `/v1/admin/accounts/${DEMO.account}/removal`).send({ confirmName: 'Northgate' }).expect(400);
    const { body } = await as('post', `/v1/admin/accounts/${DEMO.account}/removal`).send({ confirmName: 'Northgate Group' }).expect(202);
    assert.ok(body.jobId);
    const [[job]] = await pool.query('SELECT status, last_error FROM jobs WHERE id = ?', [body.jobId]);
    assert.equal(job.status, 'succeeded', job.last_error);

    for (const table of ['plans', 'plan_versions', 'captures', 'facilities', 'machines', 'machine_models', 'generated_models', 'share_links', 'memberships', 'invites']) {
      const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id = ?`, [DEMO.account]);
      assert.equal(Number(n), 0, `${table} is empty`);
    }
    const [[videos]] = await pool.query('SELECT COUNT(*) AS n FROM machine_videos');
    assert.equal(Number(videos.n), 0);
    // Lee only belonged here, and is gone; Sam is still in Kestrel.
    const [people] = await pool.query('SELECT id FROM users WHERE id IN (?, ?)', [DEMO.owner.id, DEMO.surveyor.id]);
    assert.deepEqual(people.map((p) => p.id), [DEMO.owner.id]);

    const [log] = await pool.query('SELECT * FROM audit_log WHERE account_id = ?', [DEMO.account]);
    assert.ok(log.length > 5, 'the log is kept');
    const old = log.filter((l) => !['ACCOUNT_DATA_REMOVED'].includes(l.action));
    assert.ok(old.every((l) => l.target_label === null && l.actor_name === null), 'with identifiers only');
    assert.ok(old.some((l) => l.actor_user_id === DEMO.reviewer.id), 'approvals stay attributable by id');
    const done = log.find((l) => l.action === 'ACCOUNT_DATA_REMOVED');
    assert.equal(done.detail.plans, 6);

    // Sam can no longer act in Northgate.
    const sam = await login(ctx, DEMO.owner);
    assert.deepEqual(sam.accounts.map((a) => a.name), ['Kestrel Health Clubs']);
    await api(ctx).get('/v1/plans').set('Authorization', `Bearer ${sam.accessToken}`).expect(403);
    await as('post', `/v1/admin/accounts/${DEMO.account}/removal`).send({ confirmName: 'x' }).expect(409);
  });
});
