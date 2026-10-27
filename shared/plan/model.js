/**
 * The internal plan format (PRD section 4): what plan reading produces, the
 * reviewer edits, approval freezes and 3D generation raises. Every length is
 * in metres on the floor plane; `[x, y]` is the scan's (x, z).
 *
 * {
 *   format: 'gymplan/3',
 *   units: 'm',                                                  // always metres internally
 *   scale: { source: 'scan' }                                    // LiDAR, 1:1
 *        | { source: 'line', a, b, lengthM, metresPerPixel }     // a scaled drawing
 *        | { source: 'drawn' },                                  // traced in metres
 *     (a, b, lengthM record the last correction on any source, REV-04)
 *   underlay: { fileId, widthPx, heightPx, metresPerPixel } | null,
 *   ceilingHeightM,
 *   room:     { widthM, lengthM, areaM2, perimeterM, min, max, elevationM } | null,
 *   spaces:   [{ id, name, kind, points, floorFinish, ceilingHeightM,
 *                ceilingZones: [{ id, points, heightM }] }],               // v3
 *   walls:    [{ id, a, b, confidence, mirror,
 *                lengthM, angleDeg, thicknessM, heightM, source,
 *                kind, curveM, mirrors: [{ id, fromM, toM, bottomM, topM }] }],
 *   openings: [{ id, wallId, type: 'door'|'window'|'opening', offset, width, confidence,
 *                heightM, sillHeightM, angleDeg, swing, source,
 *                kind, leaves, hinge, swingInto }],
 *   columns:  [{ id, x, y, w, d, angle, shape, heightM }],
 *   beams:    [{ id, kind: 'beam'|'bulkhead', points, bottomM }],            // v3
 *   levelChanges: [{ id, kind: 'step'|'platform'|'ramp', points, heightM, rampAngleDeg }], // v3
 *   voids:    [{ id, kind: 'stair'|'lift'|'void', points, railHeightM }],     // v3
 *   objects:  [{ id, x, y, w, d, angle, heightM, category, confidence,
 *                elevationM, equipment, source, facingDeg, modelRef, sameAs }],
 *   zones:    [{ id, points }],                                   // no-build
 *   tags:     [{ id, type, x, y, heightM }],
 *   flags:    [{ id, kind, elementId, title, detail, status: 'open'|'resolved', resolution }],
 * }
 *
 * Version 2 adds measurements (CHANGE 1) and equipment (CHANGE 2). Version 3
 * adds what the 3D generator needs (task plan G-02..G-06, sheet "2D plan for
 * 3D"): named spaces with floor finish and ceilings, wall kinds, curves and
 * mirror spans, opening kinds and hinges, column shape and height, beams,
 * level changes, stairs and lifts, and each machine's facing and model.
 * Every new field is additive and nullable, so a `gymplan/1` or `gymplan/2`
 * plan stays readable and an approved one keeps the content hash it was
 * frozen with: nothing rewrites a plan that has already been approved. Use
 * `upgradePlan` to fill the new fields on a plan that is still being edited.
 *
 * `room`, `lengthM`, `angleDeg` and object bounding boxes are *derived* from
 * the geometry, never an independent source of truth. They are recomputed by
 * `withMeasurements` so they can never drift from the points they describe.
 */
import { arcLength, direction, dist, lerp, polygonArea, project, rectCorners } from './geometry.js';

export const FORMAT = 'gymplan/3';
/** The first format. Still read, never written. */
export const FORMAT_V1 = 'gymplan/1';
/** Measurements and equipment (CHANGE 1, 2). Still read, never written. */
export const FORMAT_V2 = 'gymplan/2';
export const SUPPORTED_FORMATS = [FORMAT_V1, FORMAT_V2, FORMAT];
export const OPENING_TYPES = ['door', 'window', 'opening'];

