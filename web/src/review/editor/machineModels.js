/**
 * Machine models in the editor (L-08): which recorded machine a plan object
 * is, and "same as" (one machine's model reused for another identical one).
 *
 * "Same as" lives on the plan (`object.sameAs`, another object's id), so it
 * is versioned and approved with the rest of the plan. It always points
 * straight at the machine whose model is used, never along a chain: marking
 * A the same as B, when B is the same as C, marks A the same as C, and
 * anything that was the same as A moves with it.
 */
import { findElement, updateElement } from './ops.js';

/** The machine the surveyor recorded for a plan object (`v.equipment` entry), if any. */
export function recordedMachine(v, object) {
  if (!object?.equipment) return null;
  return (v.equipment ?? []).find((e) => e.equipmentId === object.equipment.equipmentId) ?? null;
}

/** The object whose model a machine uses: itself, or the one it is the same as. */
export function modelSource(plan, object) {
  if (!object?.sameAs) return object;
  return plan.objects.find((o) => o.id === object.sameAs && o.equipment) ?? object;
}

/** The machines an object can be marked the same as: the other named machines that are not copies themselves. */
export function sameAsChoices(plan, object) {
  return plan.objects
    .filter((o) => o.id !== object.id && o.equipment && !o.sameAs)
    .sort((a, b) => a.equipment.equipmentId.localeCompare(b.equipment.equipmentId));
}

/** Marks `objectId` the same as `otherId` (null: its own model again). */
export function setSameAs(plan, objectId, otherId) {
  const found = findElement(plan, objectId);
  if (!found || found.kind !== 'objects' || !found.el.equipment) return plan;
  if (!otherId) return updateElement(plan, objectId, { sameAs: null });
  const other = plan.objects.find((o) => o.id === otherId);
  if (!other?.equipment) return plan;
  const target = other.sameAs ?? other.id;
  if (target === objectId) return plan;
  let next = updateElement(plan, objectId, { sameAs: target });
  // Copies of this machine now copy the one it copies.
  for (const o of next.objects) {
    if (o.sameAs === objectId) next = updateElement(next, o.id, { sameAs: target });
  }
  return next;
}

/**
 * Where the plan says a machine's front faces, in its model's own frame:
 * `[x, z]`, X along the footprint's width and Z along its depth (the frame
 * L-06 makes the model in). The front is `facingDeg`, or when that is not
 * set the footprint's own rotation (docs/3d-contract.md), so +X by default.
 */
export function frontInModel(object) {
  const along = ((object?.angle ?? 0) * 180) / Math.PI;
  const facing = object?.facingDeg ?? along;
  const r = ((facing - along) * Math.PI) / 180;
  const round = (n) => (Math.abs(n) < 1e-9 ? 0 : Math.round(n * 1e6) / 1e6);
  return [round(Math.cos(r)), round(Math.sin(r))];
}
