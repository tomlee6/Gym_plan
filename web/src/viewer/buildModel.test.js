import { describe, expect, it } from 'vitest';

import { buildModel, DOOR_HEAD_M, WINDOW_HEAD_M, WINDOW_SILL_M } from './buildModel.js';
import { BODY_RADIUS_M, collide, move } from './movement.js';

const wall = (id, a, b, extra = {}) => ({ id, a, b, confidence: 1, mirror: false, ...extra });

function plan(overrides = {}) {
  return {
    format: 'gymplan/1',
    scale: { source: 'scan' },
    underlay: null,
    ceilingHeightM: 3.2,
    walls: [],
    openings: [],
    columns: [],
    objects: [],
    zones: [],
    tags: [],
    flags: [],
    ...overrides,
  };
}

/** A 10 × 6 m room; the north wall has a door at 2–3 m and a window at 6–8 m. */
const room = () =>
  plan({
    walls: [
      wall('n', [0, 0], [10, 0]),
      wall('e', [10, 0], [10, 6]),
      wall('s', [10, 6], [0, 6], { mirror: true }),
      wall('w', [0, 6], [0, 0]),
    ],
    openings: [
      { id: 'd1', wallId: 'n', type: 'door', offset: 2, width: 1, confidence: 1 },
      { id: 'w1', wallId: 'n', type: 'window', offset: 6, width: 2, confidence: 1 },
    ],
    objects: [{ id: 'b1', x: 5, y: 3, w: 2, d: 1, angle: 0, heightM: 1.1, category: 'storage', confidence: 1 }],
    columns: [{ id: 'c1', x: 8, y: 4, w: 0.5, d: 0.5, angle: 0 }],
    tags: [{ id: 't1', type: 'stair', x: 2, y: 4.5, heightM: null }],
  });

describe('buildModel', () => {
  it('splits a wall around a door and a window', () => {
    const m = buildModel(room());
    const north = m.walls.filter((p) => p.wallId === 'n');
    const describe = north.map((p) => `${p.kind} ${p.a[0]}-${p.b[0]} ${p.bottom}-${p.top}`);
    expect(describe).toEqual([
      'wall 0-2 0-3.2',
      `head 2-3 ${DOOR_HEAD_M}-3.2`,
      'wall 3-6 0-3.2',
      `sill 6-8 0-${WINDOW_SILL_M}`,
      `head 6-8 ${WINDOW_HEAD_M}-3.2`,
      'wall 8-10 0-3.2',
    ]);
  });

  it('lets a walker through the door but not the window', () => {
    const m = buildModel(room());
    const blocks = (x) =>
      m.collision.some((s) => s.a[1] === 0 && s.b[1] === 0 && Math.min(s.a[0], s.b[0]) <= x && Math.max(s.a[0], s.b[0]) >= x);
    expect(blocks(2.5)).toBe(false); // Door.
    expect(blocks(7)).toBe(true); // Window sill.
    expect(blocks(4.5)).toBe(true); // Wall.
  });

  it('raises the floor, mirrors, columns, objects and stairs', () => {
    const m = buildModel(room());
    expect(m.ceiling).toBe(3.2);
    expect(m.floorFromWalls).toBe(true);
    expect(m.floor).toHaveLength(4);
    expect(m.walls.filter((p) => p.mirror).map((p) => p.wallId)).toEqual(['s']);
    expect(m.columns[0].height).toBe(3.2);
    expect(m.objects[0].height).toBe(1.1);
    expect(m.stairs).toHaveLength(1);
    expect(m.bounds).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 6 });
  });

  it('starts just in from the entrance, facing across the room', () => {
    const { start } = buildModel(room());
    expect(start.x).toBeCloseTo(2.5);
    expect(start.y).toBeCloseTo(1.2);
    expect(Math.sin(start.heading)).toBeGreaterThan(0); // Into the room, not back at the door.
  });

  it('steps round equipment by the door so the walk does not start stuck', () => {
    const p = room();
    // A rack right inside the door.
    p.objects.push({ id: 'b2', x: 2.5, y: 2.2, w: 1.2, d: 1.8, angle: 0, heightM: 2, category: 'storage', confidence: 1 });
    const m = buildModel(p);
    const clear = m.collision.every((s) => {
      const [ax, ay] = s.a;
      const [bx, by] = s.b;
      const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
      const t = Math.max(0, Math.min(1, ((m.start.x - ax) * (bx - ax) + (m.start.y - ay) * (by - ay)) / (len2 || 1)));
      return Math.hypot(m.start.x - (ax + (bx - ax) * t), m.start.y - (ay + (by - ay) * t)) >= 0.9;
    });
    expect(clear).toBe(true);
  });

  it('finds the floor of an L-shaped room and starts inside it', () => {
    const L = plan({
      walls: [
        wall('a', [0, 0], [8, 0]),
        wall('b', [8, 0], [8, 3]),
        wall('c', [8, 3], [3, 3]),
        wall('d', [3, 3], [3, 8]),
        wall('e', [3, 8], [0, 8]),
        wall('f', [0, 8], [0, 0]),
      ],
    });
    const m = buildModel(L);
    expect(m.floor).toHaveLength(6);
    const { x, y } = m.start;
    const inL = (x > 0 && x < 8 && y > 0 && y < 3) || (x > 0 && x < 3 && y > 0 && y < 8);
    expect(inL).toBe(true);
  });

  it('falls back to the walls’ bounding box when the outline is open', () => {
    const open = plan({ walls: [wall('a', [0, 0], [5, 0]), wall('b', [5, 0], [5, 4]), wall('c', [5, 4], [1, 4])] });
    const m = buildModel(open);
    expect(m.floorFromWalls).toBe(false);
    expect(m.floor).toEqual([
      [0, 0],
      [5, 0],
      [5, 4],
      [0, 4],
    ]);
  });

  it('is deterministic whatever order the walls come in (GEN-01)', () => {
    const p = room();
    const shuffled = { ...p, walls: [...p.walls].reverse(), openings: [...p.openings].reverse() };
    expect(JSON.stringify(buildModel(shuffled))).toBe(JSON.stringify(buildModel(p)));
  });
});

