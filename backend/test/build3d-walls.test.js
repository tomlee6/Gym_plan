/**
 * Walls and openings in the 3D level (J-02): what is solid, what is cut and
 * what fills the cut, checked by firing rays through the built level, so
 * the tests hold whatever triangles the generator chooses to make.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildLevel, wallAxis } from '../../shared/build3d/index.js';
import { emptyPlan } from '../../shared/plan/index.js';
import { hits, pointsOf } from './rays.js';

const wall = (id, a, b, extra = {}) => ({ id, a, b, confidence: 1, mirror: false, ...extra });
const opening = (id, wallId, kind, offset, width, extra = {}) => ({ id, wallId, kind, offset, width, type: null, ...extra });
const space = (id, kind, points, extra = {}) => ({ id, name: id, kind, points, floorFinish: null, ceilingHeightM: null, ceilingZones: [], ...extra });

/** A 10 × 6 m box, its south wall w1 running west to east along y = 0, the room to its north. */
function box({ openings = [], walls = [], spaces = [] } = {}) {
  return emptyPlan({
    ceilingHeightM: 3,
    walls: [wall('w1', [0, 0], [10, 0]), wall('w2', [10, 0], [10, 6]), wall('w3', [10, 6], [0, 6]), wall('w4', [0, 6], [0, 0]), ...walls],
    openings,
    spaces,
  });
}

/** The nodes met going through the south wall at `x`, `h` metres up, from inside to out. */
const throughSouth = (level, x, h) => [...new Set(hits(level, [x, 1, h], [x, -1, h]).map((x) => x.node))];
const isWall = (n) => n === 'walls' || n === 'walls-exterior';

