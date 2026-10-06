/**
 * CHANGE 1.7 and CHANGE 2: the measurement and equipment editing the
 * reviewer works with — exact dimensions typed in, machines named, and the
 * clearances that say whether a gym floor works.
 */
import { dist, emptyPlan, upgradePlan, validate } from '@shared/plan/index.js';
import { describe, expect, it } from 'vitest';

import { clearanceToWall, nearestEquipment, roomFacts, wallLabels } from './measure.js';
import { nextEquipmentId, rotateObject, setEquipment, setWallLength } from './ops.js';

const wall = (id, a, b) => ({ id, a, b, confidence: 1, mirror: false });
const treadmill = { equipmentId: 'EQ-001', type: 'treadmill', name: 'Treadmill 1' };

/** A 10 x 6 m room with one scanned block in the middle. */
const room = () =>
  upgradePlan(
    emptyPlan({
      walls: [
        wall('n', [0, 0], [10, 0]),
        wall('e', [10, 0], [10, 6]),
        wall('s', [10, 6], [0, 6]),
        wall('w', [0, 6], [0, 0]),
      ],
      openings: [{ id: 'd', wallId: 'n', type: 'door', offset: 1, width: 0.9, confidence: 0.7 }],
      objects: [{ id: 'b', x: 5, y: 3, w: 1, d: 2, angle: 0, heightM: 1.5, confidence: 0.9 }],
    }),
  );

describe('setting a wall to a measured length', () => {
  it('slides the far end along the wall, leaving the anchored corner alone', () => {
    const next = setWallLength(room(), 'n', 8);
    const n = next.walls.find((w) => w.id === 'n');
    expect(n.a).toEqual([0, 0]);
    expect(dist(n.a, n.b)).toBeCloseTo(8);
  });

  it('can hold the other end instead', () => {
    const next = setWallLength(room(), 'n', 8, { anchor: 'b' });
    const n = next.walls.find((w) => w.id === 'n');
    expect(n.b).toEqual([10, 0]);
    expect(n.a[0]).toBeCloseTo(2);
    expect(dist(n.a, n.b)).toBeCloseTo(8);
  });

  it('keeps a door inside the wall it shortened', () => {
    const next = setWallLength(room(), 'n', 1.2);
    const door = next.openings.find((o) => o.id === 'd');
    const n = next.walls.find((w) => w.id === 'n');
    expect(door.offset + door.width).toBeLessThanOrEqual(dist(n.a, n.b) + 1e-6);
    expect(validate(next).some((i) => i.code === 'opening_outside')).toBe(false);
  });

  it('refuses a length that is not a length', () => {
    const before = room();
    expect(setWallLength(before, 'n', 0)).toBe(before);
    expect(setWallLength(before, 'n', -4)).toBe(before);
    expect(setWallLength(before, 'nope', 4)).toBe(before);
  });

  it('counts as an edit, so the wall’s flag resolves', () => {
    const before = {
      ...room(),
      flags: [{ id: 'f', kind: 'low_confidence', elementId: 'n', title: 'North wall', detail: '', status: 'open' }],
    };
    const next = setWallLength(before, 'n', 9);
    expect(next.flags[0].status).toBe('resolved');
    expect(next.flags[0].resolution).toBe('edited');
  });
});

