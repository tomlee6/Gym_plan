/**
 * Machines in the walkthrough (task J-06): the approved model of each
 * machine the surveyor recorded on a capture, with signed links to its
 * levels of detail, by the machine's reference (EQ-001...).
 *
 * The level's own file is frozen with its plan version, while machine
 * models are approved on their own, often after the level is built. So the
 * models are not baked into the level: they are looked up whenever a
 * walkthrough is opened, and the viewer places each on its footprint from
 * the plan (following "same as"), with a plain box where there is none.
 * Several machines using one model load it once (instancing).
 */
import { many } from '../db/pool.js';
import { linkFields } from '../generator/links.js';

const num = (v) => (v === null || v === undefined ? null : Number(v));

/** `{ [equipmentId]: { modelId, sizeM, lods: [{ url, urlExpiresAt, triangles, bytes, textureSize }] } }`. */
export async function approvedModelsOn(db, captureId) {
  if (!captureId) return {};
  const rows = await many(
    db,
    `SELECT m.ref, mm.id, mm.lods, mm.size_w_m, mm.size_d_m, mm.size_h_m
     FROM machines m JOIN machine_models mm ON mm.approved_machine_id = m.id
     WHERE m.capture_id = ? AND mm.lods IS NOT NULL
     ORDER BY m.ref`,
    [captureId],
  );
  const out = {};
  for (const r of rows) {
    out[r.ref] = {
      modelId: r.id,
      sizeM: { w: num(r.size_w_m), d: num(r.size_d_m), h: num(r.size_h_m) },
      lods: await Promise.all(
        r.lods.map(async (l) => ({ ...(await linkFields(l.key)), triangles: l.triangles, bytes: l.bytes, textureSize: l.texture })),
      ),
    };
  }
  return out;
}
