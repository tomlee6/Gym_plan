/**
 * CHANGE 1: high-accuracy measurements, and the gymplan/2 plan format.
 *
 * No database: this covers the shared plan library only, the way
 * plan.test.js does. The rules being checked are that a measurement
 * RoomPlan recorded survives into the plan unrounded, that a measurement it
 * never recorded stays null instead of being invented, and that a plan
 * written in the first format still reads.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  emptyPlan,
  FORMAT,
  FORMAT_V1,
  objectBounds,
  planFromScan,
  roomMetrics,
  summary,
  upgradePlan,
  validate,
  wallAngleDeg,
  wallLength,
  withMeasurements,
} from '../../shared/plan/index.js';

/** Column-major 4x4: rotation about y by `deg`, translation to (x, yUp, z). */
function T(deg, x, z, yUp = 1.5) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x, yUp, z, 1];
}

/**
 * A surface with a deliberately awkward width: 7.123456789 m would be lost
 * to the old millimetre rounding, so it proves the measurement survives.
 */
const surf = (deg, x, z, w, { conf = 'high', h = 3.1, depth = 0, yUp = 1.5 } = {}) => ({
  confidence: { [conf]: {} },
  dimensions: [w, h, depth],
  transform: T(deg, x, z, yUp),
});

/** A square 8 x 8 m room, corners meeting exactly. */
const ROOM = {
  walls: [
    surf(0, 4, 0, 8),
    surf(90, 8, 4, 8),
    surf(0, 4, 8, 8),
    surf(90, 0, 4, 8),
  ],
  doors: [surf(0, 2, 0, 0.9, { h: 2.04 })],
  // Sill at 0.9: centre 1.65 less half of 1.5.
  windows: [surf(0, 6, 8, 1.8, { h: 1.5, yUp: 1.65 })],
  openings: [],
  objects: [
    {
      category: { storage: {} },
      confidence: { high: {} },
      dimensions: [0.85, 1.5, 2.1],
      transform: T(90, 3, 3, 0.75),
    },
  ],
  floors: [{ transform: T(0, 4, 4, 0) }],
};

const plan = planFromScan(ROOM, {});

describe('the current plan format', () => {
  it('is what a new plan is written in, in metres', () => {
    assert.equal(plan.format, FORMAT);
    assert.equal(FORMAT, 'gymplan/3');
    assert.equal(plan.units, 'm');
  });

  it('reads a plan written in the first format, and upgrades a copy', () => {
    const old = {
      ...emptyPlan(),
      format: FORMAT_V1,
      walls: [
        { id: 'n', a: [0, 0], b: [6, 0], confidence: 1, mirror: false },
        { id: 'e', a: [6, 0], b: [6, 4], confidence: 1, mirror: false },
        { id: 's', a: [6, 4], b: [0, 4], confidence: 1, mirror: false },
        { id: 'w', a: [0, 4], b: [0, 0], confidence: 1, mirror: false },
      ],
      openings: [{ id: 'o', wallId: 'n', type: 'door', offset: 1, width: 0.9, confidence: 1 }],
      objects: [{ id: 'b', x: 3, y: 2, w: 1, d: 1, angle: 0, heightM: 1, confidence: 1 }],
    };
    delete old.units;
    delete old.room;

    // It is valid as it stands: the old format is not an error.
    assert.deepEqual(validate(old), []);

    const next = upgradePlan(old);
    assert.equal(next.format, FORMAT);
    assert.equal(old.format, FORMAT_V1, 'the original is untouched');
    // Measurements the old plan never carried are null, not guessed.
    assert.equal(next.walls[0].thicknessM, null);
    assert.equal(next.walls[0].heightM, null);
    assert.equal(next.openings[0].sillHeightM, null);
    assert.equal(next.objects[0].equipment, null);
    // Derived measurements are filled in.
    assert.equal(next.walls[0].lengthM, 6);
    assert.equal(next.room.areaM2, 24);
  });

  it('refuses a format it does not know', () => {
    const p = { ...emptyPlan(), format: 'gymplan/99' };
    assert.ok(validate(p).some((i) => i.code === 'format_unknown'));
  });
});

