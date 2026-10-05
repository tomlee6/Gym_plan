/**
 * 3D generation (GEN-01..04): an approved plan turned into what the viewer
 * draws and walks through. Pure data, no three.js, so it is testable and
 * deterministic: the same approved plan always produces the same model.
 *
 * Plan (x, y) is metres on the floor; the viewer maps it to three.js
 * (x, height, y).
 */
import { bounds as boundsOf, direction, dist, lerp, outline, pointInPolygon } from '@shared/plan/index.js';

export const WALL_THICKNESS_M = 0.15;
export const DOOR_HEAD_M = 2.1;
export const WINDOW_SILL_M = 0.9;
export const WINDOW_HEAD_M = 2.1;
export const EYE_HEIGHT_M = 1.6;
/** Pieces starting above this let a person pass underneath (door heads). */
const PASSABLE_ABOVE_M = 1.8;
const STAIR_SIZE_M = 2.4;
const DEFAULT_OBJECT_HEIGHT_M = 1.2;

const round = (n) => Math.round(n * 1e6) / 1e6;
const rp = (p) => [round(p[0]), round(p[1])];

/**
 * Splits one wall into the pieces left standing around its openings.
 * Doors keep a head above 2.1 m, windows a sill below 0.9 m and a head
 * above 2.1 m, plain openings leave a full-height gap.
 */
function wallPieces(wall, openings, ceiling) {
  const len = dist(wall.a, wall.b);
  const head = Math.min(DOOR_HEAD_M, ceiling);
  const pieces = [];
  const piece = (from, to, bottom, top, kind) => {
    if (to - from < 0.01 || top - bottom < 0.01) return;
    pieces.push({
      wallId: wall.id,
      a: rp(lerp(wall.a, wall.b, from / len)),
      b: rp(lerp(wall.a, wall.b, to / len)),
      bottom: round(bottom),
      top: round(top),
      mirror: Boolean(wall.mirror),
      kind,
    });
  };

  const cuts = openings
    .filter((o) => o.wallId === wall.id && o.width > 0)
    .map((o) => ({ ...o, from: Math.max(0, o.offset), to: Math.min(len, o.offset + o.width) }))
    .filter((o) => o.to > o.from)
    .sort((x, y) => x.from - y.from || x.id.localeCompare(y.id));

  let at = 0;
  for (const o of cuts) {
    const from = Math.max(o.from, at);
    if (from > at) piece(at, from, 0, ceiling, 'wall');
    if (o.type === 'door') {
      piece(from, o.to, head, ceiling, 'head');
    } else if (o.type === 'window') {
      piece(from, o.to, 0, Math.min(WINDOW_SILL_M, ceiling), 'sill');
      piece(from, o.to, Math.min(WINDOW_HEAD_M, ceiling), ceiling, 'head');
    }
    at = Math.max(at, o.to);
  }
  if (at < len) piece(at, len, 0, ceiling, 'wall');
  return pieces;
}

function rectCorners({ x, y, w, d, angle = 0 }) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const hx = [c * (w / 2), s * (w / 2)];
  const hz = [-s * (d / 2), c * (d / 2)];
  return [
    [x - hx[0] - hz[0], y - hx[1] - hz[1]],
    [x + hx[0] - hz[0], y + hx[1] - hz[1]],
    [x + hx[0] + hz[0], y + hx[1] + hz[1]],
    [x - hx[0] + hz[0], y - hx[1] + hz[1]],
  ].map(rp);
}

function edgesOf(corners) {
  return corners.map((p, i) => ({ a: p, b: corners[(i + 1) % corners.length] }));
}

/** The fallback floor: the walls' bounding box. */
function boxFloor(walls) {
  const b = boundsOf(walls.flatMap((w) => [w.a, w.b]));
  if (!b) return null;
  return [
    [b.minX, b.minY],
    [b.maxX, b.minY],
    [b.maxX, b.maxY],
    [b.minX, b.maxY],
  ];
}