describe('naming a machine', () => {
  it('names an object, and counts it as equipment', () => {
    const next = setEquipment(room(), 'b', treadmill);
    const object = next.objects.find((o) => o.id === 'b');
    expect(object.equipment).toEqual(treadmill);
    // The shape was measured by the scan; only the name came from a person.
    expect(object.source).toBe('reviewer');
  });

  it('keeps the scan as the source when the scan found the shape', () => {
    const before = room();
    before.objects[0].source = 'roomplan';
    const object = setEquipment(before, 'b', treadmill).objects[0];
    expect(object.source).toBe('roomplan');
  });

  it('clears the name again', () => {
    const named = setEquipment(room(), 'b', treadmill);
    expect(setEquipment(named, 'b', null).objects[0].equipment).toBeNull();
  });

  it('takes a machine type that is not in the catalogue', () => {
    const odd = { equipmentId: 'EQ-009', type: 'plateLoadedHipThrust', name: 'Hip thrust' };
    expect(setEquipment(room(), 'b', odd).objects[0].equipment.type).toBe('plateLoadedHipThrust');
  });

  it('refuses a half-filled machine rather than storing a blank name', () => {
    const before = room();
    expect(setEquipment(before, 'b', { equipmentId: 'EQ-002', type: 'bench' })).toBe(before);
    expect(setEquipment(before, 'b', { type: 'bench', name: 'Bench' })).toBe(before);
  });

  it('will not name a wall', () => {
    const before = room();
    expect(setEquipment(before, 'n', treadmill)).toBe(before);
  });

  it('hands out a reference that is not already in use', () => {
    const plan = room();
    expect(nextEquipmentId(plan)).toBe('EQ-001');
    const named = setEquipment(plan, 'b', treadmill);
    expect(nextEquipmentId(named)).toBe('EQ-002');
  });
});

describe('turning a machine', () => {
  it('sets an exact bearing in degrees', () => {
    const next = rotateObject(room(), 'b', 90);
    expect(next.objects[0].angle).toBeCloseTo(Math.PI / 2);
  });

  it('ignores a bearing that is not a number', () => {
    const before = room();
    expect(rotateObject(before, 'b', Number.NaN)).toBe(before);
  });
});

describe('measurements on the plan', () => {
  it('labels every wall with its length', () => {
    const labels = wallLabels(room());
    expect(labels).toHaveLength(4);
    expect(labels.map((l) => l.text).sort()).toEqual(['10.00 m', '10.00 m', '6.00 m', '6.00 m']);
  });

  it('leaves out a wall too short to label legibly', () => {
    const plan = room();
    plan.walls.push(wall('stub', [2, 2], [2.2, 2]));
    expect(wallLabels(plan, { minLengthM: 0.5 }).some((l) => l.id === 'stub')).toBe(false);
  });

  it('keeps label text the right way up on a return run', () => {
    const plan = emptyPlan({ walls: [wall('back', [10, 0], [0, 0])] });
    expect(Math.abs(wallLabels(plan)[0].angleDeg)).toBeLessThanOrEqual(90);
  });

  it('reports the overall room figures', () => {
    const facts = roomFacts(room());
    expect(facts.widthM).toBe(10);
    expect(facts.lengthM).toBe(6);
    expect(facts.areaM2).toBe(60);
    expect(facts.perimeterM).toBe(32);
  });
});

describe('clearances round a machine', () => {
  it('measures from the machine’s nearest corner to the nearest wall', () => {
    const plan = setEquipment(room(), 'b', treadmill);
    const near = clearanceToWall(plan, plan.objects[0]);
    // The block is 1 x 2 at (5, 3) in a 10 x 6 room: 2 m to the long walls.
    expect(near.distanceM).toBeCloseTo(2);
  });

  it('measures the gap between two machines, not their centres', () => {
    const plan = setEquipment(room(), 'b', treadmill);
    plan.objects.push({
      id: 'b2',
      x: 8,
      y: 3,
      w: 1,
      d: 2,
      angle: 0,
      heightM: 1.5,
      confidence: 0.9,
      equipment: { equipmentId: 'EQ-002', type: 'legPress', name: 'Leg Press' },
    });
    const near = nearestEquipment(plan, plan.objects[0]);
    expect(near.object.id).toBe('b2');
    // Centres are 3 m apart, but each is 1 m wide: 2 m of floor between.
    expect(near.distanceM).toBeCloseTo(2);
  });

  it('ignores an unidentified block when looking for the nearest machine', () => {
    const plan = setEquipment(room(), 'b', treadmill);
    plan.objects.push({ id: 'junk', x: 5.5, y: 3, w: 0.5, d: 0.5, angle: 0, heightM: 1, confidence: 0.5 });
    expect(nearestEquipment(plan, plan.objects[0])).toBeNull();
  });
});
