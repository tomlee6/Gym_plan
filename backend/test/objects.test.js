/**
 * 3D object scans from the phone: registering one, uploading its USDZ in
 * signed parts, finishing it, listing and downloading it, and removing it.
 *
 * Real uploads against the real local storage driver, the way
 * equipment.test.js does.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import { pool } from '../src/db/pool.js';
import { api, createOtherTenant, DEMO, login, putPart, useTestServer } from './helpers.js';

const ctx = useTestServer();
const PART = 5 * 1024 * 1024;
const USDZ = 'model/vnd.usdz+zip';

const post = (path, t = ctx.token) => api(ctx).post(path).set('Authorization', `Bearer ${t}`);
const get = (path, t = ctx.token) => api(ctx).get(path).set('Authorization', `Bearer ${t}`);
const del = (path, t = ctx.token) => api(ctx).delete(path).set('Authorization', `Bearer ${t}`);

let keys = 0;
function register(body, { key = `obj-${++keys}`, token } = {}) {
  return post('/v1/objects', token)
    .set('Idempotency-Key', key)
    .send({ name: 'Leg press', bytes: 1024, contentType: USDZ, partSize: PART, ...body });
}

/** Registers, uploads and finishes a scan; returns its id. */
async function stored(body = {}) {
  const model = randomBytes(1024);
  const opened = await register({ bytes: model.length, ...body }).expect(201);
  await putPart(ctx, opened.body.file.parts[0].url, model).expect(200);
  await post(`/v1/objects/${opened.body.objectId}/complete`).send({}).expect(200);
  return opened.body.objectId;
}

describe('3D object scans', () => {
  it('uploads in parts, reports what is missing, then stores it', async () => {
    const model = randomBytes(PART * 2 + 100);
    const opened = await register({
      name: 'Rower',
      facilityId: DEMO.facilities.northgate,
      bytes: model.length,
      photoCount: 84,
      scannedAt: '2026-10-31T11:20:00Z',
    }).expect(201);
    assert.equal(opened.body.status, 'uploading');
    assert.equal(opened.body.file.parts.length, 3);
    const id = opened.body.objectId;

    const row = await pool.query('SELECT * FROM object_scans WHERE id = ?', [id]).then(([r]) => r[0]);
    assert.equal(row.storage_key, `accounts/${DEMO.account}/objects/${id}/object.usdz`);
    assert.equal(row.facility_id, DEMO.facilities.northgate);

    await putPart(ctx, opened.body.file.parts[0].url, model.subarray(0, PART)).expect(200);
    await putPart(ctx, opened.body.file.parts[2].url, model.subarray(PART * 2)).expect(200);

    const early = await post(`/v1/objects/${id}/complete`).send({}).expect(200);
    assert.equal(early.body.status, 'incomplete');
    assert.deepEqual(early.body.missing, [{ fileId: id, parts: [2] }]);
    // Not listed until it has landed.
    assert.equal((await get('/v1/objects').expect(200)).body.objects.length, 0);

    const fresh = await post(`/v1/objects/${id}/uploads/refresh`).send({ parts: [2] }).expect(200);
    await putPart(ctx, fresh.body.parts[0].url, model.subarray(PART, PART * 2)).expect(200);
    const done = await post(`/v1/objects/${id}/complete`).send({}).expect(200);
    assert.equal(done.body.status, 'ready');
    // Finishing again is harmless.
    await post(`/v1/objects/${id}/complete`).send({}).expect(200);

    const list = (await get('/v1/objects').expect(200)).body.objects;
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'Rower');
    assert.equal(list[0].facility.name, 'Northgate Fitness');
    assert.equal(list[0].photoCount, 84);
    assert.equal(list[0].bytes, model.length);
    assert.equal(list[0].downloadUrl, undefined);

    const one = (await get(`/v1/objects/${id}`).expect(200)).body;
    assert.match(one.downloadUrl, /\/storage\/local\/objects\//);
    const u = new URL(one.downloadUrl);
    const file = await api(ctx)
      .raw.get(u.pathname + u.search)
      .buffer(true)
      .parse((r, done) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    assert.equal(Buffer.compare(file.body, model), 0);

    const [[logged]] = await pool.query(
      `SELECT * FROM audit_log WHERE action = 'OBJECT_SCANNED' AND target_id = ?`,
      [id],
    );
    assert.equal(logged.target_label, 'Rower');

    await del(`/v1/objects/${id}`).expect(204);
  });

  it('a retry with the same key is the same scan', async () => {
    const a = await register({}, { key: 'same-key' }).expect(201);
    const b = await register({}, { key: 'same-key' }).expect(200);
    assert.equal(b.body.objectId, a.body.objectId);
    assert.equal(b.body.status, 'uploading');
    assert.equal(b.body.file.parts.length, 1);
    await del(`/v1/objects/${a.body.objectId}`).expect(204);
  });

  it('checks what it is given', async () => {
    await post('/v1/objects').send({ name: 'X', bytes: 10, contentType: USDZ, partSize: PART }).expect(400);
    await register({ contentType: 'video/mp4' }).expect(400);
    await register({ name: '' }).expect(400);
    await register({ bytes: 2 * 1024 * 1024 * 1024 }).expect(400);
    await register({ facilityId: '01920000-0000-7000-8000-00000000ffff' }).expect(404);
  });

  it('can be filtered by facility, and removed with its file', async () => {
    const here = await stored({ facilityId: DEMO.facilities.northgate });
    const there = await stored({ facilityId: DEMO.facilities.riverside });

    const northgate = (await get(`/v1/objects?facilityId=${DEMO.facilities.northgate}`).expect(200)).body.objects;
    assert.deepEqual(
      northgate.map((o) => o.objectId),
      [here],
    );

    const [[row]] = await pool.query('SELECT storage_key FROM object_scans WHERE id = ?', [there]);
    assert.equal(await ctx.storage.exists(row.storage_key), true);
    await del(`/v1/objects/${there}`).expect(204);
    assert.equal(await ctx.storage.exists(row.storage_key), false);
    await get(`/v1/objects/${there}`).expect(404);
    await del(`/v1/objects/${here}`).expect(204);
  });

  it('a surveyor can scan; staff and other accounts cannot see them', async () => {
    const { accessToken: surveyor } = await login(ctx, DEMO.surveyor);
    const opened = await register({}, { token: surveyor }).expect(201);
    const id = opened.body.objectId;
    await putPart(ctx, opened.body.file.parts[0].url, randomBytes(1024)).expect(200);
    await post(`/v1/objects/${id}/complete`, surveyor).send({}).expect(200);
    assert.equal((await get('/v1/objects').expect(200)).body.objects[0].scannedBy, DEMO.surveyor.name);

    const other = await createOtherTenant();
    const { accessToken: otherToken } = await login(ctx, { sub: other.sub });
    await api(ctx)
      .get(`/v1/objects/${id}`)
      .set('X-Account-Id', other.accountId)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
    await api(ctx)
      .delete(`/v1/objects/${id}`)
      .set('X-Account-Id', other.accountId)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);

    const { accessToken: reviewer } = await login(ctx, DEMO.reviewer);
    const asReviewer = await get('/v1/objects', reviewer);
    assert.ok([403, 404].includes(asReviewer.status), `got ${asReviewer.status}`);

    await del(`/v1/objects/${id}`).expect(204);
  });
});
