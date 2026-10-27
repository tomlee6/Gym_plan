/**
 * Looking into a built 3D level from the tests: fire a ray and see what it
 * meets, so the tests hold whatever triangles the generator chooses to make.
 * Points are plan x, plan y and height.
 */

/** Everything a ray from `from` to `to` passes through, nearest first: `{ node, material, t, at }`. */
export function hits(level, from, to) {
  const o = [from[0], from[2], from[1]];
  const d = [to[0] - from[0], to[2] - from[2], to[1] - from[1]];
  const out = [];
  for (const node of level.nodes) {
    for (const p of node.primitives) {
      const v = (i) => [p.positions[i * 3], p.positions[i * 3 + 1], p.positions[i * 3 + 2]];
      for (let k = 0; k < p.indices.length; k += 3) {
        const t = rayTriangle(o, d, v(p.indices[k]), v(p.indices[k + 1]), v(p.indices[k + 2]));
        if (t !== null && t > 0 && t < 1) {
          const at = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
          out.push({ node: node.name, material: p.material, t, at });
        }
      }
    }
  }
  return out.sort((x, y) => x.t - y.t);
}

/** The first thing straight below (or above) a plan point, from `fromH` towards `toH`. */
export function firstVertical(level, x, y, fromH, toH) {
  return hits(level, [x, y, fromH], [x, y, toH])[0] ?? null;
}

function rayTriangle(o, d, a, b, c) {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
  const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (Math.abs(det) < 1e-12) return null;
  const s = [o[0] - a[0], o[1] - a[1], o[2] - a[2]];
  const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) / det;
  if (u < 0 || u > 1) return null;
  const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
  const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
  if (v < 0 || u + v > 1) return null;
  return (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
}

/** The plan-space points (x, y, height) of every vertex in a node. */
export function pointsOf(level, name) {
  const node = level.nodes.find((n) => n.name === name);
  if (!node) return [];
  return node.primitives.flatMap((p) =>
    Array.from({ length: p.positions.length / 3 }, (_, i) => [p.positions[i * 3], p.positions[i * 3 + 2], p.positions[i * 3 + 1]]),
  );
}
