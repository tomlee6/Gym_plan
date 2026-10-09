/**
 * Plan reading (PRD section 6): turns an input into the internal plan
 * format, with a confidence per element and flags for anything the reviewer
 * must confirm (RDR-02).
 *
 * - A LiDAR scan: the scan.json the app uploads, projected onto the floor as
 *   (x, z), as RoomScanner.swift does. Either one RoomPlan CapturedRoom, or
 *   (scan reader v2, F-05) an iOS 17 CapturedStructure: several rooms or
 *   sections merged by StructureBuilder, with every surface carrying its
 *   `identifier` and openings their `parentIdentifier` wall. Tags from the
 *   app are carried through as typed markers (RDR-03), and laser-measured
 *   control distances correct the scale (F-03).
 * - An uploaded drawing: an empty plan scaled from the owner's line, with
 *   the drawing underneath for the reviewer to trace (the PRD's fallback:
 *   "every plan is completable by hand").
 */
import { dist, mid, polygonArea, project } from './geometry.js';
import { objectsFromMesh, overlapsExisting } from './mesh.js';
import {
  DEFAULT_CEILING_M,
  DEFAULT_OBJECT_HEIGHT_M,
  defaultOpeningKind,
  emptyPlan,
  FLAG_THRESHOLD,
  newElementId,
  openingTypeOf,
  outline,
  roundM,
  spaceFromOutline,
  TAG_TYPES,
  wallName,
  withMeasurements,
} from './model.js';

/**
 * A control distance may correct the scan's scale by at most this share.
 * Beyond it the laser and the scan disagree too much for the cause to be
 * scale drift — a mis-tapped end is likelier — so nothing is changed and
 * the reviewer is told.
 */
export const MAX_SCALE_CORRECTION = 0.05;

/** Ends closer than this are one corner the scan did not quite meet. */
const SNAP_M = 0.15;
/** An opening this close to a wall's line belongs to that wall. */
const ATTACH_M = 0.3;
const CONFIDENCE = { high: 0.95, medium: 0.7, low: 0.4 };
/**
 * How far a marked machine may be from a scanned object and still be that
 * object. Widened to the object's own footprint, so a mark anywhere on a
 * long machine still finds it (CHANGE 2.1).
 */
const EQUIPMENT_SNAP_M = 0.6;
/** A machine marked without a size: a placeholder for the reviewer to fix. */
const DEFAULT_EQUIPMENT_SIDE_M = 1;

/** A simd_float4x4 as four columns of four, from a flat or nested encoding. */
function columns(transform) {
  if (!Array.isArray(transform)) return null;
  const flat = transform.flat(2).map(Number);
  if (flat.length !== 16 || flat.some((n) => !Number.isFinite(n))) return null;
  return [0, 1, 2, 3].map((c) => flat.slice(c * 4, c * 4 + 4));
}

function dims(d) {
  if (!Array.isArray(d) || d.length < 3) return null;
  const v = d.map(Number);
  return v.every(Number.isFinite) ? v : null;
}

/** Swift enums with associated values encode as `{"case": {...}}`. */
function enumName(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return Object.keys(value)[0] ?? null;
  return null;
}

function confidenceOf(surface) {
  return CONFIDENCE[enumName(surface?.confidence)] ?? CONFIDENCE.low;
}

/**
 * A RoomPlan surface as a floor segment, keeping every measurement the scan
 * actually recorded (CHANGE 1: "Use the original RoomPlan coordinates and
 * transforms as the source of truth").
 *
 * `dimensions` is (width, height, depth) in the surface's own frame. RoomPlan
 * reports a surface as a plane, so `depth` is usually 0 and the wall has no
 * measured thickness: that is reported as null rather than guessed at.
 *
 * - `baseM` is the bottom of the surface, from its centre height less half
 *   its height. For a window that is the sill; for a wall, the floor.
 */
