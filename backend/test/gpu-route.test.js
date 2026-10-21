/**
 * The generated route for machine models (L-05): the build is submitted to
 * AWS Batch as soon as a machine's 360 video is in, and Batch's outcome,
 * read from the gpu-jobs queue, finishes or fails the model. Batch, SQS and
 * the GPU are stood in for; the database, the jobs and the stores are real.
 *
 * The tests run in order and build on each other.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { modelFolder, setBuilder, tryFolder } from '../src/assets/index.js';
import { handleGpuEvent, handleGpuJob, pollGpuOutcomes, publishBuildGauges, sweepStuckBuilds } from '../src/assets/outcomes.js';
import { jobParameters, setBatch, submitBuild } from '../src/assets/trellis2.js';
import { config, productionProblems } from '../src/config.js';
import { one, pool } from '../src/db/pool.js';
import { enqueue, handlerFor, PermanentJobError, runDueJobs } from '../src/jobs/index.js';
import { catchMetrics } from '../src/metrics3d.js';
import { setModelStorage } from '../src/storage/index.js';
import { LocalStorage } from '../src/storage/local.js';
import { rawModel } from './fixtures/models.js';
import { api, DEMO, login, putPart, useTestServer } from './helpers.js';

const ctx = useTestServer();
const PART = 5 * 1024 * 1024;

/** AWS Batch, as far as the backend uses it. */
class FakeBatch {
  constructor() {
    this.submitted = [];
    this.jobs = new Map();
  }

  async send(command) {
    const name = command.constructor.name;
    if (name === 'SubmitJobCommand') {
      this.submitted.push(command.input);
      return { jobId: `job-${this.submitted.length}` };
    }
    if (name === 'ListJobsCommand') {
      const wanted = command.input.filters[0].values[0];
      const jobSummaryList = this.submitted
        .map((job, i) => ({ jobId: `job-${i + 1}`, jobName: job.jobName, createdAt: i, status: this.jobs.get(`job-${i + 1}`)?.status ?? 'RUNNING' }))
        .filter((job) => job.jobName === wanted);
      return { jobSummaryList };
    }
    if (name === 'DescribeJobsCommand') return { jobs: command.input.jobs.map((id) => this.jobs.get(id)).filter(Boolean) };
    throw new Error(`unexpected ${name}`);
  }
}

/** What the 3D metrics publish while `fn` runs (N-03), each as 'Name' or 'Name:dimension value'. */
async function published(fn) {
  const caught = catchMetrics();
  try {
    await fn();
  } finally {
    caught.stop();
  }
  return caught.seen.map(({ name, value, unit, namespace, ...dims }) => [name, ...Object.values(dims)].join(':'));
}

/** TRELLIS.2's GLB, small: what a finished job leaves. */
const gpuModel = () => rawModel({ grid: 24, texture: 256 });

const event = (jobId, status, extra = {}) => ({
  version: '0',
  source: 'aws.batch',
  'detail-type': 'Batch Job State Change',
  detail: { jobId, jobName: 'machine-model', jobQueue: 'arn:aws:batch:ap-southeast-2:1:job-queue/flexgym-dev-trellis2', status, ...extra },
});

