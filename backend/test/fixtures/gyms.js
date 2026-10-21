/**
 * Gyms for the generator's tests (J-10): a reference gym with one of
 * everything the 3D contract covers, a large gym for size and speed, and a
 * simulated RoomPlan scan for the whole way from scan to model.
 */
import { emptyPlan } from '../../../shared/plan/index.js';

const wall = (id, a, b, extra = {}) => ({ id, a, b, confidence: 1, mirror: false, ...extra });
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const space = (id, kind, points, extra = {}) => ({ id, name: id, kind, points, floorFinish: null, ceilingHeightM: null, ceilingZones: [], ...extra });
const opening = (id, wallId, kind, offset, width, extra = {}) => ({ id, wallId, kind, offset, width, type: null, confidence: 1, ...extra });
const machine = (id, x, y, extra = {}) => ({
  id,
  x,
  y,
  w: 0.8,
  d: 2,
  angle: 0,
  heightM: 1.5,
  category: 'treadmill',
  equipment: { equipmentId: `e-${id}`, type: 'treadmill', name: id },
  ...extra,
});

/**
 * A 16 × 10 m gym with a curved east wall, a studio behind a partition and
 * a glass screen, and one of every element type: every opening kind, ceiling
 * zones, a beam and a bulkhead, a platform, a ramp and a pit, a stair and a
 * lift, square and round columns, mirrors, signs, a no-build zone, machines
 * and objects.
 */
export function referenceGym() {
  return emptyPlan({
    ceilingHeightM: 3,
    walls: [
      wall('w1', [0, 0], [16, 0]),
      wall('w2', [16, 0], [16, 10], { curveM: -1.5 }),
      wall('w3', [16, 10], [0, 10]),
      wall('w4', [0, 10], [0, 0], { mirrors: [{ id: 'm2', fromM: 1, toM: 7, bottomM: 0.2, topM: 2.2 }] }),
      wall('w5', [10, 0], [10, 10], { mirrors: [{ id: 'm1', fromM: 0.5, toM: 5.5, bottomM: 0.3, topM: 2.4 }] }),
      wall('w6', [10, 5], [13, 5], { kind: 'glass' }),
    ],
    openings: [
      opening('o1', 'w1', 'roller_shutter', 2, 3),
      opening('o2', 'w1', 'window', 6.5, 2),
      opening('o3', 'w1', 'double_door', 12, 1.8),
      opening('o4', 'w5', 'single_door', 6, 0.9, { hinge: 'right', swingInto: 's1' }),
      opening('o5', 'w2', 'window', 3, 2, { heightM: 1.5, sillHeightM: 1 }),
      opening('o6', 'w3', 'sliding_door', 4, 1.5),
      opening('o7', 'w3', 'opening', 12, 1.2, { heightM: 2.4 }),
      opening('o8', 'w4', 'fixed_glazing', 3, 3, { sillHeightM: 0.3 }),
    ],
    spaces: [
      space('s1', 'gym_floor', rect(0, 0, 10, 10), {
        ceilingZones: [
          { id: 'z1', points: rect(2, 3, 6, 7), heightM: 3.6 },
          { id: 'z2', points: rect(0, 8, 3, 10), heightM: 2.6 },
        ],
      }),
      space('s2', 'studio', rect(10, 0, 16, 10), { ceilingHeightM: 3.4 }),
    ],
    beams: [
      { id: 'b1', kind: 'beam', points: rect(0, 4.8, 10, 5.2), bottomM: 2.6 },
      { id: 'b2', kind: 'bulkhead', points: rect(10, 8.5, 16, 10), bottomM: 2.8 },
    ],
    levelChanges: [
      { id: 'l1', kind: 'platform', points: rect(12, 1, 15, 3), heightM: 0.3 },
      { id: 'l2', kind: 'ramp', points: rect(11, 6, 14, 7.2), heightM: 0.3, rampAngleDeg: 0 },
      { id: 'l3', kind: 'step', points: rect(1, 1, 3, 2.5), heightM: -0.4 },
    ],
    voids: [
      { id: 'v1', kind: 'stair', points: rect(6.5, 6, 9.5, 7.4), railHeightM: null },
      { id: 'v2', kind: 'lift', points: rect(0.2, 6, 2, 7.6), railHeightM: null },
    ],
    columns: [
      { id: 'c1', x: 5, y: 2.5, w: 0.4, d: 0.4, angle: 0, shape: 'rect', heightM: null },
      { id: 'c2', x: 13, y: 4.2, w: 0.45, d: 0.45, angle: 0, shape: 'round', heightM: null },
    ],
    objects: [
      machine('t1', 3, 4, { facingDeg: 90 }),
      machine('t2', 4.2, 4, { heightM: null }),
      { id: 'ob3', x: 7.5, y: 4.2, w: 1.2, d: 0.6, angle: 0.4, heightM: 0.9, category: 'mesh' },
      { id: 'ob4', x: 13.5, y: 9.6, w: 1.4, d: 0.1, angle: 0, heightM: 0.8, elevationM: 1.6, category: 'tv' },
    ],
    zones: [{ id: 'nz1', points: rect(6.5, 0.5, 9.5, 2.2) }],
    tags: [
      { id: 't-exit', type: 'fireExit', x: 12.9, y: 0.15, heightM: null },
      { id: 't-power', type: 'power', x: 9.85, y: 3, heightM: null },
      { id: 't-hang', type: 'fireExit', x: 5, y: 8.2, heightM: null },
      { id: 't-ceiling', type: 'ceiling', x: 3, y: 3, heightM: 3 },
    ],
  });
}