describe('room and wall measurements', () => {
  it('measures the room from the outline', () => {
    assert.equal(plan.room.widthM, 8);
    assert.equal(plan.room.lengthM, 8);
    assert.equal(plan.room.areaM2, 64);
    assert.equal(plan.room.perimeterM, 32);
    assert.deepEqual(plan.room.min, [0, 0]);
    assert.deepEqual(plan.room.max, [8, 8]);
  });

  it('takes the floor level from RoomPlan when it found a floor', () => {
    assert.equal(plan.room.elevationM, 0);
  });

  it('gives every wall its length, bearing and measured height', () => {
    for (const w of plan.walls) {
      assert.equal(w.lengthM, 8);
      assert.equal(w.heightM, 3.1, 'the height the scan measured');
      assert.equal(w.source, 'roomplan');
    }
    // The two side walls are turned a quarter turn, which under RoomPlan's
    // rotation points them along -z, so they read 270 rather than 90. What
    // matters is that opposite walls come out parallel.
    const bearings = plan.walls.map((w) => w.angleDeg).sort((a, b) => a - b);
    assert.deepEqual(bearings, [0, 0, 270, 270]);
    assert.ok(bearings.every((b) => b % 90 === 0), 'a square room reads square');
  });

  it('leaves wall thickness null, because RoomPlan reports walls as planes', () => {
    assert.ok(plan.walls.every((w) => w.thicknessM === null));
  });

  it('reports a thickness only when the scan actually measured one', () => {
    const thick = planFromScan({ walls: [surf(0, 2, 0, 4, { depth: 0.2 })] }, {});
    assert.equal(thick.walls[0].thicknessM, 0.2);
  });

  it('keeps a measurement finer than a millimetre', () => {
    const exact = planFromScan({ walls: [surf(0, 0, 0, 7.123456)] }, {});
    assert.equal(exact.walls[0].lengthM, 7.123456);
  });

  it('recomputes derived measurements after the geometry moves', () => {
    const p = upgradePlan(plan);
    p.walls[0].b = [4, 0];
    withMeasurements(p);
    assert.equal(p.walls[0].lengthM, 4, 'the wall length follows its points');
  });

  it('has no room measurements while the walls do not close', () => {
    assert.equal(roomMetrics(emptyPlan()), null);
  });
});

describe('door and window measurements', () => {
  const door = plan.openings.find((o) => o.type === 'door');
  const window_ = plan.openings.find((o) => o.type === 'window');

  it('maps each opening to the wall it is on', () => {
    assert.ok(door.wallId, 'the door found its wall');
    assert.ok(window_.wallId);
    assert.notEqual(door.wallId, window_.wallId, 'on opposite walls');
  });

  it('keeps the measured width, height and bearing', () => {
    assert.equal(door.width, 0.9);
    assert.equal(door.heightM, 2.04);
    assert.equal(window_.width, 1.8);
    assert.equal(window_.heightM, 1.5);
    assert.equal(door.source, 'roomplan');
  });

  it('measures a window sill from the floor', () => {
    assert.equal(window_.sillHeightM, 0.9);
  });

  it('gives a door no sill and no swing, because RoomPlan reports neither', () => {
    assert.equal(door.sillHeightM, null);
    assert.equal(door.swing, null, 'the reviewer sets the swing, it is never guessed');
  });
});

describe('equipment and object measurements', () => {
  const object = plan.objects[0];

  it('keeps the footprint, height and how high off the floor it sits', () => {
    assert.equal(object.w, 0.85);
    assert.equal(object.d, 2.1);
    assert.equal(object.heightM, 1.5);
    assert.equal(object.elevationM, 0);
    assert.equal(object.category, 'storage', "RoomPlan's own category");
    assert.equal(object.source, 'roomplan');
  });

  it('starts with no equipment, because RoomPlan cannot name a gym machine', () => {
    assert.equal(object.equipment, null);
  });

  it('derives a footprint box that follows the rotation', () => {
    const b = objectBounds(object);
    // Turned a quarter turn, so the 2.1 m side now runs along x.
    assert.ok(Math.abs(b.widthM - 2.1) < 1e-6, `width ${b.widthM}`);
    assert.ok(Math.abs(b.depthM - 0.85) < 1e-6, `depth ${b.depthM}`);
    assert.equal(b.corners.length, 4);
  });

  it('counts equipment once a machine is named', () => {
    const p = upgradePlan(plan);
    assert.equal(summary(p).equipment, 0);
    p.objects[0].equipment = { equipmentId: 'EQ-001', type: 'treadmill', name: 'Treadmill 1' };
    assert.equal(summary(p).equipment, 1);
  });
});