function segment(surface) {
  const t = columns(surface?.transform);
  const d = dims(surface?.dimensions);
  if (!t || !d) return null;
  const [x, , , c] = t;
  const h = d[0] / 2;
  const thickness = d[2] > 0.005 ? d[2] : null;
  return {
    a: [c[0] - x[0] * h, c[2] - x[2] * h],
    b: [c[0] + x[0] * h, c[2] + x[2] * h],
    width: d[0],
    height: d[1],
    thickness,
    centreM: c[1],
    baseM: c[1] - d[1] / 2,
    // Bearing of the surface on the floor plane, 0–360° from the +x axis.
    angleDeg: ((Math.atan2(x[2], x[0]) * 180) / Math.PI + 360) % 360,
  };
}

function box(object) {
  const t = columns(object?.transform);
  const d = dims(object?.dimensions);
  if (!t || !d) return null;
  const [x, , , c] = t;
  return {
    x: c[0],
    y: c[2],
    w: d[0],
    d: d[2],
    heightM: d[1],
    angle: Math.atan2(x[2], x[0]),
    // How far the object's underside sits above the scan's origin plane.
    elevationM: c[1] - d[1] / 2,
  };
}

/**
 * Rounding is to the micrometre so serialisation is deterministic without
 * discarding anything the scan measured (CHANGE 1.2: "Avoid unnecessary
 * rounding during processing").
 */
const round = roundM;
const roundPoint = (p) => [round(p[0]), round(p[1])];

/** The floor's height, from RoomPlan's floor surfaces when it found any. */
function floorElevation(room) {
  const levels = list(room?.floors)
    .map((f) => columns(f?.transform)?.[3]?.[1])
    .filter((n) => Number.isFinite(n));
  return levels.length ? Math.min(...levels) : null;
}

/** Joins wall ends that nearly meet into one corner. */
function snapEnds(walls) {
  const ends = walls.flatMap((w) => [
    { w, k: 'a' },
    { w, k: 'b' },
  ]);
  const done = new Set();
  for (let i = 0; i < ends.length; i++) {
    if (done.has(i)) continue;
    const group = [i];
    for (let j = i + 1; j < ends.length; j++) {
      if (!done.has(j) && ends[j].w !== ends[i].w && dist(ends[i].w[ends[i].k], ends[j].w[ends[j].k]) < SNAP_M) {
        group.push(j);
      }
    }
    if (group.length < 2) continue;
    const pts = group.map((g) => ends[g].w[ends[g].k]);
    const c = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
    for (const g of group) {
      ends[g].w[ends[g].k] = c;
      done.add(g);
    }
  }
}

