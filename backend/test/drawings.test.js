/** Owners' uploaded drawings (UPL-01..04): into the same pipeline as a scan. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { api, DEMO, login, putPart, useTestServer } from './helpers.js';

const ctx = useTestServer();
const PART = 5 * 1024 * 1024;
const post = (path, t = ctx.token) => api(ctx).post(path).set('Authorization', `Bearer ${t}`);

const drawing = (over = {}) => ({
  facilityId: DEMO.facilities.riverside,
  level: 2,
  inputType: 'png',
  originalName: 'RG-102 rev C.png',
  bytes: 2000,
  imageWidth: 1600,
  imageHeight: 1000,
  scale: { a: [100, 900], b: [1100, 900], lengthM: 20 },
  ...over,
});

async function upload(key, body, files) {
  const reg = await post('/v1/captures/drawings').set('Idempotency-Key', key).send(body).expect(201);
  const id = reg.body.captureId;
  const opened = await post(`/v1/captures/${id}/uploads`)
    .send({
      partSize: PART,
      files: files.map(({ name, kind, bytes, contentType }) => ({ name, kind, bytes: bytes.length, contentType })),
    })
    .expect(200);
  for (const f of opened.body.files) {
    const src = files.find((x) => x.name === f.name);
    await putPart(ctx, f.parts[0].url, src.bytes).expect(200);
  }
  return id;
}

describe('uploaded drawings', () => {
  // These tests make many plans; the quota is not what they are about.
  it('starts with room in the quota', async () => {
    await pool.query(`UPDATE organisations SET plan_quota = 100 WHERE id = 'org_northgate'`);
  });

  it('turns a scaled image into a plan the reviewer traces over', async () => {
    const image = randomBytes(2000);
    const id = await upload('d-1', drawing(), [
      { name: 'source.png', kind: 'source', bytes: image, contentType: 'image/png' },
    ]);
    const done = await post(`/v1/captures/${id}/complete`).send({}).expect(200);
    assert.equal(done.body.status, 'received');

    const { accessToken } = await login(ctx, DEMO.reviewer);
    const queue = await api(ctx).get('/v1/review/queue').set('Authorization', `Bearer ${accessToken}`);
    const row = queue.body.versions.find((v) => v.facility === 'Riverside Gym' && v.level === 2);
    assert.equal(row.inputType, 'png');

    const detail = await api(ctx)
      .get(`/v1/review/versions/${row.id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const { plan, files } = detail.body;
    // 1000 px drawn over 20 m: 2 cm a pixel.
    assert.equal(plan.scale.source, 'line');
    assert.equal(plan.scale.metresPerPixel, 0.02);
    const source = files.find((f) => f.kind === 'source');
    assert.equal(plan.underlay.fileId, source.id, 'the image itself is the underlay');
    assert.equal(plan.walls.length, 0, 'nothing is detected yet; the reviewer traces it');
    assert.ok(detail.body.blockers.some((b) => /three walls/.test(b)));
  });

  it('lets the web app PUT parts from its own origin (CORS preflight)', async () => {
    const reg = await post('/v1/captures/drawings').set('Idempotency-Key', 'd-cors').send(drawing({ level: 8 })).expect(201);
    const opened = await post(`/v1/captures/${reg.body.captureId}/uploads`)
      .send({ partSize: PART, files: [{ name: 'source.png', kind: 'source', bytes: 10, contentType: 'image/png' }] })
      .expect(200);
    const u = new URL(opened.body.files[0].parts[0].url);
    const pre = await api(ctx)
      .options(u.pathname + u.search)
      .set('Origin', config.publicWebUrl)
      .set('Access-Control-Request-Method', 'PUT')
      .set('Access-Control-Request-Headers', 'content-type')
      .expect(204);
    assert.equal(pre.headers['access-control-allow-origin'], config.publicWebUrl);
    assert.match(pre.headers['access-control-allow-methods'], /PUT/);
    const put = await putPart(ctx, u.href, randomBytes(10)).set('Origin', config.publicWebUrl).expect(200);
    assert.equal(put.headers['access-control-allow-origin'], config.publicWebUrl);
    // Another origin gets no CORS grant.
    const other = await api(ctx).options(u.pathname + u.search).set('Origin', 'https://evil.example').expect(204);
    assert.equal(other.headers['access-control-allow-origin'], undefined);
  });

  it('keeps a PDF and the page chosen from it', async () => {
    const pdf = randomBytes(3000);
    const page = randomBytes(1500);
    const id = await upload(
      'd-2',
      drawing({ level: 3, inputType: 'pdf', originalName: 'plans.pdf', page: 2, pageCount: 5 }),
      [
        { name: 'source.pdf', kind: 'source', bytes: pdf, contentType: 'application/pdf' },
        { name: 'page-2.png', kind: 'source_image', bytes: page, contentType: 'image/png' },
      ],
    );
    await post(`/v1/captures/${id}/complete`).send({}).expect(200);

    // UPL-04: the original is stored unchanged.
    const stored = await ctx.storage.read(`orgs/org_northgate/captures/${id}/source.pdf`);
    assert.ok(stored.equals(pdf));
  });

  it('needs a scale for images and PDFs, but not for DWG', async () => {
    const noScale = await post('/v1/captures/drawings')
      .set('Idempotency-Key', 'd-3')
      .send(drawing({ scale: null }))
      .expect(400);
    assert.match(noScale.body.message, /known dimension/);
    await post('/v1/captures/drawings')
      .set('Idempotency-Key', 'd-4')
      .send(drawing({ level: 4, inputType: 'dwg', originalName: 'plan.dwg', scale: null }))
      .expect(201);
  });

  it('refuses drawings over 50 MB and a line too short to scale from', async () => {
    await post('/v1/captures/drawings')
      .set('Idempotency-Key', 'd-5')
      .send(drawing({ bytes: 51 * 1024 * 1024 }))
      .expect(400);
    const short = await post('/v1/captures/drawings')
      .set('Idempotency-Key', 'd-6')
      .send(drawing({ scale: { a: [10, 10], b: [12, 10], lengthM: 5 } }))
      .expect(400);
    assert.match(short.body.message, /too short/);
  });

  it('cannot be submitted without the drawing itself', async () => {
    const reg = await post('/v1/captures/drawings')
      .set('Idempotency-Key', 'd-7')
      .send(drawing({ level: 7 }))
      .expect(201);
    const res = await post(`/v1/captures/${reg.body.captureId}/complete`).send({}).expect(400);
    assert.match(res.body.message, /drawing itself/);
  });
});
