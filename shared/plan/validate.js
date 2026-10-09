/**
 * Plan validation (RDR-06, REV-06): the outline closes, no walls cross, and
 * every opening sits on a wall. Problems are reported, never repaired. A
 * plan with any issue cannot be approved.
 */
import { coverage, direction, dist, intersect, lerp, pointInPolygon, polygonArea, project } from './geometry.js';
import {
  BEAM_KINDS,
  COLUMN_SHAPES,
  FLOOR_FINISHES,
  HINGE_SIDES,
  JOIN_TOLERANCE_M,
  LEVEL_CHANGE_KINDS,
  objectBounds,
  OPENING_KINDS,
  OPENING_TYPES,
  outline,
  SPACE_KINDS,
  SUPPORTED_FORMATS,
  VOID_KINDS,
  WALL_KINDS,
} from './model.js';

const TOL = JOIN_TOLERANCE_M;
const MIN_WALL_M = 0.1;

/*
 * Measurement sanity limits (CHANGE 1.6). These are deliberately wide: they
 * catch a reading that cannot be a real building, not one that is merely
 * unusual. Anything inside them is the reviewer's judgement, not the
 * validator's.
 */
const LIMITS = {
  wallLengthM: [MIN_WALL_M, 200],
  wallHeightM: [1, 20],
  wallThicknessM: [0.01, 2],
  openingWidthM: [0.1, 20],
  openingHeightM: [0.1, 10],
  objectSideM: [0.02, 30],
  objectHeightM: [0.02, 10],
};

/** Two objects this close, at this similar a size, are the same thing twice. */
const DUPLICATE_CENTRE_M = 0.25;
const DUPLICATE_SIZE_RATIO = 0.25;

/** Is `n` a real measurement, and within `[lo, hi]`? */
function outOfRange(n, [lo, hi]) {
  if (n === null || n === undefined) return false; // Not measured is not wrong.
  return !Number.isFinite(n) || n < lo || n > hi;
}

/** Do two walls lie along the same line and share a stretch of it? */
function overlaps(w1, w2) {
  const len1 = dist(w1.a, w1.b);
  const len2 = dist(w2.a, w2.b);
  if (len1 < TOL || len2 < TOL) return false;
  // Both of w2's ends must sit on w1's line for the two to be collinear.
  const ends = [project(w2.a, w1.a, w1.b), project(w2.b, w1.a, w1.b)];
  if (ends.some((e) => e.distance > TOL)) return false;
  const lo = Math.min(ends[0].t, ends[1].t) * len1;
  const hi = Math.max(ends[0].t, ends[1].t) * len1;
  // The shared stretch, clamped to w1, must be longer than the join tolerance.
  return Math.min(hi, len1) - Math.max(lo, 0) > TOL;
}

/** Is endpoint `p` of `self` joined to another wall's end or body? */
function joined(plan, self, p) {
  return plan.walls.some((w) => {
    if (w === self) return false;
    if (dist(p, w.a) <= TOL || dist(p, w.b) <= TOL) return true;
    return project(p, w.a, w.b).distance <= TOL;
  });
}

/** Do two walls cross somewhere other than a shared end or a T-junction? */
function crosses(w1, w2) {
  const hit = intersect(w1.a, w1.b, w2.a, w2.b);
  if (!hit) return false;
  const len1 = dist(w1.a, w1.b);
  const len2 = dist(w2.a, w2.b);
  const inside1 = hit.t * len1 > TOL && (1 - hit.t) * len1 > TOL;
  const inside2 = hit.u * len2 > TOL && (1 - hit.u) * len2 > TOL;
  return inside1 && inside2;
}

/**
 * Every problem with the plan, as `{ code, message, ids }`. An empty list
 * means the plan is valid.
 */
