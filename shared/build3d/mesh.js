/**
 * Triangle soup for one material, built in plan coordinates.
 *
 * A plan point `[x, y]` at height `h` becomes the 3D point `(x, h, y)`: plan
 * x on x, height on y (up), plan y on z. That is ARKit's own frame, so the
 * model lines up with the scan (docs/3d-contract.md).
 *
 * Every face is flat-shaded (its own vertices and one normal), and every
 * triangle is wound so that its front faces along the normal asked for. The
 * winding is checked per triangle rather than assumed, because mapping plan
 * y onto 3D z mirrors orientation when seen from above.
 */
import earcut from './earcut.js';

const round = (n) => Math.round(n * 1e6) / 1e6;

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function normalise(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 1, 0];
}

/** Texture coordinates in metres, projected along the normal's main axis. */
function uvOf(p, n) {
  const ax = Math.abs(n[0]);
  const ay = Math.abs(n[1]);
  const az = Math.abs(n[2]);
  if (ay >= ax && ay >= az) return [p[0], p[2]];
  if (ax >= az) return [p[2], p[1]];
  return [p[0], p[1]];
}

/** Signed area of a ring in plan coordinates (positive anticlockwise). */
export function signedArea(ring) {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/** The ring without repeated points or a closing duplicate. */
export function cleanRing(points) {
  const out = [];
  for (const p of points ?? []) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const last = out[out.length - 1];
    if (last && Math.hypot(last[0] - p[0], last[1] - p[1]) < 1e-6) continue;
    out.push([p[0], p[1]]);
  }
  if (out.length > 1) {
    const [f, l] = [out[0], out[out.length - 1]];
    if (Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-6) out.pop();
  }
  return out;
}

export class MeshBuilder {
  constructor() {
    this.positions = [];
    this.normals = [];
    this.uvs = [];
    this.indices = [];
  }

  get vertexCount() {
    return this.positions.length / 3;
  }

  get triangleCount() {
    return this.indices.length / 3;
  }

  get empty() {
    return this.indices.length === 0;
  }

  #vertex(p, n) {
    this.positions.push(round(p[0]), round(p[1]), round(p[2]));
    this.normals.push(round(n[0]), round(n[1]), round(n[2]));
    const uv = uvOf(p, n);
    this.uvs.push(round(uv[0]), round(uv[1]));
    return this.vertexCount - 1;
  }

  /** One triangle of 3D points, wound to face `normal`. Degenerate ones are dropped. */
  triangle(p0, p1, p2, normal) {
    const c = cross3(sub3(p1, p0), sub3(p2, p0));
    if (Math.hypot(c[0], c[1], c[2]) < 1e-12) return;
    const n = normalise(normal ?? c);
    const flip = dot3(c, n) < 0;
    const i0 = this.#vertex(p0, n);
    const i1 = this.#vertex(flip ? p2 : p1, n);
    const i2 = this.#vertex(flip ? p1 : p2, n);
    this.indices.push(i0, i1, i2);
  }

  /** A flat quad of 3D points a-b-c-d (in order round its edge), facing `normal`. */
  quad(a, b, c, d, normal) {
    const n = normal ?? cross3(sub3(b, a), sub3(c, a));
    this.triangle(a, b, c, n);
    this.triangle(a, c, d, n);
  }

  /**
   * A horizontal polygon at height `h`, with optional holes, facing up or
   * down. Rings are plan points; holes are cut out (earcut).
   */
  polygon(ring, h, { up = true, holes = [] } = {}) {
    const outer = cleanRing(ring);
    if (outer.length < 3 || Math.abs(signedArea(outer)) < 1e-9) return;
    const flat = [];
    const holeIndices = [];
    for (const p of outer) flat.push(p[0], p[1]);
    for (const hole of holes) {
      const h2 = cleanRing(hole);
      if (h2.length < 3 || Math.abs(signedArea(h2)) < 1e-9) continue;
      holeIndices.push(flat.length / 2);
      for (const p of h2) flat.push(p[0], p[1]);
    }
    const tris = earcut(flat, holeIndices.length ? holeIndices : undefined, 2);
    const n = up ? [0, 1, 0] : [0, -1, 0];
    const at = (i) => [flat[i * 2], h, flat[i * 2 + 1]];
    for (let i = 0; i < tris.length; i += 3) this.triangle(at(tris[i]), at(tris[i + 1]), at(tris[i + 2]), n);
  }

  /**
   * A flat surface over a plan ring, each point at `heightOf(point)`: a
   * sloped plane (a ramp) when the heights vary linearly. `normal` is the
   * side it faces.
   */
  surface(ring, heightOf, normal = [0, 1, 0]) {
    const outer = cleanRing(ring);
    if (outer.length < 3 || Math.abs(signedArea(outer)) < 1e-9) return;
    const flat = outer.flat();
    const tris = earcut(flat, undefined, 2);
    const at = (i) => [outer[i][0], heightOf(outer[i]), outer[i][1]];
    for (let i = 0; i < tris.length; i += 3) this.triangle(at(tris[i]), at(tris[i + 1]), at(tris[i + 2]), normal);
  }

  /** A closed vertical prism over a plan ring, from `bottom` to `top`. */
  prism(ring, bottom, top) {
    const r = cleanRing(ring);
    if (r.length < 3 || !(top > bottom)) return;
    this.polygon(r, top, { up: true });
    this.polygon(r, bottom, { up: false });
    // Outward sides: for an anticlockwise ring the outside is to the right.
    const ccw = signedArea(r) > 0;
    const path = ccw ? r : [...r].reverse();
    for (let i = 0; i < path.length; i++) {
      const a = path[i];
      const b = path[(i + 1) % path.length];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      this.quad([a[0], bottom, a[1]], [b[0], bottom, b[1]], [b[0], top, b[1]], [a[0], top, a[1]], [dy, 0, -dx]);
    }
  }

  /** The finished arrays, ready for a glTF primitive. */
  toArrays() {
    return {
      positions: this.positions,
      normals: this.normals,
      uvs: this.uvs,
      indices: this.indices,
    };
  }
}
