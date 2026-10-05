import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { api, createOtherTenant, DEMO, login, putPart, useTestServer } from './helpers.js';

const ctx = useTestServer();
const PART = 5 * 1024 * 1024; // The smallest part size allowed.

const post = (path, t = ctx.token) => api(ctx).post(path).set('Authorization', `Bearer ${t}`);

const metadata = (over = {}) => ({
  facilityId: DEMO.facilities.northgate,
  level: 4,
  floorToFloorM: 3.2,
  source: 'lidar',
  coverage: 0.94,
  closed: true,
  overrideReason: null,
  areaM2: 412.3,
  durationSeconds: 540,
  photoCount: 1,
  weakWallCount: 1,
  tags: [{ type: 'fireExit', x: 4.1, y: 0.2, heightM: null }],
  capturedAt: new Date().toISOString(),
  ...over,
});

/** Column-major 4×4: rotation about y by `deg`, then translation. */
function T(deg, x, z) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x, 1.5, z, 1];
}
const surf = (deg, x, z, w, conf = 'high') => ({
  confidence: { [conf]: {} },
  dimensions: [w, 3.1, 0],
  transform: T(deg, x, z),
});

/** scan.json: a 10 × 6 m room with a door, and one weak wall. */
const ROOM = {
  walls: [surf(0, 5, 0, 10), surf(90, 10, 3, 6), surf(0, 5, 6, 10, 'low'), surf(90, 0, 3, 6)],
  doors: [surf(0, 2, 0, 0.9)],
  windows: [],
  openings: [],
  objects: [],
};

function register(key, body = metadata()) {
  return post('/v1/captures').set('Idempotency-Key', key).send(body);
}

