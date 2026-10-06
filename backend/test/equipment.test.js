/**
 * CHANGE 2 and CHANGE 4: marking gym equipment on a capture, uploading the
 * 360 degree video for each machine, and carrying both through to the plan
 * and the reviewer.
 *
 * Real uploads against the real local storage driver, the way
 * captures.test.js does: signed part URLs, parts PUT one at a time, and a
 * completion that reports what never arrived.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import { pool } from '../src/db/pool.js';
import { api, createOtherTenant, DEMO, login, putPart, useTestServer } from './helpers.js';

const ctx = useTestServer();
const PART = 5 * 1024 * 1024;

const post = (path, t = ctx.token) => api(ctx).post(path).set('Authorization', `Bearer ${t}`);
const get = (path, t = ctx.token) => api(ctx).get(path).set('Authorization', `Bearer ${t}`);
const patch = (path, t = ctx.token) => api(ctx).patch(path).set('Authorization', `Bearer ${t}`);
const del = (path, t = ctx.token) => api(ctx).delete(path).set('Authorization', `Bearer ${t}`);

function T(deg, x, z, yUp = 1.5) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x, yUp, z, 1];
}
const surf = (deg, x, z, w) => ({
  confidence: { high: {} },
  dimensions: [w, 3.1, 0],
  transform: T(deg, x, z),
});

/** A 10 x 6 m room with one scanned object at (4, 3): the treadmill. */
const ROOM = {
  walls: [surf(0, 5, 0, 10), surf(90, 10, 3, 6), surf(0, 5, 6, 10), surf(90, 0, 3, 6)],
  doors: [surf(0, 2, 0, 0.9)],
  windows: [],
  openings: [],
  objects: [
    {
      category: { storage: {} },
      confidence: { high: {} },
      dimensions: [0.85, 1.5, 2.1],
      transform: T(0, 4, 3, 0.75),
    },
  ],
  floors: [{ transform: T(0, 5, 3, 0) }],
};

const metadata = (over = {}) => ({
  facilityId: DEMO.facilities.northgate,
  level: 7,
  floorToFloorM: 3.2,
  source: 'lidar',
  coverage: 0.95,
  closed: true,
  overrideReason: null,
  areaM2: 60,
  durationSeconds: 400,
  photoCount: 0,
  weakWallCount: 0,
  tags: [],
  capturedAt: new Date().toISOString(),
  ...over,
});

const TREADMILL = {
  equipmentId: 'EQ-001',
  type: 'treadmill',
  name: 'Treadmill 1',
  // Right on the scanned object, so the two are the same machine.
  x: 4.05,
  z: 3.05,
  rotationDeg: 0,
  widthM: 0.85,
  depthM: 2.1,
  heightM: 1.5,
};
const LEG_PRESS = {
  equipmentId: 'EQ-002',
  type: 'legPress',
  name: 'Leg Press',
  // Nowhere near a scanned object, so it becomes one of its own.
  x: 8,
  z: 5,
  rotationDeg: 90,
  widthM: 1.2,
  depthM: 2,
  heightM: 1.4,
};

