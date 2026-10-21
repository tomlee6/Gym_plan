/**
 * Walls and what is cut into them (task J-02): curved walls, corners that
 * close, openings at their sill and head, and what fills them: door leaves
 * drawn open, sliding doors slid aside, roller shutters rolled up, and glass.
 * The rules are docs/3d-contract.md.
 *
 * A wall is drawn as blocks along its centre line. `s` is the distance along
 * that line from the wall's `a` end (along the arc on a curved wall, and
 * carrying on along the tangent past either end). A face of the wall is the
 * line moved sideways by an offset, positive to the left of a→b.
 */
import { arcPoints, cross, dist, dot, pointInPolygon, project } from '../plan/geometry.js';
import { defaultOpeningKind, JOIN_TOLERANCE_M, openingTypeOf } from '../plan/model.js';
import { ceilingAt } from './spaces.js';
import { blocksWalker } from './walk.js';

/** Wall thickness by kind when the scan measured none (docs/3d-contract.md). */
export const WALL_THICKNESS_M = { exterior: 0.2, interior: 0.15, partition: 0.1, glass: 0.02 };

/** Cut height above the sill by opening kind when none was measured; null means up to the wall top. */
export const OPENING_HEIGHT_M = {
  single_door: 2.1,
  double_door: 2.1,
  sliding_door: 2.1,
  roller_shutter: 3,
  window: 1.2,
  fixed_glazing: null,
  opening: null,
};

/** A wall line this close to the floor outline is on it. */
const ON_OUTLINE_M = 0.05;
/** How far either side of a wall to look for the space it bounds. */
const PROBE_M = 0.2;
/** A sagitta smaller than this is a straight wall. */
const CURVE_MIN_M = 0.001;
/** Most a drawn arc strays from the true one between its points. */
const ARC_TOLERANCE_M = 0.01;
/** Walls meeting within this angle of straight on are one wall continuing. */
const STRAIGHT_ON = Math.sin((5 * Math.PI) / 180);

const LEAF_M = 0.04;
const GLASS_M = 0.012;
const SHUTTER_BOX_M = 0.3;

const left = (v) => [-v[1], v[0]];
const along = (p, v, k) => [p[0] + v[0] * k, p[1] + v[1] * k];
const at3 = (p, h) => [p[0], h, p[1]];
const byId = (x, y) => String(x.id).localeCompare(String(y.id));

/** The circle through three points: its centre. */
function centreOf(a, m, b) {
  // Relative to a, for precision far from the origin.
  const [px, py] = [m[0] - a[0], m[1] - a[1]];
  const [qx, qy] = [b[0] - a[0], b[1] - a[1]];
  const d = 2 * (px * qy - py * qx);
  const p2 = px * px + py * py;
  const q2 = qx * qx + qy * qy;
  return [a[0] + (qy * p2 - py * q2) / d, a[1] + (px * q2 - qx * p2) / d];
}

/**
 * A wall's centre line: `at(s)`, `tangent(s)` and `normal(s)` (to the left),
 * its `length` (along the arc) and `chord`, and `samples(s0, s1)`: the
 * distances to draw it at between two points, so a curve stays within a
 * centimetre of the true arc.
 */