describe('captures', () => {
  // A model spanning 2.5 parts, and a small photo.
  const model = randomBytes(PART * 2 + PART / 2);
  const photo = randomBytes(1000);
  const room = Buffer.from(JSON.stringify(ROOM));
  let captureId;
  let files;

  it('registers a capture once per idempotency key', async () => {
    const first = await register('key-1').expect(201);
    captureId = first.body.captureId;
    assert.match(captureId, /^cap_/);

    // The response was lost and the app asks again.
    const retry = await register('key-1').expect(200);
    assert.equal(retry.body.captureId, captureId);

    // A new version of Northgate Level 4, waiting on the upload.
    const plans = await api(ctx).get('/v1/plans').set('Authorization', `Bearer ${ctx.token}`);
    const level4 = plans.body.plans.find((p) => p.site === 'Northgate Fitness' && p.level === 4);
    assert.equal(level4.status, 'uploading');
    assert.equal(level4.version, 1);
  });

  it('opens an upload with a signed URL per part', async () => {
    const res = await post(`/v1/captures/${captureId}/uploads`)
      .send({
        partSize: PART,
        files: [
          { name: 'scan.usdz', kind: 'model', bytes: model.length, contentType: 'model/vnd.usdz+zip' },
          { name: 'photo-1.jpg', kind: 'photo', bytes: photo.length, contentType: 'image/jpeg' },
          { name: 'scan.json', kind: 'room', bytes: room.length, contentType: 'application/json' },
        ],
      })
      .expect(200);
    files = Object.fromEntries(res.body.files.map((f) => [f.name, f]));
    assert.deepEqual(files['scan.usdz'].parts.map((p) => p.number), [1, 2, 3]);
    assert.equal(files['photo-1.jpg'].parts.length, 1);
    assert.match(files['scan.usdz'].parts[0].url, /expires=\d+&sig=/);
  });

  it('refuses a part with a tampered signature, as S3 would', async () => {
    const url = files['photo-1.jpg'].parts[0].url.replace(/sig=[^&]+/, 'sig=forged');
    await putPart(ctx, url, photo).expect(403);
  });

  it('refuses a part whose URL expired', async () => {
    const file = await pool
      .query('SELECT upload_id FROM capture_files WHERE id = ?', [files['photo-1.jpg'].fileId])
      .then(([rows]) => rows[0]);
    const stale = await ctx.storage.presignPart('k', file.upload_id, 1, -10);
    await putPart(ctx, stale, photo).expect(403);
  });

  it('names the parts still missing instead of confirming', async () => {
    // Everything but part 2 of the model arrives.
    await putPart(ctx, files['scan.usdz'].parts[0].url, model.subarray(0, PART)).expect(200);
    await putPart(ctx, files['scan.usdz'].parts[2].url, model.subarray(PART * 2)).expect(200);
    await putPart(ctx, files['photo-1.jpg'].parts[0].url, photo).expect(200);
    await putPart(ctx, files['scan.json'].parts[0].url, room).expect(200);

    const res = await post(`/v1/captures/${captureId}/complete`).send({}).expect(200);
    assert.equal(res.body.status, 'incomplete');
    assert.deepEqual(res.body.missing, [{ fileId: files['scan.usdz'].fileId, parts: [2] }]);
  });

  it('refreshes URLs for parts that need resending', async () => {
    const res = await post(`/v1/captures/${captureId}/uploads/refresh`)
      .send({ files: [{ fileId: files['scan.usdz'].fileId, parts: [2] }] })
      .expect(200);
    assert.deepEqual(res.body.files[0].parts.map((p) => p.number), [2]);
    await putPart(ctx, res.body.files[0].parts[0].url, model.subarray(PART, PART * 2)).expect(200);
  });

  it('confirms receipt once every part is in, byte for byte', async () => {
    const res = await post(`/v1/captures/${captureId}/complete`).send({}).expect(200);
    assert.equal(res.body.status, 'received');

    const stored = await ctx.storage.read(`orgs/${'org_northgate'}/captures/${captureId}/scan.usdz`);
    assert.ok(stored.equals(model), 'the assembled model matches what was sent');

    // Confirming again (a lost response) still says received.
    const again = await post(`/v1/captures/${captureId}/complete`).send({}).expect(200);
    assert.equal(again.body.status, 'received');

    const plans = await api(ctx).get('/v1/plans').set('Authorization', `Bearer ${ctx.token}`);
    const level4 = plans.body.plans.find((p) => p.site === 'Northgate Fitness' && p.level === 4);
    assert.equal(level4.status, 'processing');
    assert.ok(level4.submittedAt);
    assert.equal(level4.inputType, 'lidar');
  });

  it('only takes the file kinds a capture can have', async () => {
    const { body } = await register('key-kinds', metadata({ level: 6 })).expect(201);
    const res = await post(`/v1/captures/${body.captureId}/uploads`)
      .send({
        partSize: PART,
        files: [{ name: 'plan.pdf', kind: 'source', bytes: 10, contentType: 'application/pdf' }],
      })
      .expect(400);
    assert.match(res.body.message, /cannot carry a source file/);
  });

  it('refuses a LiDAR capture completed without its model', async () => {
    const { body } = await register('key-no-model', metadata({ level: 5 })).expect(201);
    await post(`/v1/captures/${body.captureId}/uploads`)
      .send({ partSize: PART, files: [{ name: 'photo-1.jpg', kind: 'photo', bytes: 10, contentType: 'image/jpeg' }] })
      .expect(200);
    const res = await post(`/v1/captures/${body.captureId}/complete`).send({}).expect(400);
    assert.match(res.body.message, /3D model/);
  });

  it('validates the metadata', async () => {
    const res = await register('key-bad', metadata({ floorToFloorM: 40 })).expect(400);
    assert.match(res.body.message, /floorToFloorM/);
    await register('key-bad-2', metadata({ facilityId: 'fac_nope' })).expect(400);
    await post('/v1/captures').send(metadata()).expect(400); // No idempotency key.
  });

  it('keeps captures inside their organisation', async () => {
    const other = await createOtherTenant();
    const { accessToken } = await login(ctx, other);
    // Someone else's facility id is refused...
    await register('key-x', metadata()).set('Authorization', `Bearer ${accessToken}`).expect(400);
    // ...and someone else's capture does not exist for them.
    await post(`/v1/captures/${captureId}/complete`, accessToken).send({}).expect(404);
  });

  it('stops at the monthly plan quota', async () => {
    await pool.query(`UPDATE organisations SET plan_quota = 0 WHERE id = 'org_northgate'`);
    const res = await register('key-quota', metadata({ level: 9 })).expect(403);
    assert.match(res.body.message, /used up/);
    await pool.query(`UPDATE organisations SET plan_quota = 10 WHERE id = 'org_northgate'`);
  });
});

