/**
 * The 3D level for an approved plan (GEN-01..05): pure data, no three.js and
 * no file format, so the backend writes it as a GLB and the browser can use
 * the same code for collision. The rules are docs/3d-contract.md.
 *
 * The same plan always gives the same level: elements are taken in order of
 * their id and every number is rounded before it is stored.
 */
import { dist } from '../plan/geometry.js';
import { outline } from '../plan/model.js';
import { buildFittings } from './fittings.js';
import { MATERIALS } from './materials.js';
import { cleanRing, MeshBuilder, signedArea } from './mesh.js';
import { buildShell } from './shell.js';
import { buildSpaces, ceilingOf } from './spaces.js';
import { buildStructure, floorHoles } from './structure.js';
import { BUILD3D_VERSION } from './version.js';
import { walkData, WalkBuilder } from './walk.js';
import { buildWalls, wallAxis, withArcs } from './walls.js';

export class Build3dError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'Build3dError';
    this.code = code;
  }
}

const byId = (x, y) => String(x.id).localeCompare(String(y.id));
const round = (n) => Math.round(n * 1e6) / 1e6;

/**
 * The same ring whatever order it was traced in: anticlockwise, starting at
 * its lowest-then-leftmost corner. Keeps the output byte-identical when the
 * plan lists the same walls in a different order.
 */
export function canonicalRing(points) {
  let ring = cleanRing(points).map(([x, y]) => [round(x), round(y)]);
  if (ring.length < 3) return ring;
  if (signedArea(ring) < 0) ring = ring.reverse();
  let first = 0;
  ring.forEach((p, i) => {
    const q = ring[first];
    if (p[1] < q[1] || (p[1] === q[1] && p[0] < q[0])) first = i;
  });
  return [...ring.slice(first), ...ring.slice(0, first)];
}

/** Collects meshes by node and material, what was assumed, and what was left out. */
class LevelBuilder {
  constructor() {
    this.nodes = new Map();
    this.defaults = new Map();
    this.left = [];
    this.walk = new WalkBuilder();
  }

  mesh(node, material) {
    if (!MATERIALS[material]) throw new Error(`Unknown material ${material}`);
    if (!this.nodes.has(node)) this.nodes.set(node, new Map());
    const parts = this.nodes.get(node);
    if (!parts.has(material)) parts.set(material, new MeshBuilder());
    return parts.get(material);
  }

  assumed(kind, id) {
    if (!this.defaults.has(kind)) this.defaults.set(kind, []);
    this.defaults.get(kind).push(id);
  }

  skipped(kind, id, reason) {
    this.left.push({ kind, id, reason });
  }
}

/** A plan point the generator can use. */
const isPoint = (p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]);

/** The spaces the generator draws: the plan's, or the outline as one space. */
function spacesOf(plan, floor, lb) {
  const spaces = [];
  for (const s of [...(plan.spaces ?? [])].sort(byId)) {
    if ((s.points ?? []).filter(isPoint).length >= 3) spaces.push(s);
    else lb.skipped('space', s.id, 'no shape');
  }
  if (spaces.length) return spaces;
  lb.assumed('space_from_outline', null);
  return [{ id: 'outline', name: 'Floor', kind: 'gym_floor', points: floor, floorFinish: null, ceilingHeightM: null, ceilingZones: [] }];
}

/**
 * The level for `plan` (format 3; older plans are read with missing fields
 * as unset). Returns `{ version, nodes, materials, bounds, stats,
 * defaultsUsed, skipped, walk }` where each node is
 * `{ name, primitives: [{ material, positions, normals, uvs, indices }] }`
 * and `walk` is what the walkthrough needs (walk.js).
 */
export function buildLevel(plan) {
  const lb = new LevelBuilder();
  const walls = [];
  for (const w of [...(plan?.walls ?? [])].sort(byId)) {
    if (isPoint(w.a) && isPoint(w.b) && dist(w.a, w.b) > 1e-6) walls.push(w);
    else lb.skipped('wall', w.id, 'no length');
  }
  if (walls.length < 3) {
    throw new Build3dError(
      'too_few_walls',
      'The plan has fewer than three walls, so there is no room to build. Draw the walls in the editor, or ask for a rescan.',
    );
  }
  const traced = outline({ ...plan, walls });
  const chords = traced ? canonicalRing(traced) : null;
  if (!chords || chords.length < 3) {
    throw new Build3dError(
      'open_outline',
      'The walls do not close round the floor, so it cannot be built. Join the gaps between wall ends in the editor.',
    );
  }

  // Curved walls: the outline and the spaces follow their arcs, not their chords.
  const axes = new Map(walls.map((w) => [w.id, wallAxis(w)]));
  const floor = withArcs(chords, walls, axes);
  const spaces = spacesOf(plan, floor, lb).map((s) => ({ ...s, points: withArcs(cleanRing(s.points), walls, axes) }));

  buildSpaces(lb, { plan, spaces, holes: floorHoles(plan) });
  buildStructure(lb, { plan, spaces });
  const specs = buildWalls(lb, { plan, walls, axes, floor, spaces });
  buildFittings(lb, { plan, spaces, walls, axes, specs });
  const ceilingTop = Math.max(
    ...spaces.flatMap((s) => [ceilingOf(s, plan), ...(s.ceilingZones ?? []).map((z) => (z.heightM > 0 ? z.heightM : 0))]),
  );
  buildShell(lb, { floor, walls, axes, specs, ceilingTop });

  // Output, in a fixed order. The bounds are the building's: the ground is left out.
  const nodes = [];
  const used = new Set();
  let triangles = 0;
  let vertices = 0;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const name of [...lb.nodes.keys()].sort()) {
    const primitives = [];
    for (const material of [...lb.nodes.get(name).keys()].sort()) {
      const mb = lb.nodes.get(name).get(material);
      if (mb.empty) continue;
      used.add(material);
      triangles += mb.triangleCount;
      vertices += mb.vertexCount;
      const arrays = mb.toArrays();
      for (let i = 0; name !== 'ground' && i < arrays.positions.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], arrays.positions[i + k]);
          max[k] = Math.max(max[k], arrays.positions[i + k]);
        }
      }
      primitives.push({ material, ...arrays });
    }
    if (primitives.length) nodes.push({ name, primitives });
  }

  const defaultsUsed = [...lb.defaults.keys()].sort().map((kind) => ({
    kind,
    count: lb.defaults.get(kind).length,
    ids: lb.defaults.get(kind).filter(Boolean).sort(),
  }));

  return {
    version: BUILD3D_VERSION,
    nodes,
    materials: Object.fromEntries([...used].sort().map((k) => [k, MATERIALS[k]])),
    bounds: { min: min.map(round), max: max.map(round) },
    stats: { triangles, vertices },
    defaultsUsed,
    skipped: lb.left,
    walk: walkData(floor, lb.walk),
  };
}
