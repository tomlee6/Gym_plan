/**
 * What is inside the rooms (task J-03): floors and ceilings per space,
 * raised and dropped ceiling zones, beams and bulkheads, and steps,
 * platforms and ramps. The rules are docs/3d-contract.md.
 */
import { centroid, dist, pointInPolygon, project } from '../plan/geometry.js';
import { DEFAULT_FINISH_BY_KIND, floorMaterial } from './materials.js';
import { cleanRing, signedArea } from './mesh.js';
import { blocksWalker, LEVEL_CHANGE_M } from './walk.js';

const byId = (x, y) => String(x.id).localeCompare(String(y.id));

/** A ring of at least three points, anticlockwise, or null. */
export function ringOf(points) {
  const ring = cleanRing(points);
  if (ring.length < 3 || Math.abs(signedArea(ring)) < 1e-6) return null;
  return signedArea(ring) < 0 ? ring.reverse() : ring;
}

/** A space's ceiling height: its own, or the level's. */
export const ceilingOf = (space, plan) => (space.ceilingHeightM > 0 ? space.ceilingHeightM : plan.ceilingHeightM);

/** A space's ceiling zones that can be drawn: a shape and a height, in order of id. */
const zonesOf = (space) =>
  [...(space.ceilingZones ?? [])].sort(byId).filter((z) => z.heightM > 0 && ringOf(z.points));

/**
 * The ceiling height over a plan point: a ceiling zone's there is one,
 * else the space's, or null outside every space.
 */
export function ceilingAt(p, spaces, plan) {
  const space = spaces.find((s) => pointInPolygon(p, s.points));
  if (!space) return null;
  const zone = zonesOf(space).find((z) => pointInPolygon(p, z.points));
  return zone ? zone.heightM : ceilingOf(space, plan);
}

/** Whether a point lies on the edge of a ring (within a centimetre). */
function onEdge(p, ring) {
  for (let i = 0; i < ring.length; i++) {
    if (project(p, ring[i], ring[(i + 1) % ring.length]).distance <= 0.01) return true;
  }
  return false;
}

/** The space a shape stands in (by its middle), or undefined. */
const spaceUnder = (ring, spaces) => spaces.find((s) => pointInPolygon(centroid(ring), s.points));

/** The floor material of a space, recording the default when its finish is unset. */
function finishOf(space, lb) {
  if (space.floorFinish) return floorMaterial(space.floorFinish);
  lb.assumed('floor_finish', space.id);
  return floorMaterial(DEFAULT_FINISH_BY_KIND[space.kind ?? 'gym_floor'] ?? 'concrete');
}

/** A ramp's rise direction: `rampAngleDeg`, else along its longest side. */
function rampDirection(lc, ring, lb) {
  if (Number.isFinite(lc.rampAngleDeg)) {
    const r = (lc.rampAngleDeg * Math.PI) / 180;
    return [Math.cos(r), Math.sin(r)];
  }
  lb.assumed('ramp_direction', lc.id);
  let best = null;
  for (let i = 0; i < ring.length; i++) {
    const [a, b] = [ring[i], ring[(i + 1) % ring.length]];
    const len = dist(a, b);
    if (!best || len > best.len + 1e-9) best = { len, d: [(b[0] - a[0]) / len, (b[1] - a[1]) / len] };
  }
  return best.d;
}

/**
 * A step, platform or ramp: its surface at `heightOf(p)`, and sides down to
 * the floor (raised) or up to it (sunken, which is also a hole in the floor).
 */
function levelChange(lb, lc, ring, material) {
  const rise = lc.heightM;
  let heightOf = () => rise;
  let normal = [0, 1, 0];
  if (lc.kind === 'ramp') {
    const d = rampDirection(lc, ring, lb);
    const along = ring.map((p) => p[0] * d[0] + p[1] * d[1]);
    const [lo, hi] = [Math.min(...along), Math.max(...along)];
    const k = rise / (hi - lo);
    heightOf = (p) => (p[0] * d[0] + p[1] * d[1] - lo) * k;
    normal = [-d[0] * k, 1, -d[1] * k];
  }
  const mesh = lb.mesh('level-changes', material);
  mesh.surface(ring, heightOf, normal);
  for (let i = 0; i < ring.length; i++) {
    const [a, b] = [ring[i], ring[(i + 1) % ring.length]];
    const [ha, hb] = [heightOf(a), heightOf(b)];
    // Raised: the sides face out from the shape. Sunken: they face into the pit.
    const out = rise > 0 ? 1 : -1;
    const n = [(b[1] - a[1]) * out, 0, -(b[0] - a[0]) * out];
    mesh.quad([a[0], 0, a[1]], [b[0], 0, b[1]], [b[0], hb, b[1]], [a[0], ha, a[1]], n);
  }
}