/** Every node the reference gym should produce: the contract's whole list. */
export const ALL_NODES = [
  'beams',
  'ceilings',
  'columns',
  'doors',
  'floors',
  'glass',
  'ground',
  'level-changes',
  'machines',
  'mirrors',
  'objects',
  'rails',
  'roof',
  'signs',
  'voids',
  'walls',
  'walls-exterior',
  'zones',
];

/**
 * A 60 × 40 m gym (2,400 m²): a row of 12 rooms with doors, windows every
 * 4 m, columns on an 8 m grid, beams, a stair and 400 machines.
 */
export function largeGym() {
  const [W, D] = [60, 40];
  const walls = [wall('n', [0, 0], [W, 0]), wall('e', [W, 0], [W, D]), wall('s', [W, D], [0, D]), wall('w', [0, D], [0, 0])];
  walls[3].mirrors = [{ id: 'm1', fromM: 6, toM: 34, bottomM: 0.2, topM: 2.4 }];
  const openings = [];
  for (let x = 2; x < W - 3; x += 4) openings.push(opening(`wn${x}`, 'n', 'window', x, 2, { sillHeightM: 0.9, heightM: 1.2 }));
  openings.push(opening('door-main', 's', 'double_door', 28, 1.8), opening('door-back', 'e', 'roller_shutter', 5, 3.5));
  walls.push(wall('corr', [0, D - 5], [W, D - 5]));
  const spaces = [space('floor', 'gym_floor', rect(0, 0, W, D - 5), { ceilingHeightM: 4 })];
  for (let i = 0; i < 12; i++) {
    if (i > 0) walls.push(wall(`p${i}`, [i * 5, D - 5], [i * 5, D]));
    openings.push(opening(`rd${i}`, 'corr', 'single_door', i * 5 + 2, 0.9));
    spaces.push(space(`room${String(i).padStart(2, '0')}`, i % 3 ? 'changing' : 'studio', rect(i * 5, D - 5, i * 5 + 5, D)));
  }
  const columns = [];
  for (let x = 8; x < W; x += 8) {
    for (let y = 8; y < D - 5; y += 8) columns.push({ id: `c${x}-${y}`, x, y, w: 0.5, d: 0.5, angle: 0, shape: 'rect', heightM: null });
  }
  const objects = [];
  for (let i = 0; i < 400; i++) {
    const [x, y] = [2 + (i % 40) * 1.4, 2 + Math.floor(i / 40) * 3];
    if (y > D - 7) break;
    objects.push(machine(`m${String(i).padStart(3, '0')}`, x, y));
  }
  const beams = [];
  for (let x = 4; x < W; x += 8) beams.push({ id: `b${x}`, kind: 'beam', points: rect(x, 0, x + 0.4, D - 5), bottomM: 3.4 });
  return emptyPlan({
    ceilingHeightM: 3,
    walls,
    openings,
    spaces,
    columns,
    objects,
    beams,
    voids: [{ id: 'v1', kind: 'stair', points: rect(50, 10, 54, 12), railHeightM: null }],
  });
}

/* A simulated RoomPlan capture, as the iPhone app uploads it (the shape plan-v3.test.js reads). */

/** A surface's transform: turned `deg` about the vertical, centred at (x, y, z). */
function T(deg, x, z, y) {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), 0, -Math.sin(r), 0, 0, 1, 0, 0, Math.sin(r), 0, Math.cos(r), 0, x, y, z, 1];
}
/** A wall, door or window surface `w` wide and `h` high, its bottom `base` above the floor. */
const surf = (deg, x, z, w, h = 3, base = 0, extra = {}) => ({
  confidence: { high: {} },
  dimensions: [w, h, 0],
  transform: T(deg, x, z, base + h / 2),
  ...extra,
});
const FLOOR = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];

/**
 * Two rooms of a 12 × 8 m gym as RoomPlan describes them: four outer walls
 * and a partition at x = 7, a front door and windows in the north wall, a
 * door through the partition, and each room's floor.
 */
export function scannedGym() {
  return {
    rooms: [
      {
        walls: [
          surf(0, 6, 0, 12, 3.2, 0, { identifier: 'north' }),
          surf(90, 12, 4, 8, 3.2, 0, { identifier: 'east' }),
          surf(0, 6, 8, 12, 3.2, 0, { identifier: 'south' }),
          surf(90, 0, 4, 8, 3.2, 0, { identifier: 'west' }),
          surf(90, 7, 4, 8, 3.2, 0, { identifier: 'partition' }),
        ],
        doors: [
          surf(0, 3, 0, 1.8, 2.1, 0, { identifier: 'front', parentIdentifier: 'north' }),
          surf(90, 7, 5, 0.9, 2.1, 0, { identifier: 'studio-door', parentIdentifier: 'partition' }),
        ],
        windows: [
          surf(0, 6, 0, 1.5, 1.2, 1, { identifier: 'win-1', parentIdentifier: 'north' }),
          surf(0, 9.5, 0, 1.5, 1.2, 1, { identifier: 'win-2', parentIdentifier: 'north' }),
        ],
        floors: [
          { transform: FLOOR, polygonCorners: [[0, 0, 0], [7, 0, 0], [7, 8, 0], [0, 8, 0]] },
          { transform: FLOOR, polygonCorners: [[7, 0, 0], [12, 0, 0], [12, 8, 0], [7, 8, 0]] },
        ],
      },
    ],
  };
}