describe('movement', () => {
  const walls = [{ a: [0, 0], b: [10, 0] }];

  it('keeps a body clear of a wall', () => {
    const [, y] = collide([5, 0.1], walls);
    expect(y).toBeCloseTo(BODY_RADIUS_M);
  });

  it('walks forward along its facing, and stops at a wall', () => {
    let p = [5, 3];
    const yawNorth = -Math.PI / 2; // Towards y = 0.
    for (let i = 0; i < 200; i++) p = move(p, yawNorth, { forward: 1 }, 1 / 30, walls);
    expect(p[0]).toBeCloseTo(5);
    expect(p[1]).toBeGreaterThanOrEqual(BODY_RADIUS_M - 1e-6);
    expect(p[1]).toBeLessThan(BODY_RADIUS_M + 0.01);
  });

  it('cannot tunnel through a wall at a run in a long frame', () => {
    const p = move([5, 0.5], -Math.PI / 2, { forward: 1, run: true }, 1, walls);
    expect(p[1]).toBeGreaterThan(0);
  });

  it('strafes to the right of its facing', () => {
    const p = move([5, 5], 0, { strafe: 1 }, 1, []);
    expect(p[0]).toBeCloseTo(5);
    expect(p[1]).toBeCloseTo(5 + 1.6);
  });
});

describe('a curved wall (K-04)', () => {
  // The room's east wall bowed 1.5 m out, as the reference gym's is.
  const curved = () => {
    const p = room();
    p.walls[1] = wall('e', [10, 0], [10, 6], { curveM: -1.5 });
    p.openings.push({ id: 'd2', wallId: 'e', type: 'door', offset: 2.5, width: 1, confidence: 1 });
    return p;
  };
  // The arc through (10, 0), (11.5, 3) and (10, 6).
  const centre = [10 - (9 - 2.25) / 3, 3];
  const radius = Math.hypot(10 - centre[0], 0 - centre[1]);
  const onArc = ([x, y]) => Math.abs(Math.hypot(x - centre[0], y - centre[1]) - radius) < 0.011;

  it('draws it along its arc, in short pieces, not its chord', () => {
    const pieces = buildModel(curved()).walls.filter((p) => p.wallId === 'e');
    expect(pieces.length).toBeGreaterThan(8);
    expect(pieces.every((p) => onArc(p.a) && onArc(p.b))).toBe(true);
    expect(Math.max(...pieces.flatMap((p) => [p.a[0], p.b[0]]))).toBeCloseTo(11.5, 2);
    // The door is still a gap with a head over it, on the arc.
    const heads = pieces.filter((p) => p.kind === 'head');
    expect(heads.length).toBeGreaterThan(0);
    expect(heads.every((p) => onArc(p.a) && onArc(p.b))).toBe(true);
  });

  it('takes the floor out to the arc, and the walk is stopped by it there', () => {
    const model = buildModel(curved());
    expect(Math.max(...model.floor.map(([x]) => x))).toBeCloseTo(11.5, 2);
    expect(model.bounds.maxX).toBeCloseTo(11.5, 2);
    expect(model.collision.some((s) => onArc(s.a) && onArc(s.b) && s.a[0] > 11)).toBe(true);
  });

  it('leaves a straight wall as one piece', () => {
    expect(buildModel(room()).walls.filter((p) => p.wallId === 'e')).toHaveLength(1);
  });
});