export function wallAxis(wall) {
  const { a, b } = wall;
  const chord = dist(a, b);
  const u = [(b[0] - a[0]) / chord, (b[1] - a[1]) / chord];
  if (!(Math.abs(wall.curveM) > CURVE_MIN_M)) {
    return {
      curved: false,
      chord,
      length: chord,
      at: (s) => along(a, u, s),
      tangent: () => u,
      normal: () => left(u),
      samples: (s0, s1) => [s0, s1],
      nearest(p) {
        const hit = project(p, a, b);
        return { s: hit.t * chord, distance: hit.distance };
      },
    };
  }

  // The same arc arcPoints() draws (bulge to the left when curveM > 0).
  const [, m] = arcPoints(a, b, wall.curveM, 2);
  const c = centreOf(a, m, b);
  const r = dist(c, a);
  const start = Math.atan2(a[1] - c[1], a[0] - c[0]);
  let half = Math.atan2(m[1] - c[1], m[0] - c[0]) - start;
  while (half <= -Math.PI) half += 2 * Math.PI;
  while (half > Math.PI) half -= 2 * Math.PI;
  const sweep = 2 * half;
  const length = r * Math.abs(sweep);
  const turn = Math.sign(sweep);
  const angle = (s) => start + (sweep * s) / length;
  const tangentAt = (th) => [-Math.sin(th) * turn, Math.cos(th) * turn];
  const tA = tangentAt(start);
  const tB = tangentAt(start + sweep);
  const step = Math.min(Math.PI / 24, 2 * Math.acos(Math.max(-1, 1 - ARC_TOLERANCE_M / r)));
  // An even count, so the middle of the arc (where it bulges most) is a point on it.
  const segments = 2 * Math.min(48, Math.max(1, Math.ceil(Math.abs(sweep) / step / 2)));
  const ds = length / segments;

  const tangent = (s) => (s <= 0 ? tA : s >= length ? tB : tangentAt(angle(s)));
  return {
    curved: true,
    chord,
    length,
    at(s) {
      if (s <= 0) return along(a, tA, s);
      if (s >= length) return along(b, tB, s - length);
      const th = angle(s);
      return [c[0] + r * Math.cos(th), c[1] + r * Math.sin(th)];
    },
    tangent,
    normal: (s) => left(tangent(s)),
    /** The nearest point of the arc to `p`: how far along it, and how far away. */
    nearest(p) {
      let d = (Math.atan2(p[1] - c[1], p[0] - c[0]) - start) * turn;
      d = ((d % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      if (d <= Math.abs(sweep)) return { s: (d / Math.abs(sweep)) * length, distance: Math.abs(dist(p, c) - r) };
      const [da, db] = [dist(p, a), dist(p, b)];
      return da <= db ? { s: 0, distance: da } : { s: length, distance: db };
    },
    samples(s0, s1) {
      const out = [s0];
      const first = Math.max(0, Math.ceil(s0 / ds));
      const last = Math.min(segments, Math.floor(s1 / ds));
      for (let k = first; k <= last; k++) {
        const s = k === segments ? length : k * ds;
        if (s > s0 + 1e-6 && s < s1 - 1e-6) out.push(s);
      }
      out.push(s1);
      return out;
    },
  };
}

/** A point on the face `offset` metres to the left of the wall's line, `s` along it. */
export const faceAt = (axis, s, offset) => along(axis.at(s), axis.normal(s), offset);

/** Where an opening's cut runs along its wall: centred where the plan says, its width along the wall. */
function cutRange(opening, axis) {
  const centre = ((opening.offset + opening.width / 2) / axis.chord) * axis.length;
  return [Math.max(0, centre - opening.width / 2), Math.min(axis.length, centre + opening.width / 2)];
}

/**
 * `ring` with any edge that runs along a curved wall's chord replaced by
 * the arc, so floors and ceilings meet curved walls.
 */
export function withArcs(ring, walls, axes) {
  const curved = walls.filter((w) => axes.get(w.id)?.curved);
  if (!curved.length) return ring;
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    out.push(p);
    for (const w of curved) {
      const hp = project(p, w.a, w.b);
      const hq = project(q, w.a, w.b);
      if (hp.distance > JOIN_TOLERANCE_M || hq.distance > JOIN_TOLERANCE_M || Math.abs(hq.t - hp.t) < 1e-6) continue;
      const axis = axes.get(w.id);
      const [s0, s1] = [hp.t * axis.length, hq.t * axis.length];
      const between = axis.samples(Math.min(s0, s1), Math.max(s0, s1)).slice(1, -1);
      if (s0 > s1) between.reverse();
      for (const s of between) out.push(axis.at(s));
      break;
    }
  }
  return out;
}

function onRing(p, ring) {
  for (let i = 0; i < ring.length; i++) {
    if (project(p, ring[i], ring[(i + 1) % ring.length]).distance <= ON_OUTLINE_M) return true;
  }
  return false;
}

/**
 * How a wall is drawn: its kind, thickness, height and which way its
 * thickness goes (`offset` of its middle from its line, positive to the
 * left), and which side the room is on, with any defaults recorded.
 */
export function wallSpec(wall, { plan, floor, spaces, lb, axis = wallAxis(wall) }) {
  const middle = axis.at(axis.length / 2);
  const exteriorLine = onRing(wall.a, floor) && onRing(wall.b, floor) && onRing(middle, floor);
  let kind = wall.kind;
  if (!kind) {
    kind = exteriorLine ? 'exterior' : 'interior';
    lb?.assumed('wall_kind', wall.id);
  }
  let thickness = wall.thicknessM;
  if (!(thickness > 0)) {
    thickness = WALL_THICKNESS_M[kind] ?? WALL_THICKNESS_M.interior;
    lb?.assumed('wall_thickness', wall.id);
  }

  // Which side is the room: probe a little to each side of the middle.
  const n = axis.normal(axis.length / 2);
  const probe = (k) => along(middle, n, PROBE_M * k);
  const leftIn = pointInPolygon(probe(1), floor);
  const rightIn = pointInPolygon(probe(-1), floor);
  const roomSide = leftIn === rightIn ? 0 : leftIn ? 1 : -1;

  // An exterior wall's line is its inside face: the thickness goes outwards.
  const offset = kind === 'exterior' && exteriorLine && roomSide ? -roomSide * (thickness / 2) : 0;

  let height = wall.heightM;
  if (!(height > 0)) {
    // Every metre along the wall, both sides: a wall bounding a high studio (or a
    // raised ceiling zone) and a lower gym floor goes up to the higher ceiling.
    const count = Math.max(1, Math.ceil(axis.length));
    const ceilings = [];
    for (let i = 0; i < count; i++) {
      const s = (axis.length * (i + 0.5)) / count;
      for (const k of [1, -1]) {
        const h = ceilingAt(along(axis.at(s), axis.normal(s), PROBE_M * k), spaces, plan);
        if (h !== null) ceilings.push(h);
      }
    }
    height = ceilings.length ? Math.max(...ceilings) : plan.ceilingHeightM;
    lb?.assumed('wall_height', wall.id);
  }
  return { kind, thickness, offset, height, roomSide, exterior: kind === 'exterior' };
}

/**
 * One end of a wall, seen from the joint: the direction `e` away from it
 * into the wall, `m` to the left of that, and the wall's two faces as
 * offsets along `m` (`hi` the one on the left).
 */
function endOf(wall, spec, axis, atB) {
  const oL = spec.offset + spec.thickness / 2;
  const oR = spec.offset - spec.thickness / 2;
  if (!atB) {
    const e = axis.tangent(0);
    return { wall, spec, joint: wall.a, e, m: left(e), hi: oL, lo: oR };
  }
  const t = axis.tangent(axis.length);
  const e = [-t[0], -t[1]];
  return { wall, spec, joint: wall.b, e, m: left(e), hi: -oR, lo: -oL };
}

/** How far from the joint, along `x`'s direction, its face at `ox` meets `y`'s face at `oy`. */
function meet(x, ox, y, oy) {
  const p = along(x.joint, x.m, ox);
  const q = along(y.joint, y.m, oy);
  return cross([q[0] - p[0], q[1] - p[1]], y.e) / cross(x.e, y.e);
}

/**
 * Where each face of each wall starts and ends, as `s` along the wall, so
 * corners close (docs/3d-contract.md, Walls):
 * - two walls meeting end to end are mitred, face to face;
 * - three or more at one point each run past it far enough to fill the middle;
 * - a wall ending on another's side stops at that wall's line, inside it.
 */
function faceSpans(walls, specs, axes) {
  const ends = walls.flatMap((w) => [endOf(w, specs.get(w.id), axes.get(w.id), false), endOf(w, specs.get(w.id), axes.get(w.id), true)]);
  const spans = new Map();
  for (const w of walls) {
    const L = axes.get(w.id).length;
    spans.set(w.id, { l: [0, L], r: [0, L] });
  }
  for (const x of ends) {
    const others = ends.filter((y) => y.wall !== x.wall && dist(y.joint, x.joint) <= JOIN_TOLERANCE_M);
    let hi = 0;
    let lo = 0;
    const straightOn = (y) => Math.abs(cross(x.e, y.e)) < STRAIGHT_ON && dot(x.e, y.e) < 0;
    // Two walls at an angle: mitre. Carrying straight on (or folded back): stop at the joint.
    if (others.length === 1 && Math.abs(cross(x.e, others[0].e)) >= STRAIGHT_ON) {
      const y = others[0];
      // Each face meets the other wall's face on the same side of the corner.
      const limit = Math.min(4 * Math.max(x.spec.thickness, y.spec.thickness) + 0.05, axes.get(x.wall.id).length / 2);
      const clamp = (u) => Math.max(-limit, Math.min(limit, u));
      hi = clamp(meet(x, x.hi, y, y.lo));
      lo = clamp(meet(x, x.lo, y, y.hi));
    } else if (others.length > 1 && !others.some(straightOn)) {
      const reach = Math.max(...others.map((y) => Math.abs(y.spec.offset) + y.spec.thickness / 2));
      hi = -reach;
      lo = -reach;
    }
    const span = spans.get(x.wall.id);
    const L = axes.get(x.wall.id).length;
    // Seen from b, the left of the way in is the wall's right face.
    if (x.joint === x.wall.a) {
      span.l[0] = hi;
      span.r[0] = lo;
    } else {
      span.r[1] = L - hi;
      span.l[1] = L - lo;
    }
  }
  return spans;
}

/** `ranges` with the `cuts` taken out. Both are lists of [from, to]. */
function subtract(ranges, cuts) {
  let out = ranges;
  for (const [c0, c1] of cuts) {
    out = out.flatMap(([r0, r1]) => {
      if (c1 <= r0 || c0 >= r1) return [[r0, r1]];
      const parts = [];
      if (c0 > r0) parts.push([r0, c0]);
      if (c1 < r1) parts.push([c1, r1]);
      return parts;
    });
  }
  return out.filter(([r0, r1]) => r1 - r0 > 1e-4);
}

const sameRanges = (x, y) =>
  x.length === y.length && x.every(([a0, a1], i) => Math.abs(a0 - y[i][0]) < 1e-6 && Math.abs(a1 - y[i][1]) < 1e-6);

/**
 * One block of a wall (or of a pane or panel along it): the faces at
 * offsets `oL` (left) and `oR` (right), each over its own `s` span, from
 * `h0` to `h1`. End caps are drawn only over the heights given, so faces
 * hidden against the next block are left out. `mesh(part)` gives the mesh
 * for 'left', 'right' and 'rest' (top, underside, caps).
 */
function block(mesh, axis, { oL, oR, l, r, h0, h1, startCaps, endCaps, underside = h0 > 1e-4 }) {
  if (!(h1 - h0 > 1e-4)) return null;
  const lp = axis.samples(l[0], Math.max(l[0], l[1])).map((s) => faceAt(axis, s, oL));
  const rp = axis.samples(r[0], Math.max(r[0], r[1])).map((s) => faceAt(axis, s, oR));
  const side = (points, part, k) => {
    for (let i = 0; i < points.length - 1; i++) {
      const [p, q] = [points[i], points[i + 1]];
      const n = [-(q[1] - p[1]) * k, 0, (q[0] - p[0]) * k];
      mesh(part).quad(at3(p, h0), at3(q, h0), at3(q, h1), at3(p, h1), n);
    }
  };
  side(lp, 'left', 1);
  side(rp, 'right', -1);
  const ring = [...lp, ...[...rp].reverse()];
  mesh('rest').polygon(ring, h1, { up: true });
  if (underside) mesh('rest').polygon(ring, h0, { up: false });
  const cap = (pl, pr, s, k, ranges) => {
    const t = axis.tangent(s);
    let n = left([pl[0] - pr[0], pl[1] - pr[1]]);
    if (dot(n, t) * k < 0) n = [-n[0], -n[1]];
    for (const [c0, c1] of ranges) {
      mesh('rest').quad(at3(pr, c0), at3(pl, c0), at3(pl, c1), at3(pr, c1), [n[0], 0, n[1]]);
    }
  };
  cap(lp[0], rp[0], Math.min(l[0], r[0]), -1, startCaps ?? [[h0, h1]]);
  cap(lp[lp.length - 1], rp[rp.length - 1], Math.max(l[1], r[1]), 1, endCaps ?? [[h0, h1]]);
  return ring;
}

/** A thin block along the wall between `s0` and `s1`, between offsets `o0` and `o1`. */
function panel(mesh, axis, s0, s1, o0, o1, h0, h1) {
  return block(mesh, axis, { oL: Math.max(o0, o1), oR: Math.min(o0, o1), l: [s0, s1], r: [s0, s1], h0, h1 });
}

/** The side (+1 left, -1 right) a point of `space` lies on, seen from the middle of a cut. */
function sideOfSpace(space, axis, s, reach) {
  const p = axis.at(s);
  const n = axis.normal(s);
  if (pointInPolygon(along(p, n, reach), space.points)) return 1;
  if (pointInPolygon(along(p, n, -reach), space.points)) return -1;
  return 0;
}

/** The openings cut into one wall, with where and how high, defaults recorded. */
function cutsOf(wall, axis, spec, openings, lb) {
  const cuts = [];
  for (const o of openings) {
    if (!(o.width > 0) || !Number.isFinite(o.offset)) {
      lb.skipped('opening', o.id, 'no position on its wall');
      continue;
    }
    let kind = o.kind;
    if (!kind) {
      kind = defaultOpeningKind(o.type, o.width);
      lb.assumed('opening_kind', o.id);
    }
    const [s0, s1] = cutRange(o, axis);
    let sill = o.sillHeightM;
    if (!(sill >= 0)) {
      sill = kind === 'window' ? 0.9 : 0;
      if (kind === 'window' || kind === 'fixed_glazing') lb.assumed('opening_sill', o.id);
    }
    let height = o.heightM;
    if (!(height > 0)) {
      height = OPENING_HEIGHT_M[kind] ?? spec.height - sill;
      lb.assumed('opening_height', o.id);
    }
    const head = Math.min(sill + height, spec.height);
    if (s1 - s0 < 0.05 || head - sill < 0.05) {
      lb.skipped('opening', o.id, 'falls outside its wall');
      continue;
    }
    cuts.push({ opening: o, kind, s0, s1, sill, head });
  }
  return cuts;
}

/** What fills a cut: glass, a door leaf drawn open, a slid door, a rolled-up shutter. */
function fill(lb, cut, { plan, axis, spec, spaces, oL, oR, stops }) {
  const { opening: o, kind, s0, s1, sill, head } = cut;
  const type = openingTypeOf(kind);
  const mid = (s0 + s1) / 2;
  const reach = Math.abs(spec.offset) + spec.thickness / 2 + 0.3;
  const into = o.swingInto ? spaces.find((s) => s.id === o.swingInto) : null;
  const intoSide = into ? sideOfSpace(into, axis, mid, reach) : 0;
  const glass = () => lb.mesh('glass', 'glass');
  const doors = (material) => () => lb.mesh('doors', material);

  // Under any cut that starts at the floor, the floor carries on through the wall.
  if (sill < 1e-3) {
    const lp = axis.samples(s0, s1).map((s) => faceAt(axis, s, oL));
    const rp = axis.samples(s0, s1).map((s) => faceAt(axis, s, oR));
    lb.mesh('floors', 'floor_concrete').polygon([...lp, ...rp.reverse()], 0.003, { up: true });
  }

  if (kind === 'window' || kind === 'fixed_glazing') {
    const pane = panel(glass, axis, s0, s1, spec.offset - GLASS_M / 2, spec.offset + GLASS_M / 2, sill, head);
    if (blocksWalker(sill, head)) lb.walk.block(pane);
    return;
  }
  if (type !== 'door') return;
  // The walk may start by any door (the viewer's rule).
  lb.walk.doorway(axis.at(mid), axis.tangent(mid), spec.exterior, kind);

  if (kind === 'roller_shutter') {
    // Rolled up into its box, on the side it is set to open into, or inside the building.
    const side = intoSide || (spec.exterior && spec.roomSide) || 1;
    const face = side > 0 ? oL : oR;
    // Under the ceiling of the room it is in, which may be lower than the wall.
    const local = ceilingAt(along(axis.at(mid), axis.normal(mid), side * reach), spaces, plan);
    const ceiling = local !== null ? Math.min(local, spec.height) : spec.height;
    const bottom = Math.max(sill, Math.min(head, ceiling - SHUTTER_BOX_M));
    panel(doors('metal'), axis, s0 - 0.05, s1 + 0.05, face, face + side * SHUTTER_BOX_M, bottom, bottom + SHUTTER_BOX_M);
    return;
  }

  let side = intoSide;
  if (!side) {
    side = o.swing === 'outward' ? -1 : 1;
    if (kind !== 'sliding_door' && o.swing !== 'outward' && o.swing !== 'inward') lb.assumed('door_swing', o.id);
  }
  const face = side > 0 ? oL : oR;
  const width = s1 - s0;

  if (kind === 'sliding_door') {
    // Slid over the wall beside it, overlapping the jamb a little, on the side with a clear run:
    // not into the end of the wall, another wall meeting it, or another opening.
    const need = width - 0.05;
    const runB = Math.min(...stops.filter((s) => s >= s1 - 1e-6)) - s1;
    const runA = s0 - Math.max(...stops.filter((s) => s <= s0 + 1e-6));
    const towardsB = runB >= need || (runA < need && runB >= runA);
    const [p0, p1] = towardsB ? [s1 - 0.05, s1 + need] : [s0 - need, s0 + 0.05];
    lb.walk.block(panel(doors('door'), axis, p0, p1, face + side * 0.02, face + side * (0.02 + LEAF_M), sill + 0.01, head));
    return;
  }

  // Hinged leaves, open at 90° on the swing side, so the walkthrough can pass.
  const leaves = o.leaves === 2 || (o.leaves == null && kind === 'double_door') ? 2 : 1;
  const hinge = o.hinge ?? (o.swing === 'left' || o.swing === 'right' ? o.swing : null);
  if (leaves === 1 && !hinge) lb.assumed('door_hinge', o.id);
  const hinges = leaves === 2 ? [s0, s1] : [hinge === 'right' ? s1 : s0];
  const leafWidth = width / leaves;
  for (const s of hinges) {
    const h = faceAt(axis, s, face);
    const out = along([0, 0], axis.normal(s), side);
    const inward = along([0, 0], axis.tangent(s), s === s0 ? 1 : -1);
    const tip = along(h, out, leafWidth);
    const leaf = [h, tip, along(tip, inward, LEAF_M), along(h, inward, LEAF_M)];
    lb.mesh('doors', 'door').prism(leaf, sill + 0.01, head - 0.01);
    lb.walk.block(leaf);
  }
}

/**
 * Draws every wall of the level, with its openings cut and filled, into the
 * level builder `lb`. `floor` and `spaces` are already drawn along any arcs.
 */
export function buildWalls(lb, { plan, walls, axes, floor, spaces }) {
  const specs = new Map(walls.map((w) => [w.id, wallSpec(w, { plan, floor, spaces, lb, axis: axes.get(w.id) })]));
  const spans = faceSpans(walls, specs, axes);
  const wallIds = new Set(walls.map((w) => w.id));
  const openings = [...(plan.openings ?? [])].sort(byId);
  for (const o of openings) {
    if (!wallIds.has(o.wallId)) lb.skipped('opening', o.id, 'not on a wall');
  }

  for (const wall of walls) {
    const axis = axes.get(wall.id);
    const spec = specs.get(wall.id);
    const span = spans.get(wall.id);
    const oL = spec.offset + spec.thickness / 2;
    const oR = spec.offset - spec.thickness / 2;

    // Materials: an exterior wall is painted like the rooms on its inside face.
    const node = spec.kind === 'glass' ? 'glass' : spec.exterior ? 'walls-exterior' : 'walls';
    const base = spec.kind === 'glass' ? 'glass' : spec.exterior ? 'wall_exterior' : 'wall_interior';
    const inside = spec.exterior && spec.offset !== 0 ? (spec.offset < 0 ? 'left' : 'right') : null;
    const mesh = (part) => lb.mesh(node, part === inside ? 'wall_interior' : base);

    const cuts = cutsOf(wall, axis, spec, openings.filter((o) => o.wallId === wall.id), lb);

    // Along the wall, the stretches between cut edges, each with the heights left solid.
    const edges = [...new Set(cuts.flatMap((c) => [c.s0, c.s1]))].sort((x, y) => x - y);
    const stretches = [];
    for (let i = 0; i <= edges.length; i++) {
      const from = i === 0 ? -Infinity : edges[i - 1];
      const to = i === edges.length ? Infinity : edges[i];
      const over = cuts.filter((c) => c.s0 <= from + 1e-9 && c.s1 >= to - 1e-9);
      const solid = subtract([[0, spec.height]], over.map((c) => [c.sill, c.head]));
      const last = stretches[stretches.length - 1];
      if (last && sameRanges(last.solid, solid)) last.to = to;
      else stretches.push({ from, to, solid });
    }

    stretches.forEach((st, i) => {
      const before = stretches[i - 1]?.solid ?? [];
      const after = stretches[i + 1]?.solid ?? [];
      const l = [Math.max(st.from, span.l[0]), Math.min(st.to, span.l[1])];
      const r = [Math.max(st.from, span.r[0]), Math.min(st.to, span.r[1])];
      for (const [h0, h1] of st.solid) {
        const ring = block(mesh, axis, {
          oL,
          oR,
          l,
          r,
          h0,
          h1,
          // A cap shows only where the next stretch is open.
          startCaps: subtract([[h0, h1]], before),
          endCaps: subtract([[h0, h1]], after),
        });
        // Walked under only above head height (a door head), stepped over only below a sill.
        if (blocksWalker(h0, h1)) lb.walk.block(ring);
      }
    });

    mirrors(lb, wall, { plan, axis, spec, spaces, oL, oR, stretches });

    // What a sliding door must not slide into: the wall's ends, walls meeting it, other openings.
    const stops = [0, axis.length, ...junctionsOn(wall, axis, walls)];
    for (const cut of cuts) {
      const others = cuts.filter((c) => c !== cut).flatMap((c) => [c.s0, c.s1]);
      fill(lb, cut, { plan, axis, spec, spaces, oL, oR, stops: [...stops, ...others] });
    }
  }
  return specs;
}

const MIRROR_M = 0.006;
/** Studios have mirrors more often than any other room. */
const MIRROR_ROOMS = ['studio', 'gym_floor'];

/**
 * Which face of a wall its mirrors are on (+1 left, -1 right): an exterior
 * wall's inside; otherwise the side a mirror tag from the scan is on, or the
 * side facing a studio (then a gym floor), recorded as assumed.
 */
function mirrorSide(wall, { plan, axis, spec, spaces }, lb) {
  if (spec.exterior && spec.roomSide) return spec.roomSide;
  for (const tag of [...(plan.tags ?? [])].filter((t) => t.type === 'mirror').sort(byId)) {
    const hit = axis.nearest([tag.x, tag.y]);
    if (hit.distance > 0.5 || hit.distance < 0.02) continue;
    const p = axis.at(hit.s);
    const n = axis.normal(hit.s);
    return (tag.x - p[0]) * n[0] + (tag.y - p[1]) * n[1] > 0 ? 1 : -1;
  }
  lb.assumed('mirror_side', wall.id);
  const mid = axis.length / 2;
  const reach = Math.abs(spec.offset) + spec.thickness / 2 + 0.2;
  const kindOn = (k) => spaces.find((s) => pointInPolygon(along(axis.at(mid), axis.normal(mid), k * reach), s.points))?.kind;
  for (const kind of MIRROR_ROOMS) {
    if (kindOn(1) === kind) return 1;
    if (kindOn(-1) === kind) return -1;
  }
  return spec.roomSide || 1;
}

/**
 * A wall's mirror spans, as thin reflective panels on one face, over the
 * solid parts of the wall only (not across its doors and windows).
 */
function mirrors(lb, wall, ctx) {
  const { axis, spec, oL, oR, stretches } = ctx;
  let spans = [...(wall.mirrors ?? [])].sort(byId);
  if (!spans.length && wall.mirror) {
    // An older plan: "this wall is a mirror wall", the whole face.
    spans = [{ id: null, fromM: 0, toM: axis.chord, bottomM: 0, topM: spec.height }];
    lb.assumed('mirror_span', wall.id);
  }
  if (!spans.length) return;
  const side = mirrorSide(wall, ctx, lb);
  const face = side > 0 ? oL : oR;
  for (const m of spans) {
    // Along the chord, like openings; mapped onto the arc on a curved wall.
    const s0 = Math.max(0, (m.fromM / axis.chord) * axis.length);
    const s1 = Math.min(axis.length, (m.toM / axis.chord) * axis.length);
    const [b, t] = [Math.max(0, m.bottomM ?? 0), Math.min(spec.height, m.topM ?? spec.height)];
    if (!(s1 - s0 > 0.01 && t - b > 0.01)) {
      lb.skipped('mirror', m.id ?? wall.id, 'falls outside its wall');
      continue;
    }
    for (const st of stretches) {
      const [p0, p1] = [Math.max(s0, st.from), Math.min(s1, st.to)];
      if (!(p1 - p0 > 1e-3)) continue;
      for (const [h0, h1] of st.solid) {
        const [q0, q1] = [Math.max(b, h0), Math.min(t, h1)];
        if (q1 - q0 > 1e-3) panel(() => lb.mesh('mirrors', 'mirror'), axis, p0, p1, face, face + side * MIRROR_M, q0, q1);
      }
    }
  }
}

/** Where along `wall` other walls end on it (T-junctions), as `s`. */
function junctionsOn(wall, axis, walls) {
  const out = [];
  for (const other of walls) {
    if (other === wall) continue;
    for (const p of [other.a, other.b]) {
      const s = project(p, wall.a, wall.b).t * axis.length;
      if (s > 1e-3 && s < axis.length - 1e-3 && dist(p, axis.at(s)) <= JOIN_TOLERANCE_M) out.push(s);
    }
  }
  return out;
}
