/**
 * The fit-out schedule: every machine on the plan, for the equipment
 * maker and the installer. What it is, how big, which room, where it
 * stands, and whether it has the free floor it needs to be used safely.
 *
 * Clearances come from the library in use (the database's; ISO 20957-1 style): `aroundM` free on all
 * sides, which two machines may share, so the gap between two machines
 * must be at least the larger of their two; and `behindM` clear behind a
 * machine whose front is known, which is what a treadmill's 2 m run-off is.
 */
import { clearanceFor, EQUIPMENT_LIBRARY, equipmentLabel, intersect, pointInPolygon, rectCorners } from '@shared/plan/index.js';

import { clearanceToWall, nearestEquipment } from './measure.js';

/** A gap this close to what is needed passes: tape-measure tolerance. */
const TOLERANCE_M = 0.02;

const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

/** The room (space) a machine stands in, by its middle. */
function roomOf(plan, o) {
  return (plan.spaces ?? []).find((s) => Array.isArray(s.points) && s.points.length >= 3 && pointInPolygon([o.x, o.y], s.points)) ?? null;
}

/** The strip `depth` deep behind a machine facing `facingDeg`, as a polygon. */
function behindZone(o, facingDeg, depth) {
  const f = (facingDeg * Math.PI) / 180;
  const back = [-Math.cos(f), -Math.sin(f)];
  // How far the footprint reaches backwards, and how wide it is across.
  const corners = rectCorners(o);
  const along = (p) => (p[0] - o.x) * back[0] + (p[1] - o.y) * back[1];
  const side = [-back[1], back[0]];
  const across = (p) => (p[0] - o.x) * side[0] + (p[1] - o.y) * side[1];
  const reach = Math.max(...corners.map(along));
  const half = Math.max(...corners.map((p) => Math.abs(across(p))));
  const at = (a, s) => [o.x + back[0] * a + side[0] * s, o.y + back[1] * a + side[1] * s];
  return [at(reach, -half), at(reach, half), at(reach + depth, half), at(reach + depth, -half)];
}

/** Whether a wall or another machine is in `zone`. */
function blocked(plan, zone, selfId) {
  const edges = zone.map((p, i) => [p, zone[(i + 1) % zone.length]]);
  for (const w of plan.walls) {
    if (pointInPolygon(w.a, zone) || pointInPolygon(w.b, zone)) return true;
    if (edges.some(([a, b]) => intersect(a, b, w.a, w.b))) return true;
  }
  for (const other of plan.objects) {
    if (other.id === selfId || !other.equipment) continue;
    const oc = rectCorners(other);
    if (oc.some((p) => pointInPolygon(p, zone)) || zone.some((p) => pointInPolygon(p, oc))) return true;
  }
  return false;
}

/** One line of the schedule for a machine on the plan. */
function lineFor(plan, o, library) {
  const need = clearanceFor(o.equipment.type, library);
  const wall = clearanceToWall(plan, o);
  const near = nearestEquipment(plan, o);
  const issues = [];

  if (wall && wall.distanceM + TOLERANCE_M < need.aroundM) {
    issues.push(`${round2(wall.distanceM).toFixed(2)} m from a wall; needs ${need.aroundM} m.`);
  }
  if (near) {
    const needed = Math.max(need.aroundM, clearanceFor(near.object.equipment.type, library).aroundM);
    if (near.distanceM + TOLERANCE_M < needed) {
      issues.push(
        near.distanceM < 0.005
          ? `Overlaps ${near.object.equipment.name}.`
          : `${round2(near.distanceM).toFixed(2)} m from ${near.object.equipment.name}; needs ${needed} m.`,
      );
    }
  }
  let behind = null;
  if (need.behindM > need.aroundM) {
    if (!Number.isFinite(o.facingDeg)) {
      behind = 'unknown';
      issues.push(`Set which way it faces to check the ${need.behindM} m clear behind it.`);
    } else if (blocked(plan, behindZone(o, o.facingDeg, need.behindM), o.id)) {
      behind = 'blocked';
      issues.push(`Needs ${need.behindM} m clear behind it.`);
    } else {
      behind = 'clear';
    }
  }

  const room = roomOf(plan, o);
  return {
    id: o.id,
    ref: o.equipment.equipmentId,
    name: o.equipment.name,
    type: equipmentLabel(o.equipment.type),
    room: room?.name ?? null,
    widthM: round2(o.w),
    depthM: round2(o.d),
    heightM: round2(o.heightM),
    x: round2(o.x),
    y: round2(o.y),
    facingDeg: Number.isFinite(o.facingDeg) ? Math.round(o.facingDeg) : null,
    wallGapM: wall ? round2(wall.distanceM) : null,
    machineGapM: near ? round2(near.distanceM) : null,
    clearanceM: need.aroundM,
    behindM: need.behindM > need.aroundM ? need.behindM : null,
    behind,
    issues,
  };
}

/**
 * The schedule: one line per named machine, by room then reference, and
 * the count of each kind (what to order).
 */
export function fitOutSchedule(plan, library = EQUIPMENT_LIBRARY) {
  const lines = plan.objects
    .filter((o) => o.equipment)
    .map((o) => lineFor(plan, o, library))
    .sort((a, b) => (a.room ?? '￿').localeCompare(b.room ?? '￿') || a.ref.localeCompare(b.ref));
  const counts = new Map();
  for (const l of lines) counts.set(l.name, (counts.get(l.name) ?? 0) + 1);
  return {
    lines,
    counts: [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    problems: lines.filter((l) => l.issues.length).length,
  };
}

const COLUMNS = [
  ['Ref', 'ref'],
  ['Machine', 'name'],
  ['Type', 'type'],
  ['Room', 'room'],
  ['Width (m)', 'widthM'],
  ['Depth (m)', 'depthM'],
  ['Height (m)', 'heightM'],
  ['X (m)', 'x'],
  ['Y (m)', 'y'],
  ['Facing (°)', 'facingDeg'],
  ['Nearest wall (m)', 'wallGapM'],
  ['Nearest machine (m)', 'machineGapM'],
  ['Clearance needed (m)', 'clearanceM'],
  ['Clear behind needed (m)', 'behindM'],
  ['Issues', 'issues'],
];

/** One CSV field, quoted when it must be, and never read as a formula by a spreadsheet. */
function csvField(v) {
  let s = Array.isArray(v) ? v.join(' ') : v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The schedule as CSV, for a spreadsheet or the installer's own system. */
export function scheduleCsv(schedule) {
  const rows = [COLUMNS.map(([h]) => h), ...schedule.lines.map((l) => COLUMNS.map(([, k]) => l[k]))];
  return rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';
}
