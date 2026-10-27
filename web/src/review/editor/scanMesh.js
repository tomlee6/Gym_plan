/**
 * The scan mesh under the plan (H-03).
 *
 * The capture may carry `mesh.obj`: the room as RoomPlan's LiDAR saw it, a
 * Wavefront OBJ already in the plan's frame (metres, x across, y up, z the
 * plan's y). Drawn faintly under the plan it shows the reviewer what the
 * walls and machines were traced from, which the cleaned-up RoomPlan
 * shapes cannot: a bench RoomPlan missed, a wall it straightened.
 *
 * Only what the editor needs is read: vertex positions and faces. Texture
 * coordinates, normals, groups and materials are skipped.
 */

/**
 * Parses an OBJ file into flat arrays: `vertices` as x, y, z triples and
 * `triangles` as vertex index triples (0-based). Faces with more than three
 * corners are fanned into triangles; `v/vt/vn` corners and negative
 * (relative) indices are understood. Lines that cannot be read are skipped
 * rather than failing the whole mesh.
 */
export function parseObj(text) {
  const vertices = [];
  const triangles = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('v ')) {
      const parts = line.trim().split(/\s+/);
      const x = Number(parts[1]);
      const y = Number(parts[2]);
      const z = Number(parts[3]);
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) vertices.push(x, y, z);
      else vertices.push(0, 0, 0); // Keep the numbering faces refer to.
    } else if (line.startsWith('f ')) {
      const count = vertices.length / 3;
      const corners = [];
      for (const token of line.trim().split(/\s+/).slice(1)) {
        const n = parseInt(token.split('/')[0], 10);
        if (!Number.isFinite(n) || n === 0) continue;
        const index = n > 0 ? n - 1 : count + n;
        if (index >= 0 && index < count) corners.push(index);
      }
      for (let i = 1; i + 1 < corners.length; i++) triangles.push(corners[0], corners[i], corners[i + 1]);
    }
  }
  return { vertices: Float32Array.from(vertices), triangles: Uint32Array.from(triangles) };
}

/**
 * The mesh's triangles flattened onto the floor, as x, y pairs in plan
 * metres: six numbers per triangle. Triangles that stand on edge (wall
 * faces) flatten to nothing and are dropped; the rest is thinned evenly
 * to `maxTriangles`, since an SVG with a few hundred thousand shapes would
 * make the editor crawl and the faint backdrop reads the same at 20,000.
 */
export function floorTriangles(mesh, { maxTriangles = 20000, minAreaM2 = 1e-4 } = {}) {
  const { vertices: v, triangles: t } = mesh;
  const kept = [];
  for (let i = 0; i + 2 < t.length; i += 3) {
    const a = t[i] * 3;
    const b = t[i + 1] * 3;
    const c = t[i + 2] * 3;
    // Plan x is OBJ x, plan y is OBJ z.
    const ax = v[a];
    const ay = v[a + 2];
    const bx = v[b];
    const by = v[b + 2];
    const cx = v[c];
    const cy = v[c + 2];
    const area = Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
    if (area >= minAreaM2) kept.push(ax, ay, bx, by, cx, cy);
  }
  const count = kept.length / 6;
  if (count <= maxTriangles) return Float32Array.from(kept);
  const out = new Float32Array(maxTriangles * 6);
  const step = count / maxTriangles;
  for (let i = 0; i < maxTriangles; i++) {
    const from = Math.floor(i * step) * 6;
    for (let k = 0; k < 6; k++) out[i * 6 + k] = kept[from + k];
  }
  return out;
}

/** One SVG path for every triangle: a single element however big the mesh. */
export function trianglesPath(flat) {
  if (!flat?.length) return '';
  const r = (n) => Math.round(n * 1000) / 1000;
  const parts = [];
  for (let i = 0; i + 5 < flat.length; i += 6) {
    parts.push(`M${r(flat[i])} ${r(flat[i + 1])}L${r(flat[i + 2])} ${r(flat[i + 3])}L${r(flat[i + 4])} ${r(flat[i + 5])}Z`);
  }
  return parts.join('');
}

/** The mesh file of a version, if the capture had one. */
export function meshFile(files = []) {
  return files.find((f) => f.kind === 'mesh' && f.url) ?? null;
}