/* Format v3 vocabularies (G-02..G-06). */
export const SPACE_KINDS = ['gym_floor', 'studio', 'changing', 'reception', 'office', 'corridor', 'storage', 'other'];
export const FLOOR_FINISHES = ['rubber', 'timber', 'turf', 'carpet', 'tile', 'concrete'];
export const WALL_KINDS = ['exterior', 'interior', 'partition', 'glass'];
export const OPENING_KINDS = [
  'single_door',
  'double_door',
  'sliding_door',
  'roller_shutter',
  'window',
  'fixed_glazing',
  'opening',
];
export const COLUMN_SHAPES = ['rect', 'round'];
export const BEAM_KINDS = ['beam', 'bulkhead'];
export const LEVEL_CHANGE_KINDS = ['step', 'platform', 'ramp'];
export const VOID_KINDS = ['stair', 'lift', 'void'];
export const HINGE_SIDES = ['left', 'right'];

/**
 * The older three-way `type` an opening kind belongs to. `type` is kept on
 * every opening so code written for format 2 (and the viewer) keeps working.
 */
export function openingTypeOf(kind) {
  if (kind === 'window' || kind === 'fixed_glazing') return 'window';
  if (kind === 'opening' || !kind) return 'opening';
  return 'door';
}

/** The kind an opening of a format 2 `type` most likely is, before anyone checks. */
export function defaultOpeningKind(type, widthM = null) {
  if (type === 'window') return 'window';
  if (type === 'door') return widthM && widthM >= 1.5 ? 'double_door' : 'single_door';
  return 'opening';
}
export const TAG_TYPES = ['ceiling', 'fireExit', 'mirror', 'power', 'stair'];
export const DEFAULT_CEILING_M = 3;
export const DEFAULT_OBJECT_HEIGHT_M = 1.2;
/** Elements read below this confidence are flagged for the reviewer (RDR-02). */
export const FLAG_THRESHOLD = 0.6;
/** Endpoints closer than this count as joined. */
export const JOIN_TOLERANCE_M = 0.05;

/**
 * Where a measurement came from, so the reviewer can tell a scanned value
 * from one that was typed in (CHANGE 1: "source/provenance information").
 *
 * - `roomplan`  measured by the LiDAR scan
 * - `mesh`      found in the LiDAR mesh where RoomPlan saw nothing (F-06)
 * - `drawing`   traced off an uploaded floor plan
 * - `surveyor`  marked by hand on the phone during the capture, which is
 *               how a gym machine gets named: RoomPlan cannot name one
 * - `reviewer`  corrected in the editor
 * - `derived`   worked out from other geometry
 */
export const SOURCES = ['roomplan', 'mesh', 'drawing', 'surveyor', 'reviewer', 'derived'];

/**
 * Lengths are kept to the micrometre. LiDAR is nowhere near that accurate,
 * but rounding is for making serialisation deterministic (REV-07), not for
 * pretending to a precision: the raw measurement survives untouched. Display
 * rounding belongs in the UI, and feet/inches conversion only at display.
 */
export const PRECISION_M = 1e-6;

/** Deterministic rounding that keeps exact decimals exact (3.18 stays 3.18). */
export function roundM(n) {
  return Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : n;
}

/**
 * The equipment catalogue is a starting point, not a closed set: `type` may
 * be any string, so a gym can name machines this list has never heard of
 * (CHANGE 2.1: "extensible rather than hardcoded"). RoomPlan itself cannot
 * recognise gym machines — its categories stop at furniture — so these are
 * assigned by the surveyor or the reviewer.
 */
export const EQUIPMENT_TYPES = [
  'treadmill',
  'legPress',
  'chestPress',
  'latPulldown',
  'cableMachine',
  'exerciseBike',
  'elliptical',
  'squatRack',
  'bench',
  'dumbbellRack',
  'smithMachine',
  'rowingMachine',
];

