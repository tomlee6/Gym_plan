/** 2D geometry on the floor plane, in metres. Points are `[x, y]`. */

export const EPS = 1e-9;

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
export const scale = (a, k) => [a[0] * k, a[1] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
export const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const mid = (a, b) => lerp(a, b, 0.5);

export function segLength(s) {
  return dist(s.a, s.b);
}

/** Unit vector from a to b, or [1, 0] for a zero-length segment. */
export function direction(a, b) {
  const d = dist(a, b);
  return d < EPS ? [1, 0] : [(b[0] - a[0]) / d, (b[1] - a[1]) / d];
}

/** Where p projects onto segment ab: `t` in [0, 1] along it, and the point. */
export function project(p, a, b) {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  if (len2 < EPS) return { t: 0, point: a, distance: dist(p, a) };
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / len2));
  const point = lerp(a, b, t);
  return { t, point, distance: dist(p, point) };
}

/**
 * Where segments ab and cd cross, as parameters along each, or null if they
 * are parallel or do not meet.
 */
export function intersect(a, b, c, d) {
  const r = sub(b, a);
  const s = sub(d, c);
  const denom = cross(r, s);
  if (Math.abs(denom) < EPS) return null;
  const qp = sub(c, a);
  const t = cross(qp, s) / denom;
  const u = cross(qp, r) / denom;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return { t, u, point: lerp(a, b, t) };
}

/** Shoelace area of a polygon (absolute). */
export function polygonArea(points) {
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    twice += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(twice) / 2;
}

/** The four corners of a rectangle centred on (x, y), `angle` in radians. */
export function rectCorners({ x, y, w, d, angle = 0 }) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const hx = [c * (w / 2), s * (w / 2)];
  const hz = [-s * (d / 2), c * (d / 2)];
  return [
    [x - hx[0] - hz[0], y - hx[1] - hz[1]],
    [x + hx[0] - hz[0], y + hx[1] - hz[1]],
    [x + hx[0] + hz[0], y + hx[1] + hz[1]],
    [x - hx[0] + hz[0], y - hx[1] + hz[1]],
  ];
}

export function pointInPolygon(p, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Bounding box of a list of points, or null when empty. */
export function bounds(points) {
  if (!points.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** The centroid of a polygon's corners: good enough to label or test a shape. */
export function centroid(points) {
  if (!points?.length) return null;
  const sx = points.reduce((s, p) => s + p[0], 0);
  const sy = points.reduce((s, p) => s + p[1], 0);
  return [sx / points.length, sy / points.length];
}

/**
 * Points along a curved wall from `a` to `b`, ends included (format v3).
 *
 * `curveM` is the sagitta: how far the middle of the arc sits from the
 * straight chord, positive to the left of a→b. Zero or null is a straight
 * wall, returned as its two ends.
 */
export function arcPoints(a, b, curveM, segments = 16) {
  const chord = dist(a, b);
  if (!curveM || !Number.isFinite(curveM) || chord < EPS) return [a, b];
  const s = curveM;
  // Radius of the circle through a, b and the arc's midpoint.
  const r = (chord * chord) / (8 * Math.abs(s)) + Math.abs(s) / 2;
  const m = mid(a, b);
  const [dx, dy] = direction(a, b);
  const left = [-dy, dx];
  // The centre sits on the far side of the chord from the bulge.
  const toCentre = r - Math.abs(s);
  const sign = Math.sign(s);
  const c = [m[0] - left[0] * sign * toCentre, m[1] - left[1] * sign * toCentre];
  const start = Math.atan2(a[1] - c[1], a[0] - c[0]);
  let end = Math.atan2(b[1] - c[1], b[0] - c[0]);
  // Sweep the short way for a shallow bulge, the long way past a semicircle.
  let sweep = end - start;
  const wantLong = Math.abs(s) > chord / 2;
  while (sweep <= -Math.PI) sweep += 2 * Math.PI;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  if (wantLong) sweep = sweep > 0 ? sweep - 2 * Math.PI : sweep + 2 * Math.PI;
  // The bulge must land on the requested side; flip the sweep if not.
  const midAngle = start + sweep / 2;
  const probe = [c[0] + r * Math.cos(midAngle), c[1] + r * Math.sin(midAngle)];
  if (Math.sign(dot(sub(probe, m), left)) !== sign) {
    sweep = sweep > 0 ? sweep - 2 * Math.PI : sweep + 2 * Math.PI;
  }
  end = start + sweep;
  const points = [];
  for (let i = 0; i <= segments; i++) {
    const t = start + ((end - start) * i) / segments;
    points.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
  }
  points[0] = a;
  points[points.length - 1] = b;
  return points;
}

/** The length of a wall along its arc, or its chord when straight. */
export function arcLength(a, b, curveM) {
  const chord = dist(a, b);
  if (!curveM || !Number.isFinite(curveM) || chord < EPS) return chord;
  const s = Math.abs(curveM);
  const r = (chord * chord) / (8 * s) + s / 2;
  const half = Math.asin(Math.min(1, chord / (2 * r)));
  const theta = s > chord / 2 ? 2 * Math.PI - 2 * half : 2 * half;
  return r * theta;
}

/**
 * How well a set of polygons tiles an outline: the area of the outline no
 * polygon covers, and the area two or more polygons claim, sampled on a
 * grid. A grid is used rather than exact clipping because spaces may be any
 * shape, and a centimetre-exact answer is not the question: the validator
 * only needs to know whether gaps or overlaps exceed a small tolerance.
 */
export function coverage(outlinePoints, polygons, { maxCells = 40000 } = {}) {
  const box = bounds(outlinePoints);
  if (!box) return { gapM2: 0, overlapM2: 0, outlineM2: 0 };
  const w = box.maxX - box.minX;
  const h = box.maxY - box.minY;
  const cell = Math.max(0.05, Math.sqrt((w * h) / maxCells));
  let gap = 0;
  let overlap = 0;
  let inside = 0;
  for (let y = box.minY + cell / 2; y < box.maxY; y += cell) {
    for (let x = box.minX + cell / 2; x < box.maxX; x += cell) {
      const p = [x, y];
      if (!pointInPolygon(p, outlinePoints)) continue;
      inside++;
      let hits = 0;
      for (const poly of polygons) if (poly.length >= 3 && pointInPolygon(p, poly)) hits++;
      if (hits === 0) gap++;
      else if (hits > 1) overlap++;
    }
  }
  const a = cell * cell;
  return { gapM2: gap * a, overlapM2: overlap * a, outlineM2: inside * a };
}
