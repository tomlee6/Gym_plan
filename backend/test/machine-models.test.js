/**
 * Machine models (L-07): the asset.build job, the states a model goes
 * through, and the reviewer's API. The builder is stood in for (the GPU
 * route is L-05); everything else is the real thing against the database.
 *
 * The tests run in order and build on each other, from the seeded treadmill
 * (EQ-001: one model awaiting review, its 360 video still uploading).
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { failModel, finishModel, modelFolder, queueModel, REPLACED_NOTE, setBuilder } from '../src/assets/index.js';
import { config } from '../src/config.js';
import { one, pool, transaction } from '../src/db/pool.js';
import { enqueue, handlerFor, PermanentJobError, runDueJobs } from '../src/jobs/index.js';
import { catchMetrics } from '../src/metrics3d.js';
import { setModelStorage } from '../src/storage/index.js';
import { LocalStorage } from '../src/storage/local.js';
import { api, DEMO, login, useTestServer } from './helpers.js';

const ctx = useTestServer();

let reviewer;
let machineId;
let modelsDir;
let models;

const as = (method, url, token = reviewer) => api(ctx)[method](url).set('Authorization', `Bearer ${token}`);
const list = () => as('get', `/v1/review/machines/${machineId}/models`).expect(200);
const build = () => as('post', `/v1/review/machines/${machineId}/models`).send({});
const row = (id) => one(pool, 'SELECT * FROM machine_models WHERE id = ?', [id]);
const events = async (action) =>
  (await pool.query('SELECT * FROM audit_log WHERE action = ? AND target_id = ? ORDER BY created_at, id', [action, machineId]))[0];

/** A builder that stores a small file as the model, as the real one stores the GLB. */
const finished = async ({ model }) => {
  const glbKey = `${modelFolder(model)}model.glb`;
  const metadataKey = `${modelFolder(model)}metadata.json`;
  await models.write(glbKey, Buffer.from(`glTF model ${model.id} seed ${model.seed}`));
  await models.write(metadataKey, Buffer.from(JSON.stringify({ seed: model.seed })));
  return { glbKey, metadataKey, bytes: 1234, triangleCount: 4000, sizeM: { w: 2, d: 0.9, h: 1.5 }, scaleErrorPct: 1.25 };
};

