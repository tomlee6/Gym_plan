import { emptyPlan } from '@shared/plan/index.js';
import { describe, expect, it } from 'vitest';

import { buildModel } from './buildModel.js';
import { BODY_RADIUS_M } from './movement.js';
import { glideAt, insidePoint, minimapToPlan, spotsOf, standAt } from './teleport.js';
import { fit } from './plan2d.jsx';

const wall = (id, a, b) => ({ id, a, b, confidence: 1, mirror: false });
const gym = () =>
  emptyPlan({
    walls: [wall('n', [0, 0], [12, 0]), wall('e', [12, 0], [12, 8]), wall('s', [12, 8], [0, 8]), wall('w', [0, 8], [0, 0])],
    spaces: [
      { id: 's1', name: 'Free weights', kind: 'gym_floor', points: [[0, 0], [6, 0], [6, 8], [0, 8]] },
      { id: 's2', name: 'Cardio', kind: 'gym_floor', points: [[6, 0], [12, 0], [12, 8], [6, 8]] },
    ],
    objects: [
      { id: 'o1', x: 9, y: 4, w: 0.8, d: 2, angle: 0, heightM: 1.4, category: 'equipment', equipment: { name: 'Treadmill', type: 'treadmill' } },
      { id: 'o2', x: 10.5, y: 4, w: 0.8, d: 2, angle: 0, heightM: 1.4, category: 'equipment', equipment: { name: 'Treadmill', type: 'treadmill' } },
    ],
  });

describe('quick navigation', () => {
  const plan = gym();
  const model = buildModel(plan);

  it('offers the start, each room by name and each machine', () => {
    const spots = spotsOf(plan, model);
    expect(spots[0]).toMatchObject({ id: 'start', group: 'Start' });
    expect(spots.filter((s) => s.group === 'Rooms').map((s) => s.label)).toEqual(['Free weights', 'Cardio']);
    // Two machines with one name are told apart.
    expect(spots.filter((s) => s.group === 'Machines').map((s) => s.label)).toEqual(['Treadmill', 'Treadmill 2']);
  });

  it('lands in each room and faces each machine from beside it', () => {
    const spots = spotsOf(plan, model);
    const weights = spots.find((s) => s.id === 'room:s1');
    expect(weights.x).toBeLessThan(6);
    const tread = spots.find((s) => s.id === 'machine:o1');
    expect(Math.hypot(tread.x - 9, tread.y - 4)).toBeLessThan(2.5);
    // Looking at it.
    const look = Math.atan2(4 - tread.y, 9 - tread.x);
    expect(Math.abs(Math.atan2(Math.sin(look - tread.heading), Math.cos(look - tread.heading)))).toBeLessThan(1e-6);
  });

  it('will not stand you inside a machine or a wall', () => {
    const inMachine = standAt(model, [9, 4]);
    expect(Math.abs(inMachine[0] - 9) >= 0.4 + BODY_RADIUS_M - 1e-6 || Math.abs(inMachine[1] - 4) >= 1 + BODY_RADIUS_M - 1e-6).toBe(true);
    const onWall = standAt(model, [0.05, 4]);
    expect(onWall[0]).toBeGreaterThanOrEqual(BODY_RADIUS_M - 1e-6);
  });

  it('refuses a spot outside the building', () => {
    expect(standAt(model, [20, 4])).toBeNull();
  });

  it('finds a point inside an L-shaped room, where the centroid is outside', () => {
    const l = [[0, 0], [10, 0], [10, 1], [1, 1], [1, 10], [0, 10]];
    const p = insidePoint(l);
    expect(p[0] <= 10 && p[1] <= 10).toBe(true);
    expect(p[0] < 1 || p[1] < 1).toBe(true);
  });

  it('reads a minimap click back to the plan point drawn there', () => {
    const { map } = fit(model.bounds, 192, 132);
    const [px, py] = map(9, 4);
    const [x, y] = minimapToPlan(model.bounds, 192, 132, px, py);
    expect(x).toBeCloseTo(9, 9);
    expect(y).toBeCloseTo(4, 9);
  });

  it('glides from start to end, turning the short way round', () => {
    const from = { pos: [0, 0], yaw: Math.PI - 0.1 };
    const to = { pos: [4, 2], yaw: -Math.PI + 0.1 };
    expect(glideAt(from, to, 0)).toEqual({ pos: [0, 0], yaw: from.yaw });
    const end = glideAt(from, to, 1);
    expect(end.pos).toEqual([4, 2]);
    expect(Math.abs(end.yaw - from.yaw)).toBeCloseTo(0.2, 9);
    // No heading given: keeps facing the same way.
    expect(glideAt(from, { pos: [1, 1], yaw: null }, 0.5).yaw).toBe(from.yaw);
  });
});
