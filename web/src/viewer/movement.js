/**
 * First-person movement on the floor plane with collision against walls
 * (VIEW-02). Pure functions: the viewer calls `move` once a frame.
 */

export const BODY_RADIUS_M = 0.3;
export const WALK_SPEED = 1.6;
export const RUN_SPEED = 3.2;

/** The closest point to p on segment ab. */
function closest(p, a, b) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const len2 = abx * abx + aby * aby;
  const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2));
  return [a[0] + abx * t, a[1] + aby * t];
}

/** Pushes a body of `radius` at p out of every segment it overlaps. */
export function collide(p, segments, radius = BODY_RADIUS_M) {
  let [x, y] = p;
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (const s of segments) {
      const c = closest([x, y], s.a, s.b);
      const dx = x - c[0];
      const dy = y - c[1];
      const d = Math.hypot(dx, dy);
      if (d >= radius) continue;
      if (d < 1e-9) {
        // Exactly on the line: push along the segment's normal.
        const ex = s.b[0] - s.a[0];
        const ey = s.b[1] - s.a[1];
        const el = Math.hypot(ex, ey) || 1;
        x += (-ey / el) * radius;
        y += (ex / el) * radius;
      } else {
        x += (dx / d) * (radius - d);
        y += (dy / d) * (radius - d);
      }
      moved = true;
    }
    if (!moved) break;
  }
  return [x, y];
}

/**
 * One frame of walking. `yaw` is the facing on the plan (radians, 0 = +x);
 * `forward` and `strafe` are -1..1. Moves in small sub-steps so a fast walker
 * cannot pass through a thin wall.
 */
export function move(pos, yaw, { forward = 0, strafe = 0, run = false }, dt, segments) {
  const len = Math.hypot(forward, strafe);
  if (len < 1e-6 || dt <= 0) return pos;
  const f = forward / Math.max(1, len);
  const s = strafe / Math.max(1, len);
  const speed = run ? RUN_SPEED : WALK_SPEED;
  const dx = (Math.cos(yaw) * f - Math.sin(yaw) * s) * speed * dt;
  const dy = (Math.sin(yaw) * f + Math.cos(yaw) * s) * speed * dt;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (BODY_RADIUS_M / 2)));
  let p = pos;
  for (let i = 0; i < steps; i++) {
    p = collide([p[0] + dx / steps, p[1] + dy / steps], segments);
  }
  return p;
}

/** Distance between two 3D points, for the measure tool. */
export function distance3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
