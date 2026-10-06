/**
 * What the reviewer needs in order to check a plan against the real gym
 * (CHANGE 1.7): the dimension of each wall, how far a machine stands from
 * the wall behind it, and how much room there is between machines.
 *
 * Everything here reads the plan and works a number out. Nothing is stored:
 * a distance that was saved would be wrong the moment anything moved.
 */
import { dist, project, rectCorners } from '@shared/plan/index.js';

/** The gap between two rectangles' footprints, 0 when they overlap. */
function gapBetween(a, b) {
  const ca = rectCorners(a);
  const cb = rectCorners(b);
  // Corner-to-edge on both sides: enough for the footprints the editor
  // draws, and exact for the axis-aligned case that most machines are.
  let best = Infinity;
  for (const [from, to] of [
    [ca, cb],
    [cb, ca],
  ]) {
    for (const p of from) {
      for (let i = 0; i < to.length; i++) {
        best = Math.min(best, project(p, to[i], to[(i + 1) % to.length]).distance);
      }
    }
  }
  return best;
}

/**
 * The nearest wall to an object, and how far its footprint stands from it.
 * Measured from the object's nearest corner, which is what someone with a
 * tape measure would read.
 */
export function clearanceToWall(plan, object) {
  const corners = rectCorners(object);
  let best = null;
  for (const wall of plan.walls) {
    for (const corner of corners) {
      const d = project(corner, wall.a, wall.b).distance;
      if (!best || d < best.distanceM) best = { wall, distanceM: d };
    }
  }
  return best;
}

/**
 * The nearest other machine, and the gap between the two footprints. Only
 * named equipment counts: the question being asked is whether someone can
 * walk between two machines, not past an unidentified block.
 */
export function nearestEquipment(plan, object) {
  let best = null;
  for (const other of plan.objects) {
    if (other.id === object.id || !other.equipment) continue;
    const d = gapBetween(object, other);
    if (!best || d < best.distanceM) best = { object: other, distanceM: d };
  }
  return best;
}

/**
 * A label for each wall: where to draw it and what it says. Walls shorter
 * than `minLengthM` are skipped, because at that size the label covers more
 * of the plan than the wall it describes.
 */
export function wallLabels(plan, { minLengthM = 0.4 } = {}) {
  return plan.walls
    .map((wall) => {
      const lengthM = dist(wall.a, wall.b);
      if (lengthM < minLengthM) return null;
      const mid = [(wall.a[0] + wall.b[0]) / 2, (wall.a[1] + wall.b[1]) / 2];
      // The outward normal, so the label sits beside the wall, not on it.
      const nx = -(wall.b[1] - wall.a[1]) / lengthM;
      const ny = (wall.b[0] - wall.a[0]) / lengthM;
      // Kept within a quarter turn either side of level, so a wall drawn
      // right to left reads the right way up rather than upside down.
      let angleDeg = (Math.atan2(wall.b[1] - wall.a[1], wall.b[0] - wall.a[0]) * 180) / Math.PI;
      if (angleDeg > 90) angleDeg -= 180;
      else if (angleDeg <= -90) angleDeg += 180;
      return { id: wall.id, lengthM, mid, normal: [nx, ny], angleDeg, text: `${lengthM.toFixed(2)} m` };
    })
    .filter(Boolean);
}

/** The overall room figures the reviewer checks against the site. */
export function roomFacts(plan) {
  const room = plan.room ?? null;
  return {
    widthM: room?.widthM ?? null,
    lengthM: room?.lengthM ?? null,
    areaM2: room?.areaM2 ?? null,
    perimeterM: room?.perimeterM ?? null,
  };
}