describe('measurement validation', () => {
  /** The square room above, upgraded, as a plan that validates clean. */
  const good = () => upgradePlan(plan);

  it('passes the scanned room', () => {
    assert.deepEqual(validate(good()), []);
  });

  it('reports a wall longer than any building', () => {
    const p = good();
    p.walls[0].b = [500, 0];
    assert.ok(validate(p).some((i) => i.code === 'invalid_dimension'));
  });

  it('reports an impossible wall height or thickness', () => {
    const tall = good();
    tall.walls[0].heightM = 40;
    assert.ok(validate(tall).some((i) => i.code === 'invalid_dimension'));

    const thick = good();
    thick.walls[0].thicknessM = 9;
    assert.ok(validate(thick).some((i) => i.code === 'invalid_dimension'));
  });

  it('accepts a measurement that was never taken', () => {
    const p = good();
    p.walls[0].heightM = null;
    p.walls[0].thicknessM = null;
    assert.deepEqual(validate(p), [], 'null is unknown, not wrong');
  });

  it('reports two walls drawn on top of each other', () => {
    const p = good();
    const first = p.walls[0];
    p.walls.push({ ...first, id: 'copy' });
    assert.ok(validate(p).some((i) => i.code === 'walls_overlap'));
  });

  it('reports a window that reaches above the ceiling', () => {
    const p = good();
    const w = p.openings.find((o) => o.type === 'window');
    w.sillHeightM = 2.8;
    w.heightM = 1.5;
    assert.ok(validate(p).some((i) => i.code === 'opening_above_ceiling'));
  });

  it('reports a sill below the floor', () => {
    const p = good();
    p.openings.find((o) => o.type === 'window').sillHeightM = -2;
    assert.ok(validate(p).some((i) => i.code === 'invalid_dimension'));
  });

  it('reports equipment outside the room', () => {
    const p = good();
    p.objects[0].x = 40;
    p.objects[0].y = 40;
    const issue = validate(p).find((i) => i.code === 'object_outside');
    assert.ok(issue, 'the object is outside the outline');
    assert.ok(issue.ids.includes(p.objects[0].id));
  });

  it('names the equipment in the message when it has a name', () => {
    const p = good();
    p.objects[0].equipment = { equipmentId: 'EQ-001', type: 'treadmill', name: 'Treadmill 1' };
    p.objects[0].x = 40;
    const issue = validate(p).find((i) => i.code === 'object_outside');
    assert.match(issue.message, /Treadmill 1/);
  });

  it('reports the same machine read twice', () => {
    const p = good();
    const first = p.objects[0];
    p.objects.push({ ...first, id: 'again', x: first.x + 0.1 });
    assert.ok(validate(p).some((i) => i.code === 'duplicate_object'));
  });

  it('does not call two different machines side by side a duplicate', () => {
    const p = good();
    const first = p.objects[0];
    p.objects.push({ ...first, id: 'neighbour', x: first.x + 1.2 });
    assert.ok(!validate(p).some((i) => i.code === 'duplicate_object'));
  });

  it('reports an object with an impossible size', () => {
    const p = good();
    p.objects[0].w = 60;
    assert.ok(validate(p).some((i) => i.code === 'invalid_dimension'));
  });

  it('says nothing about objects while the walls do not close', () => {
    const p = good();
    p.walls[0].b = [4, 0]; // Leaves the outline open.
    const codes = validate(p).map((i) => i.code);
    assert.ok(codes.includes('open_outline'));
    assert.ok(!codes.includes('object_outside'), 'one problem, reported once');
  });
});

describe('plan measurements in the summary', () => {
  it('reports the overall room figures', () => {
    const s = summary(plan);
    assert.equal(s.widthM, 8);
    assert.equal(s.lengthM, 8);
    assert.equal(s.perimeterM, 32);
    assert.equal(s.areaM2, 64);
  });

  it('reports them for a plan in the first format too', () => {
    const old = { ...emptyPlan(), format: FORMAT_V1 };
    old.walls = [
      { id: 'n', a: [0, 0], b: [5, 0], confidence: 1, mirror: false },
      { id: 'e', a: [5, 0], b: [5, 2], confidence: 1, mirror: false },
      { id: 's', a: [5, 2], b: [0, 2], confidence: 1, mirror: false },
      { id: 'w', a: [0, 2], b: [0, 0], confidence: 1, mirror: false },
    ];
    const s = summary(old);
    assert.equal(s.widthM, 5);
    assert.equal(s.lengthM, 2);
    assert.equal(s.areaM2, 10);
  });
});

describe('measurement helpers', () => {
  it('measures a wall and its bearing', () => {
    assert.equal(wallLength({ a: [0, 0], b: [3, 4] }), 5);
    assert.equal(wallAngleDeg({ a: [0, 0], b: [0, 2] }), 90);
    assert.equal(wallAngleDeg({ a: [0, 2], b: [0, 0] }), 270, 'the same wall drawn backwards');
  });
});
