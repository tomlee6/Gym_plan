/** Plan format 3 (G-02..G-08) and scan reader v2 (F-05). Pure: no database. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyControlDistances,
  arcLength,
  arcPoints,
  emptyPlan,
  FORMAT,
  openingTypeOf,
  planFromScan,
  upgradePlan,
  validate,
  wallLength,
} from '../../shared/plan/index.js';

const wall = (id, a, b, extra = {}) => ({ id, a, b, confidence: 1, mirror: false, ...extra });

/** A 10 × 6 m room split by a partition at x = 5, with a door in it. */
function twoRooms() {
  return emptyPlan({
    walls: [
      wall('n', [0, 0], [10, 0], { heightM: 3 }),
      wall('e', [10, 0], [10, 6], { heightM: 3 }),
      wall('s', [10, 6], [0, 6], { heightM: 3 }),
      wall('w', [0, 6], [0, 0], { heightM: 3 }),
      wall('p', [5, 0], [5, 6], { heightM: 3, kind: 'partition' }),
    ],
    openings: [{ id: 'd', wallId: 'p', type: 'door', kind: 'single_door', offset: 2, width: 0.9, confidence: 1, heightM: 2.1 }],
    spaces: [
      { id: 'a', name: 'Gym floor', kind: 'gym_floor', points: [[0, 0], [5, 0], [5, 6], [0, 6]], ceilingZones: [] },
      { id: 'b', name: 'Studio', kind: 'studio', points: [[5, 0], [10, 0], [10, 6], [5, 6]], floorFinish: 'timber', ceilingZones: [] },
    ],
  });
}

const codes = (plan) => validate(plan).map((i) => i.code);

describe('format 3', () => {
  it('is what new plans are written in', () => {
    assert.equal(FORMAT, 'gymplan/3');
    const p = emptyPlan();
    for (const key of ['spaces', 'beams', 'levelChanges', 'voids']) assert.deepEqual(p[key], []);
  });

  it('keeps the older three-way type in step with the opening kind', () => {
    assert.equal(openingTypeOf('sliding_door'), 'door');
    assert.equal(openingTypeOf('fixed_glazing'), 'window');
    assert.equal(openingTypeOf('opening'), 'opening');
  });

  it('measures a curved wall along its arc', () => {
    const w = wall('c', [0, 0], [4, 0], { curveM: 2 });
    assert.ok(Math.abs(wallLength(w) - 2 * Math.PI) < 1e-5, 'a semicircle of radius 2');
    const pts = arcPoints([0, 0], [4, 0], 1, 4);
    assert.deepEqual(pts[2].map((n) => Math.round(n * 1000) / 1000), [2, 1]);
    assert.equal(arcLength([0, 0], [4, 0], 0), 4);
  });
});

describe('validation v3 (G-07)', () => {
  it('accepts spaces that tile the floor, with a door between them', () => {
    assert.deepEqual(codes(twoRooms()), []);
  });

  it('finds gaps and overlaps between spaces', () => {
    const gap = twoRooms();
    gap.spaces[1].points = [[6, 0], [10, 0], [10, 6], [6, 6]];
    assert.ok(codes(gap).includes('space_gap'));
    const overlap = twoRooms();
    overlap.spaces[1].points = [[4, 0], [10, 0], [10, 6], [4, 6]];
    assert.ok(codes(overlap).includes('space_overlap'));
  });

  it('a door must join two spaces', () => {
    const p = twoRooms();
    p.spaces = [
      { id: 'a', name: 'All', kind: 'gym_floor', points: [[0, 0], [10, 0], [10, 6], [0, 6]], ceilingZones: [] },
      { id: 'x', name: 'Store', kind: 'storage', points: [[8, 4], [10, 4], [10, 6], [8, 6]], ceilingZones: [] },
    ];
    assert.ok(codes(p).includes('door_spaces'));
  });

  it('an opening must fit its wall’s height, and a mirror its wall', () => {
    const p = twoRooms();
    p.openings[0].heightM = 3.4;
    p.walls[0].mirrors = [{ id: 'm', fromM: 2, toM: 12, bottomM: 0.3, topM: 2.2 }];
    const c = codes(p);
    assert.ok(c.includes('opening_taller_than_wall'));
    assert.ok(c.includes('mirror_span'));
  });

  it('machines and columns sit inside a space, and "same as" names a real machine', () => {
    const p = twoRooms();
    p.spaces = [p.spaces[0]];
    p.spaces[0].points = [[0, 0], [5, 0], [5, 6], [0, 6]];
    p.objects.push({
      id: 'm1', x: 8, y: 3, w: 1, d: 2, angle: 0, heightM: 1.5, confidence: 1,
      equipment: { equipmentId: 'EQ-1', type: 'treadmill', name: 'Treadmill' }, sameAs: 'nope',
    });
    p.columns.push({ id: 'c1', x: 8, y: 1, w: 0.5, d: 0.5, angle: 0, shape: 'round' });
    const c = codes(p);
    for (const code of ['machine_outside_space', 'column_outside_space', 'machine_same_as']) assert.ok(c.includes(code), code);
  });

  it('checks beams, level changes and stairs', () => {
    const p = twoRooms();
    p.beams.push({ id: 'b', kind: 'bulkhead', points: [[1, 1], [2, 1], [2, 2]], bottomM: null });
    p.levelChanges.push({ id: 'l', kind: 'ramp', points: [[1, 1], [1, 1], [1, 1]], heightM: 0.3 });
    p.voids.push({ id: 'v', kind: 'stair', points: [[6, 1], [7, 1], [7, 3], [6, 3]], railHeightM: 4 });
    const c = codes(p);
    assert.ok(c.includes('invalid_dimension'));
    assert.ok(c.includes('levelChanges_shape'));
  });

  it('judges a format 2 plan exactly as before', () => {
    const old = { ...twoRooms(), format: 'gymplan/2' };
    delete old.spaces;
    delete old.beams;
    delete old.levelChanges;
    delete old.voids;
    assert.deepEqual(codes(old), []);
  });
});