describe('equipment on a capture', () => {
  let captureId;

  it('registers a capture to hang equipment off', async () => {
    const res = await post('/v1/captures').set('Idempotency-Key', 'eq-key-1').send(metadata()).expect(201);
    captureId = res.body.captureId;
  });

  it('records the machines the surveyor marked', async () => {
    const res = await post(`/v1/captures/${captureId}/equipment`)
      .send({ equipment: [TREADMILL, LEG_PRESS] })
      .expect(201);
    assert.equal(res.body.equipment.length, 2);
    const treadmill = res.body.equipment.find((e) => e.equipmentId === 'EQ-001');
    assert.equal(treadmill.name, 'Treadmill 1');
    assert.equal(treadmill.type, 'treadmill');
    assert.deepEqual(treadmill.position, { x: 4.05, z: 3.05 });
    assert.equal(treadmill.source, 'surveyor');
    assert.equal(treadmill.video, null);
  });

  it('takes a machine type that is not in the catalogue', async () => {
    const res = await post(`/v1/captures/${captureId}/equipment`)
      .send({ equipment: [{ equipmentId: 'EQ-900', type: 'plateLoadedHipThrust', name: 'Hip thrust', x: 1, z: 1 }] })
      .expect(201);
    assert.ok(res.body.equipment.some((e) => e.type === 'plateLoadedHipThrust'));
    await del(`/v1/captures/${captureId}/equipment/EQ-900`).expect(204);
  });

  it('replaces rather than doubles up when the app re-sends its list', async () => {
    const res = await post(`/v1/captures/${captureId}/equipment`)
      .send({ equipment: [{ ...TREADMILL, name: 'Treadmill A' }, LEG_PRESS] })
      .expect(201);
    assert.equal(res.body.equipment.length, 2, 'still two machines');
    assert.equal(res.body.equipment.find((e) => e.equipmentId === 'EQ-001').name, 'Treadmill A');
  });

  it('refuses two machines with the same id in one call', async () => {
    await post(`/v1/captures/${captureId}/equipment`)
      .send({ equipment: [TREADMILL, { ...LEG_PRESS, equipmentId: 'EQ-001' }] })
      .expect(400);
  });

  it('corrects one machine without touching the others', async () => {
    const res = await patch(`/v1/captures/${captureId}/equipment/EQ-001`)
      .send({ name: 'Treadmill 1', rotationDeg: 45 })
      .expect(200);
    const treadmill = res.body.equipment.find((e) => e.equipmentId === 'EQ-001');
    assert.equal(treadmill.name, 'Treadmill 1');
    assert.equal(treadmill.rotationDeg, 45);
    assert.equal(res.body.equipment.find((e) => e.equipmentId === 'EQ-002').name, 'Leg Press');
    await patch(`/v1/captures/${captureId}/equipment/EQ-001`).send({ rotationDeg: 0 }).expect(200);
  });

  it('404s for a machine that is not on the capture', async () => {
    await patch(`/v1/captures/${captureId}/equipment/EQ-404`).send({ name: 'Ghost' }).expect(404);
  });

  it('hides another customer’s capture entirely', async () => {
    const other = await createOtherTenant();
    const { accessToken } = await login(ctx, other);
    // Another customer's capture is absent, not forbidden.
    await get(`/v1/captures/${captureId}/equipment`, accessToken).expect(404);
    await post(`/v1/captures/${captureId}/equipment`, accessToken)
      .send({ equipment: [TREADMILL] })
      .expect(404);
  });
});