describe('machine models (L-07)', () => {
  after(async () => {
    setBuilder(async () => {
      throw new PermanentJobError('No builder.');
    });
    if (modelsDir) await rm(modelsDir, { recursive: true, force: true });
  });

  it('is for Flex staff only', async () => {
    reviewer = (await login(ctx, DEMO.reviewer)).accessToken;
    // The models store on its own, as the models bucket is on AWS.
    modelsDir = await mkdtemp(path.join(os.tmpdir(), 'gym-models-'));
    models = new LocalStorage({ dir: modelsDir, secret: config.storage.signingSecret, publicUrl: config.publicApiUrl });
    setModelStorage(models);
    ({ id: machineId } = await one(pool, `SELECT id FROM machines WHERE account_id = ? AND ref = 'EQ-001'`, [DEMO.account]));

    await as('get', `/v1/review/machines/${machineId}/models`, ctx.token).expect(403);
    await as('post', `/v1/review/machines/${machineId}/models`, ctx.token).send({}).expect(403);
    await api(ctx).get(`/v1/review/machines/${machineId}/models`).expect(401);
  });

  it('lists a machine’s models, and says when it cannot be built yet', async () => {
    const { body } = await list();
    assert.equal(body.equipmentId, 'EQ-001');
    assert.equal(body.videoStatus, 'uploading');
    assert.equal(body.canBuild, false);
    assert.equal(body.modelStatus, 'awaiting_review');
    assert.equal(body.models.length, 1);
    assert.deepEqual(body.models[0].sizeM, { w: 2, d: 0.9, h: 1.5 });
    // The seeded model has no file, so nothing to link to.
    assert.equal(body.models[0].url, null);

    await as('get', '/v1/review/machines/not-an-id/models').expect(404);
    await as('get', '/v1/review/machines/01920000-0000-7000-8000-00000000ffff/models').expect(404);
    const refused = await build().expect(409);
    assert.match(refused.body.message, /no finished 360 video/);
  });

  it('builds a model from the finished video: queued, building, then awaiting review with a link', async () => {
    await pool.query(`UPDATE machine_videos SET status = 'ready' WHERE machine_id = ?`, [machineId]);
    const seen = [];
    setBuilder(async (args) => {
      seen.push((await row(args.model.id)).status);
      return finished(args);
    });

    const { body } = await build().expect(202);
    assert.equal(body.queued, true);
    assert.deepEqual(seen, ['building']);
    const made = body.models.find((m) => m.modelId === body.modelId);
    assert.equal(made.status, 'awaiting_review');
    assert.equal(made.seed, 1);
    assert.equal(made.generatorVersion, config.assets.generatorVersion);
    assert.equal(made.triangleCount, 4000);
    assert.equal(made.scaleErrorPct, 1.25);
    assert.ok(made.url && made.urlExpiresAt, 'a signed link to the GLB');
    assert.equal(body.modelStatus, 'awaiting_review');

    const stored = await row(body.modelId);
    assert.equal(stored.glb_key, `models/accounts/${DEMO.account}/assets/${body.modelId}/model.glb`);
    assert.equal(stored.metadata_key, `models/accounts/${DEMO.account}/assets/${body.modelId}/metadata.json`);
    assert.equal((await events('MACHINE_MODEL_QUEUED')).at(-1).actor_user_id, DEMO.reviewer.id);
    assert.equal((await events('MACHINE_MODEL_BUILT')).at(-1).detail.modelId, body.modelId);
  });

  it('builds again with the next seed, to give the reviewer another to choose from', async () => {
    const { body } = await build().expect(202);
    const made = body.models.find((m) => m.modelId === body.modelId);
    assert.equal(made.seed, 2);
    assert.equal(made.status, 'awaiting_review');
    assert.equal(body.models.length, 3);
  });

  it('fails a build that cannot succeed, with its reason, and tries it again on the same row', async () => {
    setBuilder(async () => {
      throw new PermanentJobError('The cut-out is empty: nothing was found in front of the camera.');
    });
    const { body } = await build().expect(202);
    const failed = body.models.find((m) => m.modelId === body.modelId);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.seed, 3);
    assert.match(failed.failureReason, /cut-out is empty/);
    assert.equal(failed.url, null);
    assert.equal(body.modelStatus, 'failed');

    setBuilder(finished);
    const again = await build().expect(202);
    assert.equal(again.body.modelId, body.modelId, 'the same row, not a new one');
    const retried = again.body.models.find((m) => m.modelId === body.modelId);
    assert.equal(retried.status, 'awaiting_review');
    assert.equal(retried.seed, 3);
    assert.equal(retried.attempt, 2);
    assert.equal(retried.failureReason, null);
    assert.ok((await events('MACHINE_MODEL_FAILED')).length >= 1);
  });

  it('hands work to the GPU and takes its outcome only for that job', async () => {
    setBuilder(async () => ({ pending: true, gpuJobId: 'gpu-job-1' }));
    const { body } = await build().expect(202);
    const pending = await row(body.modelId);
    assert.equal(pending.status, 'building');
    assert.equal(pending.gpu_job_id, 'gpu-job-1');

    // Asking again while it builds gives back the same build.
    const again = await build().expect(200);
    assert.equal(again.body.queued, false);
    assert.equal(again.body.modelId, body.modelId);

    // The job running again (a duplicate delivery) does not send it twice.
    let calls = 0;
    setBuilder(async () => {
      calls++;
      return { pending: true, gpuJobId: 'gpu-job-2' };
    });
    await handlerFor('asset.build').run({ subject_id: body.modelId, payload: { attempt: 1 } });
    assert.equal(calls, 0);

    const out = await finished({ model: pending });
    assert.equal(await finishModel(body.modelId, out, { gpuJobId: 'gpu-job-other' }), false);
    assert.equal(await finishModel(body.modelId, out, { gpuJobId: 'gpu-job-1' }), true);
    assert.equal((await row(body.modelId)).status, 'awaiting_review');
    // A late failure for a model already finished changes nothing.
    assert.equal(await failModel(body.modelId, 'late', { gpuJobId: 'gpu-job-1' }), false);
    assert.equal((await row(body.modelId)).status, 'awaiting_review');
  });

  it('approves one model per machine: approving another rejects the one before', async () => {
    const { body } = await list();
    const [newest, second] = body.models.filter((m) => m.status === 'awaiting_review');

    const first = await as('post', `/v1/review/models/${second.modelId}/approve`).send({}).expect(200);
    assert.equal(first.body.replaced, null);
    assert.equal((await row(second.modelId)).status, 'approved');
    assert.equal((await row(second.modelId)).reviewed_by, DEMO.reviewer.id);

    const next = await as('post', `/v1/review/models/${newest.modelId}/approve`).send({ note: 'Better handles.' }).expect(200);
    assert.equal(next.body.replaced, second.modelId);
    const replaced = await row(second.modelId);
    assert.equal(replaced.status, 'rejected');
    assert.equal(replaced.review_note, REPLACED_NOTE);
    const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM machine_models WHERE machine_id = ? AND status = 'approved'`, [machineId]);
    assert.equal(Number(n), 1);
    const approvedModel = next.body.models.find((m) => m.modelId === newest.modelId);
    assert.equal(approvedModel.reviewNote, 'Better handles.');
    assert.equal(approvedModel.reviewedBy.name, 'Maya Restrepo');
    assert.ok(approvedModel.url, 'an approved model can be shown');

    const log = (await events('MACHINE_MODEL_APPROVED')).at(-1);
    assert.equal(log.detail.replaced, second.modelId);
    assert.equal(log.target_label, 'EQ-001 · Treadmill 1');

    // Approving it again changes nothing.
    const same = await as('post', `/v1/review/models/${newest.modelId}/approve`).send({}).expect(200);
    assert.equal(same.body.replaced, null);
  });

  it('rejects with a reason, and lets the reviewer go back to an earlier model', async () => {
    const { body } = await list();
    const approved = body.models.find((m) => m.status === 'approved');
    const earlier = body.models.find((m) => m.status === 'rejected');

    const noNote = await as('post', `/v1/review/models/${approved.modelId}/reject`).send({}).expect(400);
    assert.match(noNote.body.message, /note/);
    await as('post', `/v1/review/models/${approved.modelId}/reject`).send({ note: '   ' }).expect(400);

    const rejected = await as('post', `/v1/review/models/${approved.modelId}/reject`)
      .send({ note: 'The seat is missing.' })
      .expect(200);
    assert.ok(!rejected.body.models.some((m) => m.status === 'approved'), 'no approved model left');
    assert.equal((await row(approved.modelId)).review_note, 'The seat is missing.');
    assert.equal((await events('MACHINE_MODEL_REJECTED')).at(-1).detail.wasApproved, true);

    await as('post', `/v1/review/models/${earlier.modelId}/approve`).send({}).expect(200);
    assert.equal((await row(earlier.modelId)).status, 'approved');
  });

  it('refuses decisions a model is not ready for', async () => {
    const [seeded] = (await list()).body.models.filter((m) => m.seed === null);
    // The seeded model has no file: nothing to approve.
    await pool.query(`UPDATE machine_models SET status = 'failed' WHERE id = ?`, [seeded.modelId]);
    const refused = await as('post', `/v1/review/models/${seeded.modelId}/approve`).send({}).expect(409);
    assert.match(refused.body.message, /only a built model/);
    await as('post', `/v1/review/models/${seeded.modelId}/reject`).send({ note: 'No.' }).expect(409);
    await as('post', '/v1/review/models/01920000-0000-7000-8000-00000000ffff/approve').send({}).expect(404);
    await as('post', '/v1/review/models/nope/approve').send({}).expect(404);
    await as('post', `/v1/review/models/${seeded.modelId}/approve`).send({ extra: 1 }).expect(400);
  });

  it('builds once on its own: an automatic request finds the model already made', async () => {
    const before = (await list()).body.models.length;
    const { model, queued } = await transaction((db) => queueModel(db, { machineId, again: false }));
    assert.equal(queued, false);
    assert.equal(model.input_hash, (await row(model.id)).input_hash);
    assert.equal((await list()).body.models.length, before);
  });

  it('fails a queued build whose video was retaken before it ran', async () => {
    // Queued without running the job straight away, as on the worker.
    const { model } = await transaction((db) => queueModel(db, { machineId, again: true }));
    await pool.query(
      `UPDATE capture_files f JOIN machine_videos v ON v.video_file_id = f.id
       SET f.storage_key = CONCAT(f.storage_key, '.retake') WHERE v.machine_id = ?`,
      [machineId],
    );
    let built = false;
    setBuilder(async () => {
      built = true;
      return { glbKey: 'x' };
    });
    const caught = catchMetrics();
    await runDueJobs().finally(caught.stop);
    assert.equal(built, false);
    const failed = await row(model.id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.failure_reason, /video changed/);
    // Not a fault: the reviewer builds again from the new video (N-03).
    assert.deepEqual(caught.seen.map((m) => [m.name, m.Cause]), [['ModelsFailed', 'input']]);
  });

  it('ignores a job from an earlier try of the same model', async () => {
    setBuilder(finished);
    const { body } = await build().expect(202);
    const current = await row(body.modelId);
    assert.equal(current.status, 'awaiting_review');
    // Back to queued, as if it were being tried again, then a stale job turns up.
    await pool.query(`UPDATE machine_models SET status = 'queued', attempt = 5 WHERE id = ?`, [current.id]);
    await handlerFor('asset.build').run({ subject_id: current.id, payload: { attempt: current.attempt } });
    assert.equal((await row(current.id)).status, 'queued');
    assert.equal(await failModel(current.id, 'stale', { attempt: current.attempt }), false);
    await pool.query(`UPDATE machine_models SET status = 'awaiting_review', attempt = ? WHERE id = ?`, [current.attempt, current.id]);
  });

  it('removing the account deletes its model files from the models store', async () => {
    const keys = (
      await pool.query('SELECT glb_key, metadata_key FROM machine_models WHERE machine_id = ? AND glb_key IS NOT NULL', [machineId])
    )[0].flatMap((r) => [r.glb_key, r.metadata_key]);
    assert.ok(keys.length >= 4);
    for (const k of keys) assert.ok(await models.exists(k), k);

    await enqueue(pool, { kind: 'account.remove', subjectId: DEMO.account, accountId: DEMO.account });
    await runDueJobs();
    for (const k of keys) assert.equal(await models.exists(k), false, k);
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM machine_models WHERE account_id = ?', [DEMO.account]);
    assert.equal(Number(n), 0);
  });
});