describe('upgrading older plans (G-08)', () => {
  const v1 = () => ({
    format: 'gymplan/1',
    scale: { source: 'scan' },
    ceilingHeightM: 3,
    walls: [
      wall('n', [0, 0], [10, 0], { mirror: true }),
      wall('e', [10, 0], [10, 6]),
      wall('s', [10, 6], [0, 6]),
      wall('w', [0, 6], [0, 0]),
    ],
    openings: [{ id: 'd', wallId: 'n', type: 'door', offset: 1, width: 1.8, confidence: 1 }],
    columns: [{ id: 'c', x: 5, y: 3, w: 0.5, d: 0.5, angle: 0 }],
    objects: [],
    zones: [],
    tags: [],
    flags: [],
  });

  it('fills every format 3 field and flags each kind of default it assumed', () => {
    const old = v1();
    const next = upgradePlan(old);
    assert.equal(next.format, 'gymplan/3');
    assert.equal(old.format, 'gymplan/1', 'the original is untouched');
    assert.equal(next.spaces.length, 1);
    assert.equal(next.openings[0].kind, 'double_door');
    assert.equal(next.openings[0].leaves, 2);
    assert.deepEqual(next.walls[0].mirrors.map((m) => [m.fromM, m.toM, m.bottomM, m.topM]), [[0, 10, 0, 3]]);
    assert.equal(next.columns[0].shape, 'rect');
    assert.deepEqual(
      next.flags.filter((f) => f.kind === 'default_filled').map((f) => f.title).sort(),
      ['Column shapes assumed', 'Door kinds assumed', 'Floor drawn as one space', 'Mirror spans assumed'],
    );
    assert.deepEqual(validate(next), []);
  });

  it('can fill without flagging', () => {
    assert.equal(upgradePlan(v1(), { flagDefaults: false }).flags.length, 0);
  });
});

/* A RoomPlan surface: identity rotation about y, as the seed's T(). */
function T(deg, x, z, y = 1.5) {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), 0, -Math.sin(r), 0, 0, 1, 0, 0, Math.sin(r), 0, Math.cos(r), 0, x, y, z, 1];
}
const surf = (deg, x, z, w, extra = {}) => ({ confidence: { high: {} }, dimensions: [w, 3, 0], transform: T(deg, x, z), ...extra });

/** A floor surface: its local plane lies on the world floor, local y along world z. */
const FLOOR = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];

