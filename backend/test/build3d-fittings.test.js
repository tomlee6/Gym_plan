/**
 * Signs, power points, no-build zones and object blocks (J-07, and J-06's
 * plain boxes), checked by firing rays through the built level.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildLevel } from '../../shared/build3d/index.js';
import { emptyPlan } from '../../shared/plan/index.js';
import { readGlb, toGlb } from '../src/generator/glb.js';
import { firstVertical, hits } from './rays.js';

const wall = (id, a, b, extra = {}) => ({ id, a, b, confidence: 1, mirror: false, ...extra });
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const space = (id, kind, points, extra = {}) => ({ id, name: id, kind, points, floorFinish: 'rubber', ceilingHeightM: null, ceilingZones: [], ...extra });
const tag = (id, type, x, y) => ({ id, type, x, y, heightM: null });
const object = (id, x, y, extra = {}) => ({ id, x, y, w: 0.8, d: 2, angle: 0, heightM: 1.5, category: 'object', ...extra });

/** A 10 × 6 m room with a 3 m ceiling and a partition at x = 5. */
function room({ walls = [], ...extra } = {}) {
  return emptyPlan({
    ceilingHeightM: 3,
    walls: [wall('w1', [0, 0], [10, 0]), wall('w2', [10, 0], [10, 6]), wall('w3', [10, 6], [0, 6]), wall('w4', [0, 6], [0, 0]), wall('w5', [5, 0], [5, 6]), ...walls],
    spaces: [space('west', 'gym_floor', rect(0, 0, 5, 6)), space('east', 'studio', rect(5, 0, 10, 6))],
    ...extra,
  });
}

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ''} ${a} ≠ ${b}`);
const assumed = (level, kind) => level.defaultsUsed.find((d) => d.kind === kind)?.ids;

describe('signs and power points (J-07)', () => {
  it('fixes a fire exit sign to the wall it was tagged by, above head height', () => {
    const level = buildLevel(room({ tags: [tag('t1', 'fireExit', 2, 0.1)] }));
    const sign = hits(level, [2, 3, 2.35], [2, -1, 2.35])[0];
    assert.deepEqual([sign.node, sign.material], ['signs', 'exit_sign']);
    close(sign.at[1], 0.04, 'on the wall’s inside face, 4 cm deep:');
    assert.equal(hits(level, [2, 3, 2.15], [2, -1, 2.15])[0].node, 'walls-exterior', 'nothing below 2.25 m');
    assert.equal(hits(level, [2, 3, 2.55], [2, -1, 2.55])[0].node, 'walls-exterior', 'nothing above 2.45 m');
    assert.equal(hits(level, [2.3, 3, 2.35], [2.3, -1, 2.35])[0].node, 'walls-exterior', '40 cm wide');
  });

  it('puts a power point on the side of the wall it was tagged on, low down', () => {
    const level = buildLevel(room({ tags: [tag('t1', 'power', 5.2, 3)] }));
    const east = hits(level, [8, 3, 0.36], [5, 3, 0.36])[0];
    assert.deepEqual([east.node, east.material], ['signs', 'power_point']);
    assert.equal(hits(level, [2, 3, 0.36], [5, 3, 0.36])[0].node, 'walls', 'not on the west side');
  });

  it('hangs a sign with no wall near where it was tagged', () => {
    const level = buildLevel(room({ tags: [tag('t1', 'fireExit', 2.5, 3)] }));
    const sign = firstVertical(level, 2.5, 3, 2.9, 0);
    assert.equal(sign.node, 'signs');
    close(sign.at[2], 2.45);
  });

  it('draws nothing for the tags that only shaped the plan', () => {
    const level = buildLevel(room({ tags: [tag('t1', 'ceiling', 2, 2), tag('t2', 'mirror', 4.9, 2), tag('t3', 'stair', 7, 3)] }));
    assert.ok(!level.nodes.some((n) => n.name === 'signs'));
  });

  it('keeps the signs lit in the GLB', async () => {
    const level = buildLevel(room({ tags: [tag('t1', 'fireExit', 2, 0.1), tag('t2', 'power', 5.2, 3)] }));
    const doc = await readGlb(await toGlb(level, { generatorVersion: 'test', contentHash: 'h' }));
    const lit = Object.fromEntries(doc.getRoot().listMaterials().map((m) => [m.getName(), m.getEmissiveFactor()]));
    assert.ok(lit.exit_sign[1] > 0.3, 'exit signs glow green');
    assert.ok(lit.power_point[0] > 0.3, 'power points glow yellow');
    assert.deepEqual(lit.wall_interior, [0, 0, 0]);
  });
});

describe('no-build zones (J-07)', () => {
  it('marks a no-build zone on the floor, see-through, in a node of its own', () => {
    const level = buildLevel(room({ zones: [{ id: 'z1', points: rect(1, 1, 3, 2) }] }));
    const overlay = firstVertical(level, 2, 1.5, 2, -1);
    assert.deepEqual([overlay.node, overlay.material], ['zones', 'zone']);
    close(overlay.at[2], 0.01);
    assert.ok(level.materials.zone.alpha < 1 && level.materials.zone.doubleSided);
    assert.equal(firstVertical(level, 4, 1.5, 2, -1).node, 'floors', 'only over the zone');
  });
});

describe('objects and machines (J-06 boxes)', () => {
  it('raises machines and other objects as blocks in their own nodes', () => {
    const level = buildLevel(
      room({
        objects: [
          object('m1', 2, 3, { equipment: { equipmentId: 'e1', type: 'treadmill', name: 'Treadmill' } }),
          object('o1', 7, 3, { category: 'mesh', heightM: 0.9 }),
        ],
      }),
    );
    const machine = firstVertical(level, 2, 3, 2.5, -1);
    assert.deepEqual([machine.node, machine.material], ['machines', 'machine']);
    close(machine.at[2], 1.5);
    const lump = firstVertical(level, 7, 3, 2.5, -1);
    assert.deepEqual([lump.node, lump.material], ['objects', 'object']);
    close(lump.at[2], 0.9);
  });

  it('gives an object of no height 1.2 m, lifts one off the floor, and keeps all under the ceiling', () => {
    const level = buildLevel(
      room({
        objects: [
          object('o1', 2, 3, { heightM: null }),
          object('o2', 7, 2, { heightM: 0.6, elevationM: 1.5, d: 0.1 }),
          object('o3', 8.5, 4, { heightM: 9 }),
          object('o4', 3, 5, { w: 0 }),
        ],
      }),
    );
    close(firstVertical(level, 2, 3, 2.5, -1).at[2], 1.2);
    assert.deepEqual(assumed(level, 'object_height'), ['o1']);
    // Up off the floor: a ray under it meets the floor, one through it the object.
    assert.equal(hits(level, [6, 2, 1], [8, 2, 1]).filter((h) => h.node === 'objects').length, 0);
    assert.equal(hits(level, [6, 2, 1.8], [8, 2, 1.8])[0]?.node, 'objects');
    assert.ok(!hits(level, [7.5, 4, 3.05], [9.5, 4, 3.05]).some((h) => h.node === 'objects'), 'not through the ceiling');
    assert.deepEqual(level.skipped, [{ kind: 'object', id: 'o4', reason: 'no size' }]);
  });
});