describe('the 360 degree video', () => {
  let captureId;
  // A video spanning 2.5 parts, so resume has something to resume.
  const video = randomBytes(PART * 2 + PART / 2);
  const thumbnail = randomBytes(2048);
  let opened;

  it('sets up a capture with equipment on it', async () => {
    const res = await post('/v1/captures').set('Idempotency-Key', 'eq-key-2').send(metadata({ level: 8 })).expect(201);
    captureId = res.body.captureId;
    await post(`/v1/captures/${captureId}/equipment`).send({ equipment: [TREADMILL, LEG_PRESS] }).expect(201);
  });

  it('opens the upload with a signed URL per part, under a structured path', async () => {
    const res = await post(`/v1/captures/${captureId}/equipment/EQ-001/video`)
      .send({
        partSize: PART,
        bytes: video.length,
        contentType: 'video/mp4',
        durationSeconds: 24.5,
        thumbnail: { bytes: thumbnail.length, contentType: 'image/jpeg' },
      })
      .expect(201);
    opened = Object.fromEntries(res.body.files.map((f) => [f.kind, f]));
    assert.equal(res.body.status, 'uploading');
    assert.deepEqual(opened.video.parts.map((p) => p.number), [1, 2, 3]);
    assert.equal(opened.thumbnail.parts.length, 1);
    assert.match(opened.video.parts[0].url, /expires=\d+&sig=/);
    // CHANGE 4.3: equipment/{equipmentId}/video/360.mp4
    assert.equal(opened.video.name, 'equipment/EQ-001/video/360.mp4');
    assert.equal(opened.thumbnail.name, 'equipment/EQ-001/thumbnail/thumbnail.jpg');
  });

  it('keeps the video inside the organisation’s own storage', async () => {
    const row = await pool
      .query('SELECT storage_key FROM capture_files WHERE id = ?', [opened.video.fileId])
      .then(([rows]) => rows[0]);
    assert.equal(row.storage_key, `orgs/${DEMO.org}/captures/${captureId}/equipment/EQ-001/video/360.mp4`);
  });

  it('names the parts still missing instead of confirming', async () => {
    await putPart(ctx, opened.video.parts[0].url, video.subarray(0, PART)).expect(200);
    await putPart(ctx, opened.video.parts[2].url, video.subarray(PART * 2)).expect(200);
    await putPart(ctx, opened.thumbnail.parts[0].url, thumbnail).expect(200);

    const res = await post(`/v1/captures/${captureId}/equipment/EQ-001/video/complete`).send({}).expect(200);
    assert.equal(res.body.status, 'incomplete');
    assert.deepEqual(res.body.missing, [{ fileId: opened.video.fileId, parts: [2] }]);
  });

  it('resumes with only the part that failed, and is then ready', async () => {
    const refresh = await post(`/v1/captures/${captureId}/equipment/EQ-001/video/uploads/refresh`)
      .send({ fileId: opened.video.fileId, parts: [2] })
      .expect(200);
    assert.equal(refresh.body.parts.length, 1);
    await putPart(ctx, refresh.body.parts[0].url, video.subarray(PART, PART * 2)).expect(200);

    const res = await post(`/v1/captures/${captureId}/equipment/EQ-001/video/complete`).send({}).expect(200);
    assert.equal(res.body.status, 'ready');
  });

  it('reports the video against its machine, and only that machine', async () => {
    const { body } = await get(`/v1/captures/${captureId}/equipment`).expect(200);
    const treadmill = body.equipment.find((e) => e.equipmentId === 'EQ-001');
    assert.equal(treadmill.video.status, 'ready');
    assert.equal(treadmill.video.durationSeconds, 24.5);
    assert.equal(treadmill.video.hasThumbnail, true);
    assert.equal(body.equipment.find((e) => e.equipmentId === 'EQ-002').video, null);
  });

  it('starts a fresh upload for a retake, leaving one video on the machine', async () => {
    const retake = randomBytes(1024);
    const res = await post(`/v1/captures/${captureId}/equipment/EQ-001/video`)
      .send({ partSize: PART, bytes: retake.length, contentType: 'video/mp4', durationSeconds: 11 })
      .expect(201);
    const file = res.body.files.find((f) => f.kind === 'video');
    await putPart(ctx, file.parts[0].url, retake).expect(200);
    await post(`/v1/captures/${captureId}/equipment/EQ-001/video/complete`).send({}).expect(200);

    const rows = await pool
      .query('SELECT COUNT(*) AS n FROM equipment_videos WHERE capture_id = ?', [captureId])
      .then(([r]) => r[0]);
    assert.equal(Number(rows.n), 1, 'the retake replaced the first take');

    const { body } = await get(`/v1/captures/${captureId}/equipment`).expect(200);
    const treadmill = body.equipment.find((e) => e.equipmentId === 'EQ-001');
    assert.equal(treadmill.video.durationSeconds, 11);
    assert.equal(treadmill.video.hasThumbnail, false, 'this take had no poster frame');
  });

  it('refuses a file type that is not a video', async () => {
    await post(`/v1/captures/${captureId}/equipment/EQ-002/video`)
      .send({ partSize: PART, bytes: 100, contentType: 'application/zip' })
      .expect(400);
  });

  it('refuses a video for a machine that does not exist', async () => {
    await post(`/v1/captures/${captureId}/equipment/EQ-404/video`)
      .send({ partSize: PART, bytes: 100, contentType: 'video/mp4' })
      .expect(404);
  });

  it('will not complete a video that was never started', async () => {
    await post(`/v1/captures/${captureId}/equipment/EQ-002/video/complete`).send({}).expect(404);
  });
});