export function validate(plan) {
  const issues = [];
  const push = (code, message, ids = []) => issues.push({ code, message, ids });

  if (plan.format && !SUPPORTED_FORMATS.includes(plan.format)) {
    push('format_unknown', `This plan is in an unknown format (${plan.format}).`);
  }
  if (plan.scale?.source === 'line' && !(plan.scale.metresPerPixel > 0)) {
    push('scale_missing', 'The scale is not set. Draw a line over a known dimension.');
  }
  if (plan.walls.length < 3) {
    push('too_few_walls', 'A plan needs at least three walls that close into a room.');
  }

  for (const w of plan.walls) {
    const len = dist(w.a, w.b);
    if (len < MIN_WALL_M) {
      push('short_wall', 'A wall is shorter than 10 cm. Delete it or drag it out.', [w.id]);
    }
    // Measurements that cannot describe a real wall (CHANGE 1.6).
    if (!Number.isFinite(w.a?.[0]) || !Number.isFinite(w.a?.[1]) || !Number.isFinite(w.b?.[0]) || !Number.isFinite(w.b?.[1])) {
      push('invalid_dimension', 'A wall has a corner that is not a number.', [w.id]);
    } else if (len > LIMITS.wallLengthM[1]) {
      push('invalid_dimension', `A wall is ${len.toFixed(1)} m long, which is longer than any gym wall.`, [w.id]);
    }
    if (outOfRange(w.heightM, LIMITS.wallHeightM)) {
      push('invalid_dimension', `A wall is ${w.heightM} m high. Correct it or clear it.`, [w.id]);
    }
    if (outOfRange(w.thicknessM, LIMITS.wallThicknessM)) {
      push('invalid_dimension', `A wall is ${w.thicknessM} m thick. Correct it or clear it.`, [w.id]);
    }
  }

  // Open ends: the outline must close (no open loops).
  const open = [];
  for (const w of plan.walls) {
    for (const end of [w.a, w.b]) {
      if (!joined(plan, w, end)) open.push(w.id);
    }
  }
  if (open.length) {
    const ids = [...new Set(open)];
    push(
      'open_outline',
      `${open.length} wall end${open.length > 1 ? 's do' : ' does'} not meet another wall, so the outline is not closed.`,
      ids,
    );
  } else if (plan.walls.length >= 3 && !outline(plan)) {
    push('open_outline', 'The walls do not enclose a room.');
  }

  // Self-intersection, and walls drawn on top of one another.
  for (let i = 0; i < plan.walls.length; i++) {
    for (let j = i + 1; j < plan.walls.length; j++) {
      if (crosses(plan.walls[i], plan.walls[j])) {
        push('walls_cross', 'Two walls cross each other. Split them where they meet.', [
          plan.walls[i].id,
          plan.walls[j].id,
        ]);
      } else if (overlaps(plan.walls[i], plan.walls[j])) {
        push('walls_overlap', 'Two walls lie on top of each other. Delete one or join them.', [
          plan.walls[i].id,
          plan.walls[j].id,
        ]);
      }
    }
  }

  // Openings attached, inside their wall, not overlapping.
  const byWall = new Map();
  for (const o of plan.openings) {
    const wall = plan.walls.find((w) => w.id === o.wallId);
    if (!wall) {
      push('opening_unattached', 'An opening is not attached to a wall.', [o.id]);
      continue;
    }
    if (!OPENING_TYPES.includes(o.type)) {
      push('opening_type', 'An opening has no type. Set it to door, window or opening.', [o.id]);
    }
    const len = dist(wall.a, wall.b);
    if (o.width <= 0 || o.offset < -TOL || o.offset + o.width > len + TOL) {
      push('opening_outside', 'An opening runs past the end of its wall.', [o.id]);
    }
    if (outOfRange(o.width, LIMITS.openingWidthM)) {
      push('invalid_dimension', `A ${o.type} is ${o.width} m wide. Correct it.`, [o.id]);
    }
    if (outOfRange(o.heightM, LIMITS.openingHeightM)) {
      push('invalid_dimension', `A ${o.type} is ${o.heightM} m high. Correct it or clear it.`, [o.id]);
    }
    // A sill above the opening's own head, or below the floor, cannot be.
    if (o.sillHeightM !== null && o.sillHeightM !== undefined) {
      if (!Number.isFinite(o.sillHeightM) || o.sillHeightM < -0.5) {
        push('invalid_dimension', 'A window sill is below the floor.', [o.id]);
      } else if (o.heightM && o.sillHeightM + o.heightM > plan.ceilingHeightM + 0.5) {
        push('opening_above_ceiling', 'A window reaches above the ceiling. Check its sill and height.', [o.id]);
      }
    }
    if (!byWall.has(wall.id)) byWall.set(wall.id, []);
    byWall.get(wall.id).push(o);
  }
  for (const list of byWall.values()) {
    list.sort((x, y) => x.offset - y.offset);
    for (let i = 1; i < list.length; i++) {
      if (list[i].offset < list[i - 1].offset + list[i - 1].width - TOL) {
        push('openings_overlap', 'Two openings overlap on the same wall.', [list[i - 1].id, list[i].id]);
      }
    }
  }

  /*
   * Objects and equipment (CHANGE 1.6). The floor outline is only meaningful
   * once the walls close, so anything outside it is only reported when there
   * is a boundary to be outside of — otherwise `open_outline` already says
   * what is wrong, and repeating it would bury the real problem.
   */
  const floor = plan.walls.length >= 3 ? outline(plan) : null;
  for (const b of plan.objects) {
    const name = b.equipment?.name ?? b.category ?? 'An object';
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) {
      push('invalid_dimension', `${name} has a position that is not a number.`, [b.id]);
      continue;
    }
    if (outOfRange(b.w, LIMITS.objectSideM) || outOfRange(b.d, LIMITS.objectSideM)) {
      push('invalid_dimension', `${name} is ${b.w} × ${b.d} m, which cannot be right.`, [b.id]);
    }
    if (outOfRange(b.heightM, LIMITS.objectHeightM)) {
      push('invalid_dimension', `${name} is ${b.heightM} m high, which cannot be right.`, [b.id]);
    }
    if (floor && !pointInPolygon([b.x, b.y], floor)) {
      push('object_outside', `${name} sits outside the room. Move it in or delete it.`, [b.id]);
    }
  }

  // The same machine read twice: same place, near enough the same size.
  for (let i = 0; i < plan.objects.length; i++) {
    for (let j = i + 1; j < plan.objects.length; j++) {
      const a = plan.objects[i];
      const b = plan.objects[j];
      if (!Number.isFinite(a.x) || !Number.isFinite(b.x)) continue;
      if (dist([a.x, a.y], [b.x, b.y]) > DUPLICATE_CENTRE_M) continue;
      const areaA = objectBounds(a).widthM * objectBounds(a).depthM;
      const areaB = objectBounds(b).widthM * objectBounds(b).depthM;
      const larger = Math.max(areaA, areaB);
      if (larger <= 0) continue;
      if (Math.abs(areaA - areaB) / larger <= DUPLICATE_SIZE_RATIO) {
        push('duplicate_object', 'Two objects are in the same place. Delete the one that is not there.', [a.id, b.id]);
      }
    }
  }

  for (const z of plan.zones) {
    if (!Array.isArray(z.points) || z.points.length < 3) {
      push('zone_shape', 'A no-build zone needs at least three corners.', [z.id]);
    }
  }
  if (!(plan.ceilingHeightM >= 2 && plan.ceilingHeightM <= 12)) {
    push('ceiling', 'Set a ceiling height between 2 and 12 m.');
  }

  validateV3(plan, floor, push);

  return issues;
}

