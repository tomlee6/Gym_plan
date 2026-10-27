/**
 * The plan format 3 vocabularies the editor offers (G-02..G-08), and the
 * labels it shows for them.
 *
 * The lists come from the shared plan library, so the editor can never
 * offer a kind the validator would refuse. This module only adds what the
 * editor needs on top: labels, and a guard for plans saved before format 3.
 */
export {
  arcPoints,
  BEAM_KINDS,
  COLUMN_SHAPES,
  FLOOR_FINISHES,
  HINGE_SIDES,
  LEVEL_CHANGE_KINDS,
  OPENING_KINDS,
  openingTypeOf,
  SPACE_KINDS,
  VOID_KINDS,
  WALL_KINDS,
} from '@shared/plan/index.js';

/** The element lists added in format 3, which a format 1 or 2 plan lacks. */
export const V3_LISTS = ['spaces', 'beams', 'levelChanges', 'voids'];

/**
 * The plan with every format 3 list present. A plan read before format 3
 * (or saved by an older editor) simply has no `spaces`; treating that as an
 * empty list keeps every operation and drawing free of `?? []` checks.
 * Returns the same object when nothing was missing, so history and
 * autosave do not see a change that is not one.
 */
export function withLists(plan) {
  if (!plan || V3_LISTS.every((k) => Array.isArray(plan[k]))) return plan;
  const next = { ...plan };
  for (const k of V3_LISTS) if (!Array.isArray(next[k])) next[k] = [];
  return next;
}

/** "gym_floor" → "Gym floor". */
export function kindLabel(kind) {
  if (!kind) return 'Not recorded';
  const s = String(kind).replaceAll('_', ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
