/**
 * The generated route (task L-05): a machine's model made by TRELLIS.2 on
 * the GPU worker (gpu/trellis2), as one AWS Batch job per try.
 *
 * The job reads the machine's 360 video, and its ARKit frames when the app
 * sent them, from the captures bucket. It picks frames (L-02), cuts the
 * machine out (L-03) and models the cut-out; or, for a measured model
 * (`route: measured`, L-04), rebuilds it from the frames' depth. It writes
 * everything into the try's own folder in the models bucket:
 *
 *   models/accounts/<account>/assets/<model>/try-<n>/
 *     model.glb, metadata.json, cutout.png, cutout.json, frames.json
 *     (or error.json, with what it got as far as)
 *
 * Batch retries a try that failed for a passing reason (not one whose
 * input cannot be used) and reports the end on the gpu-jobs queue, where
 * outcomes.js picks it up. Installed by src/assets/index.js when
 * ASSET_BUILDER=trellis2.
 */
import { config } from '../config.js';
import { PermanentJobError } from '../jobs/index.js';
import { tryFolder } from './index.js';

let client = null;

/** The Batch client, made on first use so nothing else ever loads the SDK. */
export async function batch() {
  if (!client) {
    const { BatchClient } = await import('@aws-sdk/client-batch');
    client = new BatchClient({ region: config.awsRegion });
  }
  return client;
}

/** Tests stand in for Batch. */
export function setBatch(stub) {
  client = stub;
}

const metres = (v) => (v === null || v === undefined ? null : Number(v));

/** The scanned size the cut-out checks the outline against, or null if any of it is missing. */
export function boxOf(machine) {
  const box = { w: metres(machine.width_m), d: metres(machine.depth_m), h: metres(machine.height_m) };
  return Object.values(box).every((v) => v > 0) ? box : null;
}

/** What the job is given: where its video (and frames) are and where to write, and its settings. */
export function jobParameters({ model, machine }, { storage = config.storage } = {}) {
  return {
    input: `s3://${storage.s3Bucket}/${machine.storage_key}`,
    output: `s3://${storage.modelsBucket}/${tryFolder(model)}`,
    params: JSON.stringify({
      seed: model.seed ?? 1,
      machine: {
        route: model.route ?? 'generated',
        box: boxOf(machine),
        ...(machine.frames_key ? { frames: `s3://${storage.s3Bucket}/${machine.frames_key}` } : {}),
      },
    }),
  };
}

/**
 * The builder for ASSET_BUILDER=trellis2: submits the job and hands back
 * its id. Each try's job has its own name, so a try sent once already (the
 * worker stopped between sending it and recording it, and the job ran
 * again) is found and adopted rather than run twice (N-02); if it has
 * already finished, its outcome is handed back too (`finished`).
 */
export async function submitBuild({ model, machine }, { assets = config.assets, storage = config.storage } = {}) {
  if (!assets.jobQueue || !assets.jobDefinition) {
    throw new PermanentJobError('The GPU job queue is not set up here (TRELLIS2_JOB_QUEUE, TRELLIS2_JOB_DEFINITION). Tell the 3D team.');
  }
  const { ListJobsCommand, SubmitJobCommand } = await import('@aws-sdk/client-batch');
  const client = await batch();
  // Letters, digits, - and _ only, at most 128.
  const jobName = `machine-model-${model.id}-try-${model.attempt}`;
  const listed = await client.send(new ListJobsCommand({ jobQueue: assets.jobQueue, filters: [{ name: 'JOB_NAME', values: [jobName] }] }));
  const [earlier] = (listed.jobSummaryList ?? []).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  if (earlier) {
    const over = ['SUCCEEDED', 'FAILED'].includes(earlier.status);
    return { pending: true, gpuJobId: earlier.jobId, ...(over ? { finished: { jobId: earlier.jobId, status: earlier.status, statusReason: earlier.statusReason } } : {}) };
  }
  const out = await client.send(
    new SubmitJobCommand({
      jobName,
      jobQueue: assets.jobQueue,
      jobDefinition: assets.jobDefinition,
      parameters: jobParameters({ model, machine }, { storage }),
    }),
  );
  return { pending: true, gpuJobId: out.jobId };
}