describe('the generated route (L-05)', () => {
  const saved = { assets: { ...config.assets }, storage: { ...config.storage } };
  const batch = new FakeBatch();
  let models;
  let modelsDir;
  let reviewer;
  let machineId;
  let captureId;

  const as = (method, url, token) => api(ctx)[method](url).set('Authorization', `Bearer ${token ?? ctx.token}`);
  const row = (id) => one(pool, 'SELECT * FROM machine_models WHERE id = ?', [id]);
  const newest = () => one(pool, 'SELECT * FROM machine_models WHERE machine_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', [machineId]);
  const build = () => as('post', `/v1/review/machines/${machineId}/models`, reviewer).send({});

  after(async () => {
    Object.assign(config.assets, saved.assets);
    Object.assign(config.storage, saved.storage);
    setBatch(null);
    setBuilder(async () => {
      throw new PermanentJobError('No builder.');
    });
    if (modelsDir) await rm(modelsDir, { recursive: true, force: true });
  });

  it('submits the build to the GPU as soon as the 360 video is in', async () => {
    reviewer = (await login(ctx, DEMO.reviewer)).accessToken;
    modelsDir = await mkdtemp(path.join(os.tmpdir(), 'gym-gpu-models-'));
    models = new LocalStorage({ dir: modelsDir, secret: config.storage.signingSecret, publicUrl: config.publicApiUrl });
    setModelStorage(models);
    // WebP here, as encoding KTX2 takes seconds a model; KTX2 itself is tested in optimise.test.js.
    Object.assign(config.assets, { autoBuild: true, jobQueue: 'flexgym-dev-trellis2', jobDefinition: 'flexgym-dev-trellis2', textures: 'webp' });
    Object.assign(config.storage, { s3Bucket: 'flexgym-dev-captures', modelsBucket: 'flexgym-dev-models' });
    setBatch(batch);
    setBuilder(submitBuild);

    const reg = await as('post', '/v1/captures')
      .set('Idempotency-Key', 'gpu-route-1')
      .send({
        facilityId: DEMO.facilities.northgate,
        level: 11,
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
      })
      .expect(201);
    captureId = reg.body.captureId;
    const machine = { equipmentId: 'EQ-001', type: 'treadmill', name: 'Treadmill 1', x: 4, z: 3, rotationDeg: 0, widthM: 0.85, depthM: 2.1, heightM: 1.5 };
    await as('post', `/v1/captures/${captureId}/equipment`).send({ equipment: [machine] }).expect(201);
    ({ id: machineId } = await one(pool, `SELECT id FROM machines WHERE capture_id = ? AND ref = 'EQ-001'`, [captureId]));

    const video = randomBytes(1024);
    const opened = await as('post', `/v1/captures/${captureId}/equipment/EQ-001/video`)
      .send({ partSize: PART, bytes: video.length, contentType: 'video/mp4', durationSeconds: 40 })
      .expect(201);
    await putPart(ctx, opened.body.files[0].parts[0].url, video).expect(200);
    assert.equal(batch.submitted.length, 0, 'nothing until the video is complete');
    await as('post', `/v1/captures/${captureId}/equipment/EQ-001/video/complete`).send({}).expect(200);

    const model = await newest();
    assert.equal(model.status, 'building');
    assert.equal(model.gpu_job_id, 'job-1');
    assert.equal(model.seed, 1);
    const [job] = batch.submitted;
    assert.equal(job.jobName, `machine-model-${model.id}-try-1`);
    assert.equal(job.jobQueue, 'flexgym-dev-trellis2');
    assert.equal(job.jobDefinition, 'flexgym-dev-trellis2');
    const { storage_key: key } = await one(
      pool,
      'SELECT f.storage_key FROM capture_files f JOIN machine_videos v ON v.video_file_id = f.id WHERE v.machine_id = ?',
      [machineId],
    );
    assert.equal(job.parameters.input, `s3://flexgym-dev-captures/${key}`);
    assert.equal(job.parameters.output, `s3://flexgym-dev-models/models/accounts/${DEMO.account}/assets/${model.id}/try-1/`);
    assert.deepEqual(JSON.parse(job.parameters.params), { seed: 1, machine: { route: 'generated', box: { w: 0.85, d: 2.1, h: 1.5 } } });

    // Saying the video is complete again builds nothing more.
    await as('post', `/v1/captures/${captureId}/equipment/EQ-001/video/complete`).send({}).expect(200);
    assert.equal(batch.submitted.length, 1);
  });

  it('passes the ARKit frames on when the app sent them, and no box it does not have', () => {
    const params = jobParameters(
      { model: { id: 'm', account_id: 'a', attempt: 2, seed: 4 }, machine: { storage_key: 'v.mov', frames_key: 'f.zip', width_m: '1.2', depth_m: null, height_m: '1' } },
      { storage: { s3Bucket: 'c', modelsBucket: 'm' } },
    );
    assert.equal(params.output, 's3://m/models/accounts/a/assets/m/try-2/');
    assert.deepEqual(JSON.parse(params.params), { seed: 4, machine: { route: 'generated', box: null, frames: 's3://c/f.zip' } });
  });

  it('a finished job’s model is made ready and waits for the reviewer', async () => {
    const model = await newest();
    const folder = tryFolder(model);
    await models.write(`${folder}model.glb`, await gpuModel());
    await models.write(`${folder}metadata.json`, Buffer.from('{"worker":"trellis2"}'));

    assert.deepEqual(
      await published(async () => assert.equal(await handleGpuEvent(event('job-1', 'SUCCEEDED', { container: { exitCode: 0 } })), 'finished')),
      ['ModelsBuilt:generated'],
    );
    const done = await row(model.id);
    assert.equal(done.status, 'awaiting_review');
    assert.equal(done.raw_glb_key, `${folder}model.glb`, 'the GPU’s own GLB is kept');
    assert.equal(done.metadata_key, `${folder}metadata.json`);
    // Three levels of detail, nearest first, each stored under its content hash in the model's folder.
    assert.equal(done.lods.length, 3);
    for (const lod of done.lods) {
      assert.match(lod.key, new RegExp(`^${modelFolder(model)}[0-9a-f]{64}\\.glb$`));
      assert.ok(await models.exists(lod.key));
    }
    assert.equal(done.glb_key, done.lods[0].key);
    assert.equal(done.triangle_count, done.lods[0].triangles);
    assert.equal(Number(done.bytes), done.lods[0].bytes);
    // Scaled to the treadmill's scan (0.85 x 2.1 x 1.5) and turned to run its way.
    assert.equal(done.turn_deg, 90);
    assert.ok(Number(done.size_d_m) > Number(done.size_w_m));
    assert.ok(Number(done.scale_error_pct) < 15);
    assert.deepEqual(done.flags, ['front_guessed']);
    // The same event again (SQS delivers at least once) changes nothing.
    assert.equal(await handleGpuEvent(event('job-1', 'SUCCEEDED')), 'stale');

    const { body } = await as('get', `/v1/review/machines/${machineId}/models`, reviewer).expect(200);
    const shown = body.models[0];
    assert.ok(shown.url, 'the reviewer gets a link to it');
    assert.equal(shown.lods.length, 3);
    assert.ok(shown.lods.every((l) => l.url && l.triangles > 0 && l.textureSize > 0));
    assert.equal(shown.turnDeg, 90);
    assert.deepEqual(shown.flags.map((f) => f.code), ['front_guessed']);
    assert.match(shown.flags[0].message, /front/);
  });

  it('a reviewer turns a model: made again from the GPU’s GLB, without the GPU, and reviewed again', async () => {
    const first = await one(pool, 'SELECT * FROM machine_models WHERE machine_id = ? AND seed = 1', [machineId]);
    await as('post', `/v1/review/models/${first.id}/approve`, reviewer).send({}).expect(200);
    const submitted = batch.submitted.length;

    const res = await as('post', `/v1/review/models/${first.id}/turn`, reviewer).send({ turnDeg: 270 }).expect(202);
    assert.equal(res.body.changed, true);
    assert.equal(batch.submitted.length, submitted, 'no GPU job');
    const turned = await row(first.id);
    assert.equal(turned.status, 'awaiting_review', 'its files changed, so it is reviewed again');
    assert.equal(turned.turn_deg, 270);
    assert.equal(turned.flags, null, 'the front is the reviewer’s now, not a guess');
    assert.equal(turned.raw_glb_key, first.raw_glb_key);
    assert.notEqual(turned.glb_key, first.glb_key);
    assert.equal(turned.attempt, first.attempt + 1);
    // A half turn from 90: the front is the other end, the size the same.
    assert.deepEqual([turned.size_w_m, turned.size_d_m, turned.size_h_m], [first.size_w_m, first.size_d_m, first.size_h_m]);
    const log = (await pool.query(`SELECT detail FROM audit_log WHERE action = 'MACHINE_MODEL_TURNED' AND target_id = ?`, [machineId]))[0];
    assert.deepEqual(log.at(-1).detail, { modelId: first.id, from: 90, to: 270, wasApproved: true });

    const again = await as('post', `/v1/review/models/${first.id}/turn`, reviewer).send({ turnDeg: 270 }).expect(200);
    assert.equal(again.body.changed, false, 'already that way round');
    await as('post', `/v1/review/models/${first.id}/turn`, reviewer).send({ turnDeg: 45 }).expect(400);
    await as('post', `/v1/review/models/${first.id}/turn`, ctx.token).send({ turnDeg: 0 }).expect(403);
    // A quarter turn to 0 runs its long side across the footprint: the scale is fitted again, and flagged.
    await as('post', `/v1/review/models/${first.id}/turn`, reviewer).send({ turnDeg: 0 }).expect(202);
    const across = await row(first.id);
    assert.ok(Number(across.size_w_m) > Number(across.size_d_m));
    assert.deepEqual(across.flags, ['size_mismatch']);
    // The files of the way it stood before are gone; the model has new ones (N-02).
    for (const lod of first.lods) assert.equal(await models.exists(lod.key), false, lod.key);
    for (const lod of across.lods) assert.ok(await models.exists(lod.key), lod.key);
    // Back to how it was.
    await as('post', `/v1/review/models/${first.id}/turn`, reviewer).send({ turnDeg: 90 }).expect(202);
    const back = await row(first.id);
    assert.equal(back.glb_key, first.glb_key, 'the same files as before: named by their content');
    for (const lod of back.lods) assert.ok(await models.exists(lod.key), lod.key);
  });

  it('a model that cannot be made ready fails with the reason', async () => {
    await build().expect(202);
    const model = await newest();
    await models.write(`${tryFolder(model)}model.glb`, Buffer.from('glTF but not really'));
    assert.deepEqual(
      await published(async () => assert.equal(await handleGpuEvent(event(model.gpu_job_id, 'SUCCEEDED')), 'failed')),
      ['ModelsFailed:ready', 'ModelFaults'],
    );
    assert.match((await row(model.id)).failure_reason, /could not be made ready for the walkthrough \(it is not a GLB/);
  });

  it('a failed job says why: the worker’s own reason, or Batch’s', async () => {
    // The model the last test failed is tried again: its second try.
    await build().expect(202);
    let model = await newest();
    assert.equal(model.seed, 2);
    assert.equal(model.attempt, 2);
    assert.equal(model.gpu_job_id, 'job-3');
    await models.write(
      `${tryFolder(model)}error.json`,
      Buffer.from(JSON.stringify({ kind: 'input', reason: 'No frame shows the whole machine on its own (…).' })),
    );
    // The recording's problem, not ours: counted, but no alarm (N-03).
    assert.deepEqual(
      await published(async () =>
        assert.equal(await handleGpuEvent(event('job-3', 'FAILED', { statusReason: 'Essential container in task exited' })), 'failed'),
      ),
      ['ModelsFailed:input'],
    );
    assert.equal((await row(model.id)).failure_reason, 'No frame shows the whole machine on its own (…).');

    // Tried again: the same row, its own folder, so the last try's error.json is not mistaken for this one's.
    await build().expect(202);
    model = await row(model.id);
    assert.equal(model.attempt, 3);
    assert.equal(model.gpu_job_id, 'job-4');
    assert.equal(batch.submitted.at(-1).parameters.output.endsWith('/try-3/'), true);
    assert.deepEqual(
      await published(async () =>
        assert.equal(await handleGpuEvent(event('job-4', 'FAILED', { statusReason: 'Job attempt duration exceeded timeout' })), 'failed'),
      ),
      ['ModelsFailed:gpu', 'ModelFaults'],
    );
    assert.match((await row(model.id)).failure_reason, /ran out of time/);

    await build().expect(202);
    model = await row(model.id);
    await models.write(`${tryFolder(model)}error.json`, Buffer.from(JSON.stringify({ kind: 'internal', reason: 'RuntimeError: CUDA out of memory' })));
    assert.deepEqual(await published(() => handleGpuEvent(event(model.gpu_job_id, 'FAILED'))), ['ModelsFailed:gpu', 'ModelFaults']);
    assert.equal((await row(model.id)).failure_reason, 'The GPU worker failed: RuntimeError: CUDA out of memory. Tell the 3D team.');
    const refused = await as('post', `/v1/review/models/${model.id}/turn`, reviewer).send({ turnDeg: 180 }).expect(409);
    assert.match(refused.body.message, /only a built model can be turned/);
  });

  it('a job that says it succeeded but left no model fails', async () => {
    await build().expect(202);
    const model = await newest();
    assert.equal(model.status, 'building');
    assert.deepEqual(
      await published(async () => assert.equal(await handleGpuEvent(event(model.gpu_job_id, 'SUCCEEDED')), 'failed')),
      ['ModelsFailed:gpu', 'ModelFaults'],
    );
    assert.match((await row(model.id)).failure_reason, /left no model/);
  });

  it('makes machine models with KTX2 textures unless told otherwise (N-01)', () => {
    assert.equal(saved.assets.textures, 'ktx2', 'the default, with MODEL_TEXTURES unset');
    const prod = (textures) => productionProblems({ ...config, isProduction: true, assets: { ...config.assets, textures } });
    assert.ok(prod('png').includes('MODEL_TEXTURES must be webp or ktx2'));
    assert.ok(!prod('ktx2').some((p) => /MODEL_TEXTURES/.test(p)));
  });

  it('will not start in production with the GPU route on and not set up', () => {
    const prod = (assets) => productionProblems({ ...config, isProduction: true, assets: { ...config.assets, ...assets } });
    const missing = prod({ builder: 'trellis2', jobQueue: '', outcomesQueueUrl: '' });
    assert.ok(missing.includes('TRELLIS2_JOB_QUEUE must be set when ASSET_BUILDER is trellis2'));
    assert.ok(missing.includes('GPU_JOBS_QUEUE_URL must be set when ASSET_BUILDER is trellis2'));
    assert.ok(prod({ builder: 'gpu' }).includes('ASSET_BUILDER must be none or trellis2'));
    assert.ok(!prod({ builder: 'none' }).some((p) => /ASSET_BUILDER/.test(p)));
  });

  it('ignores what is not a finished job of ours', async () => {
    assert.equal(await handleGpuEvent(event('job-unknown', 'SUCCEEDED')), 'unknown');
    assert.equal(await handleGpuEvent(event('job-1', 'RUNNING')), 'ignored');
    assert.equal(await handleGpuEvent({ 'detail-type': 'Object Created', detail: {} }), 'ignored');
    assert.equal(await handleGpuEvent({}), 'ignored');
  });

  it('reads the queue: handled messages are deleted, the rest come back later', async () => {
    const deleted = [];
    const queue = {
      async receive() {
        return [1, 2, 3].map((n) => ({ body: { n }, done: async () => deleted.push(n) }));
      },
    };
    const quiet = console.error;
    console.error = () => {};
    const handled = await pollGpuOutcomes(queue, {
      handle: async (body) => {
        if (body.n === 2) throw new Error('database away');
      },
    }).finally(() => {
      console.error = quiet;
    });
    assert.equal(handled, 2);
    assert.deepEqual(deleted, [1, 3]);
  });

  it('settles builds whose events went missing, by asking Batch', async () => {
    await build().expect(202);
    const lostEvent = await newest();
    await pool.query(`UPDATE machine_models SET updated_at = UTC_TIMESTAMP(3) - INTERVAL 7 HOUR WHERE id = ?`, [lostEvent.id]);
    await models.write(`${tryFolder(lostEvent)}model.glb`, await gpuModel());
    batch.jobs.set(lostEvent.gpu_job_id, { jobId: lostEvent.gpu_job_id, status: 'SUCCEEDED' });

    const other = await one(pool, `SELECT id FROM machines WHERE account_id = ? AND ref = 'EQ-002'`, [DEMO.account]);
    // A second machine whose job Batch has forgotten, and a third still within its time.
    const forgotten = { id: '01920000-0000-7000-8000-0000000f0001', gpu: 'job-forgotten' };
    const recent = { id: '01920000-0000-7000-8000-0000000f0002', gpu: 'job-recent' };
    for (const [m, ago] of [[forgotten, 8], [recent, 1]]) {
      await pool.query(
        `INSERT INTO machine_models (id, account_id, machine_id, route, generator_version, input_hash, seed, status, gpu_job_id, updated_at)
         VALUES (?, ?, ?, 'generated', 'trellis2-1', ?, 1, 'building', ?, UTC_TIMESTAMP(3) - INTERVAL ? HOUR)`,
        [m.id, DEMO.account, other.id, m.id.replace(/-/g, '').padEnd(64, '0'), m.gpu, ago],
      );
    }

    // How the builds on the GPU stand (N-03): the oldest was sent there 8 hours ago.
    const caught = catchMetrics();
    const gauges = await publishBuildGauges();
    caught.stop();
    const building = await one(pool, `SELECT COUNT(*) AS n FROM machine_models WHERE status = 'building' AND gpu_job_id IS NOT NULL`);
    assert.equal(gauges.onGpu, Number(building.n));
    assert.ok(gauges.onGpu >= 3);
    assert.ok(gauges.oldestSeconds >= 8 * 3600 - 60 && gauges.oldestSeconds < 8 * 3600 + 60, String(gauges.oldestSeconds));
    assert.deepEqual(
      caught.seen.map(({ name, value, unit }) => [name, value, unit]),
      [['BuildsOnGpu', gauges.onGpu, 'Count'], ['OldestBuildSeconds', gauges.oldestSeconds, 'Seconds']],
    );

    let settled;
    const seen = await published(async () => {
      settled = await sweepStuckBuilds({ client: batch });
    });
    assert.deepEqual(seen.sort(), ['ModelFaults', 'ModelsBuilt:generated', 'ModelsFailed:lost']);
    assert.equal(settled, 2);
    assert.equal((await row(lostEvent.id)).status, 'awaiting_review');
    assert.equal((await row(forgotten.id)).status, 'failed');
    assert.match((await row(forgotten.id)).failure_reason, /lost/);
    assert.equal((await row(recent.id)).status, 'building');
    assert.equal(await sweepStuckBuilds({ client: batch }), 0, 'nothing left to settle');
    assert.equal(await handleGpuJob({ jobId: recent.gpu, status: 'FAILED', statusReason: 'Host EC2 terminated' }), 'failed');
    // Nothing on the GPU any more: the gauge falls back to nothing, so the alarm clears.
    await pool.query(`UPDATE machine_models SET status = 'failed' WHERE status = 'building'`);
    assert.deepEqual(await publishBuildGauges(), { onGpu: 0, oldestSeconds: 0 });
  });

  it('a measured model (L-04) needs the ARKit frames, is built once, and keeps its measured size', async () => {
    // No frames yet: the reviewer is told why.
    let listed = await as('get', `/v1/review/machines/${machineId}/models`, reviewer).expect(200);
    assert.equal(listed.body.canMeasure, false);
    const refused = await as('post', `/v1/review/machines/${machineId}/models`, reviewer).send({ route: 'measured' }).expect(409);
    assert.match(refused.body.message, /needs the walk-round’s ARKit frames/);
    await as('post', `/v1/review/machines/${machineId}/models`, reviewer).send({ route: 'drawn' }).expect(400);

    // The app sends the frames with the video (I-05).
    const video = await one(pool, 'SELECT * FROM machine_videos WHERE machine_id = ?', [machineId]);
    const framesKey = `accounts/${DEMO.account}/captures/${captureId}/equipment/EQ-001/${video.id}/frames.zip`;
    const framesId = '01920000-0000-7000-8000-0000000f0f01';
    await pool.query(
      `INSERT INTO capture_files (id, capture_id, kind, name, bytes, content_type, part_size, part_count, storage_key, upload_id, status)
       VALUES (?, ?, 'frames', ?, 4096, 'application/zip', 5242880, 1, ?, 'upload-frames-1', 'stored')`,
      [framesId, captureId, `equipment/EQ-001/${video.id}/frames.zip`, framesKey],
    );
    await pool.query('UPDATE machine_videos SET frames_file_id = ? WHERE id = ?', [framesId, video.id]);
    listed = await as('get', `/v1/review/machines/${machineId}/models`, reviewer).expect(200);
    assert.equal(listed.body.canMeasure, true);

    const built = await as('post', `/v1/review/machines/${machineId}/models`, reviewer).send({ route: 'measured' }).expect(202);
    const model = await row(built.body.modelId);
    assert.equal(model.route, 'measured');
    assert.equal(model.status, 'building');
    const params = JSON.parse(batch.submitted.at(-1).parameters.params);
    assert.deepEqual(params.machine, { route: 'measured', box: { w: 0.85, d: 2.1, h: 1.5 }, frames: `s3://flexgym-dev-captures/${framesKey}` });

    // Asked for again while it builds, or once built: the same model, as measuring again gives the same.
    assert.equal((await as('post', `/v1/review/machines/${machineId}/models`, reviewer).send({ route: 'measured' }).expect(200)).body.modelId, model.id);
    await models.write(`${tryFolder(model)}model.glb`, await gpuModel());
    assert.equal(await handleGpuEvent(event(model.gpu_job_id, 'SUCCEEDED')), 'finished');
    const again = await as('post', `/v1/review/machines/${machineId}/models`, reviewer).send({ route: 'measured' }).expect(200);
    assert.equal(again.body.queued, false);
    assert.equal(again.body.modelId, model.id);

    // Measured, so its size is its own (the stand-in is 0.9 x 0.62 x 0.42 m), checked against the scan and flagged.
    const done = await row(model.id);
    assert.equal(done.status, 'awaiting_review');
    assert.deepEqual([Number(done.size_w_m), Number(done.size_h_m)].map((v) => Math.round(v * 100) / 100), [0.42, 0.62]);
    assert.ok(Number(done.scale_error_pct) > 50);
    assert.deepEqual(done.flags, ['size_mismatch', 'front_guessed']);
    const shown = (await as('get', `/v1/review/machines/${machineId}/models`, reviewer).expect(200)).body.models.find((m) => m.modelId === model.id);
    assert.equal(shown.route, 'measured');
  });

  it('adopts a try already on the GPU instead of sending it twice (N-02)', async () => {
    // The worker sent the try and stopped before recording its job; the job runs again.
    await build().expect(202);
    const model = await newest();
    const sent = batch.submitted.length;
    await pool.query('UPDATE machine_models SET gpu_job_id = NULL WHERE id = ?', [model.id]);
    await handlerFor('asset.build').run({ subject_id: model.id, payload: { attempt: model.attempt } });
    assert.equal(batch.submitted.length, sent, 'not sent again');
    assert.equal((await row(model.id)).gpu_job_id, model.gpu_job_id);

    // And if that job had already finished, its outcome is taken there and then.
    await pool.query('UPDATE machine_models SET gpu_job_id = NULL WHERE id = ?', [model.id]);
    batch.jobs.set(model.gpu_job_id, { jobId: model.gpu_job_id, status: 'SUCCEEDED' });
    await models.write(`${tryFolder(model)}model.glb`, await gpuModel());
    await handlerFor('asset.build').run({ subject_id: model.id, payload: { attempt: model.attempt } });
    assert.equal(batch.submitted.length, sent);
    assert.equal((await row(model.id)).status, 'awaiting_review');
  });

  it('removing the account clears every try’s files from the models store', async () => {
    // The second model's tries left an error.json each, and the first model its levels of detail.
    const model = await one(pool, 'SELECT * FROM machine_models WHERE machine_id = ? AND seed = 2', [machineId]);
    const first = await one(pool, 'SELECT * FROM machine_models WHERE machine_id = ? AND seed = 1', [machineId]);
    const left = [...[2, 4].map((attempt) => `${tryFolder({ ...model, attempt })}error.json`), ...first.lods.map((l) => l.key)];
    for (const key of left) assert.ok(await models.exists(key), key);
    await enqueue(pool, { kind: 'account.remove', subjectId: DEMO.account, accountId: DEMO.account });
    await runDueJobs();
    for (const key of left) assert.equal(await models.exists(key), false, key);
  });
});
