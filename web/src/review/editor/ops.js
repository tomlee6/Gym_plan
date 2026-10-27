/**
 * Plan editing operations (REV-04). Each takes a plan and returns a new
 * one; nothing is changed in place, so undo is just the previous plan.
 *
 * Editing an element that carries an open flag resolves the flag as
 * "edited"; deleting it resolves it as "deleted" (REV-05).
 */
import {
  clonePlan,
  dist,
  JOIN_TOLERANCE_M,
  lerp,
  newElementId,
  pointInPolygon,
  project,
  wallLength,
} from '@shared/plan/index.js';

import { openingTypeOf, withLists } from './planKinds.js';

const round = (n) => Math.round(n * 1000) / 1000;
const roundPoint = (p) => [round(p[0]), round(p[1])];

/** Marks the open flags on `ids` as resolved. */
export function resolveFlags(plan, ids, resolution) {
  const set = new Set(ids);
  if (!plan.flags.some((f) => f.status === 'open' && set.has(f.elementId))) return plan;
  return {
    ...plan,
    flags: plan.flags.map((f) =>
      f.status === 'open' && set.has(f.elementId) ? { ...f, status: 'resolved', resolution } : f,
    ),
  };
}

/** Confirm one flag as read correctly, by flag id. */
export function confirmFlag(plan, flagId) {
  return {
    ...plan,
    flags: plan.flags.map((f) =>
      f.id === flagId && f.status === 'open' ? { ...f, status: 'resolved', resolution: 'confirmed' } : f,
    ),
  };
}

export function confirmAllFlags(plan) {
  return {
    ...plan,
    flags: plan.flags.map((f) =>
      f.status === 'open' ? { ...f, status: 'resolved', resolution: 'confirmed' } : f,
    ),
  };
}

/** Every top-level list of elements a reviewer can select, format 3 included. */
export const ELEMENT_KINDS = ['walls', 'openings', 'columns', 'objects', 'zones', 'tags', 'spaces', 'beams', 'levelChanges', 'voids'];

/** The lists whose elements are a polygon (`points`). */
export const POLYGON_KINDS = ['zones', 'spaces', 'beams', 'levelChanges', 'voids', 'ceilingZones'];

/**
 * Which element an id names, and its collection. A ceiling zone lives
 * inside its space (format 3 nests them), so it comes back as kind
 * 'ceilingZones' with the `spaceId` that holds it.
 */
export function findElement(plan, id) {
  if (!id) return null;
  for (const kind of ELEMENT_KINDS) {
    const el = (plan[kind] ?? []).find((e) => e.id === id);
    if (el) return { kind, el };
  }
  for (const space of plan.spaces ?? []) {
    const el = (space.ceilingZones ?? []).find((z) => z.id === id);
    if (el) return { kind: 'ceilingZones', el, spaceId: space.id };
  }
  return null;
}

