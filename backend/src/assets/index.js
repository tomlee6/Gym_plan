/**
 * Machine models (task L-07): the asset.build job and the states a model
 * goes through. Owned by the 3D team.
 *
 *   queued ──▶ building ──▶ awaiting_review ──▶ approved
 *                 │                 │              │
 *                 ▼                 ▼              ▼
 *               failed           rejected ◀────────┘
 *
 * A machine with no model rows is `none`. A reviewer queues a build
 * (`queueModel`) and approves or rejects what it made (`reviewModel`). One
 * model per machine is approved at a time (C-09): approving another rejects
 * the one before, with a note saying why. A rejected model can still be
 * approved later, so a reviewer can go back to an earlier choice.
 *
 * A model's identity is its machine, route, input (the 360 video's stored
 * object), generator version and seed. TRELLIS.2 invents the sides the video
 * does not show, so building again with the next seed gives another model to
 * choose from, while a build that failed is tried again with the same seed
 * on the same row. Each try is its own job (`attempt`), so a late job from
 * an earlier try never touches the row.
 *
 * The builder does the work, installed with `setBuilder` (L-05: cut-out to
 * the GPU worker). It returns the finished model, or `{ pending: true,
 * gpuJobId }` when the work goes on elsewhere; the outcome then arrives
 * through `finishModel` or `failModel`. Importing this module registers the
 * job handler: app.js and worker.js both import it.
 */
import { createHash } from 'node:crypto';

import { audit } from '../audit.js';
import { config } from '../config.js';
import { many, one, pool, transaction } from '../db/pool.js';
import { conflict, notFound } from '../errors.js';
import { newId } from '../ids.js';
import { enqueue, jobsCommitted, PermanentJobError, registerHandler } from '../jobs/index.js';
import { CAUSES, metric3d, modelFailed } from '../metrics3d.js';
import { modelStorage } from '../storage/index.js';

export const ROUTES = ['generated', 'measured'];
const IN_FLIGHT = ['queued', 'building'];
/** States whose model has a file a reviewer can look at and approve. */
const BUILT = ['awaiting_review', 'approved', 'rejected'];
export const REPLACED_NOTE = 'Replaced by a newer approved model.';

/** Where a model's files are kept: under the account, so account removal finds them. */
export function modelFolder(model) {
  return `models/accounts/${model.account_id}/assets/${model.id}/`;
}

/** One try at building it: its own folder, so nothing is left over from a try before. */
export function tryFolder(model) {
  return `${modelFolder(model)}try-${model.attempt}/`;
}

/**
 * What a model is built from, as a hash: the 360 video, and the ARKit frames
 * when the app sent them. A file's own hash when the app sent one, otherwise
 * its stored object: every take has its own keys, so a retake is a
 * different input.
 */
