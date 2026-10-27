/**
 * Outcomes of GPU jobs (task L-05). AWS Batch reports each TRELLIS.2 job
 * that succeeded or failed as a "Batch Job State Change" event, which
 * EventBridge puts on the gpu-jobs queue (infra/lib/gpu-stack.ts). The
 * worker reads that queue (`pollGpuOutcomes`) and finishes or fails the
 * model whose job it was.
 *
 * By the time Batch says FAILED it has already retried any try that failed
 * for a passing reason, so a failure is final; the reviewer can build again.
 * The reason is the worker's own (its error.json) when it wrote one, or
 * Batch's (a timeout, a lost host) when it did not.
 *
 * A finished job's GLB is TRELLIS.2's own; before the model goes to the
 * reviewer it is scaled, lined up and given its levels of detail (L-06,
 * optimise.js), each stored under its content hash.
 *
 * If an event is ever lost, `sweepStuckBuilds` asks Batch about models that
 * have been building for too long and treats the answer as the event.
 */
import { config } from '../config.js';
import { many, one, pool } from '../db/pool.js';
import { CAUSES, metric3d } from '../metrics3d.js';
import { modelStorage } from '../storage/index.js';
import { failModel, finishModel, machineFor, modelFolder, tryFolder } from './index.js';
import { optimiseInThread } from './optimise-thread.js';
import { batch, boxOf } from './trellis2.js';

const DONE = ['SUCCEEDED', 'FAILED'];
/** Longer than a job's own limit (an hour per attempt) plus time in the queue. */
export const STUCK_MINUTES = 6 * 60;

/** Why Batch ended a job the worker could not explain itself (no error.json). */
function batchReason(job) {
  const said = job.statusReason || job.container?.reason || 'no reason given';
  if (/timeout/i.test(said)) return 'The GPU job ran out of time. Build again; if it happens again, tell the 3D team.';
  return `The GPU job stopped: ${said}. Build again; if it happens again, tell the 3D team.`;
}

/**
 * Handles one Batch job state change (the event's `detail`, or a job as
 * DescribeJobs returns it). Returns what it did: 'finished', 'failed',
 * 'ignored' (not a finished job), 'unknown' (no model has this job) or
 * 'stale' (the model has moved on).
 */
export async function handleGpuJob(job, { store = modelStorage() } = {}) {
  if (!job?.jobId || !DONE.includes(job.status)) return 'ignored';
  const model = await one(pool, 'SELECT * FROM machine_models WHERE gpu_job_id = ?', [job.jobId]);
  if (!model) return 'unknown';
  if (model.status !== 'building') return 'stale';
  const folder = tryFolder(model);
  const expect = { gpuJobId: job.jobId };

  if (job.status === 'SUCCEEDED') {
    const rawGlbKey = `${folder}model.glb`;
    let raw;
    try {
      raw = await store.read(rawGlbKey);
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.name !== 'NoSuchKey') throw err; // the store, for a moment: try again later
      return (await failModel(model.id, 'The GPU job left no model. Tell the 3D team.', expect, { cause: CAUSES.gpu })) ? 'failed' : 'stale';
    }
    const machine = await machineFor(pool, model.machine_id);
    let ready;
    try {
      ready = await makeReady(model, raw, { box: boxOf(machine), store });
    } catch (err) {
      if (err?.storeError) throw err;
      const why = `The GPU's model could not be made ready for the walkthrough (${err.message}). Tell the 3D team.`;
      return (await failModel(model.id, why, expect, { cause: CAUSES.ready })) ? 'failed' : 'stale';
    }
    const done = await finishModel(model.id, { ...ready, rawGlbKey, metadataKey: `${folder}metadata.json` }, expect);
    if (done) metric3d('ModelsBuilt', { Route: model.route });
    return done ? 'finished' : 'stale';
  }

  let reason = null;
  let cause = CAUSES.gpu;
  try {
    const error = JSON.parse(await store.read(`${folder}error.json`));
    if (error.kind === 'input') cause = CAUSES.input;
    reason = error.kind === 'input' ? error.reason : `The GPU worker failed: ${error.reason}. Tell the 3D team.`;
  } catch {
    reason = batchReason(job);
  }
  return (await failModel(model.id, reason, expect, { cause })) ? 'failed' : 'stale';
}

/**
 * Makes the walkthrough's model from the GPU's GLB (L-06) and stores its
 * levels of detail in the model's folder, each named by its content, so a
 * file under a name never changes and links to it can be cached. Returns
 * what finishModel records.
 */