function list(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

/**
 * The surfaces of a scan, whichever way it was captured. A CapturedStructure
 * (iOS 17) has the merged walls, doors, windows, openings, objects and
 * floors at its top level, like a CapturedRoom; one that only carries its
 * `rooms` is merged here, room by room, keeping every surface once.
 */
function surfacesOf(scan) {
  const keys = ['walls', 'doors', 'windows', 'openings', 'objects', 'floors'];
  const out = Object.fromEntries(keys.map((k) => [k, list(scan?.[k])]));
  const merged = !keys.some((k) => out[k].length) && list(scan?.rooms).length > 0;
  if (merged) {
    const seen = new Set();
    for (const room of list(scan.rooms)) {
      for (const k of keys) {
        for (const s of list(room[k])) {
          const id = identifierOf(s);
          if (id && seen.has(id)) continue;
          if (id) seen.add(id);
          out[k].push(s);
        }
      }
    }
  }
  return out;
}

/** RoomPlan's UUID for a surface, as Codable writes it. */
function identifierOf(surface) {
  const id = surface?.identifier;
  return typeof id === 'string' ? id.toUpperCase() : null;
}

/** A local point through a surface's transform, onto the floor plane. */
function toFloor(cols, p) {
  const [x, y, z] = [Number(p[0]), Number(p[1]), Number(p[2] ?? 0)];
  if (![x, y, z].every(Number.isFinite)) return null;
  const wx = cols[0][0] * x + cols[1][0] * y + cols[2][0] * z + cols[3][0];
  const wz = cols[0][2] * x + cols[1][2] * y + cols[2][2] * z + cols[3][2];
  return [round(wx), round(wz)];
}

/**
 * The outline of a floor surface (iOS 17 `polygonCorners`), on the floor
 * plane, or null when the scan has none.
 */
function floorPolygon(floor) {
  const t = columns(floor?.transform);
  const corners = list(floor?.polygonCorners);
  if (!t || corners.length < 3) return null;
  const points = corners.map((c) => toFloor(t, Array.isArray(c) ? c : [c.x, c.y, c.z]));
  if (points.some((p) => !p) || polygonArea(points) < 0.5) return null;
  return points;
}

/** An angle as RoomPlan's Codable Measurement writes it, in radians. */
function radians(m) {
  if (Number.isFinite(m)) return m;
  const value = Number(m?.value);
  if (!Number.isFinite(value)) return null;
  const symbol = m?.unit?.symbol ?? m?.unit;
  return symbol === '°' || symbol === 'deg' ? (value * Math.PI) / 180 : value;
}

/**
 * The sagitta of a curved wall (iOS 17 `curve`: start and end angle and a
 * radius), or null for a straight one. RoomPlan does not say which side the
 * wall bulges to, so it is taken as bulging away from the scan's origin,
 * which is outwards for a room scanned from inside.
 */
function curveOf(surface, s) {
  const c = surface?.curve;
  const r = Number(c?.radius);
  const a0 = radians(c?.startAngle);
  const a1 = radians(c?.endAngle);
  if (!Number.isFinite(r) || r <= 0 || a0 === null || a1 === null) return null;
  const theta = Math.abs(a1 - a0);
  if (theta < 1e-3) return null;
  const sagitta = r * (1 - Math.cos(theta / 2));
  const m = mid(s.a, s.b);
  const left = [-(s.b[1] - s.a[1]), s.b[0] - s.a[0]];
  // Bulge left of a→b if that side is the far side from the origin.
  const away = left[0] * m[0] + left[1] * m[1] >= 0 ? 1 : -1;
  return round(sagitta * away);
}

/**
 * The plan for a LiDAR scan. `room` is the parsed scan.json (may be null
 * for a simulated scan) and `capture` the metadata the app registered.
 */
export function planFromScan(scan, capture = {}) {
  const plan = emptyPlan({ scale: { source: 'scan' } });
  const room = surfacesOf(scan);

  const floorM = floorElevation(room);

  let tallest = 0;
  /** RoomPlan's wall identifiers, so an opening can find its parent wall. */
  const wallByIdentifier = new Map();
  for (const surface of list(room?.walls)) {
    const s = segment(surface);
    if (!s || s.width < 0.05) continue;
    tallest = Math.max(tallest, s.height);
    const wall = {
      id: newElementId('w'),
      a: s.a,
      b: s.b,
      confidence: confidenceOf(surface),
      mirror: false,
      // Measured by the scan (CHANGE 1.2). `thicknessM` is null unless
      // RoomPlan gave the wall a depth, which it usually does not.
      heightM: round(s.height),
      thicknessM: s.thickness === null ? null : round(s.thickness),
      source: 'roomplan',
      // Format 3: RoomPlan cannot tell an exterior wall from a partition,
      // so the kind is the reviewer's to set.
      kind: null,
      curveM: curveOf(surface, s),
      mirrors: [],
    };
    plan.walls.push(wall);
    const ident = identifierOf(surface);
    if (ident) wallByIdentifier.set(ident, wall);
  }
  snapEnds(plan.walls);
  for (const w of plan.walls) {
    w.a = roundPoint(w.a);
    w.b = roundPoint(w.b);
  }

  const openings = [
    ...list(room?.doors).map((s) => ['door', s]),
    ...list(room?.windows).map((s) => ['window', s]),
    ...list(room?.openings).map((s) => ['opening', s]),
  ];
  for (const [type, surface] of openings) {
    const s = segment(surface);
    if (!s) continue;
    const centre = mid(s.a, s.b);
    let best = null;
    // iOS 17 names the wall an opening is cut into; trust that over distance.
    const parent = wallByIdentifier.get(
      typeof surface.parentIdentifier === 'string' ? surface.parentIdentifier.toUpperCase() : '',
    );
    if (parent) {
      best = { wall: parent, hit: project(centre, parent.a, parent.b) };
    } else {
      for (const wall of plan.walls) {
        const hit = project(centre, wall.a, wall.b);
        if (hit.distance <= ATTACH_M && (!best || hit.distance < best.hit.distance)) best = { wall, hit };
      }
    }
    const confidence = confidenceOf(surface);
    const id = newElementId('o');
    /*
     * Height, and the sill for a window, come straight from the surface
     * (CHANGE 1.3, 1.4). The sill is measured from the floor when RoomPlan
     * found one, otherwise from the scan's origin plane.
     *
     * RoomPlan does not report which way a door swings, so `swing` is null
     * for the reviewer to set rather than a guess that would look measured.
     */
    const kind = defaultOpeningKind(type, s.width);
    const measured = {
      heightM: round(s.height),
      sillHeightM: type === 'window' ? round(s.baseM - (floorM ?? 0)) : null,
      angleDeg: round(s.angleDeg),
      swing: null,
      source: 'roomplan',
      // Format 3. RoomPlan knows door from window but not single from
      // double or sliding, nor the hinge: a door's kind is a guess by width
      // and its "type unclear" flag asks the reviewer to confirm it.
      kind,
      leaves: openingTypeOf(kind) === 'door' ? (kind === 'double_door' ? 2 : 1) : null,
      hinge: null,
      swingInto: null,
    };
    if (!best) {
      plan.flags.push({
        id: newElementId('f'),
        kind: 'opening_unattached',
        elementId: id,
        title: `${type[0].toUpperCase()}${type.slice(1)} not on a wall`,
        detail: `A ${s.width.toFixed(2)} m ${type} is not within ${ATTACH_M} m of any wall.`,
        status: 'open',
      });
      plan.openings.push({ id, wallId: null, type, offset: 0, width: round(s.width), confidence, ...measured });
      continue;
    }
    const len = dist(best.wall.a, best.wall.b);
    const along = best.hit.t * len;
    const width = Math.min(s.width, len);
    const offset = Math.max(0, Math.min(len - width, along - width / 2));
    plan.openings.push({
      id,
      wallId: best.wall.id,
      type,
      offset: round(offset),
      width: round(width),
      confidence,
      ...measured,
    });
  }

  /*
   * Every object RoomPlan recognised is kept (CHANGE 1.5), in the same
   * coordinate frame as the walls, so a machine sits where it was scanned.
   *
   * `category` is RoomPlan's own — storage, table, chair and so on. It has
   * no gym machine categories at all, so `equipment` starts null and is
   * filled by the surveyor or the reviewer (CHANGE 2.1).
   */
  for (const object of list(room?.objects)) {
    const b = box(object);
    if (!b) continue;
    plan.objects.push({
      id: newElementId('b'),
      x: round(b.x),
      y: round(b.y),
      w: round(b.w),
      d: round(b.d),
      angle: round(b.angle),
      heightM: round(b.heightM > 0.1 ? b.heightM : DEFAULT_OBJECT_HEIGHT_M),
      category: enumName(object.category) ?? 'object',
      confidence: confidenceOf(object),
      elevationM: round(b.elevationM - (floorM ?? 0)),
      equipment: null,
      source: 'roomplan',
      // Format 3: which way a machine faces is set by the reviewer.
      facingDeg: null,
      modelRef: null,
      sameAs: null,
    });
  }

  /*
   * Floor-standing things RoomPlan did not report, from the LiDAR mesh
   * (F-06). Read before the surveyor's marks are matched, so a machine
   * marked on one of these keeps the mesh's measured footprint.
   */
  if (Array.isArray(capture.meshVertices) && capture.meshVertices.length) {
    const boxes = objectsFromMesh(capture.meshVertices, {
      walls: plan.walls,
      outline: plan.walls.length >= 3 ? outline(plan) : null,
      floorY: floorM,
    });
    for (const b of boxes) {
      if (overlapsExisting(b, plan.objects)) continue;
      plan.objects.push({
        id: newElementId('b'),
        x: round(b.x),
        y: round(b.y),
        w: round(b.w),
        d: round(b.d),
        angle: round(b.angle),
        heightM: round(b.heightM),
        category: 'mesh',
        // A lump in the mesh: below the flag threshold, so a person confirms it.
        confidence: CONFIDENCE.low,
        elevationM: 0,
        equipment: null,
        source: 'mesh',
        facingDeg: null,
        modelRef: null,
        sameAs: null,
      });
    }
  }

  /*
   * Equipment the surveyor marked during the capture (CHANGE 2.1).
   *
   * RoomPlan recognises a shape but cannot say it is a treadmill, so a
   * machine is named by the surveyor. Where that naming lands on an object
   * the scan already found, the two are the same thing and the name is
   * attached to it: the scanned footprint is kept, because it was measured
   * and the typed one was not. Where it lands on nothing, the machine is
   * added as its own object, marked as having come from the surveyor.
   */
  for (const item of list(capture.equipment)) {
    if (!item?.equipmentId || !Number.isFinite(item.x) || !Number.isFinite(item.y)) continue;
    const named = { equipmentId: item.equipmentId, type: item.type ?? 'equipment', name: item.name ?? 'Equipment' };

    let match = null;
    for (const o of plan.objects) {
      if (o.equipment) continue;
      const d = dist([item.x, item.y], [o.x, o.y]);
      // Within the object's own footprint, give or take: any further off and
      // it is a different machine.
      const reach = Math.max(EQUIPMENT_SNAP_M, Math.max(o.w, o.d) / 2);
      if (d <= reach && (!match || d < match.d)) match = { o, d };
    }

    if (match) {
      match.o.equipment = named;
      continue;
    }
    plan.objects.push({
      id: newElementId('b'),
      x: round(item.x),
      y: round(item.y),
      w: round(item.w > 0 ? item.w : DEFAULT_EQUIPMENT_SIDE_M),
      d: round(item.d > 0 ? item.d : DEFAULT_EQUIPMENT_SIDE_M),
      angle: round(Number.isFinite(item.angle) ? item.angle : 0),
      heightM: round(item.heightM > 0 ? item.heightM : DEFAULT_OBJECT_HEIGHT_M),
      category: 'equipment',
      // Typed in rather than measured, so it carries no scan confidence.
      confidence: Number.isFinite(item.confidence) ? item.confidence : CONFIDENCE.medium,
      elevationM: Number.isFinite(item.elevationM) ? round(item.elevationM) : 0,
      equipment: named,
      source: 'surveyor',
      facingDeg: Number.isFinite(item.facingDeg) ? round(item.facingDeg) : null,
      modelRef: null,
      sameAs: null,
    });
  }

  for (const t of list(capture.tags)) {
    if (!TAG_TYPES.includes(t.type) || !Number.isFinite(t.x) || !Number.isFinite(t.y)) continue;
    plan.tags.push({ id: newElementId('t'), type: t.type, x: round(t.x), y: round(t.y), heightM: t.heightM ?? null });
  }

  const ceilingTag = plan.tags.find((t) => t.type === 'ceiling' && t.heightM > 0);
  plan.ceilingHeightM = round(
    ceilingTag?.heightM ?? (tallest > 1.8 ? tallest : Math.max(2.4, (capture.floorToFloorM ?? DEFAULT_CEILING_M + 0.3) - 0.3)),
  );

  // A mirror tag marks the wall it sits on as a mirror wall (GEN-03).
  for (const tag of plan.tags.filter((t) => t.type === 'mirror')) {
    let best = null;
    for (const wall of plan.walls) {
      const d = project([tag.x, tag.y], wall.a, wall.b).distance;
      if (d < 0.5 && (!best || d < best.d)) best = { wall, d };
    }
    if (best && !best.wall.mirror) {
      best.wall.mirror = true;
      // Format 3 wants the span; the tag only says "mirror here", so the
      // whole wall is assumed and the reviewer trims it.
      best.wall.mirrors.push({
        id: newElementId('m'),
        fromM: 0,
        toM: round(dist(best.wall.a, best.wall.b)),
        bottomM: 0,
        topM: round(best.wall.heightM ?? plan.ceilingHeightM),
      });
    }
  }

  // Laser-measured control distances correct the scan's scale (F-03, F-05).
  const control = applyControlDistances(plan, list(capture.controlDistances));
  if (control) {
    plan.scale = { source: 'scan', control };
    if (!control.applied) {
      plan.flags.push({
        id: newElementId('f'),
        kind: 'control_distance',
        elementId: null,
        title: 'Control distances disagree with the scan',
        detail:
          `The laser measurements differ from the scan by ${(Math.abs(control.factor - 1) * 100).toFixed(1)} % on average, ` +
          'more than scale drift explains. The scale was left as scanned: check where the ends were marked.',
        status: 'open',
      });
    }
  }

  // Wall lengths, bearings and the overall room box, from the geometry above.
  withMeasurements(plan, { elevationM: floorM });

  /*
   * Spaces (format 3). iOS 17 gives each room's floor its own outline, and
   * each becomes a space; otherwise the whole floor outline is one space.
   * Either way the kind and finish are the reviewer's to set.
   */
  const floors = list(room.floors).map(floorPolygon).filter(Boolean);
  const k = control?.applied ? control.factor : 1;
  if (floors.length > 1) {
    floors.forEach((points, i) => {
      plan.spaces.push({
        id: newElementId('s'),
        name: `Room ${i + 1}`,
        kind: 'gym_floor',
        points: points.map((p) => [round(p[0] * k), round(p[1] * k)]),
        floorFinish: null,
        ceilingHeightM: plan.ceilingHeightM,
        ceilingZones: [],
      });
    });
  } else {
    const space = spaceFromOutline(plan);
    if (space) plan.spaces.push(space);
  }

  plan.flags.push(...flagsFor(plan));
  return plan;
}

/**
 * Corrects the plan's scale from laser-measured control distances (F-05),
 * in place, and reports what it found.
 *
 * Each distance has its two ends as marked on the scanned outline (`a`, `b`,
 * metres in the plan's frame) and the laser reading `measuredM`. The scale
 * factor is the least-squares fit of measured to scanned lengths; what
 * remains after scaling is the error the scan still carries, reported as an
 * RMS in millimetres (`residualMm`, stored as captures.scale_residual_mm).
 *
 * Only the floor plane is scaled, about the scan's origin: LiDAR drift over a
 * long walk shows up as length, not height. Returns null with no distances.
 */
export function applyControlDistances(plan, distances) {
  const usable = distances
    .filter((c) => Array.isArray(c?.a) && Array.isArray(c?.b) && c.measuredM > 0)
    .map((c) => ({ a: c.a.map(Number), b: c.b.map(Number), measuredM: Number(c.measuredM), scannedM: dist(c.a, c.b) }))
    .filter((c) => c.scannedM > 0.1 && [...c.a, ...c.b].every(Number.isFinite));
  if (!usable.length) return null;

  const factor =
    usable.reduce((s, c) => s + c.measuredM * c.scannedM, 0) / usable.reduce((s, c) => s + c.scannedM * c.scannedM, 0);
  const applied = Math.abs(factor - 1) <= MAX_SCALE_CORRECTION;
  const k = applied ? factor : 1;
  const residualMm = Math.sqrt(usable.reduce((s, c) => s + (k * c.scannedM - c.measuredM) ** 2, 0) / usable.length) * 1000;

  if (applied && k !== 1) scalePlan(plan, k);

  return {
    applied,
    factor: round(factor),
    residualMm: Math.round(residualMm * 100) / 100,
    distances: usable.map((c) => ({
      a: c.a.map((n) => round(n * k)),
      b: c.b.map((n) => round(n * k)),
      measuredM: round(c.measuredM),
      scannedM: round(c.scannedM),
      errorMm: Math.round((k * c.scannedM - c.measuredM) * 100000) / 100,
    })),
  };
}

/** Scales every horizontal length and position in a plan by `k`, in place. */
function scalePlan(plan, k) {
  const p = (pt) => [round(pt[0] * k), round(pt[1] * k)];
  const ring = (pts) => (Array.isArray(pts) ? pts.map(p) : pts);
  for (const w of plan.walls) {
    w.a = p(w.a);
    w.b = p(w.b);
    if (w.curveM) w.curveM = round(w.curveM * k);
    for (const m of w.mirrors ?? []) {
      m.fromM = round(m.fromM * k);
      m.toM = round(m.toM * k);
    }
  }
  for (const o of plan.openings) {
    o.offset = round(o.offset * k);
    o.width = round(o.width * k);
  }
  for (const list of [plan.columns, plan.objects]) {
    for (const b of list) {
      b.x = round(b.x * k);
      b.y = round(b.y * k);
      b.w = round(b.w * k);
      b.d = round(b.d * k);
    }
  }
  for (const t of plan.tags) {
    t.x = round(t.x * k);
    t.y = round(t.y * k);
  }
  for (const z of plan.zones) z.points = ring(z.points);
  for (const key of ['spaces', 'beams', 'levelChanges', 'voids']) {
    for (const e of plan[key] ?? []) {
      e.points = ring(e.points);
      for (const z of e.ceilingZones ?? []) z.points = ring(z.points);
    }
  }
}

/**
 * The plan for an uploaded drawing: scaled from the owner's line and empty,
 * with the drawing as the underlay the reviewer traces.
 */
export function planFromUpload(upload = {}) {
  const s = upload.scale ?? {};
  const lengthPx = Array.isArray(s.a) && Array.isArray(s.b) ? dist(s.a, s.b) : 0;
  const mpp = lengthPx > 0 && s.lengthM > 0 ? s.lengthM / lengthPx : null;
  const toM = (p) => (Array.isArray(p) && mpp ? [round(p[0] * mpp), round(p[1] * mpp)] : null);
  return emptyPlan({
    // A DWG carries its own units and has no picture to scale, so the
    // reviewer draws it in metres.
    scale: mpp
      ? { source: 'line', a: toM(s.a), b: toM(s.b), lengthM: s.lengthM, metresPerPixel: mpp }
      : upload.imageFileId
        ? { source: 'line', metresPerPixel: null }
        : { source: 'drawn' },
    underlay: upload.imageFileId
      ? {
          fileId: upload.imageFileId,
          widthPx: upload.imageWidth ?? null,
          heightPx: upload.imageHeight ?? null,
          metresPerPixel: mpp,
        }
      : null,
    ceilingHeightM: upload.ceilingHeightM ?? DEFAULT_CEILING_M,
  });
}

/** Flags for everything read below the confidence threshold (RDR-02). */
export function flagsFor(plan) {
  const flags = [];
  const flag = (kind, elementId, title, detail) =>
    flags.push({ id: newElementId('f'), kind, elementId, title, detail, status: 'open' });

  for (const w of plan.walls) {
    if (w.confidence < FLAG_THRESHOLD) {
      flag(
        'low_confidence',
        w.id,
        `${wallName(plan, w)}, low confidence`,
        `Read at ${w.confidence.toFixed(2)} over ${dist(w.a, w.b).toFixed(1)} m. The scan was weak along this run.`,
      );
    }
    for (const end of [w.a, w.b]) {
      const touches = plan.walls.some(
        (o) => o !== w && (dist(end, o.a) < 0.05 || dist(end, o.b) < 0.05 || project(end, o.a, o.b).distance < 0.05),
      );
      if (touches) continue;
      const near = plan.walls
        .filter((o) => o !== w)
        .map((o) => project(end, o.a, o.b).distance)
        .sort((x, y) => x - y)[0];
      if (near !== undefined && near < 0.6) {
        flag(
          'wall_unattached',
          w.id,
          'Wall not attached',
          `${wallName(plan, w)} stops ${near.toFixed(2)} m short of the next wall.`,
        );
        break;
      }
    }
  }
  for (const o of plan.openings) {
    if (o.wallId && o.confidence < 0.8) {
      flag('opening_type', o.id, 'Opening type unclear', `A ${o.width.toFixed(2)} m gap read as a ${o.type}. Door, window or opening?`);
    }
  }
  for (const b of plan.objects) {
    const square = Math.abs(b.w - b.d) < 0.15 && Math.max(b.w, b.d) <= 0.8;
    if (square) {
      flag('column_or_object', b.id, 'Column or object?', `A ${b.w.toFixed(1)} m square block. A structural column, or a free-standing rack?`);
    } else if (b.confidence < FLAG_THRESHOLD) {
      flag('low_confidence', b.id, 'Object, low confidence', `A ${b.w.toFixed(1)} × ${b.d.toFixed(1)} m block read at ${b.confidence.toFixed(2)}.`);
    }
  }
  return flags;
}
