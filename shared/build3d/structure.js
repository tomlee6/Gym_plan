/**
 * Columns, stairs, lifts and voids (task J-04). The rules are
 * docs/3d-contract.md.
 */
import { centroid, rectCorners } from '../plan/geometry.js';
import { ceilingAt, ringOf } from './spaces.js';

/** How far a stair or void is drawn going down: one storey. */
export const VOID_DEPTH_M = 3;
export const RAIL_HEIGHT_M = 1;
const RAIL_SETBACK_M = 0.03;
const HANDRAIL_M = 0.05;
const BALUSTRADE_M = 0.012;

const byId = (x, y) => String(x.id).localeCompare(String(y.id));

/** The stairs and voids that are holes in the floor (lifts stand on it). */
export const floorHoles = (plan) =>
  [...(plan.voids ?? [])]
    .sort(byId)
    .filter((v) => v.kind !== 'lift')
    .map((v) => ringOf(v.points))
    .filter(Boolean);

/** An anticlockwise ring moved `d` metres outwards, its corners mitred. */
export function grow(ring, d) {
  const n = ring.length;
  return ring.map((p, i) => {
    const prev = ring[(i - 1 + n) % n];
    const next = ring[(i + 1) % n];
    const e0 = unit([p[0] - prev[0], p[1] - prev[1]]);
    const e1 = unit([next[0] - p[0], next[1] - p[1]]);
    // Outside an anticlockwise ring is to the right of each edge.
    const m = unit([e0[1] + e1[1], -(e0[0] + e1[0])]);
    const k = d / Math.max(0.25, m[0] * e1[1] - m[1] * e1[0]);
    return [p[0] + m[0] * k, p[1] + m[1] * k];
  });
}

function unit(v) {
  const l = Math.hypot(v[0], v[1]);
  return l > 1e-12 ? [v[0] / l, v[1] / l] : [1, 0];
}

/** A straight bar along p→q, `width` across, from `h0` to `h1`, run past each end by half its width. */
function bar(mesh, p, q, width, h0, h1) {
  const u = unit([q[0] - p[0], q[1] - p[1]]);
  const n = [-u[1] * (width / 2), u[0] * (width / 2)];
  const [a, b] = [
    [p[0] - (u[0] * width) / 2, p[1] - (u[1] * width) / 2],
    [q[0] + (u[0] * width) / 2, q[1] + (u[1] * width) / 2],
  ];
  mesh.prism([[a[0] - n[0], a[1] - n[1]], [b[0] - n[0], b[1] - n[1]], [b[0] + n[0], b[1] + n[1]], [a[0] + n[0], a[1] + n[1]]], h0, h1);
}

/** A column's footprint: a rectangle, or an ellipse `w` by `d` for a round one. */
function columnRing(c) {
  if (c.shape !== 'round') return rectCorners(c);
  const segments = Math.min(48, Math.max(12, Math.ceil((Math.PI * Math.max(c.w, c.d)) / 0.08)));
  const [cos, sin] = [Math.cos(c.angle ?? 0), Math.sin(c.angle ?? 0)];
  return Array.from({ length: segments }, (_, i) => {
    const t = (2 * Math.PI * i) / segments;
    const [ex, ey] = [(c.w / 2) * Math.cos(t), (c.d / 2) * Math.sin(t)];
    return [c.x + ex * cos - ey * sin, c.y + ex * sin + ey * cos];
  });
}

/** Draws columns, stairs and voids (with their rails) and lift shafts into `lb`. */
export function buildStructure(lb, { plan, spaces }) {
  for (const c of [...(plan.columns ?? [])].sort(byId)) {
    if (!(c.w > 0 && c.d > 0) || !Number.isFinite(c.x) || !Number.isFinite(c.y)) {
      lb.skipped('column', c.id, 'no size');
      continue;
    }
    if (!c.shape) lb.assumed('column_shape', c.id);
    let height = c.heightM;
    if (!(height > 0)) {
      height = ceilingAt([c.x, c.y], spaces, plan) ?? plan.ceilingHeightM;
      lb.assumed('column_height', c.id);
    }
    const ring = ringOf(columnRing(c));
    lb.mesh('columns', 'wall_interior').prism(ring, 0, height);
    lb.walk.block(ring);
  }

  for (const v of [...(plan.voids ?? [])].sort(byId)) {
    const ring = ringOf(v.points);
    if (!ring) {
      lb.skipped('void', v.id, 'no shape');
      continue;
    }
    if (v.kind === 'lift') {
      // A closed shaft from the floor to the ceiling.
      const top = ceilingAt(centroid(ring), spaces, plan) ?? plan.ceilingHeightM;
      lb.mesh('voids', 'wall_interior').prism(ring, 0, top);
      lb.walk.block(ring);
      continue;
    }

    // A hole in the floor going down a storey: its sides face into it.
    const shaft = lb.mesh('voids', 'void');
    shaft.polygon(ring, -VOID_DEPTH_M, { up: true });
    for (let i = 0; i < ring.length; i++) {
      const [a, b] = [ring[i], ring[(i + 1) % ring.length]];
      shaft.quad([a[0], -VOID_DEPTH_M, a[1]], [b[0], -VOID_DEPTH_M, b[1]], [b[0], 0, b[1]], [a[0], 0, a[1]], [-(b[1] - a[1]), 0, b[0] - a[0]]);
    }

    // A glass balustrade with a handrail all round, just back from the edge.
    let rail = v.railHeightM;
    if (!(rail > 0)) {
      rail = RAIL_HEIGHT_M;
      lb.assumed('rail_height', v.id);
    }
    const line = grow(ring, RAIL_SETBACK_M);
    lb.walk.block(line);
    for (let i = 0; i < line.length; i++) {
      const [p, q] = [line[i], line[(i + 1) % line.length]];
      bar(lb.mesh('rails', 'glass'), p, q, BALUSTRADE_M, 0.1, rail - HANDRAIL_M);
      bar(lb.mesh('rails', 'metal'), p, q, HANDRAIL_M, rail - HANDRAIL_M, rail);
    }
  }
}