export async function makeReady(model, raw, { box, turnDeg = null, store = modelStorage() } = {}) {
  // A measured model (L-04) is in metres already: its size is kept, and checked against the scan.
  const made = await optimiseInThread(raw, { box, turnDeg, keepScale: model.route === 'measured', textures: config.assets.textures });
  const lods = [];
  for (const lod of made.lods) {
    const key = `${modelFolder(model)}${lod.sha256}.glb`;
    try {
      await store.write(key, lod.glb, { contentType: 'model/gltf-binary' });
    } catch (err) {
      err.storeError = true;
      throw err;
    }
    lods.push({ key, bytes: lod.bytes, triangles: lod.triangles, texture: lod.texture });
  }
  return {
    glbKey: lods[0].key,
    bytes: lods[0].bytes,
    triangleCount: lods[0].triangles,
    lods,
    sizeM: made.sizeM,
    scaleErrorPct: made.scaleErrorPct,
    turnDeg: made.turnDeg,
    flags: made.flags,
  };
}

/** An EventBridge event from the queue: its detail is the job. */
export const handleGpuEvent = (event, options) =>
  event?.['detail-type'] === 'Batch Job State Change' ? handleGpuJob(event.detail, options) : Promise.resolve('ignored');

/**
 * Reads one batch of messages from the gpu-jobs queue and handles them. A
 * message that cannot be handled now (the database or store unreachable)
 * is left on the queue to come back; one that keeps failing goes to the
 * queue's dead-letter queue.
 */
export async function pollGpuOutcomes(queue, { handle = handleGpuEvent } = {}) {
  let handled = 0;
  for (const message of await queue.receive(10)) {
    try {
      await handle(message.body);
      await message.done();
      handled++;
    } catch (err) {
      console.error('GPU outcome not handled, left on the queue:', err);
    }
  }
  return handled;
}

/** Models building on the GPU for longer than any job takes: their events went missing. */
export async function sweepStuckBuilds({ client, olderThanMinutes = STUCK_MINUTES, store } = {}) {
  const stuck = await many(
    pool,
    `SELECT id, gpu_job_id FROM machine_models
     WHERE status = 'building' AND gpu_job_id IS NOT NULL AND updated_at < UTC_TIMESTAMP(3) - INTERVAL ? MINUTE
     LIMIT 100`,
    [olderThanMinutes],
  );
  if (!stuck.length) return 0;
  const { DescribeJobsCommand } = await import('@aws-sdk/client-batch');
  const batchClient = client ?? (await batch());
  let settled = 0;
  for (let i = 0; i < stuck.length; i += 100) {
    const ids = stuck.slice(i, i + 100).map((m) => m.gpu_job_id);
    const { jobs = [] } = await batchClient.send(new DescribeJobsCommand({ jobs: ids }));
    const known = new Map(jobs.map((j) => [j.jobId, j]));
    for (const m of stuck.slice(i, i + 100)) {
      const job = known.get(m.gpu_job_id);
      if (job) {
        if ((await handleGpuJob(job, { store })) !== 'ignored') settled++;
      } else if (await failModel(m.id, 'The GPU job was lost. Build again.', { gpuJobId: m.gpu_job_id }, { cause: CAUSES.lost })) {
        // Batch forgets jobs after a week or so.
        settled++;
      }
    }
  }
  return settled;
}

/**
 * How many builds are on the GPU, and how long ago the oldest was sent
 * there (N-03). Published every few minutes by the worker: the "stuck"
 * alarm watches the oldest, so a person hears of a build waiting for a GPU
 * host (or whose outcome was lost) long before the sweep above gives up on
 * it. Returns what it published.
 */
export async function publishBuildGauges() {
  const row = await one(
    pool,
    `SELECT COUNT(*) AS onGpu, COALESCE(TIMESTAMPDIFF(SECOND, MIN(updated_at), UTC_TIMESTAMP(3)), 0) AS oldestSeconds
     FROM machine_models WHERE status = 'building' AND gpu_job_id IS NOT NULL`,
  );
  const gauges = { onGpu: Number(row.onGpu), oldestSeconds: Number(row.oldestSeconds) };
  metric3d('BuildsOnGpu', {}, { value: gauges.onGpu });
  metric3d('OldestBuildSeconds', {}, { value: gauges.oldestSeconds, unit: 'Seconds' });
  return gauges;
}

let outcomesQueue = null;

/** The gpu-jobs queue, made on first use. */
export async function gpuJobsQueue() {
  if (!outcomesQueue) {
    if (!config.assets.outcomesQueueUrl) throw new Error('GPU_JOBS_QUEUE_URL is required when ASSET_BUILDER=trellis2');
    const { SqsQueue } = await import('../jobs/sqs.js');
    outcomesQueue = new SqsQueue({ url: config.assets.outcomesQueueUrl, region: config.awsRegion });
  }
  return outcomesQueue;
}
