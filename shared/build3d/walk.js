/**
 * What the walkthrough needs besides the picture (task J-08): where a
 * walker cannot go, as plan segments, and where the walk starts. Gathered
 * from the same pieces the level is built from, so what blocks the walker
 * is exactly what is drawn. The rules match the browser viewer's
 * (web/src/viewer/buildModel.js), so the walk behaves the same.
 */
import { pointInPolygon } from '../plan/geometry.js';

export const EYE_HEIGHT_M = 1.6;
/** Anything starting above this, a person walks under (door heads, beams). */
export const PASSABLE_ABOVE_M = 1.8;
/** Anything lower than this, a person steps over. */
export const STEP_OVER_M = 0.3;
/** A floor level change bigger than this, up or down, cannot be walked over. */
export const LEVEL_CHANGE_M = 0.25;
/** Room enough to stand and look round: this far from anything solid. */
const START_CLEARANCE_M = 0.9;
/** Which door is the way in: a gym's front door before a side door, a loading shutter last. */
const ENTRANCE_RANK = { double_door: 0, sliding_door: 0, single_door: 1, roller_shutter: 2 };

const round = (n) => Math.round(n * 1e4) / 1e4;

/** Whether something from `bottom` to `top` stops a walker. */
export const blocksWalker = (bottom, top) => bottom < PASSABLE_ABOVE_M && top > STEP_OVER_M;

/** Collects what blocks the walker while the level is built. */
export class WalkBuilder {
  constructor() {
    this.segments = [];
    this.rings = [];
    this.doorways = [];
  }

  /** A closed outline the walker cannot cross or stand in. */
  block(ring) {
    if (!ring || ring.length < 2) return;
    this.rings.push(ring);
    for (let i = 0; i < ring.length; i++) {
      const [a, b] = [ring[i], ring[(i + 1) % ring.length]];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-6) this.segments.push([a, b]);
    }
  }

  /**
   * A door the walk may start by: its middle on the wall's line, the wall's
   * direction there, whether it is on the outside, and its kind.
   */
  doorway(mid, dir, exterior, kind) {
    this.doorways.push({ mid, dir, exterior, rank: ENTRANCE_RANK[kind] ?? 1 });
  }
}

/** The area centroid of a ring. */
function middleOf(ring) {
  let [a, x, y] = [0, 0, 0];
  for (let i = 0; i < ring.length; i++) {
    const [p, q] = [ring[i], ring[(i + 1) % ring.length]];
    const c = p[0] * q[1] - q[0] * p[1];
    a += c;
    x += (p[0] + q[0]) * c;
    y += (p[1] + q[1]) * c;
  }
  return Math.abs(a) < 1e-12 ? ring[0] : [x / (3 * a), y / (3 * a)];
}

function distToSeg(p, a, b) {
  const [abx, aby] = [b[0] - a[0], b[1] - a[1]];
  const len2 = abx * abx + aby * aby;
  const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2));
  return Math.hypot(p[0] - (a[0] + abx * t), p[1] - (a[1] + aby * t));
}

/**
 * Where the walk starts: just inside an entrance, clear of everything,
 * looking across the room. Entrances on the outline come first; if none has
 * room to stand, the most open spot on the floor. `heading` is in radians,
 * plan x towards plan y, as the viewer uses it.
 */
function startOf(floor, walk) {
  const { segments, rings } = walk;
  const inside = (p) => pointInPolygon(p, floor) && !rings.some((r) => r.length > 2 && pointInPolygon(p, r));
  const clearance = (p) => segments.reduce((m, [a, b]) => Math.min(m, distToSeg(p, a, b)), Infinity);
  const centre = middleOf(floor);
  // How far one can see from p along a heading before something is in the way,
  // or the building ends: a view out through an open door is no view of the room.
  const edges = floor.map((a, i) => [a, floor[(i + 1) % floor.length]]);
  const sight = (p, h) => {
    const d = [Math.cos(h), Math.sin(h)];
    let best = 60;
    for (const [a, b] of [...segments, ...edges]) {
      const e = [b[0] - a[0], b[1] - a[1]];
      const denom = d[0] * e[1] - d[1] * e[0];
      if (Math.abs(denom) < 1e-12) continue;
      const w = [a[0] - p[0], a[1] - p[1]];
      const t = (w[0] * e[1] - w[1] * e[0]) / denom;
      const u = (w[0] * d[1] - w[1] * d[0]) / denom;
      if (t > 0 && u >= 0 && u <= 1) best = Math.min(best, t);
    }
    return best;
  };
  // The heading nearest "towards the middle of the room" with a long clear view.
  const facing = (p, fallback) => {
    const [dx, dy] = [centre[0] - p[0], centre[1] - p[1]];
    const aim = Math.hypot(dx, dy) > 1 ? Math.atan2(dy, dx) : fallback;
    let best = { h: aim, view: sight(p, aim) };
    if (best.view >= 6) return aim;
    for (let step = 1; step <= 12; step++) {
      for (const sign of [1, -1]) {
        const h = aim + (sign * step * Math.PI) / 12;
        const view = sight(p, h);
        if (view >= 6) return h;
        if (view > best.view + 1e-9) best = { h, view };
      }
    }
    return best.h;
  };
  // Heading kept within (-π, π].
  const at = (p, heading) => ({ x: round(p[0]), y: round(p[1]), heading: round(Math.PI - ((((Math.PI - heading) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI))) });

  // Doors on the outside first, front doors before others, then by position: the same every time.
  const doors = [...walk.doorways].sort(
    (x, y) => Number(y.exterior) - Number(x.exterior) || x.rank - y.rank || x.mid[1] - y.mid[1] || x.mid[0] - y.mid[0],
  );
  for (const door of doors) {
    for (const side of [1, -1]) {
      const n = [-door.dir[1] * side, door.dir[0] * side];
      for (const depth of [1.2, 2, 3]) {
        for (const lateral of [0, -1, 1, -2, 2]) {
          const p = [door.mid[0] + n[0] * depth + door.dir[0] * lateral, door.mid[1] + n[1] * depth + door.dir[1] * lateral];
          const fallback = Math.atan2(n[1], n[0]);
          if (inside(p) && clearance(p) >= START_CLEARANCE_M && sight(p, facing(p, fallback)) >= 4) {
            return at(p, facing(p, fallback));
          }
        }
      }
    }
  }

  // The most open spot on a grid over the floor.
  const xs = floor.map((p) => p[0]);
  const ys = floor.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  let best = null;
  for (let i = 1; i < 16; i++) {
    for (let j = 1; j < 16; j++) {
      const p = [x0 + ((x1 - x0) * i) / 16, y0 + ((y1 - y0) * j) / 16];
      if (!inside(p)) continue;
      const c = clearance(p);
      if (!best || c > best.c + 1e-9) best = { p, c };
    }
  }
  return best ? at(best.p, facing(best.p, 0)) : at(centre, 0);
}

/**
 * The walk data for a built level: `{ eyeHeightM, start: { x, y, heading },
 * collision: [[ax, ay, bx, by], ...] }`, in plan metres.
 */
export function walkData(floor, walk) {
  return {
    eyeHeightM: EYE_HEIGHT_M,
    start: startOf(floor, walk),
    collision: walk.segments.map(([a, b]) => [round(a[0]), round(a[1]), round(b[0]), round(b[1])]),
  };
}