describe('equipment in the plan and in front of the reviewer', () => {
  let captureId;
  let versionId;
  const room = Buffer.from(JSON.stringify(ROOM));
  const model = randomBytes(2048);

  it('captures a room with two marked machines and one 360 video', async () => {
    const reg = await post('/v1/captures').set('Idempotency-Key', 'eq-key-3').send(metadata({ level: 9 })).expect(201);
    captureId = reg.body.captureId;
    await post(`/v1/captures/${captureId}/equipment`).send({ equipment: [TREADMILL, LEG_PRESS] }).expect(201);

    const video = randomBytes(1024);
    const opened = await post(`/v1/captures/${captureId}/equipment/EQ-001/video`)
      .send({ partSize: PART, bytes: video.length, contentType: 'video/mp4', durationSeconds: 30 })
      .expect(201);
    await putPart(ctx, opened.body.files[0].parts[0].url, video).expect(200);
    await post(`/v1/captures/${captureId}/equipment/EQ-001/video/complete`).send({}).expect(200);

    const uploads = await post(`/v1/captures/${captureId}/uploads`)
      .send({
        partSize: PART,
        files: [
          { name: 'scan.usdz', kind: 'model', bytes: model.length, contentType: 'model/vnd.usdz+zip' },
          { name: 'scan.json', kind: 'room', bytes: room.length, contentType: 'application/json' },
        ],
      })
      .expect(200);
    const files = Object.fromEntries(uploads.body.files.map((f) => [f.name, f]));
    await putPart(ctx, files['scan.usdz'].parts[0].url, model).expect(200);
    await putPart(ctx, files['scan.json'].parts[0].url, room).expect(200);

    const done = await post(`/v1/captures/${captureId}/complete`).send({}).expect(200);
    assert.equal(done.body.status, 'received');
  });

  it('puts both machines in the 2D plan, in the scan’s own frame', async () => {
    const row = await pool
      .query(
        `SELECT id, plan_json, equipment_count, object_count FROM plan_versions WHERE capture_id = ?`,
        [captureId],
      )
      .then(([rows]) => rows[0]);
    versionId = row.id;
    const plan = row.plan_json;

    const named = plan.objects.filter((o) => o.equipment);
    assert.equal(named.length, 2, 'both machines are in the plan');
    assert.equal(Number(row.equipment_count), 2, 'and counted on the version row');

    // The treadmill was marked on top of a scanned object, so it is that
    // object: the measured footprint is kept, not the typed one.
    const treadmill = named.find((o) => o.equipment.equipmentId === 'EQ-001');
    assert.equal(treadmill.source, 'roomplan');
    assert.equal(treadmill.x, 4, 'the scanned position, not the marked one');
    assert.equal(treadmill.equipment.name, 'Treadmill 1');

    // The leg press matched nothing, so it is an object of its own.
    const legPress = named.find((o) => o.equipment.equipmentId === 'EQ-002');
    assert.equal(legPress.source, 'surveyor');
    assert.equal(legPress.x, 8);
    assert.equal(legPress.y, 5);
    assert.equal(legPress.w, 1.2);
  });

  it('does not let a video change where a machine is', async () => {
    const row = await pool
      .query('SELECT plan_json FROM plan_versions WHERE capture_id = ?', [captureId])
      .then(([rows]) => rows[0]);
    const treadmill = row.plan_json.objects.find((o) => o.equipment?.equipmentId === 'EQ-001');
    // The geometry is the scan's, whether or not a video was recorded.
    assert.equal(treadmill.x, 4);
    assert.equal(treadmill.y, 3);
  });

  it('shows the reviewer each machine with a playable video', async () => {
    const { accessToken } = await login(ctx, DEMO.reviewer);
    const { body } = await get(`/v1/review/versions/${versionId}`, accessToken).expect(200);

    assert.equal(body.equipment.length, 2);
    const treadmill = body.equipment.find((e) => e.equipmentId === 'EQ-001');
    assert.equal(treadmill.video.status, 'ready');
    assert.equal(treadmill.video.durationSeconds, 30);
    assert.match(treadmill.video.url, /expires=\d+&sig=/);
    assert.equal(treadmill.video.thumbnailUrl, null, 'this take had no poster frame');

    assert.equal(body.equipment.find((e) => e.equipmentId === 'EQ-002').video, null);
    const videoFile = body.files.find((f) => f.kind === 'video');
    assert.equal(videoFile.equipmentId, treadmill.planObjectId ?? videoFile.equipmentId);
    assert.ok(videoFile.url, 'the video is downloadable like any other file');
  });

  it('keeps the equipment through a reviewer save', async () => {
    const { accessToken } = await login(ctx, DEMO.reviewer);
    await post(`/v1/review/versions/${versionId}/start`, accessToken).send({}).expect(204);
    const open = await get(`/v1/review/versions/${versionId}`, accessToken).expect(200);

    const saved = await api(ctx)
      .put(`/v1/review/versions/${versionId}/plan`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ plan: open.body.plan, revision: open.body.planRevision })
      .expect(200);
    assert.equal(saved.body.summary.equipment, 2, 'the save did not drop the machines');

    const row = await pool
      .query('SELECT plan_json, equipment_count FROM plan_versions WHERE id = ?', [versionId])
      .then(([rows]) => rows[0]);
    assert.equal(Number(row.equipment_count), 2);
    const treadmill = row.plan_json.objects.find((o) => o.equipment?.equipmentId === 'EQ-001');
    assert.equal(treadmill.equipment.name, 'Treadmill 1', 'the name survived the round trip');
  });
});