export function inputHash(route, machine) {
  const input = {
    route,
    video: machine.sha256 ?? `${machine.storage_key}:${machine.bytes}`,
    frames: machine.frames_key ? (machine.frames_sha256 ?? `${machine.frames_key}:${machine.frames_bytes}`) : null,
  };
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

/** A machine with its 360 video's stored file and ARKit frames, if it has them. */
export function machineFor(db, machineId, { lock = false } = {}) {
  return one(
    db,
    `SELECT m.id, m.account_id, m.capture_id, m.ref, m.name, m.width_m, m.depth_m, m.height_m,
            v.id AS video_id, v.status AS video_status,
            f.id AS video_file_id, f.storage_key, f.bytes, f.sha256, f.content_type,
            ff.storage_key AS frames_key, ff.bytes AS frames_bytes, ff.sha256 AS frames_sha256
     FROM machines m
     LEFT JOIN machine_videos v ON v.machine_id = m.id
     LEFT JOIN capture_files f ON f.id = v.video_file_id
     LEFT JOIN capture_files ff ON ff.id = v.frames_file_id AND ff.status = 'stored'
     WHERE m.id = ?${lock ? ' FOR UPDATE' : ''}`,
    [machineId],
  );
}

const machineTarget = (m) => ({ type: 'machine', id: m.id, label: `${m.ref} · ${m.name}` });

/* ------------------------------------------------------------------ */
/* Queueing a build.                                                    */

/**
 * Queues a build of a machine's model, inside the caller's transaction (call
 * `jobsCommitted()` after it commits). Returns `{ model, queued }`.
 *
 * - A build already queued or running is returned as it is.
 * - Without `again`, a model already made from this input is returned as it
 *   is: how an automatic first build stays a single one.
 * - With `again` (a reviewer asking): a failed newest build is tried again
 *   with its seed; otherwise a new build with the next seed. A measured
 *   model (L-04) is the same every time, so it is only ever tried again.
 */
export async function queueModel(db, { machineId, route = 'generated', actor = null, again = false }) {
  if (!ROUTES.includes(route)) throw conflict(`A machine model is built by one of: ${ROUTES.join(', ')}.`);
  const machine = await machineFor(db, machineId, { lock: true });
  if (!machine) throw notFound('No such machine.');
  if (machine.video_status !== 'ready') {
    throw conflict('This machine has no finished 360 video to build a model from.');
  }
  if (route === 'measured' && !machine.frames_key) {
    throw conflict('A measured model needs the walk-round’s ARKit frames (depth and camera positions), and this machine has none.');
  }

  const inFlight = await one(
    db,
    `SELECT * FROM machine_models WHERE machine_id = ? AND status IN (?) ORDER BY created_at DESC, id DESC LIMIT 1`,
    [machine.id, IN_FLIGHT],
  );
  if (inFlight) return { model: inFlight, queued: false };

  const hash = inputHash(route, machine);
  const generatorVersion = config.assets.generatorVersion;
  const same = await many(
    db,
    `SELECT * FROM machine_models
     WHERE machine_id = ? AND route = ? AND input_hash = ? AND generator_version = ?
     ORDER BY created_at DESC, id DESC`,
    [machine.id, route, hash, generatorVersion],
  );
  if (same.length && (!again || (route === 'measured' && same[0].status !== 'failed'))) {
    return { model: same[0], queued: false };
  }

  let modelId;
  let retry = false;
  if (same[0]?.status === 'failed') {
    modelId = same[0].id;
    retry = true;
    await db.query(
      `UPDATE machine_models
       SET status = 'queued', attempt = attempt + 1, gpu_job_id = NULL, failure_reason = NULL
       WHERE id = ?`,
      [modelId],
    );
  } else {
    modelId = newId();
    const seed = Math.max(0, ...same.map((m) => m.seed ?? 0)) + 1;
    await db.query(
      `INSERT INTO machine_models (id, account_id, machine_id, route, generator_version, input_hash, seed, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')`,
      [modelId, machine.account_id, machine.id, route, generatorVersion, hash, seed],
    );
  }

  const model = await one(db, 'SELECT * FROM machine_models WHERE id = ?', [modelId]);
  await enqueue(db, {
    kind: 'asset.build',
    subjectId: model.id,
    accountId: model.account_id,
    dedupeKey: `${model.id}#${model.attempt}`,
    payload: { attempt: model.attempt },
  });
  await audit(db, {
    accountId: machine.account_id,
    actor,
    action: 'MACHINE_MODEL_QUEUED',
    target: machineTarget(machine),
    detail: { modelId: model.id, route, generatorVersion, seed: model.seed, attempt: model.attempt, retry },
  });
  return { model, queued: true };
}

/**
 * A machine's 360 video has just arrived: its model is built straight away
 * when ASSET_AUTO_BUILD is on (L-05). Never fails the caller, whose upload
 * has succeeded: a reviewer can always build it from the editor.
 */
export async function buildOnArrival(machineId) {
  if (!config.assets.autoBuild) return null;
  try {
    const { model, queued } = await transaction((db) => queueModel(db, { machineId, again: false }));
    if (queued) await jobsCommitted();
    return model;
  } catch (err) {
    console.error(`Could not queue a model for machine ${machineId}:`, err);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Building.                                                            */

/**
 * The builder: `({ model, machine }) -> result`, where a finished result is
 * `{ glbKey, rawGlbKey?, metadataKey?, bytes?, triangleCount?, sizeM?: { w,
 * d, h }, scaleErrorPct?, lods?, turnDeg?, flags? }` and work handed
 * elsewhere is `{ pending: true, gpuJobId }`.
 */
let builder = async () => {
  throw new PermanentJobError(
    `No machine model builder is set up here (ASSET_BUILDER=${config.assets.builder}). Tell the 3D team.`,
  );
};

export function setBuilder(fn) {
  builder = fn;
}

// The GPU route, loaded only where it is used (it brings the AWS Batch client).
if (config.assets.builder === 'trellis2') {
  setBuilder(async (args) => (await import('./trellis2.js')).submitBuild(args));
}

/** A build that cannot succeed because of what it was given, not a fault of ours (N-03: no alarm). */
export class InputError extends PermanentJobError {}

/** Does `model` still match what the caller expects of it? */
const expected = (model, { attempt, gpuJobId } = {}) =>
  (attempt === undefined || attempt === model.attempt) && (gpuJobId === undefined || gpuJobId === model.gpu_job_id);

const size = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * Records a finished build: the model waits for a reviewer. Does nothing
 * (returns false) unless the model is building and, when given, on the
 * expected try or GPU job.
 */
export async function finishModel(modelId, out, expect = {}) {
  if (!out?.glbKey) throw new Error('A finished machine model needs its GLB key.');
  return transaction(async (db) => {
    const model = await one(db, 'SELECT * FROM machine_models WHERE id = ? FOR UPDATE', [modelId]);
    if (!model || model.status !== 'building' || !expected(model, expect)) return false;
    await db.query(
      `UPDATE machine_models
       SET status = 'awaiting_review', glb_key = ?, raw_glb_key = ?, metadata_key = ?, lods = ?, bytes = ?,
           triangle_count = ?, size_w_m = ?, size_d_m = ?, size_h_m = ?, turn_deg = ?, scale_error_pct = ?,
           flags = ?, failure_reason = NULL
       WHERE id = ?`,
      [
        out.glbKey,
        out.rawGlbKey ?? null,
        out.metadataKey ?? null,
        out.lods ? JSON.stringify(out.lods) : null,
        out.bytes ?? null,
        out.triangleCount ?? null,
        size(out.sizeM?.w),
        size(out.sizeM?.d),
        size(out.sizeM?.h),
        out.turnDeg ?? 0,
        out.scaleErrorPct ?? null,
        out.flags?.length ? JSON.stringify(out.flags) : null,
        model.id,
      ],
    );
    const machine = await machineFor(db, model.machine_id);
    await audit(db, {
      accountId: model.account_id,
      actor: null,
      action: 'MACHINE_MODEL_BUILT',
      target: machineTarget(machine),
      detail: {
        modelId: model.id,
        seed: model.seed,
        bytes: out.bytes ?? null,
        triangles: out.triangleCount ?? null,
        scaleErrorPct: out.scaleErrorPct ?? null,
        flags: out.flags ?? [],
      },
    });
    return true;
  });
}

/**
 * Records a build that failed for good, with the reason the reviewer will
 * see, and counts it by `cause` (CAUSES in metrics3d.js), which says
 * whether it is a fault.
 */
export async function failModel(modelId, reason, expect = {}, { cause = CAUSES.job } = {}) {
  const failed = await transaction(async (db) => {
    const model = await one(db, 'SELECT * FROM machine_models WHERE id = ? FOR UPDATE', [modelId]);
    if (!model || !IN_FLIGHT.includes(model.status) || !expected(model, expect)) return false;
    const why = String(reason).slice(0, 500);
    await db.query(`UPDATE machine_models SET status = 'failed', failure_reason = ? WHERE id = ?`, [why, model.id]);
    const machine = await machineFor(db, model.machine_id);
    await audit(db, {
      accountId: model.account_id,
      actor: null,
      action: 'MACHINE_MODEL_FAILED',
      target: machineTarget(machine),
      detail: { modelId: model.id, seed: model.seed, attempt: model.attempt, reason: why, cause },
    });
    return true;
  });
  if (failed) modelFailed(cause);
  return failed;
}

registerHandler('asset.build', {
  async run(job) {
    const model = await one(pool, 'SELECT * FROM machine_models WHERE id = ?', [job.subject_id]);
    const attempt = job.payload?.attempt;
    if (!model || !IN_FLIGHT.includes(model.status) || !expected(model, { attempt })) return;
    if (job.payload?.turnDeg !== undefined) return remake(model, job.payload.turnDeg);
    // Already handed to the GPU by an earlier run of this job: its outcome will arrive.
    if (model.gpu_job_id) return;
    await pool.query(`UPDATE machine_models SET status = 'building' WHERE id = ? AND status = 'queued'`, [model.id]);

    const machine = await machineFor(pool, model.machine_id);
    if (!machine || machine.video_status !== 'ready' || inputHash(model.route, machine) !== model.input_hash) {
      throw new InputError('The 360 video changed after this build was queued. Build again from the new video.');
    }
    const out = await builder({ model: { ...model, status: 'building' }, machine });
    if (out?.pending) {
      await pool.query(
        `UPDATE machine_models SET gpu_job_id = ? WHERE id = ? AND status = 'building' AND attempt = ?`,
        [out.gpuJobId, model.id, model.attempt],
      );
      // A try sent before a crash, and already over: its outcome went by while nobody knew its job.
      if (out.finished) {
        const { handleGpuJob } = await import('./outcomes.js');
        await handleGpuJob(out.finished);
      }
      return;
    }
    if (await finishModel(model.id, out, { attempt: model.attempt })) metric3d('ModelsBuilt', { Route: model.route });
  },

  /** A build that keeps failing, or cannot succeed, is failed with its reason. */
  async onDead(job, err) {
    const cause = err instanceof InputError ? CAUSES.input : CAUSES.job;
    await failModel(job.subject_id, String(err?.message ?? err), { attempt: job.payload?.attempt }, { cause });
  },
});

/**
 * A reviewer's turn (L-08): the model made again from the GPU's own GLB,
 * turned their way, with no GPU. Its files are new, so it goes back to
 * review, however it stood.
 */
async function remake(model, turnDeg) {
  // Loaded here: outcomes.js builds on this module.
  const { makeReady } = await import('./outcomes.js');
  const { boxOf } = await import('./trellis2.js');
  const machine = await machineFor(pool, model.machine_id);
  let raw;
  try {
    raw = await modelStorage().read(model.raw_glb_key);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.name === 'NoSuchKey') {
      throw new PermanentJobError('The GPU’s own model is gone, so it cannot be turned. Build it again.');
    }
    throw err;
  }
  let ready;
  try {
    ready = await makeReady(model, raw, { box: boxOf(machine), turnDeg });
  } catch (err) {
    if (err?.storeError) throw err;
    throw new PermanentJobError(`The model could not be turned (${err.message}). Tell the 3D team.`);
  }
  const done = await finishModel(model.id, { ...ready, rawGlbKey: model.raw_glb_key, metadataKey: model.metadata_key }, { attempt: model.attempt });
  // The levels of detail it had before are no longer this model's (N-02): those the new ones do not share go.
  if (done) await dropFiles((model.lods ?? []).map((l) => l.key).filter((key) => !ready.lods.some((l) => l.key === key)));
}

/** Deletes stored model files that nothing records any more. A file that will not go is left, and said. */
async function dropFiles(keys) {
  for (const key of keys) {
    try {
      await modelStorage().delete(key);
    } catch (err) {
      console.error(`Could not delete the old model file ${key}:`, err?.message ?? err);
    }
  }
}

export const TURNS = [0, 90, 180, 270];

/**
 * Turns a built model about its up axis (right-handed: a quarter turn takes
 * its front, +Z, to +X), inside the caller's transaction; the worker makes
 * it again (call `jobsCommitted()` after it commits). Returns whether
 * anything changed.
 */
export async function turnModel(db, { modelId, actor, turnDeg }) {
  if (!TURNS.includes(turnDeg)) throw conflict('A model turns in quarter turns: 0, 90, 180 or 270 degrees.');
  const found = await one(db, 'SELECT machine_id FROM machine_models WHERE id = ?', [modelId]);
  if (!found) throw notFound('No such machine model.');
  const machine = await machineFor(db, found.machine_id, { lock: true });
  const model = await one(db, 'SELECT * FROM machine_models WHERE id = ? FOR UPDATE', [modelId]);
  if (!BUILT.includes(model.status) || !model.raw_glb_key) {
    throw conflict(`This model is ${model.status.replace('_', ' ')}: only a built model can be turned.`);
  }
  if (model.turn_deg === turnDeg) return false;
  await db.query(
    `UPDATE machine_models
     SET status = 'building', attempt = attempt + 1, gpu_job_id = NULL, failure_reason = NULL
     WHERE id = ?`,
    [model.id],
  );
  await enqueue(db, {
    kind: 'asset.build',
    subjectId: model.id,
    accountId: model.account_id,
    dedupeKey: `${model.id}#${model.attempt + 1}`,
    payload: { attempt: model.attempt + 1, turnDeg },
  });
  await audit(db, {
    accountId: model.account_id,
    actor,
    action: 'MACHINE_MODEL_TURNED',
    target: machineTarget(machine),
    detail: { modelId: model.id, from: model.turn_deg, to: turnDeg, wasApproved: model.status === 'approved' },
  });
  return true;
}

/* ------------------------------------------------------------------ */
/* Review.                                                              */

/**
 * A reviewer's decision on a model, inside the caller's transaction.
 * `decision` is 'approve' (a built model: awaiting review, or rejected
 * before) or 'reject' (awaiting review, or approved before; a note is
 * required). Returns the model's id and, on approval, the model it replaced.
 */
export async function reviewModel(db, { modelId, actor, decision, note = null }) {
  const found = await one(db, 'SELECT machine_id FROM machine_models WHERE id = ?', [modelId]);
  if (!found) throw notFound('No such machine model.');
  // The machine first, as queueModel locks it: one decision per machine at a time.
  const machine = await machineFor(db, found.machine_id, { lock: true });
  const model = await one(db, 'SELECT * FROM machine_models WHERE id = ? FOR UPDATE', [modelId]);

  if (decision === 'approve') {
    if (model.status === 'approved') return { modelId: model.id, replaced: null };
    if (!BUILT.includes(model.status) || !model.glb_key) {
      throw conflict(`This model is ${model.status.replace('_', ' ')}: only a built model can be approved.`);
    }
    const before = await one(
      db,
      `SELECT id FROM machine_models WHERE machine_id = ? AND status = 'approved' FOR UPDATE`,
      [model.machine_id],
    );
    if (before) {
      await db.query(
        `UPDATE machine_models SET status = 'rejected', review_note = ?, reviewed_by = ?, reviewed_at = UTC_TIMESTAMP(3)
         WHERE id = ?`,
        [REPLACED_NOTE, actor.id, before.id],
      );
    }
    await db.query(
      `UPDATE machine_models SET status = 'approved', review_note = ?, reviewed_by = ?, reviewed_at = UTC_TIMESTAMP(3)
       WHERE id = ?`,
      [note, actor.id, model.id],
    );
    await audit(db, {
      accountId: model.account_id,
      actor,
      action: 'MACHINE_MODEL_APPROVED',
      target: machineTarget(machine),
      detail: { modelId: model.id, seed: model.seed, replaced: before?.id ?? null, note },
    });
    return { modelId: model.id, replaced: before?.id ?? null };
  }

  if (decision === 'reject') {
    if (!note?.trim()) throw conflict('Say why the model is rejected.');
    if (!['awaiting_review', 'approved'].includes(model.status)) {
      throw conflict(`This model is ${model.status.replace('_', ' ')}: only a model awaiting review or approved can be rejected.`);
    }
    await db.query(
      `UPDATE machine_models SET status = 'rejected', review_note = ?, reviewed_by = ?, reviewed_at = UTC_TIMESTAMP(3)
       WHERE id = ?`,
      [note, actor.id, model.id],
    );
    await audit(db, {
      accountId: model.account_id,
      actor,
      action: 'MACHINE_MODEL_REJECTED',
      target: machineTarget(machine),
      detail: { modelId: model.id, seed: model.seed, wasApproved: model.status === 'approved', note },
    });
    return { modelId: model.id, replaced: null };
  }

  throw new Error(`Unknown decision: ${decision}`);
}

/* ------------------------------------------------------------------ */
/* Reading.                                                             */

/** A machine's models with their reviewer's name, newest first. */
export function modelsOf(db, machineId) {
  return many(
    db,
    `SELECT mm.*, u.name AS reviewer_name FROM machine_models mm
     LEFT JOIN users u ON u.id = mm.reviewed_by
     WHERE mm.machine_id = ? ORDER BY mm.created_at DESC, mm.id DESC`,
    [machineId],
  );
}

/** The machine's state as one word: its newest model's status, or `none`. */
export const modelStatus = (models) => models[0]?.status ?? 'none';

export { BUILT, IN_FLIGHT };