describe('scan reader v2 (F-05)', () => {
  it('reads an iOS 17 structure of several rooms, attaching openings by their parent wall', () => {
    const structure = {
      rooms: [
        {
          walls: [
            surf(0, 5, 0, 10, { identifier: 'w-north' }),
            surf(90, 10, 3, 6, { identifier: 'w-east' }),
            surf(0, 5, 6, 10, { identifier: 'w-south' }),
            surf(90, 0, 3, 6, { identifier: 'w-west' }),
          ],
          // Closer to the west wall's line than the north's, but cut into the north wall.
          doors: [surf(0, 0.6, 0.25, 0.9, { identifier: 'd1', parentIdentifier: 'w-north' })],
          floors: [
            { transform: FLOOR, polygonCorners: [[0, 0, 0], [5, 0, 0], [5, 6, 0], [0, 6, 0]] },
          ],
        },
        {
          // The same west wall again, as the merged structure repeats it.
          walls: [surf(90, 0, 3, 6, { identifier: 'w-west' })],
          floors: [{ transform: FLOOR, polygonCorners: [[5, 0, 0], [10, 0, 0], [10, 6, 0], [5, 6, 0]] }],
        },
      ],
    };
    const plan = planFromScan(structure, {});
    assert.equal(plan.walls.length, 4, 'a wall shared by two rooms is read once');
    const north = plan.walls.find((w) => Math.abs(w.a[1]) < 0.01 && Math.abs(w.b[1]) < 0.01);
    assert.equal(plan.openings[0].wallId, north.id);
    assert.equal(plan.openings[0].kind, 'single_door');
    assert.equal(plan.spaces.length, 2, 'each room’s floor becomes a space');
  });

  it('corrects the scale from control distances and reports what is left', () => {
    const plan = emptyPlan({ walls: [wall('n', [0, 0], [10, 0]), wall('e', [10, 0], [10, 5])] });
    const r = applyControlDistances(plan, [
      { a: [0, 0], b: [10, 0], measuredM: 10.05 },
      { a: [10, 0], b: [10, 5], measuredM: 5.04 },
    ]);
    assert.equal(r.applied, true);
    assert.ok(Math.abs(r.factor - 1.0056) < 0.0001);
    assert.ok(r.residualMm > 0 && r.residualMm < 20, `${r.residualMm} mm left`);
    assert.ok(Math.abs(plan.walls[0].b[0] - 10.056) < 0.001);
  });

  it('leaves the scale alone, and says so, when the laser and scan disagree too much', () => {
    const scan = { walls: [surf(0, 5, 0, 10), surf(90, 10, 3, 6), surf(0, 5, 6, 10), surf(90, 0, 3, 6)] };
    const plan = planFromScan(scan, { controlDistances: [{ a: [0, 0], b: [10, 0], measuredM: 12 }] });
    assert.equal(plan.scale.control.applied, false);
    assert.ok(plan.flags.some((f) => f.kind === 'control_distance'));
    assert.equal(plan.room.widthM, 10);
  });
});

describe('machines from the mesh (F-06)', () => {
  /** Mesh vertices: a floor, walls, and a 2 × 0.9 m machine 1.5 m tall at (4, 3), turned 30°. */
  function meshOBJ() {
    const lines = [];
    for (let x = 0; x <= 10; x += 0.2) for (let z = 0; z <= 6; z += 0.2) lines.push(`v ${x} 0 ${z}`);
    for (let h = 0; h <= 3; h += 0.1) for (let x = 0; x <= 10; x += 0.1) lines.push(`v ${x} ${h} 0.02`, `v ${x} ${h} 5.98`);
    const a = Math.PI / 6;
    for (let u = -1; u <= 1; u += 0.04) {
      for (let v = -0.45; v <= 0.45; v += 0.04) {
        for (const h of [0.3, 0.8, 1.5]) {
          lines.push(`v ${4 + u * Math.cos(a) - v * Math.sin(a)} ${h} ${3 + u * Math.sin(a) + v * Math.cos(a)}`);
        }
      }
    }
    lines.push('f 1 2 3');
    return lines.join('\n');
  }

  it('finds a floor-standing machine RoomPlan missed, with a box and height', async () => {
    const { parseObjVertices } = await import('../../shared/plan/index.js');
    const scan = { walls: [surf(0, 5, 0, 10), surf(90, 10, 3, 6), surf(0, 5, 6, 10), surf(90, 0, 3, 6)] };
    const plan = planFromScan(scan, { meshVertices: parseObjVertices(meshOBJ()) });
    const found = plan.objects.filter((o) => o.source === 'mesh');
    assert.equal(found.length, 1);
    const [m] = found;
    assert.ok(Math.abs(m.x - 4) < 0.15 && Math.abs(m.y - 3) < 0.15, `at ${m.x}, ${m.y}`);
    assert.ok(Math.abs(Math.max(m.w, m.d) - 2.1) < 0.25 && Math.abs(Math.min(m.w, m.d) - 1.0) < 0.25, `${m.w} × ${m.d}`);
    assert.equal(m.heightM, 1.5);
    // Found, not measured: a reviewer confirms it.
    assert.ok(plan.flags.some((f) => f.elementId === m.id));
  });

  it('a surveyor’s mark on a mesh box names it rather than adding another', () => {
    return import('../../shared/plan/index.js').then(({ parseObjVertices }) => {
      const scan = { walls: [surf(0, 5, 0, 10), surf(90, 10, 3, 6), surf(0, 5, 6, 10), surf(90, 0, 3, 6)] };
      const plan = planFromScan(scan, {
        meshVertices: parseObjVertices(meshOBJ()),
        equipment: [{ equipmentId: 'EQ-1', type: 'treadmill', name: 'Treadmill', x: 4.1, y: 3 }],
      });
      const named = plan.objects.filter((o) => o.equipment);
      assert.equal(named.length, 1);
      assert.equal(named[0].source, 'mesh');
    });
  });
});