/** Why Approve is disabled, or [] when it may be pressed (REV-05, REV-06). */
export function approvalBlockers(plan) {
  const blockers = validate(plan).map((i) => i.message);
  const open = plan.flags.filter((f) => f.status === 'open').length;
  if (open) {
    blockers.unshift(
      `${open} flagged element${open > 1 ? 's need' : ' needs'} confirming, editing or deleting.`,
    );
  }
  return blockers;
}

/* -------------------------------------------------------------------------
 * Format 3 (G-07): spaces, wall and opening details, structure and machine
 * fields. Every rule is skipped when the plan does not use the feature, so a
 * format 1 or 2 plan is judged exactly as before.
 * ---------------------------------------------------------------------- */

/** Gaps or overlaps between spaces larger than this share of the floor fail. */
const SPACE_COVERAGE_TOLERANCE = 0.01;
/** How far either side of a door to look for the spaces it joins. */
const DOOR_PROBE_M = 0.35;

const isPolygon = (points) =>
  Array.isArray(points) &&
  points.length >= 3 &&
  points.every((p) => Number.isFinite(p?.[0]) && Number.isFinite(p?.[1]));

const missing = (n) => n === null || n === undefined;

function spaceAt(spaces, p) {
  return spaces.find((s) => pointInPolygon(p, s.points)) ?? null;
}

/** Is `p` within the join tolerance of a polygon's edge? */
function nearEdge(p, points) {
  for (let i = 0; i < points.length; i++) {
    if (project(p, points[i], points[(i + 1) % points.length]).distance <= TOL) return true;
  }
  return false;
}

