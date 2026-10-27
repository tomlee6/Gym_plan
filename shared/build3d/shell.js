/**
 * The outside of the building (task J-03): what an inside scan cannot see,
 * built from what the plan knows. A roof over the outline and the outer
 * walls, its own node so the viewer can lift it off for a dollhouse view,
 * and the ground around the building. The rules are docs/3d-contract.md.
 */
import { cross, dot } from '../plan/geometry.js';
import { JOIN_TOLERANCE_M } from '../plan/model.js';
import { faceAt } from './walls.js';

export const ROOF_M = 0.3;
export const GROUND_MARGIN_M = 5;
/**
 * Level with the floor. The building is cut out of the ground, so the two
 * never overlap, and there is no slit under the outer walls to see through.
 */
const GROUND_Y = 0;

/**
 * The building's outer edge: the floor outline pushed out by the walls
 * standing on it (an exterior wall's whole thickness, half of a centred
 * one). `floor` is anticlockwise. Returns `{ ring, edges }`, where
 * `edges[i]` is the spec of the wall along the edge from point i, or null.
 */
export function outerRing(floor, walls, axes, specs) {
  const n = floor.length;
  // The wall along each edge of the outline, and the offset of its outside face.
  const edges = floor.map((p, i) => {
    const q = floor[(i + 1) % n];
    const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    let best = null;
    for (const w of walls) {
      const hit = axes.get(w.id).nearest(mid);
      if (hit.distance <= JOIN_TOLERANCE_M && (!best || hit.distance < best.hit.distance)) best = { w, hit };
    }
    if (!best) return null;
    const axis = axes.get(best.w.id);
    const spec = specs.get(best.w.id);
    // Outside an anticlockwise ring is to the right of each edge.
    const same = dot([q[0] - p[0], q[1] - p[1]], axis.tangent(best.hit.s)) > 0;
    return { wall: best.w, axis, spec, out: same ? spec.offset - spec.thickness / 2 : spec.offset + spec.thickness / 2 };
  });

  // The outside face of an edge's wall by point p: a point on it, and its direction.
  const faceBy = (e, p) => {
    const { s } = e.axis.nearest(p);
    return { point: faceAt(e.axis, s, e.out), dir: e.axis.tangent(s) };
  };

  // Along one wall, its outside face itself (the same points the wall is drawn
  // with); where two walls meet, where their outside faces cross.
  const ring = floor.map((p, i) => {
    const [e0, e1] = [edges[(i - 1 + n) % n], edges[i]];
    if (!e0 && !e1) return p;
    if (!e0 || !e1 || e0.wall === e1.wall) return faceBy(e1 ?? e0, p).point;
    const [l0, l1] = [faceBy(e0, p), faceBy(e1, p)];
    const det = cross(l0.dir, l1.dir);
    if (Math.abs(det) < 1e-6) return l1.point;
    const t = cross([l1.point[0] - l0.point[0], l1.point[1] - l0.point[1]], l1.dir) / det;
    const corner = [l0.point[0] + l0.dir[0] * t, l0.point[1] + l0.dir[1] * t];
    // A very sharp corner is cut short, as the walls' own corners are.
    const limit = 4 * Math.max(e0.spec.thickness, e1.spec.thickness) + 0.05;
    const off = Math.hypot(corner[0] - p[0], corner[1] - p[1]);
    return off > limit ? [p[0] + ((corner[0] - p[0]) * limit) / off, p[1] + ((corner[1] - p[1]) * limit) / off] : corner;
  });
  return { ring, edges: edges.map((e) => e?.spec ?? null) };
}

/**
 * Draws the roof and the ground into `lb`. `ceilingTop` is the highest
 * ceiling inside (ceiling zones included). Returns the building's outer ring.
 */
export function buildShell(lb, { floor, walls, axes, specs, ceilingTop }) {
  const { ring: outer, edges } = outerRing(floor, walls, axes, specs);
  const top = Math.max(ceilingTop, ...[...specs.values()].map((s) => s.height));

  // The roof sits on the highest wall or ceiling. It has no underside: from
  // inside, the ceilings are what you see. Its edge comes down to the top of
  // the wall below it, so a lower wall leaves no gap seen from outside.
  const roof = lb.mesh('roof', 'roof');
  roof.polygon(outer, top + ROOF_M, { up: true });
  for (let i = 0; i < outer.length; i++) {
    const [a, b] = [outer[i], outer[(i + 1) % outer.length]];
    const bottom = edges[i]?.height ?? top;
    roof.quad([a[0], bottom, a[1]], [b[0], bottom, b[1]], [b[0], top + ROOF_M, b[1]], [a[0], top + ROOF_M, a[1]], [b[1] - a[1], 0, a[0] - b[0]]);
  }

  // The ground, 5 m round the building, with the building cut out of it.
  const xs = outer.map((p) => p[0]);
  const ys = outer.map((p) => p[1]);
  const [x0, x1] = [Math.min(...xs) - GROUND_MARGIN_M, Math.max(...xs) + GROUND_MARGIN_M];
  const [y0, y1] = [Math.min(...ys) - GROUND_MARGIN_M, Math.max(...ys) + GROUND_MARGIN_M];
  lb.mesh('ground', 'ground').polygon([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], GROUND_Y, { up: true, holes: [outer] });
  return outer;
}
