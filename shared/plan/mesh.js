/**
 * Machines from the scan mesh (F-06).
 *
 * RoomPlan only recognises household furniture, so most gym machines never
 * reach its object list. The LiDAR mesh the app records (F-02, `mesh.obj`,
 * metres, y up, in the plan's frame) does see them: anything standing on the
 * floor, away from the walls, is a lump in it. This finds those lumps and
 * gives each a footprint box with a height, for the surveyor or the reviewer
 * to name — or delete, when it was a bag left on the floor.
 *
 * The method is deliberately plain: keep mesh vertices between ankle and
 * head height, drop those on or near a wall, bin the rest on a 10 cm floor
 * grid, and take connected clusters of occupied cells. Each cluster's box is
 * aligned to its principal axis. Nothing here is trusted: every box comes in
 * at low confidence and is flagged.
 */
import { dist, pointInPolygon, project } from './geometry.js';

const CELL_M = 0.1;
/** Below this the mesh is floor, rubber matting and cables. */
const MIN_HEIGHT_M = 0.15;
/** Above this it is ceiling services, not a machine. */
const MAX_HEIGHT_M = 2.6;
/** Vertices this close to a wall belong to the wall (skirting, mirrors, racks fixed to it). */
const WALL_CLEARANCE_M = 0.25;
/** A cell needs this many vertices to count: one stray triangle is noise. */
const MIN_POINTS_PER_CELL = 3;
const MIN_AREA_M2 = 0.15;
const MAX_AREA_M2 = 20;
const MIN_OBJECT_HEIGHT_M = 0.3;

/** The vertices of a Wavefront OBJ, as `[x, y, z]`. Faces are not needed. */
export function parseObjVertices(text) {
  const out = [];
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    if (text.charCodeAt(start) === 118 && text.charCodeAt(start + 1) === 32) {
      // "v x y z"
      const parts = text.slice(start + 2, end).trim().split(/\s+/);
      const v = [Number(parts[0]), Number(parts[1]), Number(parts[2])];
      if (v.every(Number.isFinite)) out.push(v);
    }
    start = end + 1;
  }
  return out;
}

/**
 * Footprint boxes for floor-standing objects in the mesh, in the plan's
 * frame. `outline` (the floor polygon) and `walls` limit the search to the
 * room's open floor; `floorY` is the floor's height in the mesh.
 */
export function objectsFromMesh(vertices, { walls = [], outline = null, floorY = null } = {}) {
  if (!vertices.length) return [];
  const floor = floorY ?? lowPercentile(vertices.map((v) => v[1]), 0.02);

  const cells = new Map();
  for (const [x, y, z] of vertices) {
    const h = y - floor;
    if (h < MIN_HEIGHT_M || h > MAX_HEIGHT_M) continue;
    const p = [x, z];
    if (outline && !pointInPolygon(p, outline)) continue;
    if (walls.some((w) => project(p, w.a, w.b).distance < WALL_CLEARANCE_M)) continue;
    const key = `${Math.floor(x / CELL_M)},${Math.floor(z / CELL_M)}`;
    const cell = cells.get(key) ?? { n: 0, top: 0 };
    cell.n++;
    cell.top = Math.max(cell.top, h);
    cells.set(key, cell);
  }
  for (const [k, c] of cells) if (c.n < MIN_POINTS_PER_CELL) cells.delete(k);

  // Connected clusters of occupied cells (8-neighbour).
  const seen = new Set();
  const clusters = [];
  for (const key of cells.keys()) {
    if (seen.has(key)) continue;
    const stack = [key];
    const members = [];
    seen.add(key);
    while (stack.length) {
      const k = stack.pop();
      members.push(k);
      const [i, j] = k.split(',').map(Number);
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          const nk = `${i + di},${j + dj}`;
          if (cells.has(nk) && !seen.has(nk)) {
            seen.add(nk);
            stack.push(nk);
          }
        }
      }
    }
    clusters.push(members);
  }

  const boxes = [];
  for (const members of clusters) {
    const area = members.length * CELL_M * CELL_M;
    if (area < MIN_AREA_M2 || area > MAX_AREA_M2) continue;
    const height = Math.max(...members.map((k) => cells.get(k).top));
    if (height < MIN_OBJECT_HEIGHT_M) continue;
    boxes.push({ ...orientedBox(members.map((k) => k.split(',').map((n) => (Number(n) + 0.5) * CELL_M))), heightM: height });
  }
  return boxes;
}

/** The box around cell centres, aligned to their principal axis. */
function orientedBox(points) {
  const n = points.length;
  const cx = points.reduce((s, p) => s + p[0], 0) / n;
  const cy = points.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const [x, y] of points) {
    sxx += (x - cx) ** 2;
    syy += (y - cy) ** 2;
    sxy += (x - cx) * (y - cy);
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const [x, y] of points) {
    const u = (x - cx) * c + (y - cy) * s;
    const v = -(x - cx) * s + (y - cy) * c;
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
    minV = Math.min(minV, v);
    maxV = Math.max(maxV, v);
  }
  // Re-centre on the box, not the mass, and add back the cell's own size.
  const mu = (minU + maxU) / 2;
  const mv = (minV + maxV) / 2;
  return {
    x: cx + mu * c - mv * s,
    y: cy + mu * s + mv * c,
    w: maxU - minU + CELL_M,
    d: maxV - minV + CELL_M,
    angle,
  };
}

function lowPercentile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * q)] ?? 0;
}

/** Is a mesh box the same thing as an object already on the plan? */
export function overlapsExisting(box, objects) {
  return objects.some((o) => dist([box.x, box.y], [o.x, o.y]) < Math.max(o.w, o.d, box.w, box.d) / 2);
}
