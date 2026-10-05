import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sentMail } from '../src/mailer.js';
import { api, DEMO, login, useTestServer } from './helpers.js';

const ctx = useTestServer();

describe('auth', () => {
  it('signs in with the demo account', async () => {
    const body = await login(ctx);
    assert.ok(body.accessToken);
    assert.ok(body.refreshToken);
    assert.equal(body.expiresIn, 1800);
    assert.deepEqual(body.user, {
      id: DEMO.owner.id,
      name: 'Sam Okafor',
      email: DEMO.owner.email,
      initials: 'SO',
      role: 'owner',
    });
  });

  it('accepts the email in any case, with spaces', async () => {
    await api(ctx)
      .post('/v1/auth/login')
      .send({ email: '  SAM.Okafor@NorthgateFitness.com ', password: DEMO.owner.password })
      .expect(200);
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const wrong = await api(ctx)
      .post('/v1/auth/login')
      .send({ email: DEMO.owner.email, password: 'nope-nope' })
      .expect(401);
    const unknown = await api(ctx)
      .post('/v1/auth/login')
      .send({ email: 'nobody@example.com', password: 'nope-nope' })
      .expect(401);
    assert.equal(wrong.body.message, 'Incorrect email or password.');
    assert.equal(unknown.body.message, wrong.body.message);
  });

  it('rejects a malformed email with a readable message', async () => {
    const res = await api(ctx)
      .post('/v1/auth/login')
      .send({ email: 'not-an-email', password: 'x' })
      .expect(400);
    assert.match(res.body.message, /valid email/);
  });

  it('protects the API with the access token', async () => {
    await api(ctx).get('/v1/me').expect(401);
    await api(ctx).get('/v1/me').set('Authorization', 'Bearer forged.token.here').expect(401);
    const { accessToken } = await login(ctx);
    await api(ctx).get('/v1/me').set('Authorization', `Bearer ${accessToken}`).expect(200);
  });

  it('rotates refresh tokens, and a reused one ends every session', async () => {
    const first = await login(ctx);
    const second = await api(ctx)
      .post('/v1/auth/refresh')
      .send({ refreshToken: first.refreshToken })
      .expect(200);
    assert.notEqual(second.body.refreshToken, first.refreshToken);

    // The old token again: someone copied it.
    await api(ctx).post('/v1/auth/refresh').send({ refreshToken: first.refreshToken }).expect(401);
    // ...so the legitimate newer one is revoked too.
    await api(ctx)
      .post('/v1/auth/refresh')
      .send({ refreshToken: second.body.refreshToken })
      .expect(401);
  });

  it('signs out by revoking the refresh token', async () => {
    const { refreshToken } = await login(ctx);
    await api(ctx).post('/v1/auth/logout').send({ refreshToken }).expect(204);
    await api(ctx).post('/v1/auth/refresh').send({ refreshToken }).expect(401);
  });

  it('password reset: same answer for everyone, working link for real users', async () => {
    sentMail.length = 0;
    await api(ctx).post('/v1/auth/password-reset').send({ email: 'nobody@example.com' }).expect(202);
    assert.equal(sentMail.length, 0);

    const { refreshToken } = await login(ctx);
    await api(ctx).post('/v1/auth/password-reset').send({ email: DEMO.owner.email }).expect(202);
    assert.equal(sentMail.length, 1);
    const token = sentMail[0].text.match(/token=([\w-]+)/)[1];

    await api(ctx)
      .post('/v1/auth/password-reset/confirm')
      .send({ token, password: 'a-new-password' })
      .expect(204);
    // The link works once.
    await api(ctx)
      .post('/v1/auth/password-reset/confirm')
      .send({ token, password: 'another-password' })
      .expect(400);

    // Old sessions are gone; the new password works.
    await api(ctx).post('/v1/auth/refresh').send({ refreshToken }).expect(401);
    await api(ctx)
      .post('/v1/auth/login')
      .send({ email: DEMO.owner.email, password: 'a-new-password' })
      .expect(200);
    await api(ctx)
      .post('/v1/auth/login')
      .send({ email: DEMO.owner.email, password: DEMO.owner.password })
      .expect(401);
  });
});