describe('walls and openings (J-02)', () => {
  it('closes the outside corners of exterior walls', () => {
    const level = buildLevel(box());
    // Diagonally into the south-west corner, through the corner square both walls' thickness covers.
    const corner = hits(level, [-1, -1, 1.5], [0.05, 0.05, 1.5]);
    assert.equal(corner[0]?.node, 'walls-exterior');
    // Painted like the rooms on the inside, exterior finish outside.
    const south = level.nodes.find((n) => n.name === 'walls-exterior').primitives.map((p) => p.material);
    assert.deepEqual(south, ['wall_exterior', 'wall_interior']);
    assert.equal(hits(level, [5, 1, 1.5], [5, -1, 1.5])[0].material, 'wall_interior');
    assert.equal(hits(level, [5, -1, 1.5], [5, 1, 1.5])[0].material, 'wall_exterior');
  });

  it('cuts a window from its sill to its head and glazes it, with the defaults recorded', () => {
    const level = buildLevel(box({ openings: [opening('o1', 'w1', 'window', 4, 2)] }));
    assert.deepEqual(throughSouth(level, 5, 0.5), ['walls-exterior'], 'below the 0.9 m sill');
    assert.deepEqual(throughSouth(level, 5, 1.5), ['glass'], 'through the window');
    assert.deepEqual(throughSouth(level, 5, 2.4), ['walls-exterior'], 'above the 2.1 m head');
    assert.deepEqual(throughSouth(level, 3.5, 1.5), ['walls-exterior'], 'beside it');
    const defaults = Object.fromEntries(level.defaultsUsed.map((d) => [d.kind, d.ids]));
    assert.deepEqual(defaults.opening_sill, ['o1']);
    assert.deepEqual(defaults.opening_height, ['o1']);
  });

  it('uses a measured sill and height, clipped to the wall top', () => {
    const level = buildLevel(box({ openings: [opening('o1', 'w1', 'fixed_glazing', 4, 2, { sillHeightM: 0.3, heightM: 5 })] }));
    assert.deepEqual(throughSouth(level, 5, 0.2), ['walls-exterior']);
    assert.deepEqual(throughSouth(level, 5, 2.9), ['glass'], 'glazed right up to the 3 m wall top');
    assert.ok(!level.defaultsUsed.some((d) => d.kind.startsWith('opening_')));
  });

  it('leaves a door open at 90° into the space it swings into, hinged where the plan says', () => {
    const plan = box({
      walls: [wall('w5', [5, 0], [5, 6])],
      openings: [opening('o1', 'w5', 'single_door', 2, 0.9, { hinge: 'right', swingInto: 'west' })],
      spaces: [space('west', 'gym_floor', [[0, 0], [5, 0], [5, 6], [0, 6]]), space('east', 'studio', [[5, 0], [10, 0], [10, 6], [5, 6]])],
    });
    const level = buildLevel(plan);
    // Through the doorway, at 1 m: nothing in the way.
    assert.deepEqual(hits(level, [4, 2.45, 1], [6, 2.45, 1]).filter((h) => isWall(h.node) || h.node === 'doors'), []);
    // The leaf: on the west side, at the hinge end (y = 2.9), sticking out 0.9 m.
    const leaf = pointsOf(level, 'doors');
    const xs = leaf.map((p) => p[0]);
    const ys = leaf.map((p) => p[1]);
    assert.ok(Math.max(...xs) <= 5 - 0.075 + 1e-6 && Math.min(...xs) >= 5 - 0.075 - 0.9 - 1e-6, `leaf x ${Math.min(...xs)}..${Math.max(...xs)}`);
    assert.ok(Math.min(...ys) >= 2.9 - 0.04 - 1e-6 && Math.max(...ys) <= 2.9 + 1e-6, `leaf y ${Math.min(...ys)}..${Math.max(...ys)}`);
    assert.ok(!level.defaultsUsed.some((d) => d.kind === 'door_swing' || d.kind === 'door_hinge'));
  });

  it('opens a door with no swing to the left of its wall, and says so', () => {
    const level = buildLevel(box({ openings: [opening('o1', 'w1', 'double_door', 4, 1.8)] }));
    const leaf = pointsOf(level, 'doors');
    // Left of w1 (west to east) is north, into the room; two leaves, one at each jamb.
    assert.ok(leaf.every((p) => p[1] >= -1e-6), 'into the room');
    assert.ok(leaf.some((p) => Math.abs(p[0] - 4) < 0.05) && leaf.some((p) => Math.abs(p[0] - 5.8) < 0.05));
    assert.deepEqual(level.defaultsUsed.find((d) => d.kind === 'door_swing').ids, ['o1']);
    assert.ok(!level.defaultsUsed.some((d) => d.kind === 'door_hinge'), 'a double door has no hinge side to guess');
    // The floor carries on under the door, through the wall's thickness.
    assert.equal(hits(level, [4.9, -0.1, 1], [4.9, -0.1, -1])[0]?.node, 'floors');
  });

  it('slides a sliding door away from a wall that meets its own', () => {
    const plan = box({ walls: [wall('w5', [6, 0], [6, 6])], openings: [opening('o1', 'w1', 'sliding_door', 4.5, 1.2)] });
    const panel = pointsOf(buildLevel(plan), 'doors');
    const xs = panel.map((p) => p[0]);
    // Towards b (east) it would run into w5 at x = 6, so it slides west.
    assert.ok(Math.max(...xs) <= 4.5 + 0.05 + 1e-6 && Math.min(...xs) >= 4.5 - 1.15 - 1e-6, `panel x ${Math.min(...xs)}..${Math.max(...xs)}`);
  });

  it('rolls a roller shutter up into a box under the ceiling, inside the building', () => {
    const level = buildLevel(box({ openings: [opening('o1', 'w1', 'roller_shutter', 3, 3)] }));
    assert.deepEqual(throughSouth(level, 4.5, 1.5), [], 'open from the floor up');
    const housing = pointsOf(level, 'doors');
    assert.ok(housing.every((p) => p[1] >= -1e-6), 'inside');
    assert.equal(Math.max(...housing.map((p) => p[2])), 3);
    assert.equal(Math.min(...housing.map((p) => p[2])), 2.7);
  });

  it('draws glass walls as glass', () => {
    const level = buildLevel(box({ walls: [wall('w5', [6, 0], [6, 6], { kind: 'glass' })] }));
    assert.equal(hits(level, [5, 3, 1.5], [7, 3, 1.5])[0].node, 'glass');
  });

  it('builds a curved wall along its arc, with the floor and ceiling following it', () => {
    // The east wall bulges 1.5 m outwards (to the right of south to north).
    const plan = box();
    plan.walls[1].curveM = -1.5;
    plan.openings = [opening('o1', 'w2', 'window', 2, 2, { sillHeightM: 1, heightM: 1.2 })];
    const level = buildLevel(plan);
    assert.equal(level.bounds.max[0], 11.7, 'bulge plus the wall thickness outwards');
    // At the middle of the bulge the floor reaches the wall's inside face at x = 11.5.
    assert.equal(hits(level, [11.45, 3, 1], [11.45, 3, -1])[0]?.node, 'floors');
    assert.equal(hits(level, [11.45, 3, 1], [11.45, 3, 4])[0]?.node, 'ceilings');
    // The window is cut where the plan puts it: its middle 3 m along the chord, on the arc.
    const axis = wallAxis(plan.walls[1]);
    const s = (3 / axis.chord) * axis.length;
    const [p, n] = [axis.at(s), axis.normal(s)];
    const through = (h) => [...new Set(hits(level, [p[0] + n[0], p[1] + n[1], h], [p[0] - n[0], p[1] - n[1], h]).map((x) => x.node))];
    assert.deepEqual(through(1.6), ['glass']);
    assert.deepEqual(through(0.5), ['walls-exterior']);
  });

  it('raises a wall to the highest ceiling anywhere along it', () => {
    const plan = box({
      walls: [wall('w5', [4, 0], [4, 6])],
      spaces: [space('low', 'gym_floor', [[0, 0], [4, 0], [4, 6], [0, 6]]), space('high', 'studio', [[4, 0], [10, 0], [10, 6], [4, 6]], { ceilingHeightM: 3.6 })],
    });
    // The north wall's middle (x = 5) is in the studio, but its west end is over the low gym floor.
    const level = buildLevel(plan);
    assert.equal(hits(level, [1, 5, 3.4], [1, 7, 3.4]).filter((h) => isWall(h.node)).length > 0, true);
  });

  it('lists the openings it could not place', () => {
    const level = buildLevel(box({ openings: [opening('o1', 'nowhere', 'window', 1, 1), opening('o2', 'w1', 'window', 20, 1)] }));
    assert.deepEqual(level.skipped, [
      { kind: 'opening', id: 'o1', reason: 'not on a wall' },
      { kind: 'opening', id: 'o2', reason: 'falls outside its wall' },
    ]);
  });

  it('gives the same level whatever order the walls and openings are listed in', () => {
    const make = () =>
      box({
        walls: [wall('w5', [6, 0], [6, 6])],
        openings: [opening('o1', 'w1', 'window', 1, 2), opening('o2', 'w5', 'single_door', 2, 0.9), opening('o3', 'w3', 'sliding_door', 1, 1.2)],
      });
    const shuffled = make();
    shuffled.walls.reverse();
    shuffled.openings.reverse();
    shuffled.walls[0].curveM = shuffled.walls[0].curveM ?? null;
    assert.equal(JSON.stringify(buildLevel(shuffled)), JSON.stringify(buildLevel(make())));
  });
});
