import { dist, project } from '@shared/plan/index.js';

/** Screen pixels within which a point snaps to a corner or a wall. */
const CORNER_PX = 12;
const WALL_PX = 8;
/** Degrees within which a line snaps to horizontal or vertical. */
const SQUARE_DEG = 4;

/**
 * Where a point being drawn or dragged should land: on a nearby wall end,
 * else on a nearby wall, else squared up to `anchor` when nearly horizontal
 * or vertical, else rounded to the centimetre. `pxPerM` is the zoom, so
 * snapping feels the same at any scale. `ignore` lists "wallId:end" keys
 * of the ends being moved, so they do not snap to themselves.
 */
export function snapPoint(plan, p, { pxPerM, anchor = null, ignore = new Set(), free = false }) {
  if (free) return { point: round(p), kind: 'free' };
  const cornerM = CORNER_PX / pxPerM;
  const wallM = WALL_PX / pxPerM;

  let best = null;
  for (const w of plan.walls) {
    for (const end of ['a', 'b']) {
      if (ignore.has(`${w.id}:${end}`)) continue;
      const d = dist(p, w[end]);
      if (d <= cornerM && (!best || d < best.d)) best = { d, point: w[end], kind: 'corner' };
    }
  }
  if (best) return best;

  for (const w of plan.walls) {
    if (ignore.has(`${w.id}:a`) && ignore.has(`${w.id}:b`)) continue;
    const hit = project(p, w.a, w.b);
    if (hit.distance <= wallM && (!best || hit.distance < best.d)) {
      best = { d: hit.distance, point: round(hit.point), kind: 'wall', wallId: w.id };
    }
  }
  if (best) return best;

  if (anchor) {
    const dx = p[0] - anchor[0];
    const dy = p[1] - anchor[1];
    const angle = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI);
    const fromAxis = Math.min(angle % 90, 90 - (angle % 90));
    if (fromAxis <= SQUARE_DEG) {
      const horizontal = Math.abs(dx) >= Math.abs(dy);
      return {
        point: round(horizontal ? [p[0], anchor[1]] : [anchor[0], p[1]]),
        kind: horizontal ? 'horizontal' : 'vertical',
      };
    }
  }
  return { point: round(p), kind: 'free' };
}

function round(p) {
  return [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100];
}