describe('review', () => {
  it('a reviewer can approve, and the owner sees it ready', async () => {
    const { accessToken: reviewer } = await login(ctx, DEMO.reviewer);
    const queue = await api(ctx)
      .get('/v1/review/queue')
      .set('Authorization', `Bearer ${reviewer}`)
      .expect(200);
    const version = queue.body.versions.find((v) => v.facility === 'Northgate Fitness' && v.level === 4);
    assert.ok(version, 'the uploaded capture is waiting for review');

    // The reviewer sees the capture's metadata and can download its files.
    const detail = await api(ctx)
      .get(`/v1/review/versions/${version.id}`)
      .set('Authorization', `Bearer ${reviewer}`)
      .expect(200);
    assert.equal(detail.body.capture.floorToFloorM, 3.2);
    assert.deepEqual(detail.body.capture.tags, [{ type: 'fireExit', x: 4.1, y: 0.2, heightM: null }]);
    const scan = detail.body.files.find((f) => f.name === 'scan.usdz');
    const u = new URL(scan.url);
    const download = await api(ctx)
      .get(u.pathname + u.search)
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    assert.equal(download.body.length, scan.bytes);
    // A tampered download URL is refused.
    await api(ctx).get(u.pathname + '?expires=9999999999&sig=nope').expect(403);
    // Gym users cannot read the reviewer view.
    await api(ctx)
      .get(`/v1/review/versions/${version.id}`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .expect(403);

    // Plan reading turned scan.json into a plan, and flagged the weak wall.
    assert.equal(detail.body.plan.walls.length, 4);
    assert.equal(detail.body.plan.openings[0].type, 'door');
    assert.equal(detail.body.plan.tags[0].type, 'fireExit');
    assert.deepEqual(detail.body.issues, []);
    assert.match(detail.body.blockers[0], /flagged element/);

    const as = (method, path) => api(ctx)[method](path).set('Authorization', `Bearer ${reviewer}`);
    await as('post', `/v1/review/versions/${version.id}/start`).send({}).expect(204);

    // REV-05: flags block approval until each is confirmed, edited or deleted.
    const blocked = await as('post', `/v1/review/versions/${version.id}/approve`).send({}).expect(409);
    assert.match(blocked.body.blockers[0], /flagged element/);

    const plan = structuredClone(detail.body.plan);
    for (const f of plan.flags) Object.assign(f, { status: 'resolved', resolution: 'confirmed' });
    const saved = await as('put', `/v1/review/versions/${version.id}/plan`)
      .send({ plan, revision: detail.body.planRevision })
      .expect(200);
    assert.equal(saved.body.revision, detail.body.planRevision + 1);
    assert.deepEqual(saved.body.blockers, []);
    assert.equal(saved.body.summary.areaM2, 60);

    // A save from a stale copy is refused rather than overwriting.
    await as('put', `/v1/review/versions/${version.id}/plan`)
      .send({ plan, revision: detail.body.planRevision })
      .expect(409);

    const approved = await as('post', `/v1/review/versions/${version.id}/approve`).send({}).expect(200);
    assert.match(approved.body.contentHash, /^[0-9a-f]{64}$/);
    // Approving twice is refused, and an approved plan is read-only.
    await as('post', `/v1/review/versions/${version.id}/approve`).send({}).expect(409);
    await as('put', `/v1/review/versions/${version.id}/plan`).send({ plan, revision: 1 }).expect(409);

    const plans = await api(ctx).get('/v1/plans').set('Authorization', `Bearer ${ctx.token}`);
    const level4 = plans.body.plans.find((p) => p.site === 'Northgate Fitness' && p.level === 4);
    assert.equal(level4.status, 'ready');
    const model = await api(ctx)
      .get(`/v1/plans/${level4.id}/model`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .expect(200);
    assert.equal(model.body.contentHash, approved.body.contentHash);

    // ACC-06: each step is in the audit log, against the version.
    const [log] = await pool.query(
      'SELECT action FROM audit_log WHERE target_id = ? AND version = 1',
      [level4.id],
    );
    for (const action of ['CAPTURED', 'PLAN_PRODUCED', 'CLAIMED', 'CORRECTED', 'APPROVED']) {
      assert.ok(log.some((l) => l.action === action), `${action} is logged`);
    }
  });

  it('a rejection needs a reason and a note', async () => {
    const { accessToken: reviewer } = await login(ctx, DEMO.reviewer);
    await post('/v1/review/versions/pv_ng2_1/reject', reviewer).send({ reason: 'x' }).expect(400);
    // REV-08: one of the reason codes.
    await post('/v1/review/versions/pv_ng2_1/reject', reviewer)
      .send({ reason: 'Bad vibes', note: 'Please rescan.' })
      .expect(400);
    await post('/v1/review/versions/pv_ng2_1/reject', reviewer)
      .send({ reason: 'Incomplete coverage', note: 'Rewalk the south wall.' })
      .expect(204);
    const plan = await api(ctx).get('/v1/plans/plan_ng2').set('Authorization', `Bearer ${ctx.token}`);
    assert.equal(plan.body.status, 'recapture');
    assert.equal(plan.body.review.note, 'Rewalk the south wall.');
  });

  it('lists the queue with who has claimed what, and stats', async () => {
    const { accessToken: reviewer } = await login(ctx, DEMO.reviewer);
    const { body } = await api(ctx)
      .get('/v1/review/queue')
      .set('Authorization', `Bearer ${reviewer}`)
      .expect(200);
    const riverside = body.versions.find((v) => v.id === 'pv_rv1_1');
    assert.equal(riverside.status, 'processing');
    assert.equal(riverside.reviewer, null);
    assert.equal(typeof riverside.coverage, 'number');
    assert.equal(body.stats.waiting, body.versions.length);
    assert.ok(body.stats.approvedThisWeek >= 1, 'the Level 4 approval above counts');
    assert.ok(body.stats.myReviewsThisWeek >= 1);
  });

  it('a claimed plan belongs to its reviewer until released', async () => {
    const { accessToken: maya } = await login(ctx, DEMO.reviewer);
    await pool.query(
      `INSERT INTO users (id, org_id, email, password_hash, name, role, role_label)
       SELECT 'usr_tom', org_id, 'tom@flexmotion.app', password_hash, 'Tom Alder', 'reviewer', 'Reviewer'
       FROM users WHERE id = ?`,
      [DEMO.reviewer.id],
    );
    const { accessToken: tom } = await login(ctx, {
      email: 'tom@flexmotion.app',
      password: DEMO.reviewer.password,
    });

    await post('/v1/review/versions/pv_rv1_1/start', maya).send({}).expect(204);
    const taken = await post('/v1/review/versions/pv_rv1_1/start', tom).send({}).expect(409);
    assert.match(taken.body.message, /Maya Restrepo is reviewing/);
    await post('/v1/review/versions/pv_rv1_1/approve', tom).send({}).expect(409);
    await post('/v1/review/versions/pv_rv1_1/release', tom).send({}).expect(409);

    const queue = await api(ctx).get('/v1/review/queue').set('Authorization', `Bearer ${tom}`);
    const row = queue.body.versions.find((v) => v.id === 'pv_rv1_1');
    assert.deepEqual(row.reviewer, { id: DEMO.reviewer.id, name: 'Maya Restrepo', isMe: false });

    await post('/v1/review/versions/pv_rv1_1/release', maya).send({}).expect(204);
    await post('/v1/review/versions/pv_rv1_1/start', tom).send({}).expect(204);
    const detail = await api(ctx)
      .get('/v1/review/versions/pv_rv1_1')
      .set('Authorization', `Bearer ${tom}`)
      .expect(200);
    assert.equal(detail.body.reviewer.isMe, true);
  });

  it('counts reviewer time but not idle spells over 10 minutes', async () => {
    const { accessToken: tom } = await login(ctx, { email: 'tom@flexmotion.app', password: DEMO.reviewer.password });
    const seconds = async () =>
      (await pool.query('SELECT review_active_seconds AS s FROM plan_versions WHERE id = ?', ['pv_rv1_1']))[0][0].s;
    const before = await seconds();

    await pool.query(
      "UPDATE plan_versions SET review_last_activity_at = UTC_TIMESTAMP(3) - INTERVAL 20 MINUTE WHERE id = 'pv_rv1_1'",
    );
    await post('/v1/review/versions/pv_rv1_1/activity', tom).send({}).expect(204);
    assert.equal(await seconds(), before, 'twenty idle minutes do not count');

    await pool.query(
      "UPDATE plan_versions SET review_last_activity_at = UTC_TIMESTAMP(3) - INTERVAL 2 MINUTE WHERE id = 'pv_rv1_1'",
    );
    await post('/v1/review/versions/pv_rv1_1/activity', tom).send({}).expect(204);
    const after = await seconds();
    assert.ok(after - before >= 119 && after - before <= 125, `two working minutes count (${after - before} s)`);
  });

  it('refuses a malformed plan', async () => {
    const { accessToken: tom } = await login(ctx, { email: 'tom@flexmotion.app', password: DEMO.reviewer.password });
    await api(ctx)
      .put('/v1/review/versions/pv_rv1_1/plan')
      .set('Authorization', `Bearer ${tom}`)
      .send({ plan: { format: 'gymplan/1', walls: 'lots' }, revision: 0 })
      .expect(400);
  });

  it('revising an approved plan makes a new version that supersedes it', async () => {
    const { accessToken: maya } = await login(ctx, DEMO.reviewer);
    const as = (method, path) => api(ctx)[method](path).set('Authorization', `Bearer ${maya}`);
    const owner = (path) => api(ctx).get(path).set('Authorization', `Bearer ${ctx.token}`);

    const { body } = await as('post', '/v1/review/versions/pv_eb0_1/revise').send({}).expect(201);
    // Only one revision at a time.
    await as('post', '/v1/review/versions/pv_eb0_1/revise').send({}).expect(409);

    const draft = await as('get', `/v1/review/versions/${body.id}`).expect(200);
    assert.equal(draft.body.version, 2);
    assert.equal(draft.body.origin, 'revision');
    assert.equal(draft.body.status, 'in_review');
    assert.equal(draft.body.reviewer.isMe, true);
    // The owner keeps the approved walkthrough while the revision is in review.
    assert.equal((await owner('/v1/plans/plan_eb0/model').expect(200)).body.version, 1);

    const plan = draft.body.plan;
    plan.ceilingHeightM = 3.4;
    await as('put', `/v1/review/versions/${body.id}/plan`)
      .send({ plan, revision: draft.body.planRevision })
      .expect(200);
    await as('post', `/v1/review/versions/${body.id}/approve`).send({}).expect(200);

    const after = await owner('/v1/plans/plan_eb0').expect(200);
    assert.deepEqual(
      after.body.history.map((h) => `v${h.version} ${h.status}`),
      ['v2 ready', 'v1 superseded'],
    );
    assert.equal((await owner('/v1/plans/plan_eb0/model').expect(200)).body.plan.ceilingHeightM, 3.4);

    // A revision does not use the customer's monthly quota.
    const me = await owner('/v1/me').expect(200);
    const [[{ n }]] = await pool.query(
      `SELECT COUNT(*) AS n FROM plan_versions WHERE org_id = 'org_northgate' AND origin = 'capture'
         AND created_at >= DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-01')`,
    );
    assert.equal(me.body.plansUsed, Number(n));
  });

  it('answers the web app’s CORS preflight, and only for its origin', async () => {
    const pre = await api(ctx)
      .options('/v1/review/queue')
      .set('Origin', config.publicWebUrl)
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization')
      .expect(204);
    assert.equal(pre.headers['access-control-allow-origin'], config.publicWebUrl);
    assert.match(pre.headers['access-control-allow-headers'], /Authorization/);
    const other = await api(ctx).get('/v1/share/x').set('Origin', 'https://evil.example');
    assert.equal(other.headers['access-control-allow-origin'], undefined);
  });

  it('gym users cannot review', async () => {
    await api(ctx).get('/v1/review/queue').set('Authorization', `Bearer ${ctx.token}`).expect(403);
  });
});
