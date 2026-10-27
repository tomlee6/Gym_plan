/**
 * The walk data (J-08): what stops a walker, as plan segments, and where the
 * walk starts. Checked by walking short lines across the plan.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildLevel } from '../../shared/build3d/index.js';
import { emptyPlan, pointInPolygon } from '../../shared/plan/index.js';

const wall = (id, a, b, extra = {}) => ({ id, a, b, confidence: 1, mirror: false, ...extra });
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const opening = (id, wallId, kind, offset, width, extra = {}) => ({ id, wallId, kind, offset, width, type: null, ...extra });

/** A 10 × 6 m room with a 3 m ceiling and a rubber floor; `walls` are added, the rest replaces. */
function room({ walls = [], ...extra } = {}) {
  return emptyPlan({
    ceilingHeightM: 3,
    walls: [wall('w1', [0, 0], [10, 0]), wall('w2', [10, 0], [10, 6]), wall('w3', [10, 6], [0, 6]), wall('w4', [0, 6], [0, 0]), ...walls],
    spaces: [{ id: 's1', name: 'Gym', kind: 'gym_floor', points: rect(0, 0, 10, 6), floorFinish: 'rubber', ceilingHeightM: null, ceilingZones: [] }],
    ...extra,
  });
}

/** Whether walking straight from p to q runs into anything. */
function blocked(level, p, q) {
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  return level.walk.collision.some(([ax, ay, bx, by]) => {
    const [a, b] = [
      [ax, ay],
      [bx, by],
    ];
    return cross(p, q, a) * cross(p, q, b) < 0 && cross(a, b, p) * cross(a, b, q) < 0;
  });
}

describe('what stops a walker (J-08)', () => {
  it('stops at walls and windows, but not at a doorway or an archway', () => {
    const level = buildLevel(
      room({
        openings: [
          opening('o1', 'w1', 'single_door', 2, 0.9),
          opening('o2', 'w1', 'window', 5, 1.5),
          opening('o3', 'w3', 'opening', 4, 1.2, { heightM: 2.4 }),
        ],
      }),
    );
    assert.ok(blocked(level, [1, 1], [1, -1]), 'the wall');
    assert.ok(!blocked(level, [2.45, 1], [2.45, -1]), 'through the door, under its head');
    assert.ok(blocked(level, [5.75, 1], [5.75, -1]), 'the wall below the window');
    assert.ok(!blocked(level, [5.4, 5], [5.4, 7]), 'through the archway');
  });

  it('stops at floor-length glazing and an open door’s leaf', () => {
    const level = buildLevel(
      room({
        openings: [opening('o1', 'w1', 'fixed_glazing', 5, 2, { sillHeightM: 0 }), opening('o2', 'w1', 'single_door', 1, 0.9, { hinge: 'left' })],
      }),
    );
    assert.ok(blocked(level, [6, 1], [6, -1]), 'the glass');
    // The leaf stands open into the room at the hinge (x = 1), 0.9 m long.
    assert.ok(blocked(level, [0.5, 0.5], [1.5, 0.5]), 'the leaf');
  });

  it('stops at columns, lifts, rails and machines, not at what it can step over or walk under', () => {
    const level = buildLevel(
      room({
        columns: [{ id: 'c1', x: 2, y: 3, w: 0.4, d: 0.4, angle: 0, shape: 'rect', heightM: null }],
        voids: [
          { id: 'v1', kind: 'stair', points: rect(4, 2, 6, 4), railHeightM: null },
          { id: 'v2', kind: 'lift', points: rect(8, 4, 9.8, 5.8), railHeightM: null },
        ],
        objects: [
          { id: 'o1', x: 8, y: 1.5, w: 1, d: 1, angle: 0, heightM: 1.4, category: 'rack' },
          { id: 'o2', x: 2, y: 5, w: 1, d: 1, angle: 0, heightM: 0.2, category: 'mat' },
          { id: 'o3', x: 2, y: 1, w: 1, d: 0.2, angle: 0, heightM: 0.5, elevationM: 2, category: 'tv' },
        ],
        beams: [
          { id: 'b1', kind: 'bulkhead', points: rect(0, 5.6, 10, 6), bottomM: 1.5 },
          { id: 'b2', kind: 'beam', points: rect(6.5, 0, 7, 6), bottomM: 2.6 },
        ],
      }),
    );
    assert.ok(blocked(level, [1, 3], [3, 3]), 'the column');
    assert.ok(blocked(level, [5, 1], [5, 3]), 'the stair rail');
    assert.ok(blocked(level, [7.5, 5], [8.5, 5]), 'the lift');
    assert.ok(blocked(level, [7, 1.5], [9, 1.5]), 'the rack');
    assert.ok(!blocked(level, [1, 5], [3, 5]), 'a mat is stepped over');
    assert.ok(!blocked(level, [1, 1], [3, 1]), 'a TV on the wall is walked under');
    assert.ok(blocked(level, [3, 5], [3, 5.9]), 'a low bulkhead');
    assert.ok(!blocked(level, [6.2, 0.5], [7.4, 0.5]), 'a beam overhead');
  });

  it('stops at a platform or a pit, but walks up a ramp or over a low step', () => {
    const level = buildLevel(
      room({
        levelChanges: [
          { id: 'l1', kind: 'platform', points: rect(1, 1, 3, 2), heightM: 0.4 },
          { id: 'l2', kind: 'step', points: rect(4, 1, 6, 2), heightM: -0.5 },
          { id: 'l3', kind: 'ramp', points: rect(7, 1, 9, 2), heightM: 0.6, rampAngleDeg: 0 },
          { id: 'l4', kind: 'step', points: rect(1, 4, 3, 5), heightM: 0.15 },
        ],
      }),
    );
    assert.ok(blocked(level, [2, 0.5], [2, 1.5]), 'the platform');
    assert.ok(blocked(level, [5, 0.5], [5, 1.5]), 'the pit');
    assert.ok(!blocked(level, [6.5, 1.5], [8, 1.5]), 'up the ramp');
    assert.ok(!blocked(level, [2, 3.5], [2, 4.5]), 'over the step');
  });
});