/** The same loop always starts at its lowest corner and runs the same way. */
function canonicalLoop(points) {
  let first = 0;
  points.forEach((p, i) => {
    const q = points[first];
    if (p[1] < q[1] || (p[1] === q[1] && p[0] < q[0])) first = i;
  });
  const loop = [...points.slice(first), ...points.slice(0, first)];
  let twice = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i];
    const q = loop[(i + 1) % loop.length];
    twice += p[0] * q[1] - q[0] * p[1];
  }
  return twice < 0 ? [loop[0], ...loop.slice(1).reverse()] : loop;
}

function centroid(points) {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
  }
  return [x / points.length, y / points.length];
}

/** Room enough to stand and look around: this far from anything solid. */
const START_CLEARANCE_M = 0.9;

/**
 * Where the walk starts: just inside an entrance, clear of equipment,
 * looking across the room. Entrances on the outline come first; if none has
 * room to stand, the most open spot in the room.
 */
function startOf(plan, floor, segments) {
  const inside = (p) => Boolean(floor) && pointInPolygon(p, floor);
  const clearance = (p) => segments.reduce((m, s) => Math.min(m, distToSeg(p, s.a, s.b)), Infinity);
  const onOutline = (p) =>
    Boolean(floor) && floor.some((q, i) => distToSeg(p, q, floor[(i + 1) % floor.length]) < 0.05);
  const centre = floor ? centroid(floor) : [0, 0];
  /** How far one can see from p along a heading before hitting something. */
  const sight = (p, h) => {
    const d = [Math.cos(h), Math.sin(h)];
    let best = 60;
    for (const seg of segments) {
      const e = [seg.b[0] - seg.a[0], seg.b[1] - seg.a[1]];
      const denom = d[0] * e[1] - d[1] * e[0];
      if (Math.abs(denom) < 1e-12) continue;
      const w = [seg.a[0] - p[0], seg.a[1] - p[1]];
      const t = (w[0] * e[1] - w[1] * e[0]) / denom;
      const u = (w[0] * d[1] - w[1] * d[0]) / denom;
      if (t > 0 && u >= 0 && u <= 1) best = Math.min(best, t);
    }
    return best;
  };
  /**
   * The heading closest to "towards the middle of the room" that has a long
   * clear view; failing that, the longest view there is.
   */
  const facing = (p, fallback) => {
    const dx = centre[0] - p[0];
    const dy = centre[1] - p[1];
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
  const viewFrom = (p, fallback) => sight(p, facing(p, fallback));
  const at = (p, heading) => ({ x: round(p[0]), y: round(p[1]), heading: round(heading) });

  const doors = plan.openings
    .filter((o) => o.type === 'door')
    .map((o) => {
      const wall = plan.walls.find((w) => w.id === o.wallId);
      if (!wall) return null;
      const len = dist(wall.a, wall.b);
      const mid = lerp(wall.a, wall.b, (o.offset + o.width / 2) / len);
      return { mid, dir: direction(wall.a, wall.b), exterior: onOutline(wall.a) && onOutline(wall.b) };
    })
    .filter(Boolean)
    // Entrances first, then top-left to bottom-right: the same every time.
    .sort((x, y) => Number(y.exterior) - Number(x.exterior) || x.mid[1] - y.mid[1] || x.mid[0] - y.mid[0]);

  for (const door of doors) {
    for (const side of [1, -1]) {
      const n = [-door.dir[1] * side, door.dir[0] * side];
      for (const depth of [1.2, 2, 3]) {
        for (const lateral of [0, -1, 1, -2, 2]) {
          const p = [
            door.mid[0] + n[0] * depth + door.dir[0] * lateral,
            door.mid[1] + n[1] * depth + door.dir[1] * lateral,
          ];
          const fallback = Math.atan2(n[1], n[0]);
          if (inside(p) && clearance(p) >= START_CLEARANCE_M && viewFrom(p, fallback) >= 4) {
            return at(p, facing(p, fallback));
          }
        }
      }
    }
  }

  if (floor) {
    // The most open spot on a grid over the floor.
    const box = boundsOf(floor);
    const steps = 16;
    let best = null;
    for (let i = 1; i < steps; i++) {
      for (let j = 1; j < steps; j++) {
        const p = [box.minX + ((box.maxX - box.minX) * i) / steps, box.minY + ((box.maxY - box.minY) * j) / steps];
        if (!inside(p)) continue;
        const c = clearance(p);
        if (!best || c > best.c + 1e-9) best = { p, c };
      }
    }
    if (best) return at(best.p, facing(best.p, 0));
  }
  return at([0, 0], 0);
}

export function distToSeg(p, a, b) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const len2 = abx * abx + aby * aby;
  const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2));
  return Math.hypot(p[0] - (a[0] + abx * t), p[1] - (a[1] + aby * t));
}

