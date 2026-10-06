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
  project,
} from '@shared/plan/index.js';

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

/** Which element an id names, and its collection. */
export function findElement(plan, id) {
  for (const kind of ['walls', 'openings', 'columns', 'objects', 'zones', 'tags']) {
    const el = plan[kind].find((e) => e.id === id);
    if (el) return { kind, el };
  }
  return null;
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
export function addOpening(plan, p, { type = 'door', width = 0.9, tolerance = 0.5 } = {}) {
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
      openings: [...plan.openings, { id, wallId: best.w.id, type, offset: round(offset), width: round(size), confidence: 1 }],
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
  let next = { ...plan, [found.kind]: plan[found.kind].filter((e) => e.id !== id) };
  const gone = [id];
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
  next.walls = next.walls.map((w) => ({ ...w, a: P(w.a), b: P(w.b) }));
  next.openings = next.openings.map((o) => ({ ...o, offset: round(o.offset * k), width: round(o.width * k) }));
  next.columns = next.columns.map((c) => ({ ...c, x: round(c.x * k), y: round(c.y * k), w: round(c.w * k), d: round(c.d * k) }));
  next.objects = next.objects.map((c) => ({ ...c, x: round(c.x * k), y: round(c.y * k), w: round(c.w * k), d: round(c.d * k) }));
  next.zones = next.zones.map((z) => ({ ...z, points: z.points.map(P) }));
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