describe('where the walk starts (J-08)', () => {
  it('starts just inside the entrance, looking into the room', () => {
    const level = buildLevel(room({ openings: [opening('o1', 'w1', 'double_door', 4, 1.8)] }));
    const { start, eyeHeightM } = level.walk;
    assert.equal(eyeHeightM, 1.6);
    assert.deepEqual([start.x, start.y], [4.9, 1.2], '1.2 m in from the middle of the door');
    // Looking into the room: northwards, give or take.
    assert.ok(Math.sin(start.heading) > 0.5, `heading ${start.heading}`);
  });

  it('starts at the front door rather than a loading shutter', () => {
    const level = buildLevel(
      room({ openings: [opening('o1', 'w1', 'roller_shutter', 1, 3), opening('o2', 'w3', 'double_door', 4, 1.8)] }),
    );
    // The double door is on the north wall (y = 6): start 1.2 m south of its middle.
    assert.deepEqual([level.walk.start.x, level.walk.start.y], [5.1, 4.8]);
  });

  it('never looks back out of the door it came in by, even in a small room', () => {
    // The front door opens into a 3 x 3 m lobby, whose own door leads on: the long view is out the front door.
    const level = buildLevel(
      room({
        walls: [wall('l1', [3, 0], [3, 3]), wall('l2', [3, 3], [0, 3])],
        openings: [opening('o1', 'w1', 'double_door', 0.6, 1.8), opening('o2', 'l2', 'single_door', 1, 0.9)],
      }),
    );
    const { start } = level.walk;
    assert.ok(start.y > 0 && start.y < 3, `in the lobby: ${start.x}, ${start.y}`);
    // Looking into the building, not out through the door at y = 0.
    assert.ok(Math.sin(start.heading) > 0, `heading ${start.heading}`);
  });

  it('starts clear of things, and in the open when there is no door', () => {
    const level = buildLevel(
      room({ levelChanges: [{ id: 'l1', kind: 'platform', points: rect(0.2, 0.2, 9.8, 2.5), heightM: 0.5 }] }),
    );
    const { start } = level.walk;
    assert.ok(pointInPolygon([start.x, start.y], rect(0, 2.5, 10, 6)), 'not on the platform');
    const clear = level.walk.collision.every(([ax, ay, bx, by]) => {
      const t = Math.max(0, Math.min(1, ((start.x - ax) * (bx - ax) + (start.y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
      return Math.hypot(start.x - (ax + (bx - ax) * t), start.y - (ay + (by - ay) * t)) >= 0.9;
    });
    assert.ok(clear, 'at least 0.9 m from anything');
  });
});
