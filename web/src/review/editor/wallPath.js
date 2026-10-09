/**
 * Where a wall runs on the canvas: straight, or along its arc when it has a
 * `curveM` (format 3), and the stretch of it a mirror span covers.
 */
import { dist } from '@shared/plan/index.js';

import { arcPoints } from './planKinds.js';

/** The points a wall is drawn through, ends included. */
export function wallPoints(wall) {
  return wall.curveM ? arcPoints(wall.a, wall.b, wall.curveM, 24) : [wall.a, wall.b];
}

/**
 * The part of a polyline between `fromM` and `toM` measured along it: how
 * a mirror span is drawn on a curved wall as well as a straight one.
 */
export function stretch(points, fromM, toM) {
  const out = [];
  let walked = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const len = dist(a, b);
    const s = walked;
    const e = walked + len;
    walked = e;
    if (e < fromM || s > toM || len === 0) continue;
    const at = (m) => {
      const t = Math.max(0, Math.min(1, (m - s) / len));
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    };
    if (!out.length) out.push(at(Math.max(fromM, s)));
    out.push(at(Math.min(toM, e)));
  }
  return out;
}
