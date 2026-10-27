/**
 * Machine models for reviewers (task L-07, owned by the 3D team).
 *
 *   GET  /v1/review/machines/:machineId/models   the machine's models, newest first
 *   POST /v1/review/machines/:machineId/models   {route?}: build one, or again     202
 *   POST /v1/review/models/:modelId/approve      {note?}
 *   POST /v1/review/models/:modelId/reject       {note}
 *   POST /v1/review/models/:modelId/turn         {turnDeg}: made again, turned  202
 *
 * The editor finds `machineId` on each machine in GET /v1/review/versions/:id.
 * Reviewers and admins are Flex staff and see every account's machines, as
 * they do its plans. States and rules: src/assets/index.js.
 */
import { Router } from 'express';
import { z } from 'zod';

import { BUILT, machineFor, modelsOf, modelStatus, queueModel, reviewModel, ROUTES, TURNS, turnModel } from '../assets/index.js';
import { pool, transaction } from '../db/pool.js';
import { notFound } from '../errors.js';
import { linkFields } from '../generator/links.js';
import { isId } from '../ids.js';
import { jobsCommitted } from '../jobs/index.js';
import { requireAuth, requireStaff } from '../middleware/auth.js';

export const router = Router();
router.use(['/machines', '/models'], requireAuth, requireStaff('reviewer', 'admin'));

const num = (v) => (v === null || v === undefined ? null : Number(v));

/** What each flag on a model asks of the reviewer (L-06). */
export const FLAGS = {
  front_guessed: 'Check that its front faces the way the plan says the machine faces, and turn it if not.',
  size_mismatch: 'Its proportions differ from the scanned size: check the scan, or build again.',
  no_scanned_size: 'The machine has no scanned size, so the model was made 1.2 m tall.',
};

/** One model as the editor sees it, with a signed link to its GLB once it is built. */
export async function presentModel(row) {
  const viewable = row.glb_key && BUILT.includes(row.status);
  return {
    modelId: row.id,
    machineId: row.machine_id,
    route: row.route,
    status: row.status,
    generatorVersion: row.generator_version,
    seed: row.seed,
    attempt: row.attempt,
    sizeM: row.size_w_m === null ? null : { w: num(row.size_w_m), d: num(row.size_d_m), h: num(row.size_h_m) },
    scaleErrorPct: num(row.scale_error_pct),
    turnDeg: row.turn_deg,
    flags: (row.flags ?? []).map((code) => ({ code, message: FLAGS[code] ?? code })),
    bytes: num(row.bytes),
    triangleCount: row.triangle_count,
    failureReason: row.failure_reason,
    reviewNote: row.review_note,
    reviewedBy: row.reviewed_by ? { id: row.reviewed_by, name: row.reviewer_name ?? null } : null,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(viewable ? await linkFields(row.glb_key) : { url: null, urlExpiresAt: null }),
    // Nearest first, for the walkthrough to switch between by distance.
    lods: viewable
      ? await Promise.all(
          (row.lods ?? []).map(async (l) => ({ ...(await linkFields(l.key)), triangles: l.triangles, bytes: l.bytes, textureSize: l.texture })),
        )
      : [],
  };
}

/** The machine, its video's state and every model made for it. */
async function machineModels(db, machineId) {
  const machine = await machineFor(db, machineId);
  if (!machine) throw notFound('No such machine.');
  const models = await modelsOf(db, machineId);
  return {
    machineId: machine.id,
    equipmentId: machine.ref,
    name: machine.name,
    videoStatus: machine.video_status ?? null,
    canBuild: machine.video_status === 'ready',
    // A measured model (L-04) needs the walk-round's ARKit frames too.
    canMeasure: machine.video_status === 'ready' && Boolean(machine.frames_key),
    modelStatus: modelStatus(models),
    models: await Promise.all(models.map(presentModel)),
  };
}

const idParam = (value, what) => {
  if (!isId(value)) throw notFound(`No such ${what}.`);
  return value;
};

router.get('/machines/:machineId/models', async (req, res) => {
  res.json(await machineModels(pool, idParam(req.params.machineId, 'machine')));
});

router.post('/machines/:machineId/models', async (req, res) => {
  const body = z.object({ route: z.enum(ROUTES).default('generated') }).strict().parse(req.body ?? {});
  const machineId = idParam(req.params.machineId, 'machine');
  const { model, queued } = await transaction((db) =>
    queueModel(db, { machineId, route: body.route, actor: { id: req.user.id }, again: true }),
  );
  if (queued) await jobsCommitted();
  res.status(queued ? 202 : 200).json({ queued, modelId: model.id, ...(await machineModels(pool, machineId)) });
});

const decide = (decision, note) => async (req, res) => {
  const body = z.object({ note }).strict().parse(req.body ?? {});
  const modelId = idParam(req.params.modelId, 'machine model');
  const { replaced } = await transaction((db) =>
    reviewModel(db, { modelId, actor: { id: req.user.id }, decision, note: body.note ?? null }),
  );
  const [row] = await pool.query('SELECT machine_id FROM machine_models WHERE id = ?', [modelId]);
  res.json({ modelId, replaced, ...(await machineModels(pool, row[0].machine_id)) });
};

router.post('/models/:modelId/approve', decide('approve', z.string().trim().min(1).max(500).nullish()));
router.post('/models/:modelId/reject', decide('reject', z.string().trim().min(1, 'Say why the model is rejected.').max(500)));

router.post('/models/:modelId/turn', async (req, res) => {
  const body = z
    .object({ turnDeg: z.number().int().refine((n) => TURNS.includes(n), 'A model turns by 0, 90, 180 or 270 degrees.') })
    .strict()
    .parse(req.body ?? {});
  const modelId = idParam(req.params.modelId, 'machine model');
  const changed = await transaction((db) => turnModel(db, { modelId, actor: { id: req.user.id }, turnDeg: body.turnDeg }));
  if (changed) await jobsCommitted();
  const [row] = await pool.query('SELECT machine_id FROM machine_models WHERE id = ?', [modelId]);
  res.status(changed ? 202 : 200).json({ modelId, changed, ...(await machineModels(pool, row[0].machine_id)) });
});