/** Replaces one ceiling zone inside its space; `fn` returns the new zone, or null to remove it. */
function mapCeilingZone(plan, spaceId, zoneId, fn) {
  return {
    ...plan,
    spaces: plan.spaces.map((s) =>
      s.id === spaceId
        ? { ...s, ceilingZones: (s.ceilingZones ?? []).flatMap((z) => (z.id === zoneId ? [fn(z)].filter(Boolean) : [z])) }
        : s,
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Walls                                                                */

/** Every wall end at point p (within tolerance), as [wallId, 'a'|'b']. */
export function endsAt(plan, p, tolerance = JOIN_TOLERANCE_M) {
  const out = [];
  for (const w of plan.walls) {
    if (dist(w.a, p) <= tolerance) out.push([w.id, 'a']);
    if (dist(w.b, p) <= tolerance) out.push([w.id, 'b']);
  }
  return out;
}

/** Keeps each opening inside its wall after the wall changed length. */
function clampOpenings(plan, wallIds) {
  const ids = new Set(wallIds);
  return plan.openings.map((o) => {
    if (!ids.has(o.wallId)) return o;
    const w = plan.walls.find((x) => x.id === o.wallId);
    const len = dist(w.a, w.b);
    const width = Math.min(o.width, len);
    return { ...o, width: round(width), offset: round(Math.max(0, Math.min(o.offset, len - width))) };
  });
}

/**
 * Moves a wall end to `to`. Other wall ends joined to it move with it, so
 * corners stay closed, unless `detach` is set.
 */
export function moveWallEnd(plan, wallId, end, to, { detach = false } = {}) {
  const wall = plan.walls.find((w) => w.id === wallId);
  if (!wall) return plan;
  const from = wall[end];
  const moving = detach ? [[wallId, end]] : endsAt(plan, from);
  const key = new Set(moving.map(([id, e]) => `${id}:${e}`));
  const target = roundPoint(to);
  const walls = plan.walls.map((w) => {
    const next = { ...w };
    if (key.has(`${w.id}:a`)) next.a = target;
    if (key.has(`${w.id}:b`)) next.b = target;
    return next;
  });
  const touched = [...new Set(moving.map(([id]) => id))];
  let next = { ...plan, walls };
  next = { ...next, openings: clampOpenings(next, touched) };
  return resolveFlags(next, touched, 'edited');
}

/** Moves a whole wall by a vector, taking joined ends of other walls along. */
export function moveWall(plan, wallId, delta) {
  const wall = plan.walls.find((w) => w.id === wallId);
  if (!wall) return plan;
  let next = moveWallEnd(plan, wallId, 'a', [wall.a[0] + delta[0], wall.a[1] + delta[1]]);
  const moved = next.walls.find((w) => w.id === wallId);
  next = moveWallEnd(next, wallId, 'b', [wall.b[0] + delta[0], wall.b[1] + delta[1]]);
  return moved ? next : plan;
}

export function addWall(plan, a, b) {
  if (dist(a, b) < 0.05) return { plan, id: null };
  const id = newElementId('w');
  return {
    plan: { ...plan, walls: [...plan.walls, { id, a: roundPoint(a), b: roundPoint(b), confidence: 1, mirror: false }] },
    id,
  };
}

/** Splits a wall at `t` (0..1 along it); openings go to whichever half holds them. */
export function splitWall(plan, wallId, t = 0.5) {
  const wall = plan.walls.find((w) => w.id === wallId);
  if (!wall || t <= 0.02 || t >= 0.98) return { plan, ids: [] };
  const len = dist(wall.a, wall.b);
  const cut = roundPoint(lerp(wall.a, wall.b, t));
  const at = t * len;
  const first = { ...wall, id: newElementId('w'), b: cut };
  const second = { ...wall, id: newElementId('w'), a: cut };
  const openings = plan.openings.map((o) => {
    if (o.wallId !== wallId) return o;
    const centre = o.offset + o.width / 2;
    if (centre <= at) return { ...o, wallId: first.id, width: round(Math.min(o.width, at)), offset: round(Math.min(o.offset, Math.max(0, at - o.width))) };
    return { ...o, wallId: second.id, offset: round(Math.max(0, o.offset - at)) };
  });
  const walls = plan.walls.flatMap((w) => (w.id === wallId ? [first, second] : [w]));
  let next = { ...plan, walls, openings };
  next = { ...next, openings: clampOpenings(next, [first.id, second.id]) };
  // Flags on the old wall follow the first half.
  next = {
    ...next,
    flags: next.flags.map((f) => (f.elementId === wallId ? { ...f, elementId: first.id } : f)),
  };
  return { plan: resolveFlags(next, [first.id], 'edited'), ids: [first.id, second.id] };
}

/**
 * The wall that continues `wallId` in a straight line through one of its
 * ends, where only those two walls meet: the pair `joinWalls` can merge.
 */
export function joinCandidate(plan, wallId) {
  const wall = plan.walls.find((w) => w.id === wallId);
  if (!wall) return null;
  for (const end of ['a', 'b']) {
    const ends = endsAt(plan, wall[end]).filter(([id]) => id !== wallId);
    if (ends.length !== 1) continue;
    const other = plan.walls.find((w) => w.id === ends[0][0]);
    const d1 = [wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]];
    const d2 = [other.b[0] - other.a[0], other.b[1] - other.a[1]];
    const sin = Math.abs(d1[0] * d2[1] - d1[1] * d2[0]) / (Math.hypot(...d1) * Math.hypot(...d2));
    // Nothing else may be joined into the shared point (a T would break).
    const tee = plan.walls.some(
      (w) => w.id !== wallId && w.id !== other.id && project(wall[end], w.a, w.b).distance < JOIN_TOLERANCE_M,
    );
    if (sin < Math.sin((2 * Math.PI) / 180) && !tee) return { other, end, otherEnd: ends[0][1] };
  }
  return null;
}

/** Merges a wall with its straight continuation into one wall. */
export function joinWalls(plan, wallId) {
  const c = joinCandidate(plan, wallId);
  if (!c) return { plan, id: null };
  const wall = plan.walls.find((w) => w.id === wallId);
  const farWall = c.end === 'a' ? wall.b : wall.a;
  const farOther = c.otherEnd === 'a' ? c.other.b : c.other.a;
  const merged = { ...wall, a: farWall, b: farOther, confidence: Math.min(wall.confidence, c.other.confidence), mirror: wall.mirror || c.other.mirror };
  const len = dist(merged.a, merged.b);
  // Re-anchor each opening by where its centre sits on the merged wall.
  const openings = plan.openings.map((o) => {
    if (o.wallId !== wallId && o.wallId !== c.other.id) return o;
    const src = o.wallId === wallId ? wall : c.other;
    const centre = lerp(src.a, src.b, (o.offset + o.width / 2) / dist(src.a, src.b));
    const along = project(centre, merged.a, merged.b).t * len;
    return { ...o, wallId: wallId, offset: round(Math.max(0, Math.min(len - o.width, along - o.width / 2))) };
  });
  const walls = plan.walls.filter((w) => w.id !== c.other.id).map((w) => (w.id === wallId ? merged : w));
  let next = {
    ...plan,
    walls,
    openings,
    flags: plan.flags.map((f) => (f.elementId === c.other.id ? { ...f, elementId: wallId } : f)),
  };
  next = resolveFlags(next, [wallId], 'edited');
  return { plan: next, id: wallId };
}

/* ------------------------------------------------------------------ */
/* Openings                                                             */

/** Adds an opening centred where `p` falls on the nearest wall. */
export function addOpening(plan, p, { type: given = 'door', kind = null, width = 0.9, tolerance = 0.5 } = {}) {
  // A format 3 kind decides the type; a bare type still works as it did.
  const type = kind ? openingTypeOf(kind) : given;
  let best = null;
  for (const w of plan.walls) {
    const hit = project(p, w.a, w.b);
    if (hit.distance <= tolerance && (!best || hit.distance < best.hit.distance)) best = { w, hit };
  }
  if (!best) return { plan, id: null };
  const len = dist(best.w.a, best.w.b);
  const size = Math.min(width, len);
  const offset = Math.max(0, Math.min(len - size, best.hit.t * len - size / 2));
  const id = newElementId('o');
  return {
    plan: {
      ...plan,
      openings: [
        ...plan.openings,
        {
          id,
          wallId: best.w.id,
          type,
          offset: round(offset),
          width: round(size),
          confidence: 1,
          ...(kind && { kind, leaves: type === 'door' ? (kind === 'double_door' ? 2 : 1) : null, hinge: null, swingInto: null }),
        },
      ],
    },
    id,
  };
}

/** Moves an opening along its wall so its centre is nearest `p`. */
export function slideOpening(plan, openingId, p) {
  const o = plan.openings.find((x) => x.id === openingId);
  const w = o && plan.walls.find((x) => x.id === o.wallId);
  if (!w) return plan;
  const len = dist(w.a, w.b);
  const along = project(p, w.a, w.b).t * len;
  const offset = round(Math.max(0, Math.min(len - o.width, along - o.width / 2)));
  return updateElement(plan, openingId, { offset });
}

/* ------------------------------------------------------------------ */
/* Columns, objects, zones, tags                                        */

export function addColumn(plan, p, size = 0.5) {
  const id = newElementId('c');
  return {
    plan: { ...plan, columns: [...plan.columns, { id, x: round(p[0]), y: round(p[1]), w: size, d: size, angle: 0 }] },
    id,
  };
}

/** A footprint the reader called an object is really a column. */
export function objectToColumn(plan, objectId) {
  const b = plan.objects.find((o) => o.id === objectId);
  if (!b) return { plan, id: null };
  const id = newElementId('c');
  let next = {
    ...plan,
    objects: plan.objects.filter((o) => o.id !== objectId),
    columns: [...plan.columns, { id, x: b.x, y: b.y, w: b.w, d: b.d, angle: b.angle }],
  };
  next = resolveFlags(next, [objectId], 'edited');
  return { plan: next, id };
}

export function addZone(plan, points) {
  if (points.length < 3) return { plan, id: null };
  const id = newElementId('z');
  return { plan: { ...plan, zones: [...plan.zones, { id, points: points.map(roundPoint) }] }, id };
}

export function addTag(plan, p, type, heightM = null) {
  const id = newElementId('t');
  return {
    plan: { ...plan, tags: [...plan.tags, { id, type, x: round(p[0]), y: round(p[1]), heightM }] },
    id,
  };
}

/** Moves a column, object or tag to `p`. */
export function moveItem(plan, id, p) {
  const found = findElement(plan, id);
  if (!found || !['columns', 'objects', 'tags'].includes(found.kind)) return plan;
  return updateElement(plan, id, { x: round(p[0]), y: round(p[1]) });
}

/** Changes fields of any element; resolves its open flag as edited. */
export function updateElement(plan, id, fields) {
  const found = findElement(plan, id);
  if (!found) return plan;
  if (found.kind === 'ceilingZones') {
    return resolveFlags(mapCeilingZone(plan, found.spaceId, id, (z) => ({ ...z, ...fields })), [id], 'edited');
  }
  let next = {
    ...plan,
    [found.kind]: plan[found.kind].map((e) => (e.id === id ? { ...e, ...fields } : e)),
  };
  if (found.kind === 'walls') next = { ...next, openings: clampOpenings(next, [id]) };
  return resolveFlags(next, [id], 'edited');
}

/** Deletes an element; a wall takes its openings with it. */
export function deleteElement(plan, id) {
  const found = findElement(plan, id);
  if (!found) return plan;
  if (found.kind === 'ceilingZones') {
    return resolveFlags(mapCeilingZone(plan, found.spaceId, id, () => null), [id], 'deleted');
  }
  let next = { ...plan, [found.kind]: plan[found.kind].filter((e) => e.id !== id) };
  const gone = [id];
  if (found.kind === 'spaces') {
    // A door cannot swing into a room that is no longer there.
    next = { ...next, openings: next.openings.map((o) => (o.swingInto === id ? { ...o, swingInto: null } : o)) };
    gone.push(...(found.el.ceilingZones ?? []).map((z) => z.id));
  }
  if (found.kind === 'walls') {
    const openings = next.openings.filter((o) => o.wallId === id).map((o) => o.id);
    gone.push(...openings);
    next = { ...next, openings: next.openings.filter((o) => o.wallId !== id) };
  }
  return resolveFlags(next, gone, 'deleted');
}

/* ------------------------------------------------------------------ */
/* Scale                                                                */

/**
 * Corrects the scale (REV-04): the line from `a` to `b` is really
 * `lengthM` long, so every position and size is multiplied by the ratio.
 * Heights are not affected.
 */
export function rescale(plan, a, b, lengthM) {
  const measured = dist(a, b);
  if (!(measured > 0) || !(lengthM > 0)) return plan;
  const k = lengthM / measured;
  const P = (p) => roundPoint([p[0] * k, p[1] * k]);
  const next = clonePlan(plan);
  next.walls = next.walls.map((w) => ({
    ...w,
    a: P(w.a),
    b: P(w.b),
    ...(w.curveM != null && { curveM: round(w.curveM * k) }),
    // Mirror spans are measured along the wall, so they stretch with it; their heights do not.
    ...(Array.isArray(w.mirrors) && { mirrors: w.mirrors.map((m) => ({ ...m, fromM: round(m.fromM * k), toM: round(m.toM * k) })) }),
  }));
  next.openings = next.openings.map((o) => ({ ...o, offset: round(o.offset * k), width: round(o.width * k) }));
  next.columns = next.columns.map((c) => ({ ...c, x: round(c.x * k), y: round(c.y * k), w: round(c.w * k), d: round(c.d * k) }));
  next.objects = next.objects.map((c) => ({ ...c, x: round(c.x * k), y: round(c.y * k), w: round(c.w * k), d: round(c.d * k) }));
  next.zones = next.zones.map((z) => ({ ...z, points: z.points.map(P) }));
  for (const kind of ['beams', 'levelChanges', 'voids']) {
    if (Array.isArray(next[kind])) next[kind] = next[kind].map((e) => ({ ...e, points: e.points.map(P) }));
  }
  if (Array.isArray(next.spaces)) {
    next.spaces = next.spaces.map((sp) => ({
      ...sp,
      points: sp.points.map(P),
      ceilingZones: (sp.ceilingZones ?? []).map((z) => ({ ...z, points: z.points.map(P) })),
    }));
  }
  next.tags = next.tags.map((t) => ({ ...t, x: round(t.x * k), y: round(t.y * k) }));
  // A drawing's pixels shrink or grow with it; a scan or a traced plan just
  // records the correction.
  const mpp = plan.scale?.metresPerPixel > 0 ? plan.scale.metresPerPixel * k : null;
  next.scale = { ...plan.scale, a: P(a), b: P(b), lengthM };
  if (plan.scale?.source === 'line') next.scale.metresPerPixel = mpp;
  if (next.underlay?.metresPerPixel > 0) next.underlay = { ...next.underlay, metresPerPixel: next.underlay.metresPerPixel * k };
  return next;
}

/* -------------------------------------------------------------------------
 * Measurement editing (CHANGE 1.7). The reviewer types the dimension they
 * measured on site and the geometry follows, rather than nudging a corner
 * until the readout looks right.
 * ---------------------------------------------------------------------- */

/**
 * Sets a wall to an exact length by sliding one end along the wall's own
 * direction. The anchored end does not move, so a corner the reviewer has
 * already placed stays where they put it.
 *
 * Openings are clamped back inside the wall by `updateElement`, so
 * shortening a wall cannot leave a door hanging off the end of it.
 */
export function setWallLength(plan, wallId, lengthM, { anchor = 'a' } = {}) {
  const wall = plan.walls.find((w) => w.id === wallId);
  if (!wall || !(lengthM > 0)) return plan;
  const current = dist(wall.a, wall.b);
  if (current < 1e-9) return plan;
  const from = anchor === 'b' ? wall.b : wall.a;
  const to = anchor === 'b' ? wall.a : wall.b;
  const moved = [
    round(from[0] + ((to[0] - from[0]) / current) * lengthM),
    round(from[1] + ((to[1] - from[1]) / current) * lengthM),
  ];
  return updateElement(plan, wallId, anchor === 'b' ? { a: moved } : { b: moved });
}

/** Turns an object to an exact bearing, in degrees. */
export function rotateObject(plan, id, degrees) {
  if (!Number.isFinite(degrees)) return plan;
  return updateElement(plan, id, { angle: round((degrees * Math.PI) / 180) });
}

/**
 * Names an object as a piece of gym equipment, or clears the name
 * (CHANGE 2.1). RoomPlan cannot tell a treadmill from a shelf, so this is
 * how a scanned block becomes a machine the walkthrough can label.
 *
 * Naming records the reviewer as the source: the shape was measured, the
 * name was not.
 */
export function setEquipment(plan, objectId, equipment) {
  const found = findElement(plan, objectId);
  if (!found || found.kind !== 'objects') return plan;
  if (!equipment) return updateElement(plan, objectId, { equipment: null });
  const { equipmentId, type, name } = equipment;
  if (!equipmentId || !type || !name) return plan;
  return updateElement(plan, objectId, {
    equipment: { equipmentId, type, name },
    source: found.el.source === 'roomplan' ? 'roomplan' : 'reviewer',
  });
}

/** An equipment id that is not already used in this plan. */
export function nextEquipmentId(plan) {
  const used = new Set(plan.objects.map((o) => o.equipment?.equipmentId).filter(Boolean));
  for (let n = 1; n <= 999; n++) {
    const id = `EQ-${String(n).padStart(3, '0')}`;
    if (!used.has(id)) return id;
  }
  return `EQ-${Date.now()}`;
}

/**
 * Raises a flag against an element (CHANGE 5: "flag incorrect equipment").
 *
 * An open flag blocks approval, which is the point: a machine the reviewer
 * cannot identify from the scan or the 360 video must be settled by a
 * person before the plan is frozen, not waved through.
 */
export function flagElement(plan, id, { kind = 'equipment_wrong', title, detail = '' } = {}) {
  const found = findElement(plan, id);
  if (!found || !title) return plan;
  // One open flag of a kind per element: raising it twice says no more.
  if (plan.flags.some((f) => f.elementId === id && f.kind === kind && f.status === 'open')) return plan;
  return {
    ...plan,
    flags: [...plan.flags, { id: newElementId('f'), kind, elementId: id, title, detail, status: 'open' }],
  };
}

/* -------------------------------------------------------------------------
 * Format 3 (H-01): spaces and their ceiling zones, beams, level changes,
 * stairs, lifts and voids, wall kinds, curves and mirror spans, opening
 * kinds, column shapes and machine facing.
 * ---------------------------------------------------------------------- */

/** Adds a polygon element to `list`; fewer than three corners is not a shape. */
function addPolygon(plan, list, prefix, points, fields) {
  if (points.length < 3) return { plan, id: null };
  const base = withLists(plan);
  const id = newElementId(prefix);
  return { plan: { ...base, [list]: [...base[list], { id, ...fields, points: points.map(roundPoint) }] }, id };
}

/** A space: one room of the floor, with its kind, floor finish and ceiling. */
export function addSpace(plan, points, { name, kind = 'gym_floor', floorFinish = null, ceilingHeightM = null } = {}) {
  const n = (plan.spaces?.length ?? 0) + 1;
  return addPolygon(plan, 'spaces', 's', points, {
    name: name ?? `Space ${n}`,
    kind,
    floorFinish,
    ceilingHeightM: ceilingHeightM ?? plan.ceilingHeightM ?? null,
    ceilingZones: [],
  });
}

/** A beam or bulkhead: something hanging below the ceiling, `bottomM` above the floor. */
export function addBeam(plan, points, { kind = 'beam', bottomM = null } = {}) {
  return addPolygon(plan, 'beams', 'bm', points, { kind, bottomM });
}

/** A step, platform or ramp: part of the floor at another height. */
export function addLevelChange(plan, points, { kind = 'step', heightM = 0.15, rampAngleDeg = null } = {}) {
  return addPolygon(plan, 'levelChanges', 'lc', points, { kind, heightM, rampAngleDeg });
}

/** A stair, lift or void: a hole in the floor nothing may be placed over. */
export function addVoid(plan, points, { kind = 'void', railHeightM = null } = {}) {
  return addPolygon(plan, 'voids', 'vd', points, { kind, railHeightM });
}

/**
 * A ceiling zone inside a space: part of the room where the ceiling is at
 * another height (a raised bay, a dropped ceiling over the changing rooms).
 */
export function addCeilingZone(plan, spaceId, points, heightM = null) {
  const base = withLists(plan);
  const space = base.spaces.find((s) => s.id === spaceId);
  if (!space || points.length < 3) return { plan, id: null };
  const id = newElementId('cz');
  const zone = {
    id,
    points: points.map(roundPoint),
    heightM: heightM ?? space.ceilingHeightM ?? plan.ceilingHeightM ?? null,
  };
  return {
    plan: {
      ...base,
      spaces: base.spaces.map((s) => (s.id === spaceId ? { ...s, ceilingZones: [...(s.ceilingZones ?? []), zone] } : s)),
    },
    id,
  };
}

/** Moves one corner of any polygon element (space, zone, beam, level change, void, ceiling zone). */
export function movePolygonPoint(plan, id, index, p) {
  const found = findElement(plan, id);
  if (!found || !POLYGON_KINDS.includes(found.kind) || !found.el.points[index]) return plan;
  const points = found.el.points.map((q, i) => (i === index ? roundPoint(p) : q));
  return updateElement(plan, id, { points });
}

/**
 * Moves a whole polygon by a vector. A space takes its ceiling zones with
 * it, since they describe that room's ceiling and not a place on the floor.
 */
export function movePolygon(plan, id, delta) {
  const found = findElement(plan, id);
  if (!found || !POLYGON_KINDS.includes(found.kind)) return plan;
  const shift = (pts) => pts.map((q) => roundPoint([q[0] + delta[0], q[1] + delta[1]]));
  const fields = { points: shift(found.el.points) };
  if (found.kind === 'spaces') {
    fields.ceilingZones = (found.el.ceilingZones ?? []).map((z) => ({ ...z, points: shift(z.points) }));
  }
  return updateElement(plan, id, fields);
}

/** The space a point falls in, if any: where a ceiling zone being drawn belongs. */
export function spaceAt(plan, p) {
  return (plan.spaces ?? []).find((s) => pointInPolygon(p, s.points)) ?? null;
}

/* Walls ------------------------------------------------------------------ */

/**
 * Bends a wall into an arc. `curveM` is the sagitta, how far the middle of
 * the arc stands off the straight line, positive to the left of a to b.
 * Zero is stored as null: a straight wall, as format 2 drew every wall.
 */
export function setWallCurve(plan, wallId, curveM) {
  const value = curveM === null || curveM === undefined || Math.abs(curveM) < 0.005 ? null : round(curveM);
  return updateElement(plan, wallId, { curveM: value });
}

/** Rewrites a wall's mirror spans; `mirror` stays true exactly when there are any. */
function setMirrors(plan, wallId, fn) {
  const wall = plan.walls.find((w) => w.id === wallId);
  if (!wall) return plan;
  const mirrors = fn(wall.mirrors ?? []);
  return updateElement(plan, wallId, { mirrors, mirror: mirrors.length > 0 });
}

/**
 * Adds a mirror span. By default it runs the whole wall from the floor to
 * 2.4 m (or the wall's height when lower), the usual gym mirror wall; the
 * reviewer trims it to the real glass.
 */
export function addMirror(plan, wallId, span = {}) {
  const wall = plan.walls.find((w) => w.id === wallId);
  if (!wall) return { plan, id: null };
  const id = newElementId('m');
  const len = round(wallLength(wall));
  const top = Math.min(wall.heightM ?? plan.ceilingHeightM ?? 2.4, 2.4);
  const mirror = { id, fromM: 0, toM: len, bottomM: 0, topM: round(top), ...span };
  return { plan: setMirrors(plan, wallId, (m) => [...m, mirror]), id };
}

/**
 * Changes one mirror span, kept inside its wall and the right way round
 * (from before to, bottom below top), so a typo cannot make a span of
 * negative length.
 */
export function updateMirror(plan, wallId, mirrorId, fields) {
  const wall = plan.walls.find((w) => w.id === wallId);
  if (!wall) return plan;
  const len = round(wallLength(wall));
  return setMirrors(plan, wallId, (list) =>
    list.map((m) => {
      if (m.id !== mirrorId) return m;
      const n = { ...m, ...fields };
      const fromM = Math.max(0, Math.min(len, n.fromM));
      const toM = Math.max(fromM, Math.min(len, n.toM));
      const bottomM = Math.max(0, n.bottomM);
      const topM = Math.max(bottomM, n.topM);
      return { ...n, fromM: round(fromM), toM: round(toM), bottomM: round(bottomM), topM: round(topM) };
    }),
  );
}

export function removeMirror(plan, wallId, mirrorId) {
  return setMirrors(plan, wallId, (list) => list.filter((m) => m.id !== mirrorId));
}

/**
 * The format 2 "mirror wall" tick box, in format 3 terms: ticking it adds a
 * whole-wall span when there is none, clearing it removes every span.
 */
export function setWallMirror(plan, wallId, on) {
  const wall = plan.walls.find((w) => w.id === wallId);
  if (!wall) return plan;
  if (!on) return setMirrors(plan, wallId, () => []);
  if ((wall.mirrors ?? []).length > 0) return updateElement(plan, wallId, { mirror: true });
  return addMirror(plan, wallId).plan;
}

/* Openings --------------------------------------------------------------- */

/**
 * Sets an opening's kind. The older `type` follows from it, so the viewer
 * and every format 2 reader keep drawing the right thing. A door gets a
 * number of leaves (two for a double door); anything that is not a door
 * loses the door-only fields rather than keeping stale ones, and only a
 * window keeps a sill.
 */
export function setOpeningKind(plan, openingId, kind) {
  const o = plan.openings.find((x) => x.id === openingId);
  if (!o) return plan;
  const type = openingTypeOf(kind);
  const fields = { kind, type };
  if (type === 'door') {
    fields.leaves = kind === 'double_door' ? 2 : o.type === 'door' && o.leaves && o.kind !== 'double_door' ? o.leaves : 1;
  } else {
    Object.assign(fields, { leaves: null, hinge: null, swing: null, swingInto: null });
  }
  if (type !== 'window') fields.sillHeightM = null;
  return updateElement(plan, openingId, fields);
}

/* Columns and machines --------------------------------------------------- */

/** Round or rectangular; a round column takes its width as the diameter. */
export function setColumnShape(plan, columnId, shape) {
  const c = plan.columns.find((x) => x.id === columnId);
  if (!c) return plan;
  if (shape === 'round') return updateElement(plan, columnId, { shape, d: c.w, angle: 0 });
  return updateElement(plan, columnId, { shape });
}

/**
 * Which way a machine faces: its front, in degrees anticlockwise from +x
 * (format 3). Stored 0..360 to a tenth of a degree; null is "not set".
 */
export function setFacing(plan, objectId, degrees) {
  const found = findElement(plan, objectId);
  if (!found || found.kind !== 'objects') return plan;
  if (degrees === null || degrees === undefined || !Number.isFinite(degrees)) {
    return updateElement(plan, objectId, { facingDeg: null });
  }
  const d = Math.round((((degrees % 360) + 360) % 360) * 10) / 10;
  return updateElement(plan, objectId, { facingDeg: d === 360 ? 0 : d });
}

/* Unplaced machines (H-02) ----------------------------------------------- */

/**
 * The machines the surveyor recorded on the phone without a position
 * (`placed: false` in the version payload) that are not on the plan yet.
 */
export function unplacedEquipment(plan, equipment = []) {
  const onPlan = new Set(plan.objects.map((o) => o.equipment?.equipmentId).filter(Boolean));
  return equipment.filter((e) => e.placed === false && e.equipmentId && !onPlan.has(e.equipmentId));
}

/**
 * Puts a machine the surveyor named but did not place onto the plan at
 * `point`. Its footprint is the size the phone recorded, or a metre square
 * until the reviewer measures it; the reviewer is the source, because the
 * position is theirs. Linking by `equipmentId` is what lets the machine's
 * 360 video show in the inspector like any other.
 */
export function placeEquipment(plan, item, point) {
  if (!item?.equipmentId || !point) return { plan, id: null };
  const id = newElementId('b');
  const positive = (n, fallback) => (Number.isFinite(n) && n > 0 ? round(n) : fallback);
  const object = {
    id,
    x: round(point[0]),
    y: round(point[1]),
    w: positive(item.widthM, 1),
    d: positive(item.depthM, 1),
    angle: 0,
    heightM: positive(item.heightM, 1.2),
    category: 'equipment',
    confidence: 1,
    elevationM: 0,
    equipment: { equipmentId: item.equipmentId, type: item.type ?? 'other', name: item.name ?? item.equipmentId },
    source: 'reviewer',
    facingDeg: null,
    modelRef: null,
    sameAs: null,
  };
  return { plan: { ...plan, objects: [...plan.objects, object] }, id };
}