/** A human label for an equipment type, including one not in the catalogue. */
export function equipmentLabel(type) {
  if (!type) return 'Equipment';
  const spaced = String(type).replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

let counter = 0;

/** A short id, unique within a plan. */
export function newElementId(prefix) {
  counter = (counter + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

export function emptyPlan(overrides = {}) {
  return {
    format: FORMAT,
    units: 'm',
    scale: { source: 'scan' },
    underlay: null,
    ceilingHeightM: DEFAULT_CEILING_M,
    room: null,
    spaces: [],
    walls: [],
    openings: [],
    columns: [],
    beams: [],
    levelChanges: [],
    voids: [],
    objects: [],
    zones: [],
    tags: [],
    flags: [],
    ...overrides,
  };
}

/** A deep copy that is safe to edit. */
export function clonePlan(plan) {
  return JSON.parse(JSON.stringify(plan));
}

/** The stretch of wall an opening occupies, as a segment. */
export function openingSegment(plan, opening) {
  const wall = plan.walls.find((w) => w.id === opening.wallId);
  if (!wall) return null;
  const len = dist(wall.a, wall.b);
  if (len <= 0) return null;
  const t0 = opening.offset / len;
  const t1 = (opening.offset + opening.width) / len;
  return { a: lerp(wall.a, wall.b, t0), b: lerp(wall.a, wall.b, t1), wall };
}

/**
 * The wall a point sits on, within `tolerance`, and where along it: used to
 * attach openings and to find T-junctions.
 */
export function nearestWall(plan, p, tolerance = Infinity) {
  let best = null;
  for (const wall of plan.walls) {
    const hit = project(p, wall.a, wall.b);
    if (hit.distance <= tolerance && (!best || hit.distance < best.distance)) {
      best = { wall, ...hit, along: hit.t * dist(wall.a, wall.b) };
    }
  }
  return best;
}

/** JSON with keys sorted, so equal plans always serialise the same (REV-07). */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/* -------------------------------------------------------------------------
 * Outline: the faces of the wall graph. The largest face is the floor.
 * Walls are split where another wall's end meets them (a T-junction), then
 * faces are traced by always taking the next edge clockwise.
 * ---------------------------------------------------------------------- */

function key(p) {
  return `${Math.round(p[0] / JOIN_TOLERANCE_M)},${Math.round(p[1] / JOIN_TOLERANCE_M)}`;
}

function graphOf(plan) {
  const nodes = new Map();
  const nodeFor = (p) => {
    const k = key(p);
    if (!nodes.has(k)) nodes.set(k, { k, p, out: [] });
    return nodes.get(k);
  };

  const ends = plan.walls.flatMap((w) => [w.a, w.b]);
  for (const wall of plan.walls) {
    const len = dist(wall.a, wall.b);
    if (len < JOIN_TOLERANCE_M) continue;
    const cuts = [0, 1];
    for (const e of ends) {
      const hit = project(e, wall.a, wall.b);
      if (hit.distance < JOIN_TOLERANCE_M && hit.t > 1e-6 && hit.t < 1 - 1e-6) cuts.push(hit.t);
    }
    cuts.sort((x, y) => x - y);
    for (let i = 0; i < cuts.length - 1; i++) {
      if ((cuts[i + 1] - cuts[i]) * len < JOIN_TOLERANCE_M) continue;
      const u = nodeFor(lerp(wall.a, wall.b, cuts[i]));
      const v = nodeFor(lerp(wall.a, wall.b, cuts[i + 1]));
      if (u === v) continue;
      u.out.push(v);
      v.out.push(u);
    }
  }
  return nodes;
}

/** Every closed face of the wall graph, largest first, as point lists. */
export function faces(plan) {
  const nodes = graphOf(plan);
  const angle = (from, to) => Math.atan2(to.p[1] - from.p[1], to.p[0] - from.p[0]);
  for (const n of nodes.values()) n.out.sort((x, y) => angle(n, x) - angle(n, y));

  const used = new Set();
  const found = [];
  for (const start of nodes.values()) {
    for (const first of start.out) {
      if (used.has(`${start.k}>${first.k}`)) continue;
      const loop = [];
      let from = start;
      let to = first;
      for (let guard = 0; guard < 10000; guard++) {
        const edge = `${from.k}>${to.k}`;
        if (used.has(edge)) break;
        used.add(edge);
        loop.push(from.p);
        // Next edge: the one just clockwise of the way back.
        const back = to.out.indexOf(from);
        const next = to.out[(back - 1 + to.out.length) % to.out.length];
        from = to;
        to = next;
        if (from === start && to === first) break;
      }
      if (loop.length >= 3) found.push(loop);
    }
  }
  return found
    .map((points) => ({ points, area: polygonArea(points) }))
    .filter((f) => f.area > 0.01)
    .sort((x, y) => y.area - x.area);
}

/** The floor outline: the largest face, or null if the walls do not close. */
export function outline(plan) {
  const all = faces(plan);
  if (!all.length) return null;
  // The unbounded outer face traces the same loop as the floor; both have
  // the largest area, so either is the outline.
  return all[0].points;
}

/* -------------------------------------------------------------------------
 * Measurements (CHANGE 1). All of these are derived from the geometry, so
 * they are recomputed rather than stored independently: a stored copy could
 * disagree with the points it describes after the reviewer drags something.
 * ---------------------------------------------------------------------- */

/** A wall's length in metres, along its arc when it is curved. */
export function wallLength(wall) {
  return roundM(arcLength(wall.a, wall.b, wall.curveM));
}

/**
 * A wall's bearing in degrees, 0–360 anticlockwise from the +x axis. A wall
 * and the same wall drawn backwards differ by 180°, which is what lets the
 * reviewer see that two walls are parallel.
 */
export function wallAngleDeg(wall) {
  const deg = (Math.atan2(wall.b[1] - wall.a[1], wall.b[0] - wall.a[0]) * 180) / Math.PI;
  return roundM((deg + 360) % 360);
}

/**
 * An object's footprint: its four rotated corners and the axis-aligned box
 * around them (CHANGE 1.5 "boundingBox"). Derived, never stored, so it
 * cannot drift from the object's position and rotation.
 */
export function objectBounds(object) {
  const corners = rectCorners(object);
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  const min = [roundM(Math.min(...xs)), roundM(Math.min(...ys))];
  const max = [roundM(Math.max(...xs)), roundM(Math.max(...ys))];
  return {
    corners: corners.map((p) => [roundM(p[0]), roundM(p[1])]),
    min,
    max,
    widthM: roundM(max[0] - min[0]),
    depthM: roundM(max[1] - min[1]),
  };
}

/** The length of a closed ring of points. */
function ringLength(points) {
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    total += dist(points[i], points[(i + 1) % points.length]);
  }
  return total;
}

/**
 * Overall room measurements from the floor outline: width and length are the
 * axis-aligned extent, area the true polygon area, perimeter the wall run.
 * Null when the walls do not close, because none of it means anything then.
 */
export function roomMetrics(plan, { elevationM = null } = {}) {
  const floor = outline(plan);
  if (!floor || floor.length < 3) return null;
  const xs = floor.map((p) => p[0]);
  const ys = floor.map((p) => p[1]);
  const min = [roundM(Math.min(...xs)), roundM(Math.min(...ys))];
  const max = [roundM(Math.max(...xs)), roundM(Math.max(...ys))];
  return {
    widthM: roundM(max[0] - min[0]),
    lengthM: roundM(max[1] - min[1]),
    areaM2: roundM(polygonArea(floor)),
    perimeterM: roundM(ringLength(floor)),
    min,
    max,
    elevationM: elevationM === null ? null : roundM(elevationM),
  };
}

/**
 * Refreshes every derived measurement on `plan`, in place, and returns it.
 * Called after reading and after any edit that moves geometry, so wall
 * lengths, bearings and the room box always describe the current points.
 */
export function withMeasurements(plan, { elevationM } = {}) {
  for (const wall of plan.walls) {
    wall.lengthM = wallLength(wall);
    wall.angleDeg = wallAngleDeg(wall);
  }
  const keep = elevationM === undefined ? (plan.room?.elevationM ?? null) : elevationM;
  plan.room = roomMetrics(plan, { elevationM: keep });
  return plan;
}

/**
 * An older plan (`gymplan/1` or `gymplan/2`) with every format 3 field
 * present, so the editor and the viewer can treat every plan the same way
 * (G-08). Measurements the scan never recorded stay null rather than being
 * invented; the reviewer fills them.
 *
 * Where a value has to be assumed to make the plan usable — the whole floor
 * as one space, a door as a single door, a mirror wall mirrored over its full
 * length, a column as rectangular — it is filled in and a `default_filled`
 * flag says so, one per kind of default, for the reviewer to confirm. Pass
 * `{ flagDefaults: false }` to fill without flagging.
 *
 * This returns a copy. An approved plan must never be upgraded in place:
 * its content hash was taken over the bytes it was frozen with.
 */
export function upgradePlan(plan, { flagDefaults = true } = {}) {
  const next = clonePlan(plan);
  const defaults = new Map();
  const filled = (kind, id) => {
    if (!defaults.has(kind)) defaults.set(kind, []);
    defaults.get(kind).push(id);
  };

  next.format = FORMAT;
  next.units = next.units ?? 'm';
  for (const key of PLAN_LISTS) {
    next[key] = Array.isArray(next[key]) ? next[key] : [];
  }

  for (const wall of next.walls) {
    wall.thicknessM = wall.thicknessM ?? null;
    wall.heightM = wall.heightM ?? null;
    wall.source = wall.source ?? 'derived';
    wall.kind = wall.kind ?? null;
    wall.curveM = wall.curveM ?? null;
    if (!Array.isArray(wall.mirrors)) {
      wall.mirrors = [];
      if (wall.mirror) {
        wall.mirrors.push({
          id: newElementId('m'),
          fromM: 0,
          toM: roundM(dist(wall.a, wall.b)),
          bottomM: 0,
          topM: roundM(wall.heightM ?? next.ceilingHeightM ?? DEFAULT_CEILING_M),
        });
        filled('mirror_span', wall.id);
      }
    }
    wall.mirror = wall.mirrors.length > 0;
  }
  for (const opening of next.openings) {
    opening.heightM = opening.heightM ?? null;
    opening.sillHeightM = opening.sillHeightM ?? null;
    opening.angleDeg = opening.angleDeg ?? null;
    opening.swing = opening.swing ?? null;
    opening.source = opening.source ?? 'derived';
    if (!opening.kind) {
      opening.kind = defaultOpeningKind(opening.type, opening.width);
      if (opening.type === 'door') filled('opening_kind', opening.id);
    }
    opening.type = openingTypeOf(opening.kind);
    opening.leaves =
      opening.leaves ?? (opening.kind === 'double_door' ? 2 : opening.type === 'door' ? 1 : null);
    opening.hinge =
      opening.hinge ?? (opening.swing === 'left' || opening.swing === 'right' ? opening.swing : null);
    opening.swingInto = opening.swingInto ?? null;
  }
  for (const column of next.columns) {
    if (!column.shape) {
      column.shape = 'rect';
      filled('column_shape', column.id);
    }
    column.heightM = column.heightM ?? null;
  }
  for (const object of next.objects) {
    object.category = object.category ?? 'object';
    object.elevationM = object.elevationM ?? null;
    object.equipment = object.equipment ?? null;
    object.source = object.source ?? 'derived';
    object.facingDeg = object.facingDeg ?? null;
    object.modelRef = object.modelRef ?? null;
    object.sameAs = object.sameAs ?? null;
  }

  withMeasurements(next);

  if (!next.spaces.length) {
    const space = spaceFromOutline(next);
    if (space) {
      next.spaces.push(space);
      filled('space', space.id);
    }
  }

  if (flagDefaults) {
    for (const [kind, ids] of defaults) {
      const [title, detail] = DEFAULT_TEXT[kind];
      next.flags.push({
        id: newElementId('f'),
        kind: 'default_filled',
        elementId: ids.length === 1 ? ids[0] : null,
        title,
        detail: kind === 'space' ? detail : `${ids.length} ${detail}`,
        status: 'open',
      });
    }
  }
  return next;
}

/** Every list a plan carries, in format 3. */
export const PLAN_LISTS = [
  'spaces',
  'walls',
  'openings',
  'columns',
  'beams',
  'levelChanges',
  'voids',
  'objects',
  'zones',
  'tags',
  'flags',
];

const DEFAULT_TEXT = {
  space: [
    'Floor drawn as one space',
    'The whole floor was made one space. Split it into rooms and set each one’s kind and floor finish.',
  ],
  opening_kind: [
    'Door kinds assumed',
    'doors were set to single or double by their width. Check each one, and set its hinge side.',
  ],
  mirror_span: [
    'Mirror spans assumed',
    'mirror walls were mirrored over their whole length and height. Trim the spans to the real mirrors.',
  ],
  column_shape: [
    'Column shapes assumed',
    'columns were taken as rectangular and full height. Correct any round or part-height column.',
  ],
};

/** The whole floor outline as one space, or null when the walls do not close. */
export function spaceFromOutline(plan, { name = 'Gym floor', kind = 'gym_floor' } = {}) {
  const floor = outline(plan);
  if (!floor) return null;
  return {
    id: newElementId('s'),
    name,
    kind,
    points: floor.map((p) => [roundM(p[0]), roundM(p[1])]),
    floorFinish: null,
    ceilingHeightM: plan.ceilingHeightM ?? null,
    ceilingZones: [],
  };
}

/** Counts and facts the editor and approval screen show. */
export function summary(plan) {
  const floor = outline(plan);
  const ceilingTag = plan.tags.find((t) => t.type === 'ceiling' && t.heightM);
  return {
    spaces: plan.spaces?.length ?? 0,
    walls: plan.walls.length,
    openings: plan.openings.length,
    columns: plan.columns.length,
    objects: plan.objects.length,
    zones: plan.zones.length,
    tags: plan.tags.length,
    areaM2: floor ? Math.round(polygonArea(floor) * 10) / 10 : null,
    // Room measurements (CHANGE 1.1). Computed here rather than read from
    // `plan.room`, so a version 1 plan reports them too.
    widthM: floor ? roundM(Math.max(...floor.map((p) => p[0])) - Math.min(...floor.map((p) => p[0]))) : null,
    lengthM: floor ? roundM(Math.max(...floor.map((p) => p[1])) - Math.min(...floor.map((p) => p[1]))) : null,
    perimeterM: floor ? roundM(ringLength(floor)) : null,
    equipment: plan.objects.filter((o) => o.equipment).length,
    ceilingHeightM: plan.ceilingHeightM,
    ceilingFromTag: Boolean(ceilingTag),
    scale:
      plan.scale?.lengthM > 0
        ? `Set from a ${plan.scale.lengthM} m line`
        : plan.scale?.source === 'scan'
          ? 'From scan · 1:1'
          : plan.scale?.source === 'drawn'
            ? 'Drawn in metres'
            : 'Not set',
    openFlags: plan.flags.filter((f) => f.status === 'open').length,
  };
}

/** A compass name for a wall, from where it sits in the plan. */
export function wallName(plan, wall) {
  const xs = plan.walls.flatMap((w) => [w.a[0], w.b[0]]);
  const ys = plan.walls.flatMap((w) => [w.a[1], w.b[1]]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const [dx, dy] = direction(wall.a, wall.b);
  const m = lerp(wall.a, wall.b, 0.5);
  // y grows downwards on the plan, so smaller y is north.
  if (Math.abs(dx) >= Math.abs(dy)) return m[1] <= cy ? 'North wall' : 'South wall';
  return m[0] >= cx ? 'East wall' : 'West wall';
}