function validateV3(plan, floor, push) {
  const spaces = Array.isArray(plan.spaces) ? plan.spaces : [];
  const spaceIds = new Set(spaces.map((s) => s.id));

  for (const s of spaces) {
    const label = s.name || 'A space';
    if (!isPolygon(s.points)) {
      push('space_shape', `${label} needs at least three corners.`, [s.id]);
      continue;
    }
    if (s.kind && !SPACE_KINDS.includes(s.kind)) {
      push('space_kind', `${label} has an unknown kind (${s.kind}).`, [s.id]);
    }
    if (s.floorFinish && !FLOOR_FINISHES.includes(s.floorFinish)) {
      push('space_finish', `${label} has an unknown floor finish (${s.floorFinish}).`, [s.id]);
    }
    if (outOfRange(s.ceilingHeightM, [2, 12])) {
      push('ceiling', `${label} has a ceiling of ${s.ceilingHeightM} m. Set it between 2 and 12 m.`, [s.id]);
    }
    for (const z of s.ceilingZones ?? []) {
      if (!isPolygon(z.points)) {
        push('ceiling_zone_shape', `A ceiling zone in ${label} needs at least three corners.`, [s.id, z.id]);
      } else if (!z.points.every((p) => pointInPolygon(p, s.points) || nearEdge(p, s.points))) {
        push('ceiling_zone_outside', `A ceiling zone runs outside ${label}.`, [s.id, z.id]);
      }
      if (missing(z.heightM) || outOfRange(z.heightM, [1.8, 15])) {
        push('ceiling', `A ceiling zone in ${label} needs a height between 1.8 and 15 m.`, [s.id, z.id]);
      }
    }
  }

  // Spaces tile the floor: no gaps, no overlaps.
  const shaped = spaces.filter((s) => isPolygon(s.points));
  if (floor && shaped.length) {
    const c = coverage(floor, shaped.map((s) => s.points));
    const limit = Math.max(0.25, c.outlineM2 * SPACE_COVERAGE_TOLERANCE);
    const ids = shaped.map((s) => s.id);
    if (c.gapM2 > limit) {
      push(
        'space_gap',
        `${c.gapM2.toFixed(1)} m² of the floor is in no space. Draw a space over it or stretch a neighbour.`,
        ids,
      );
    }
    if (c.overlapM2 > limit) {
      push('space_overlap', `Spaces overlap by ${c.overlapM2.toFixed(1)} m². Each part of the floor belongs to one space.`, ids);
    }
  }

  for (const w of plan.walls) {
    if (w.kind && !WALL_KINDS.includes(w.kind)) push('wall_kind', `A wall has an unknown kind (${w.kind}).`, [w.id]);
    const len = dist(w.a, w.b);
    if (!missing(w.curveM) && (!Number.isFinite(w.curveM) || Math.abs(w.curveM) > len / 2 + TOL)) {
      push('wall_curve', 'A curved wall bulges more than a semicircle. Reduce its curve.', [w.id]);
    }
    const top = w.heightM ?? plan.ceilingHeightM;
    for (const m of w.mirrors ?? []) {
      if (!(m.toM > m.fromM) || m.fromM < -TOL || m.toM > len + TOL) {
        push('mirror_span', 'A mirror runs past the end of its wall.', [w.id]);
      }
      if (!(m.topM > m.bottomM) || m.bottomM < -TOL || (top && m.topM > top + 0.05)) {
        push('mirror_span', 'A mirror’s bottom and top do not fit the wall’s height.', [w.id]);
      }
    }
  }

  for (const o of plan.openings) {
    const wall = plan.walls.find((w) => w.id === o.wallId);
    if (o.kind && !OPENING_KINDS.includes(o.kind)) {
      push('opening_kind', `An opening has an unknown kind (${o.kind}).`, [o.id]);
    }
    if (!missing(o.leaves) && ![1, 2].includes(o.leaves)) push('opening_leaves', 'A door has one or two leaves.', [o.id]);
    if (o.hinge && !HINGE_SIDES.includes(o.hinge)) push('opening_hinge', 'A door hinges on the left or the right.', [o.id]);
    if (o.swingInto && !spaceIds.has(o.swingInto)) {
      push('opening_swing', 'A door swings into a space that is not on the plan.', [o.id]);
    }
    // The opening fits its wall's height as well as its length.
    if (wall && o.heightM && wall.heightM) {
      const head = (o.sillHeightM ?? 0) + o.heightM;
      if (head > wall.heightM + TOL) {
        push(
          'opening_taller_than_wall',
          `A ${o.type} reaches ${head.toFixed(2)} m on a ${wall.heightM} m wall.`,
          [o.id, wall.id],
        );
      }
    }
    // A door joins two spaces, or a space and the outside.
    if (wall && o.type === 'door' && shaped.length >= 2) {
      const len = dist(wall.a, wall.b);
      if (len > 0) {
        const c = lerp(wall.a, wall.b, (o.offset + o.width / 2) / len);
        const [dx, dy] = direction(wall.a, wall.b);
        const left = spaceAt(shaped, [c[0] - dy * DOOR_PROBE_M, c[1] + dx * DOOR_PROBE_M]);
        const right = spaceAt(shaped, [c[0] + dy * DOOR_PROBE_M, c[1] - dx * DOOR_PROBE_M]);
        if (!left && !right) {
          push('door_spaces', 'A door does not open into any space.', [o.id]);
        } else if (left && right && left.id === right.id) {
          push('door_spaces', `A door has ${left.name || 'the same space'} on both sides. Doors join two spaces.`, [o.id]);
        }
      }
    }
  }

  for (const c of plan.columns) {
    if (c.shape && !COLUMN_SHAPES.includes(c.shape)) {
      push('column_shape', `A column has an unknown shape (${c.shape}).`, [c.id]);
    }
    if (outOfRange(c.heightM, [0.1, 20])) push('invalid_dimension', `A column is ${c.heightM} m high.`, [c.id]);
  }

  const shapes = [
    ['beams', BEAM_KINDS, 'A beam or bulkhead'],
    ['levelChanges', LEVEL_CHANGE_KINDS, 'A level change'],
    ['voids', VOID_KINDS, 'A stair, lift or void'],
  ];
  for (const [key, kinds, label] of shapes) {
    for (const e of plan[key] ?? []) {
      if (!isPolygon(e.points)) push(`${key}_shape`, `${label} needs at least three corners.`, [e.id]);
      else if (polygonArea(e.points) < 0.01) push(`${key}_shape`, `${label} has no area.`, [e.id]);
      if (e.kind && !kinds.includes(e.kind)) push(`${key}_kind`, `${label} has an unknown kind (${e.kind}).`, [e.id]);
    }
  }
  for (const b of plan.beams ?? []) {
    if (missing(b.bottomM) || outOfRange(b.bottomM, [1, 15])) {
      push('invalid_dimension', 'Set the height of the underside of a beam or bulkhead.', [b.id]);
    }
  }
  for (const l of plan.levelChanges ?? []) {
    if (missing(l.heightM) || l.heightM === 0 || outOfRange(l.heightM, [-3, 3])) {
      push('invalid_dimension', 'Set how far a step, platform or ramp rises (up to 3 m).', [l.id]);
    }
    if (l.kind === 'ramp' && !missing(l.rampAngleDeg) && !Number.isFinite(l.rampAngleDeg)) {
      push('invalid_dimension', 'A ramp’s direction is not a number.', [l.id]);
    }
  }
  for (const v of plan.voids ?? []) {
    if (outOfRange(v.railHeightM, [0.5, 2])) push('invalid_dimension', `A rail is ${v.railHeightM} m high.`, [v.id]);
  }

  // Machine fields, and machines and columns inside a space.
  const objects = new Map(plan.objects.map((o) => [o.id, o]));
  for (const b of plan.objects) {
    const name = b.equipment?.name ?? b.category ?? 'An object';
    if (!missing(b.facingDeg) && !Number.isFinite(b.facingDeg)) {
      push('invalid_dimension', `${name} has a facing that is not a number.`, [b.id]);
    }
    if (b.sameAs) {
      const other = objects.get(b.sameAs);
      if (!other || other === b || !other.equipment) {
        push('machine_same_as', `${name} is marked the same as a machine that is not on the plan.`, [b.id]);
      }
    }
    if (shaped.length && b.equipment && Number.isFinite(b.x) && !spaceAt(shaped, [b.x, b.y])) {
      push('machine_outside_space', `${name} is not inside any space.`, [b.id]);
    }
  }
  if (shaped.length) {
    for (const c of plan.columns) {
      const p = [c.x, c.y];
      if (Number.isFinite(c.x) && !spaceAt(shaped, p) && !shaped.some((s) => nearEdge(p, s.points))) {
        push('column_outside_space', 'A column is not inside any space.', [c.id]);
      }
    }
  }
}
