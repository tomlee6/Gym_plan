/** Sign-in through the GoalCert Hub, sessions and Hub events (B-01..B-06, D-09). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { config, productionProblems } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { hub } from '../src/hub/index.js';
import { signHubEvent } from '../src/modules/hub-events.js';
import { api, DEMO, hubCode, login, useTestServer } from './helpers.js';

const ctx = useTestServer();

function sendEvent(event, { timestamp = Math.floor(Date.now() / 1000), secret } = {}) {
  const body = JSON.stringify(event);
  return api(ctx)
    .raw.post('/v1/hub/events')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Timestamp', String(timestamp))
    .set('X-Hub-Signature', signHubEvent(body, timestamp, secret))
    .send(body);
}

describe('Hub sign-in', () => {
  it('tells clients where the Hub is', async () => {
    const { body } = await api(ctx).raw.get('/v1/auth/hub/config').expect(200);
    assert.equal(body.clientId, config.hub.clientId);
    assert.match(body.authorizeUrl, /\/dev-hub\/authorize$/);
    assert.deepEqual(body.redirectUris, { web: config.hub.webRedirectUri, ios: config.hub.iosRedirectUri });
  });

  it('swaps a Hub code for Flex tokens, with the accounts', async () => {
    const body = await login(ctx);
    assert.ok(body.accessToken && body.refreshToken);
    assert.equal(body.expiresIn, 1800);
    assert.deepEqual(body.user, {
      id: DEMO.owner.id,
      name: 'Sam Okafor',
      email: DEMO.owner.email,
      initials: 'SO',
      staffRole: null,
    });
    assert.deepEqual(
      body.accounts.map((a) => `${a.name}:${a.role}`),
      ['Kestrel Health Clubs:surveyor', 'Northgate Group:owner'],
    );
  });

  it('a code works once, and only with its own verifier and nonce', async () => {
    const good = await hubCode(DEMO.owner);
    await api(ctx).raw.post('/v1/auth/hub').send({ ...good, codeVerifier: 'x'.repeat(43) }).expect(401);
    // The failed try used it up.
    await api(ctx).raw.post('/v1/auth/hub').send(good).expect(401);

    const again = await hubCode(DEMO.owner);
    await api(ctx).raw.post('/v1/auth/hub').send({ ...again, nonce: 'not-the-nonce' }).expect(401);

    const wrongPlace = await hubCode(DEMO.owner);
    await api(ctx).raw.post('/v1/auth/hub').send({ ...wrongPlace, redirectUri: 'https://evil.example/cb' }).expect(400);
  });

  it('refuses a token signed by anyone but the Hub, or for another organisation', async () => {
    const outsider = hub().person({ email: 'someone@elsewhere.example', org: 'not-flex' });
    const res = await api(ctx).raw.post('/v1/auth/hub').send(await hubCode(outsider)).expect(403);
    assert.equal(res.body.code, 'no_access');
  });

  it('refuses a Hub user with no access, and creates nobody', async () => {
    const res = await login(ctx, { email: 'stranger@example.com' }, { expect: 403 });
    assert.equal(res.code, 'no_access');
    const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM users WHERE email = 'stranger@example.com'`);
    assert.equal(Number(n), 0);
  });

  it('has no password sign-in or reset any more (B-03)', async () => {
    await api(ctx).raw.post('/v1/auth/login').send({ email: DEMO.owner.email, password: 'flex1234' }).expect(404);
    await api(ctx).raw.post('/v1/auth/password-reset').send({ email: DEMO.owner.email }).expect(404);
  });
});

describe('sessions', () => {
  it('protects the API with the access token', async () => {
    await api(ctx).get('/v1/me').expect(401);
    await api(ctx).get('/v1/me').set('Authorization', 'Bearer forged.token.here').expect(401);
    const { accessToken } = await login(ctx);
    await api(ctx).get('/v1/me').set('Authorization', `Bearer ${accessToken}`).expect(200);
  });

  it('rotates refresh tokens, and a reused one ends every session', async () => {
    const first = await login(ctx);
    const second = await api(ctx).raw.post('/v1/auth/refresh').send({ refreshToken: first.refreshToken }).expect(200);
    assert.notEqual(second.body.refreshToken, first.refreshToken);
    assert.equal(second.body.accounts.length, 2);

    await api(ctx).raw.post('/v1/auth/refresh').send({ refreshToken: first.refreshToken }).expect(401);
    await api(ctx).raw.post('/v1/auth/refresh').send({ refreshToken: second.body.refreshToken }).expect(401);
  });

  it('web sessions end the same day, phone sessions slide for 60 days (B-06)', async () => {
    const web = await login(ctx, DEMO.owner, { client: 'web' });
    const ios = await login(ctx, DEMO.owner, { client: 'ios' });
    const [[w]] = await pool.query(
      `SELECT ROUND(TIMESTAMPDIFF(SECOND, created_at, absolute_expires_at) / 3600) AS h, client FROM sessions WHERE token_hash = SHA2(?, 256)`,
      [web.refreshToken],
    );
    const [[i]] = await pool.query(
      `SELECT ROUND(TIMESTAMPDIFF(SECOND, created_at, expires_at) / 86400) AS d, ROUND(TIMESTAMPDIFF(SECOND, created_at, absolute_expires_at) / 86400) AS abs, client
       FROM sessions WHERE token_hash = SHA2(?, 256)`,
      [ios.refreshToken],
    );
    assert.deepEqual([w.client, Number(w.h)], ['web', 12]);
    assert.deepEqual([i.client, Number(i.d), Number(i.abs)], ['ios', 60, 180]);

    // A refresh never stretches the absolute limit.
    const next = await api(ctx).raw.post('/v1/auth/refresh').send({ refreshToken: ios.refreshToken }).expect(200);
    const [[n]] = await pool.query(`SELECT absolute_expires_at FROM sessions WHERE token_hash = SHA2(?, 256)`, [
      next.body.refreshToken,
    ]);
    const [[o]] = await pool.query(`SELECT absolute_expires_at FROM sessions WHERE token_hash = SHA2(?, 256)`, [
      ios.refreshToken,
    ]);
    assert.equal(n.absolute_expires_at.getTime(), o.absolute_expires_at.getTime());
  });

  it('signs out by revoking the refresh token', async () => {
    const { refreshToken } = await login(ctx);
    await api(ctx).raw.post('/v1/auth/logout').send({ refreshToken }).expect(204);
    await api(ctx).raw.post('/v1/auth/refresh').send({ refreshToken }).expect(401);
  });
});

describe('invites (B-05)', () => {
  it('the first sign-in with a verified matching email takes the invite; after that the Hub id is what counts', async () => {
    const admin = (await login(ctx, DEMO.admin)).accessToken;
    const { body: invite } = await api(ctx)
      .post(`/v1/admin/accounts/${DEMO.account}/invites`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ email: 'New.Person@Example.com', role: 'surveyor' })
      .expect(201);
    assert.ok(invite.id);

    // An unverified email cannot claim it.
    hub().person({ email: 'new.person@example.com', emailVerified: false });
    await login(ctx, { email: 'new.person@example.com' }, { expect: 403 });

    const p = hub().person({ email: 'new.person@example.com' });
    p.emailVerified = true;
    const body = await login(ctx, { sub: p.sub });
    assert.deepEqual(body.accounts.map((a) => `${a.name}:${a.role}`), ['Northgate Group:surveyor']);

    // A later email change at the Hub changes nothing about access.
    p.email = 'renamed@example.com';
    const again = await login(ctx, { sub: p.sub });
    assert.equal(again.user.id, body.user.id);
    assert.equal(again.accounts.length, 1);

    const [[row]] = await pool.query('SELECT accepted_user_id, open_email FROM invites WHERE id = ?', [invite.id]);
    assert.deepEqual(row, { accepted_user_id: body.user.id, open_email: null });
  });
});

describe('Hub events (B-02)', () => {
  it('refuses an unsigned, mis-signed or stale event', async () => {
    const event = { id: 'evt-0', type: 'user.updated', data: { sub: DEMO.surveyor.sub, name: 'X' } };
    await api(ctx).raw.post('/v1/hub/events').set('Content-Type', 'application/json').send(event).expect(401);
    await sendEvent(event, { secret: 'wrong-secret' }).expect(401);
    await sendEvent(event, { timestamp: Math.floor(Date.now() / 1000) - 3600 }).expect(401);
  });

  it('updates name and email, once per event id', async () => {
    const event = { id: 'evt-1', type: 'user.updated', data: { sub: DEMO.surveyor.sub, name: 'Lee Tan-Wright', email: 'Lee@Northgate.example' } };
    const first = await sendEvent(event).expect(200);
    assert.equal(first.body.outcome, 'applied');
    const [[u]] = await pool.query('SELECT name, email FROM users WHERE id = ?', [DEMO.surveyor.id]);
    assert.deepEqual(u, { name: 'Lee Tan-Wright', email: 'lee@northgate.example' });

    await pool.query(`UPDATE users SET name = 'Lee Tan' WHERE id = ?`, [DEMO.surveyor.id]);
    const repeat = await sendEvent(event).expect(200);
    assert.equal(repeat.body.outcome, 'duplicate');
    const [[after]] = await pool.query('SELECT name FROM users WHERE id = ?', [DEMO.surveyor.id]);
    assert.equal(after.name, 'Lee Tan');
  });

  it('a disabled user is signed out everywhere and cannot sign in', async () => {
    const phone = await login(ctx, DEMO.surveyor, { client: 'ios' });
    await sendEvent({ id: 'evt-2', type: 'user.disabled', data: { sub: DEMO.surveyor.sub } }).expect(200);
    await api(ctx).raw.post('/v1/auth/refresh').send({ refreshToken: phone.refreshToken }).expect(401);
    await login(ctx, DEMO.surveyor, { expect: 403 });

    await sendEvent({ id: 'evt-3', type: 'user.enabled', data: { sub: DEMO.surveyor.sub } }).expect(200);
    await login(ctx, DEMO.surveyor);
  });
});

describe('production start-up checks (D-09)', () => {
  const prod = (over = {}) => ({
    ...config,
    isProduction: true,
    awsRegion: 'ap-southeast-2',
    publicApiUrl: 'https://api.gym.example',
    publicWebUrl: 'https://gym.example',
    auth: { ...config.auth, jwtSecret: 'j'.repeat(48) },
    hub: {
      ...config.hub,
      driver: 'oidc',
      clientSecret: 'c'.repeat(48),
      eventsSecret: 'e'.repeat(48),
      issuer: 'https://hub.example',
      authorizeUrl: 'https://hub.example/a',
      tokenUrl: 'https://hub.example/t',
      jwksUrl: 'https://hub.example/k',
    },
    storage: { ...config.storage, driver: 's3', s3Region: 'ap-southeast-2', signingSecret: 's'.repeat(48) },
    uploads: { ...config.uploads, allowSimulatedScans: false },
    jobs: { ...config.jobs, driver: 'sqs', queueUrl: 'https://sqs.ap-southeast-2.amazonaws.com/1/jobs' },
    mail: { ...config.mail, driver: 'ses' },
    ...over,
  });

  it('accepts a sound production set-up', () => {
    assert.deepEqual(productionProblems(prod()), []);
  });

  it('accepts Cognito in Sydney, which needs no events secret, and refuses a pool elsewhere', () => {
    const cognito = (region) =>
      prod({ hub: { ...prod().hub, driver: 'cognito', eventsSecret: '', cognito: { userPoolId: `${region}_abc`, region } } });
    assert.deepEqual(productionProblems(cognito('ap-southeast-2')), []);
    assert.match(productionProblems(cognito('us-east-1')).join('\n'), /COGNITO_USER_POOL_ID/);
    assert.match(productionProblems(prod({ hub: { ...prod().hub, driver: 'dev' } })).join('\n'), /HUB_DRIVER/);
  });

  it('refuses simulated scans, local storage, another region and weak secrets', () => {
    const problems = productionProblems(
      prod({
        uploads: { ...config.uploads, allowSimulatedScans: true },
        storage: { ...config.storage, driver: 'local', s3Region: 'eu-west-2', signingSecret: 'change-me' },
        auth: { ...config.auth, jwtSecret: 'short' },
      }),
    ).join('\n');
    for (const re of [/ALLOW_SIMULATED_SCANS/, /STORAGE_DRIVER/, /S3_REGION/, /JWT_SECRET/, /STORAGE_SIGNING_SECRET/]) {
      assert.match(problems, re);
    }
  });
});