/**
 * Draws floors, ceilings, ceiling zones, beams and level changes into `lb`.
 * `spaces` are already drawn along any curved walls; `holes` are other
 * openings in the floor (stairs and voids), each cut from the space it is in.
 */
export function buildSpaces(lb, { plan, spaces, holes = [] }) {
  // Steps, platforms and ramps, each in the space it stands in.
  const changes = [];
  for (const lc of [...(plan.levelChanges ?? [])].sort(byId)) {
    const ring = ringOf(lc.points);
    if (!ring) {
      lb.skipped('level_change', lc.id, 'no shape');
    } else if (!(Number.isFinite(lc.heightM) && Math.abs(lc.heightM) > 1e-3)) {
      lb.skipped('level_change', lc.id, 'no rise');
    } else {
      changes.push({ lc, ring, space: spaceUnder(ring, spaces) });
    }
  }

  const finishes = new Map(spaces.map((s) => [s, finishOf(s, lb)]));
  for (const s of spaces) {
    // A sunken step or ramp is a hole in the floor, with its own floor below.
    const pits = changes.filter((c) => c.space === s && c.lc.heightM < 0).map((c) => c.ring);
    const voids = holes.filter((ring) => spaceUnder(ring, spaces) === s);
    lb.mesh('floors', finishes.get(s)).polygon(s.points, 0, { up: true, holes: [...pits, ...voids] });

    // The ceiling, with each zone cut out and drawn at its own height.
    const height = ceilingOf(s, plan);
    const zones = zonesOf(s);
    lb.mesh('ceilings', 'ceiling').polygon(s.points, height, { up: false, holes: zones.map((z) => ringOf(z.points)) });
    for (const z of zones) {
      const ring = ringOf(z.points);
      const mesh = lb.mesh('ceilings', 'ceiling');
      mesh.polygon(ring, z.heightM, { up: false });
      // Where the heights meet: faces into a raised zone, out of a dropped one.
      // Not along the room's own edge, where the wall already is.
      const [lo, hi] = [Math.min(height, z.heightM), Math.max(height, z.heightM)];
      const inward = z.heightM > height ? 1 : -1;
      for (let i = 0; i < ring.length; i++) {
        const [a, b] = [ring[i], ring[(i + 1) % ring.length]];
        const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (onEdge(a, s.points) && onEdge(b, s.points) && onEdge(m, s.points)) continue;
        const n = [-(b[1] - a[1]) * inward, 0, (b[0] - a[0]) * inward];
        mesh.quad([a[0], lo, a[1]], [b[0], lo, b[1]], [b[0], hi, b[1]], [a[0], hi, a[1]], n);
      }
    }
    for (const z of s.ceilingZones ?? []) {
      if (!zones.includes(z)) lb.skipped('ceiling_zone', z.id, ringOf(z.points) ? 'no height' : 'no shape');
    }
  }

  // Finished like the floor around them. A ramp is walked; a big enough step or pit is not.
  for (const { lc, ring, space } of changes) {
    levelChange(lb, lc, ring, finishes.get(space) ?? 'floor_concrete');
    if (lc.kind !== 'ramp' && Math.abs(lc.heightM) > LEVEL_CHANGE_M) lb.walk.block(ring);
  }

  // Beams and bulkheads, from their underside up to the ceiling above them.
  for (const b of [...(plan.beams ?? [])].sort(byId)) {
    const ring = ringOf(b.points);
    if (!ring) {
      lb.skipped('beam', b.id, 'no shape');
      continue;
    }
    if (!(b.bottomM > 0)) {
      lb.skipped('beam', b.id, 'no underside height');
      continue;
    }
    // The highest ceiling over it: sampled at its middle and just inside each corner.
    const c = centroid(ring);
    const samples = [c, ...ring.map((p) => [p[0] + (c[0] - p[0]) * 0.02, p[1] + (c[1] - p[1]) * 0.02])];
    const ceilings = samples.map((p) => ceilingAt(p, spaces, plan)).filter((h) => h !== null);
    const top = ceilings.length ? Math.max(...ceilings) : plan.ceilingHeightM;
    if (b.bottomM >= top - 0.01) {
      lb.skipped('beam', b.id, 'above the ceiling');
      continue;
    }
    lb.mesh('beams', b.kind === 'bulkhead' ? 'wall_interior' : 'beam').prism(ring, b.bottomM, top);
    if (blocksWalker(b.bottomM, top)) lb.walk.block(ring);
  }
}
