/**
 * What stands in or on the rooms (tasks J-07, and the plain boxes of J-06):
 * fire exit signs and power points from the scan's tags, the no-build zone
 * overlay, and every object and machine as a block at its footprint. The
 * rules are docs/3d-contract.md.
 */
import { rectCorners } from '../plan/geometry.js';
import { DEFAULT_OBJECT_HEIGHT_M } from '../plan/model.js';
import { ceilingAt, ringOf } from './spaces.js';
import { blocksWalker } from './walk.js';
import { faceAt } from './walls.js';

/** A tag this close to a wall is on it. */
const ON_WALL_M = 0.5;
/** Just above the floor, so the overlay never fights it for pixels. */
const ZONE_Y = 0.01;

/** How each tag is drawn: its size on a wall (width, height, depth) and height range. */
const SIGNS = {
  fireExit: { material: 'exit_sign', node: 'signs', width: 0.4, depth: 0.04, bottom: 2.25, top: 2.45, free: 0.45 },
  power: { material: 'power_point', node: 'signs', width: 0.16, depth: 0.03, bottom: 0.3, top: 0.42, free: 0.16 },
};

const byId = (x, y) => String(x.id).localeCompare(String(y.id));

/** The wall face nearest a point, within reach: `{ axis, s, face, side }`, or null. */
function wallFaceNear(p, { walls, axes, specs }) {
  let best = null;
  for (const w of walls) {
    const axis = axes.get(w.id);
    const hit = axis.nearest(p);
    if (hit.distance > ON_WALL_M || (best && hit.distance >= best.distance)) continue;
    const spec = specs.get(w.id);
    const at = axis.at(hit.s);
    const n = axis.normal(hit.s);
    // The face on the point's side (a point on the line goes on the room side).
    const along = (p[0] - at[0]) * n[0] + (p[1] - at[1]) * n[1];
    const side = Math.abs(along) > 1e-3 ? Math.sign(along) : spec.roomSide || 1;
    const face = spec.offset + (side * spec.thickness) / 2;
    best = { distance: hit.distance, axis, s: hit.s, face, side };
  }
  return best;
}

/** Draws signs, the no-build overlay and object blocks into `lb`. */
export function buildFittings(lb, { plan, spaces, walls, axes, specs }) {
  for (const tag of [...(plan.tags ?? [])].sort(byId)) {
    const sign = SIGNS[tag.type];
    if (!sign) continue; // ceiling, mirror and stair tags already shaped the plan.
    if (!Number.isFinite(tag.x) || !Number.isFinite(tag.y)) {
      lb.skipped('tag', tag.id, 'no position');
      continue;
    }
    const mesh = lb.mesh(sign.node, sign.material);
    const wall = wallFaceNear([tag.x, tag.y], { walls, axes, specs });
    if (wall) {
      // A plate on the wall's face, square to it.
      const c = faceAt(wall.axis, wall.s, wall.face);
      const t = wall.axis.tangent(wall.s);
      const n = wall.axis.normal(wall.s).map((v) => v * wall.side * sign.depth);
      const [a, b] = [
        [c[0] - (t[0] * sign.width) / 2, c[1] - (t[1] * sign.width) / 2],
        [c[0] + (t[0] * sign.width) / 2, c[1] + (t[1] * sign.width) / 2],
      ];
      mesh.prism(ringOf([a, b, [b[0] + n[0], b[1] + n[1]], [a[0] + n[0], a[1] + n[1]]]), sign.bottom, sign.top);
    } else {
      // Nowhere to fix it: a block where the tag is, as the viewer drew them.
      mesh.prism(ringOf(rectCorners({ x: tag.x, y: tag.y, w: sign.free, d: sign.free })), sign.bottom, sign.top);
    }
  }

  // No-build zones: a see-through overlay on the floor, in a node of its own.
  for (const z of [...(plan.zones ?? [])].sort(byId)) {
    const ring = ringOf(z.points);
    if (ring) lb.mesh('zones', 'zone').polygon(ring, ZONE_Y, { up: true });
    else lb.skipped('zone', z.id, 'no shape');
  }

  // Objects and machines as blocks at their footprint (machine models replace these in J-06).
  for (const o of [...(plan.objects ?? [])].sort(byId)) {
    if (!(o.w > 0 && o.d > 0) || !Number.isFinite(o.x) || !Number.isFinite(o.y)) {
      lb.skipped('object', o.id, 'no size');
      continue;
    }
    const bottom = o.elevationM > 0 ? o.elevationM : 0;
    let height = o.heightM;
    if (!(height > 0)) {
      height = DEFAULT_OBJECT_HEIGHT_M;
      lb.assumed('object_height', o.id);
    }
    // Never through the ceiling over it.
    const ceiling = ceilingAt([o.x, o.y], spaces, plan) ?? plan.ceilingHeightM;
    const top = Math.min(bottom + height, ceiling);
    if (!(top - bottom > 1e-3)) {
      lb.skipped('object', o.id, 'above the ceiling');
      continue;
    }
    const machine = Boolean(o.equipment);
    const ring = ringOf(rectCorners(o));
    lb.mesh(machine ? 'machines' : 'objects', machine ? 'machine' : 'object').prism(ring, bottom, top);
    if (blocksWalker(bottom, top)) lb.walk.block(ring);
  }
}