/**
 * The model for an approved plan:
 *
 * {
 *   ceiling, floor: [[x, y]], floorFromWalls: bool,
 *   walls:   [{ wallId, a, b, bottom, top, mirror, kind }],   // kind: wall | head | sill
 *   columns: [{ x, y, w, d, angle, height }],
 *   objects: [{ x, y, w, d, angle, height, category }],
 *   stairs:  [{ x, y, size, corners }],
 *   tags:    [{ type, x, y, heightM }],
 *   zones:   [{ points }],
 *   collision: [{ a, b }],
 *   bounds: { minX, minY, maxX, maxY },
 *   start: { x, y, heading },
 * }
 */
export function buildModel(plan) {
  const ceiling = plan.ceilingHeightM >= 2 ? plan.ceilingHeightM : 3;
  const walls = [...(plan.walls ?? [])].sort((x, y) => x.id.localeCompare(y.id));
  const openings = plan.openings ?? [];

  const traced = walls.length >= 3 ? outline({ ...plan, walls }) : null;
  const floor = (traced && canonicalLoop(traced.map(rp))) ?? boxFloor(walls);

  const pieces = walls.flatMap((w) => wallPieces(w, openings, ceiling));
  const columns = (plan.columns ?? []).map((c) => ({
    x: c.x,
    y: c.y,
    w: c.w,
    d: c.d,
    angle: c.angle ?? 0,
    height: ceiling,
  }));
  const objects = (plan.objects ?? []).map((o) => ({
    x: o.x,
    y: o.y,
    w: o.w,
    d: o.d,
    angle: o.angle ?? 0,
    height: Math.min(ceiling, o.heightM > 0 ? o.heightM : DEFAULT_OBJECT_HEIGHT_M),
    category: o.category ?? 'object',
  }));
  const stairs = (plan.tags ?? [])
    .filter((t) => t.type === 'stair')
    .map((t) => ({
      x: t.x,
      y: t.y,
      size: STAIR_SIZE_M,
      corners: rectCorners({ x: t.x, y: t.y, w: STAIR_SIZE_M, d: STAIR_SIZE_M }),
    }));

  // What stops a walker: every piece reaching the floor, columns, objects
  // and the rail round a stair void. Door heads are walked under.
  const collision = [
    ...pieces.filter((p) => p.bottom < PASSABLE_ABOVE_M).map((p) => ({ a: p.a, b: p.b })),
    ...columns.flatMap((c) => edgesOf(rectCorners(c))),
    ...objects.filter((o) => o.height > 0.3).flatMap((o) => edgesOf(rectCorners(o))),
    ...stairs.flatMap((s) => edgesOf(s.corners)),
  ];

  const allPoints = [
    ...(floor ?? []),
    ...pieces.flatMap((p) => [p.a, p.b]),
    ...objects.flatMap((o) => rectCorners(o)),
  ];
  const bounds = boundsOf(allPoints) ?? { minX: -5, minY: -5, maxX: 5, maxY: 5 };

  return {
    ceiling,
    floor,
    floorFromWalls: Boolean(traced),
    walls: pieces,
    columns,
    objects,
    stairs,
    tags: (plan.tags ?? []).map((t) => ({ type: t.type, x: t.x, y: t.y, heightM: t.heightM ?? null })),
    zones: (plan.zones ?? []).map((z) => ({ points: z.points })),
    collision,
    bounds,
    start: startOf({ ...plan, walls }, floor, collision),
  };
}

export { rectCorners };
