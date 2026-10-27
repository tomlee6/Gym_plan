/**
 * Columns, stairs, lifts, voids and mirrors (J-04), checked by firing rays
 * through the built level.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildLevel } from '../../shared/build3d/index.js';
import { emptyPlan } from '../../shared/plan/index.js';
import { firstVertical, hits } from './rays.js';

const wall = (id, a, b, extra = {}) => ({ id, a, b, confidence: 1, mirror: false, ...extra });
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const space = (id, kind, points) => ({ id, name: id, kind, points, floorFinish: 'rubber', ceilingHeightM: null, ceilingZones: [] });

/** A 10 × 6 m room with a 3 m ceiling; `walls` are added to its four, the rest replaces. */
function room({ walls = [], ...extra } = {}) {
  return emptyPlan({
    ceilingHeightM: 3,
    walls: [wall('w1', [0, 0], [10, 0]), wall('w2', [10, 0], [10, 6]), wall('w3', [10, 6], [0, 6]), wall('w4', [0, 6], [0, 0]), ...walls],
    spaces: [space('s1', 'gym_floor', rect(0, 0, 10, 6))],
    ...extra,
  });
}

const down = (level, x, y, h = 5) => firstVertical(level, x, y, h, -5);
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ''} ${a} ≠ ${b}`);
const assumed = (level, kind) => level.defaultsUsed.find((d) => d.kind === kind)?.ids;

describe('columns (J-04)', () => {
  it('stands a column up to the ceiling unless its height was measured', () => {
    const level = buildLevel(
      room({
        columns: [
          { id: 'c1', x: 2, y: 2, w: 0.4, d: 0.4, angle: 0, shape: 'rect', heightM: null },
          { id: 'c2', x: 5, y: 2, w: 0.4, d: 0.4, angle: 0, shape: 'rect', heightM: 1.2 },
        ],
      }),
    );
    // Up to the 3 m ceiling: met just under it, not above it.
    assert.equal(hits(level, [1, 2, 2.95], [3, 2, 2.95])[0]?.node, 'columns');
    assert.ok(!hits(level, [1, 2, 3.05], [3, 2, 3.05]).some((h) => h.node === 'columns'));
    close(down(level, 5, 2, 2.5).at[2], 1.2);
    assert.equal(down(level, 5, 2, 2.5).node, 'columns');
    assert.deepEqual(assumed(level, 'column_height'), ['c1']);
  });

  it('makes a round column round', () => {
    const level = buildLevel(room({ columns: [{ id: 'c1', x: 5, y: 3, w: 0.6, d: 0.6, angle: 0, shape: 'round', heightM: 2 }] }));
    // Straight at it: met within a few millimetres of its 0.3 m radius.
    const face = hits(level, [3, 3, 1], [5, 3, 1])[0];
    assert.equal(face.node, 'columns');
    assert.ok(Math.abs(face.at[0] - 4.7) < 0.005, `${face.at[0]}`);
    // Past where a square column's corner would be: a round one is missed.
    assert.ok(!hits(level, [4, 2.0, 1], [6, 4.0, 1]).some((h) => h.node === 'columns' && Math.hypot(h.at[0] - 5, h.at[1] - 3) > 0.31));
    assert.equal(assumed(level, 'column_shape'), undefined);
  });

  it('assumes square for a column of no shape, and skips one of no size', () => {
    const level = buildLevel(
      room({
        columns: [
          { id: 'c1', x: 5, y: 3, w: 0.4, d: 0.4, angle: 0, shape: null, heightM: 2 },
          { id: 'c2', x: 7, y: 3, w: 0, d: 0.4, angle: 0, shape: 'rect', heightM: 2 },
        ],
      }),
    );
    assert.deepEqual(assumed(level, 'column_shape'), ['c1']);
    assert.deepEqual(level.skipped, [{ kind: 'column', id: 'c2', reason: 'no size' }]);
  });
});

describe('stairs, voids and lifts (J-04)', () => {
  it('cuts a stair out of the floor, a storey deep, with a rail round it', () => {
    const level = buildLevel(room({ voids: [{ id: 'v1', kind: 'stair', points: rect(4, 2, 7, 3.5), railHeightM: null }] }));
    const bottom = down(level, 5.5, 2.75, 2);
    assert.equal(bottom.node, 'voids');
    close(bottom.at[2], -3);
    close(down(level, 2, 2, 2).at[2], 0, 'the floor around it');
    // From the room: the glass balustrade, and the handrail on top at 1 m.
    const low = hits(level, [5.5, 1, 0.5], [5.5, 2.75, 0.5])[0];
    assert.deepEqual([low.node, low.material], ['rails', 'glass']);
    const top = hits(level, [5.5, 1, 0.98], [5.5, 2.75, 0.98])[0];
    assert.deepEqual([top.node, top.material], ['rails', 'metal']);
    assert.ok(!hits(level, [5.5, 1, 1.05], [5.5, 2.75, 1.05]).some((h) => h.node === 'rails'), 'nothing above 1 m');
    assert.deepEqual(assumed(level, 'rail_height'), ['v1']);
  });

  it('uses a measured rail height', () => {
    const level = buildLevel(room({ voids: [{ id: 'v1', kind: 'void', points: rect(4, 2, 7, 3.5), railHeightM: 1.2 }] }));
    assert.equal(hits(level, [5.5, 1, 1.15], [5.5, 2.75, 1.15])[0]?.node, 'rails');
    assert.equal(assumed(level, 'rail_height'), undefined);
  });

  it('closes a lift into a shaft from floor to ceiling, without cutting the floor', () => {
    const level = buildLevel(room({ voids: [{ id: 'v1', kind: 'lift', points: rect(0.2, 4, 2, 5.8), railHeightM: null }] }));
    // Closed on every side, right up to the ceiling.
    assert.equal(hits(level, [4, 5, 1.5], [1, 5, 1.5])[0]?.node, 'voids');
    assert.equal(hits(level, [4, 5, 2.95], [1, 5, 2.95])[0]?.node, 'voids');
    assert.ok(!hits(level, [4, 5, 3.05], [1, 5, 3.05]).some((h) => h.node === 'voids'));
    // Inside the shaft the floor is still there.
    close(hits(level, [1, 5, 1], [1, 5, -1]).find((h) => h.node === 'floors').at[2], 0);
    assert.equal(assumed(level, 'rail_height'), undefined, 'a lift has no rail');
  });
});

describe('mirrors (J-04)', () => {
  it('puts a mirror on the inside of an outer wall, only over the solid wall', () => {
    const plan = room({ openings: [{ id: 'o1', wallId: 'w1', kind: 'window', type: 'window', offset: 4, width: 2, sillHeightM: 1, heightM: 1 }] });
    plan.walls[0].mirrors = [{ id: 'm1', fromM: 1, toM: 9, bottomM: 0.2, topM: 2.4 }];
    const level = buildLevel(plan);
    // From inside, at 1.5 m: the mirror, just proud of the wall's inside face.
    const m = hits(level, [2, 3, 1.5], [2, -1, 1.5])[0];
    assert.equal(m.node, 'mirrors');
    close(m.at[1], 0.006);
    // Through the window, at the same height: glass, no mirror.
    assert.ok(!hits(level, [5, 3, 1.5], [5, -1, 1.5]).some((h) => h.node === 'mirrors'));
    // Below and above the span, and outside it along the wall: plain wall.
    assert.equal(hits(level, [2, 3, 0.1], [2, -1, 0.1])[0].node, 'walls-exterior');
    assert.equal(hits(level, [2, 3, 2.6], [2, -1, 2.6])[0].node, 'walls-exterior');
    assert.equal(hits(level, [0.5, 3, 1.5], [0.5, -1, 1.5])[0].node, 'walls-exterior');
    // Not on the outside.
    assert.ok(!hits(level, [2, -1, 1.5], [2, 3, 1.5]).slice(0, 1).some((h) => h.node === 'mirrors'));
    assert.equal(assumed(level, 'mirror_side'), undefined);
  });

  it('puts an inside wall’s mirror on the side its scan tag is on', () => {
    const plan = room({
      walls: [wall('w5', [5, 0], [5, 6], { mirrors: [{ id: 'm1', fromM: 1, toM: 5, bottomM: 0, topM: 2.5 }] })],
      spaces: [space('west', 'studio', rect(0, 0, 5, 6)), space('east', 'gym_floor', rect(5, 0, 10, 6))],
      tags: [{ id: 't1', type: 'mirror', x: 5.3, y: 3, heightM: null }],
    });
    const level = buildLevel(plan);
    assert.equal(hits(level, [8, 3, 1.5], [5, 3, 1.5])[0].node, 'mirrors', 'east, where the tag is, though the studio is west');
    assert.equal(hits(level, [2, 3, 1.5], [5, 3, 1.5])[0].node, 'walls');
    assert.equal(assumed(level, 'mirror_side'), undefined);
  });

  it('without a tag, faces a studio, and says it guessed', () => {
    const plan = room({
      walls: [wall('w5', [5, 0], [5, 6], { mirrors: [{ id: 'm1', fromM: 1, toM: 5, bottomM: 0, topM: 2.5 }] })],
      spaces: [space('west', 'gym_floor', rect(0, 0, 5, 6)), space('east', 'studio', rect(5, 0, 10, 6))],
    });
    const level = buildLevel(plan);
    assert.equal(hits(level, [8, 3, 1.5], [5, 3, 1.5])[0].node, 'mirrors');
    assert.deepEqual(assumed(level, 'mirror_side'), ['w5']);
  });

  it('mirrors the whole face of an older plan’s mirror wall', () => {
    const plan = room();
    plan.walls[0].mirror = true;
    delete plan.walls[0].mirrors;
    const level = buildLevel(plan);
    assert.equal(hits(level, [9.5, 3, 2.9], [9.5, -1, 2.9])[0].node, 'mirrors');
    assert.deepEqual(assumed(level, 'mirror_span'), ['w1']);
  });
});
