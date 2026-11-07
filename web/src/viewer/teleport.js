/**
 * Quick navigation in the walkthrough: jump to a room, to a machine, back to
 * the start, or to any spot picked on the minimap or the floor. Pure
 * functions; the viewer glides the camera to what they return.
 */
import { centroid, equipmentLabel, pointInPolygon } from '@shared/plan/index.js';

import { BODY_RADIUS_M, collide } from './movement.js';

/** How long a jump takes: quick, but long enough to see where you went. */
export const GLIDE_S = 0.45;

/** How far in front of a machine you stand to look at it. */
const STAND_OFF_M = 0.9;

const inFloor = (model, p) => !model.floor || model.floor.length < 3 || pointInPolygon(p, model.floor);

/** Out of any machine or column footprint `p` is inside, by the shortest way. */
function outOfFootprints(p, model) {
  let [x, y] = p;
  const r = BODY_RADIUS_M + 0.02;
  for (const o of [...(model.objects ?? []).filter((o) => o.height > 0.3), ...(model.columns ?? [])]) {
    const c = Math.cos(o.angle ?? 0);
    const s = Math.sin(o.angle ?? 0);
    // In the footprint's own axes.
    const lx = (x - o.x) * c + (y - o.y) * s;
    const ly = -(x - o.x) * s + (y - o.y) * c;
    const hx = o.w / 2 + r;
    const hy = o.d / 2 + r;
    if (Math.abs(lx) >= hx || Math.abs(ly) >= hy) continue;
    let nx = lx;
    let ny = ly;
    if (hx - Math.abs(lx) < hy - Math.abs(ly)) nx = Math.sign(lx || 1) * hx;
    else ny = Math.sign(ly || 1) * hy;
    x = o.x + nx * c - ny * s;
    y = o.y + nx * s + ny * c;
  }
  return [x, y];
}

/**
 * Where a walker can actually stand nearest `p`: out of machines and
 * columns, clear of walls. Null when `p` is outside the building.
 */
export function standAt(model, p) {
  if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
  if (!inFloor(model, p)) return null;
  const spot = collide(outOfFootprints(p, model), model.collision ?? []);
  return inFloor(model, spot) ? spot : null;
}

/** A point inside `points`: the centroid when it is in, else the inside point nearest it. */
export function insidePoint(points) {
  const c = centroid(points);
  if (!c) return null;
  if (pointInPolygon(c, points)) return c;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const step = Math.max(maxX - minX, maxY - minY) / 40;
  let best = null;
  for (let x = minX + step / 2; x < maxX; x += step) {
    for (let y = minY + step / 2; y < maxY; y += step) {
      if (!pointInPolygon([x, y], points)) continue;
      const d = Math.hypot(x - c[0], y - c[1]);
      if (!best || d < best.d) best = { p: [x, y], d };
    }
  }
  return best?.p ?? null;
}

/** Facing from `from` towards `to`, in the walkthrough's yaw (0 = +x). */
const facing = (from, to) => Math.atan2(to[1] - from[1], to[0] - from[0]);

/**
 * Where to stand to look at a machine: in front of it when its front is
 * known, otherwise on whichever side is clear, nearest the room's middle.
 */
function machineSpot(model, o, middle) {
  const angle = o.angle ?? 0;
  const sides = [
    [Math.cos(angle), Math.sin(angle), o.w / 2],
    [-Math.cos(angle), -Math.sin(angle), o.w / 2],
    [-Math.sin(angle), Math.cos(angle), o.d / 2],
    [Math.sin(angle), -Math.cos(angle), o.d / 2],
  ];
  if (Number.isFinite(o.facingDeg)) {
    const f = (o.facingDeg * Math.PI) / 180;
    sides.unshift([Math.cos(f), Math.sin(f), Math.max(o.w, o.d) / 2]);
  } else if (middle) {
    const towards = (s) => -((o.x + s[0] - middle[0]) ** 2 + (o.y + s[1] - middle[1]) ** 2);
    sides.sort((a, b) => towards(b) - towards(a));
  }
  for (const [dx, dy, half] of sides) {
    const want = [o.x + dx * (half + STAND_OFF_M), o.y + dy * (half + STAND_OFF_M)];
    const spot = standAt(model, want);
    // Close to where it was asked for: not pushed off round a corner.
    if (spot && Math.hypot(spot[0] - want[0], spot[1] - want[1]) < 0.35) {
      return { x: spot[0], y: spot[1], heading: facing(spot, [o.x, o.y]) };
    }
  }
  return null;
}

/**
 * The places the "Go to" menu offers, in order: the start, each room by
 * name, each named machine. Each is `{ id, group, label, x, y, heading }`.
 * A room or machine with nowhere to stand is left out.
 */
export function spotsOf(plan, model) {
  const spots = [];
  if (model.start) {
    spots.push({ id: 'start', group: 'Start', label: 'Back to the start', x: model.start.x, y: model.start.y, heading: model.start.heading });
  }
  const middle = model.floor?.length >= 3 ? insidePoint(model.floor) : null;

  for (const s of plan.spaces ?? []) {
    if (!Array.isArray(s.points) || s.points.length < 3) continue;
    const at = standAt(model, insidePoint(s.points));
    if (!at) continue;
    spots.push({ id: `room:${s.id}`, group: 'Rooms', label: s.name || 'Room', x: at[0], y: at[1], heading: model.start?.heading ?? 0 });
  }

  const names = new Map();
  for (const o of plan.objects ?? []) {
    if (!o.equipment) continue;
    const spot = machineSpot(model, { ...o, height: 1 }, middle);
    if (!spot) continue;
    const base = o.equipment.name || equipmentLabel(o.equipment.type);
    // Two machines called "Treadmill" are "Treadmill" and "Treadmill 2".
    const n = (names.get(base) ?? 0) + 1;
    names.set(base, n);
    spots.push({ id: `machine:${o.id}`, group: 'Machines', label: n > 1 ? `${base} ${n}` : base, ...spot });
  }
  return spots;
}

/** The plan point under (px, py) on a minimap of w × h drawing `bounds` (inverse of plan2d's fit). */
export function minimapToPlan(bounds, w, h, px, py, pad = 8) {
  const bw = Math.max(bounds.maxX - bounds.minX, 0.1);
  const bh = Math.max(bounds.maxY - bounds.minY, 0.1);
  const k = Math.min((w - pad * 2) / bw, (h - pad * 2) / bh);
  const ox = (w - bw * k) / 2 - bounds.minX * k;
  const oy = (h - bh * k) / 2 - bounds.minY * k;
  return [(px - ox) / k, (py - oy) / k];
}

/** Turning the short way round from `a` to `b`. */
function shortTurn(a, b) {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a));
}

/**
 * The walker part way through a glide: `t` 0–1, eased so it sets off and
 * arrives gently. `to.heading` may be omitted to keep facing the same way.
 */
export function glideAt(from, to, t) {
  const k = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
  const pos = [from.pos[0] + (to.pos[0] - from.pos[0]) * k, from.pos[1] + (to.pos[1] - from.pos[1]) * k];
  const yaw = to.yaw == null ? from.yaw : from.yaw + shortTurn(from.yaw, to.yaw) * k;
  return { pos, yaw };
}

