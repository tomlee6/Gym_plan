/**
 * Inside the rooms and the outside shell (J-03): ceiling zones, beams and
 * bulkheads, steps, platforms, ramps and pits, the roof and the ground,
 * checked by firing rays through the built level.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildLevel } from '../../shared/build3d/index.js';
import { emptyPlan } from '../../shared/plan/index.js';
import { firstVertical, hits, pointsOf } from './rays.js';

const wall = (id, a, b, extra = {}) => ({ id, a, b, confidence: 1, mirror: false, ...extra });
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

/** A 10 × 6 m room, one space with a 3 m ceiling and a rubber floor. */
function room(space = {}, extra = {}) {
  return emptyPlan({
    ceilingHeightM: 3,
    walls: [wall('w1', [0, 0], [10, 0]), wall('w2', [10, 0], [10, 6]), wall('w3', [10, 6], [0, 6]), wall('w4', [0, 6], [0, 0])],
    spaces: [{ id: 's1', name: 'Gym', kind: 'gym_floor', points: rect(0, 0, 10, 6), floorFinish: 'rubber', ceilingHeightM: null, ceilingZones: [], ...space }],
    ...extra,
  });
}

const up = (level, x, y, h = 1) => firstVertical(level, x, y, h, 20);
const down = (level, x, y, h = 2) => firstVertical(level, x, y, h, -5);
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ''} ${a} ≠ ${b}`);

describe('ceilings (J-03)', () => {
  it('raises and drops ceiling zones, with faces where the heights meet', () => {
    const level = buildLevel(
      room({
        ceilingZones: [
          { id: 'z1', points: rect(2, 2, 4, 4), heightM: 3.6 },
          { id: 'z2', points: rect(6, 2, 8, 4), heightM: 2.6 },
        ],
      }),
    );
    close(up(level, 3, 3).at[2], 3.6, 'raised zone');
    close(up(level, 7, 3).at[2], 2.6, 'dropped zone');
    close(up(level, 5, 3).at[2], 3, 'the rest of the room');
    // Sideways into each zone, between the two heights: the faces where they meet.
    assert.equal(hits(level, [1, 3, 3.3], [3, 3, 3.3])[0]?.node, 'ceilings');
    assert.equal(hits(level, [5, 3, 2.8], [7, 3, 2.8])[0]?.node, 'ceilings');
  });

  it('skips a zone with no height, and says so', () => {
    const level = buildLevel(room({ ceilingZones: [{ id: 'z1', points: rect(2, 2, 4, 4), heightM: null }] }));
    close(up(level, 3, 3).at[2], 3);
    assert.deepEqual(level.skipped, [{ kind: 'ceiling_zone', id: 'z1', reason: 'no height' }]);
  });

  it('takes a wall up to a raised zone beside it', () => {
    const level = buildLevel(room({ ceilingZones: [{ id: 'z1', points: rect(0, 0, 3, 6), heightM: 4 }] }));
    // The west wall, between the room's 3 m ceiling and the zone's 4 m.
    assert.equal(hits(level, [1, 3, 3.5], [-1, 3, 3.5])[0]?.node, 'walls-exterior');
  });

  it('hangs beams and bulkheads from the ceiling down to their underside', () => {
    const level = buildLevel(
      room(
        {},
        {
          beams: [
            { id: 'b1', kind: 'beam', points: rect(0, 2.8, 10, 3.2), bottomM: 2.5 },
            { id: 'b2', kind: 'bulkhead', points: rect(0, 5, 10, 6), bottomM: 2.7 },
            { id: 'b3', kind: 'beam', points: rect(0, 1, 10, 1.2), bottomM: null },
            { id: 'b4', kind: 'beam', points: rect(0, 4, 10, 4.2), bottomM: 3.2 },
          ],
        },
      ),
    );
    const beam = up(level, 5, 3);
    assert.equal(beam.node, 'beams');
    close(beam.at[2], 2.5);
    assert.equal(beam.material, 'beam');
    assert.equal(up(level, 5, 5.5).material, 'wall_interior', 'a bulkhead is boxed in and painted');
    // Right up to the ceiling: no gap above the beam.
    assert.equal(hits(level, [5, 2, 2.95], [5, 4, 2.95])[0]?.node, 'beams');
    assert.deepEqual(level.skipped, [
      { kind: 'beam', id: 'b3', reason: 'no underside height' },
      { kind: 'beam', id: 'b4', reason: 'above the ceiling' },
    ]);
  });
});

describe('floor levels (J-03)', () => {
  it('raises a platform in the floor finish around it', () => {
    const level = buildLevel(room({}, { levelChanges: [{ id: 'l1', kind: 'platform', points: rect(1, 1, 3, 2), heightM: 0.4 }] }));
    const top = down(level, 2, 1.5);
    assert.equal(top.node, 'level-changes');
    assert.equal(top.material, 'floor_rubber');
    close(top.at[2], 0.4);
    // Its side, seen from the room.
    assert.equal(hits(level, [5, 1.5, 0.2], [2, 1.5, 0.2])[0]?.node, 'level-changes');
  });

  it('sinks a pit into the floor, cutting the floor away above it', () => {
    const level = buildLevel(room({}, { levelChanges: [{ id: 'l1', kind: 'step', points: rect(1, 1, 3, 2), heightM: -0.5 }] }));
    const bottom = down(level, 2, 1.5);
    assert.equal(bottom.node, 'level-changes');
    close(bottom.at[2], -0.5);
    close(down(level, 5, 3).at[2], 0, 'the floor around it');
    // The pit's side, seen from inside the pit.
    assert.equal(hits(level, [2, 1.5, -0.25], [0.5, 1.5, -0.25])[0]?.node, 'level-changes');
  });

  it('slopes a ramp up the way it faces, or along its longest side', () => {
    const facing = buildLevel(room({}, { levelChanges: [{ id: 'l1', kind: 'ramp', points: rect(1, 1, 4, 2), heightM: 0.3, rampAngleDeg: 180 }] }));
    // Rising towards -x: high at x = 1, low at x = 4.
    close(down(facing, 1.5, 1.5).at[2], 0.25);
    close(down(facing, 3.5, 1.5).at[2], 0.05);
    assert.ok(!facing.defaultsUsed.some((d) => d.kind === 'ramp_direction'));

    const guessed = buildLevel(room({}, { levelChanges: [{ id: 'l1', kind: 'ramp', points: rect(1, 1, 4, 2), heightM: 0.3 }] }));
    // Longest side of the anticlockwise outline runs west to east: rising towards +x.
    close(down(guessed, 3.5, 1.5).at[2], 0.25);
    assert.deepEqual(guessed.defaultsUsed.find((d) => d.kind === 'ramp_direction').ids, ['l1']);
  });

  it('skips a level change that does not rise', () => {
    const level = buildLevel(room({}, { levelChanges: [{ id: 'l1', kind: 'step', points: rect(1, 1, 3, 2), heightM: 0 }] }));
    assert.deepEqual(level.skipped, [{ kind: 'level_change', id: 'l1', reason: 'no rise' }]);
  });
});

describe('outside the building (J-03)', () => {
  it('puts a roof over the outer walls, above the highest ceiling', () => {
    const level = buildLevel(room({ ceilingZones: [{ id: 'z1', points: rect(4, 2, 6, 4), heightM: 4 }] }));
    const roof = down(level, -0.1, 3, 10);
    assert.equal(roof.node, 'roof');
    close(roof.at[2], 4.3, 'on the 4 m zone, not the 3 m walls');
    // Its edge comes down to the wall tops: no gap seen from outside.
    assert.equal(hits(level, [-1, 3, 3.5], [1, 3, 3.5])[0]?.node, 'roof');
    // From inside you see the ceiling, not the roof's underside.
    assert.equal(up(level, 2, 3).node, 'ceilings');
    assert.ok(pointsOf(level, 'roof').every((p) => p[2] >= 3 - 1e-6));
  });

  it('lays the ground round the building, but not under it', () => {
    const level = buildLevel(room());
    const ground = down(level, -3, 3);
    assert.equal(ground.node, 'ground');
    close(ground.at[2], 0);
    assert.ok(!hits(level, [5, 3, 2], [5, 3, -5]).some((h) => h.node === 'ground'));
    // Five metres beyond the building's outside face.
    const xs = pointsOf(level, 'ground').map((p) => p[0]);
    close(Math.min(...xs), -5.2);
    close(Math.max(...xs), 15.2);
  });
});
