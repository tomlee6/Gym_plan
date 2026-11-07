import { emptyPlan, mainWallAngle, roomMetrics, summary, withMeasurements } from '@shared/plan/index.js';
import { describe, expect, it } from 'vitest';

/** A w × l room with its walls turned `deg` from the scan's axes, as when the phone faced across the room at the start. */
function turnedRoom(w, l, deg) {
  const a = (deg * Math.PI) / 180;
  const turn = ([x, y]) => [x * Math.cos(a) - y * Math.sin(a) + 20, x * Math.sin(a) + y * Math.cos(a) + 20];
  const c = [[0, 0], [w, 0], [w, l], [0, l]].map(turn);
  const walls = c.map((p, i) => ({ id: `w${i}`, a: p, b: c[(i + 1) % 4], confidence: 1, mirror: false }));
  return withMeasurements(emptyPlan({ walls }));
}

describe('room width × length', () => {
  it('is measured along the room’s own walls, whatever way the scan began', () => {
    for (const deg of [0, 12, 30, 45, -60, 89]) {
      const plan = turnedRoom(12, 8, deg);
      const s = summary(plan);
      const [w, l] = [s.widthM, s.lengthM].sort((x, y) => y - x);
      expect(w).toBeCloseTo(12, 6);
      expect(l).toBeCloseTo(8, 6);
      expect(s.areaM2).toBeCloseTo(96, 1);
      // The stored room figures agree with the summary.
      const room = roomMetrics(plan);
      expect([room.widthM, room.lengthM].sort((x, y) => y - x)).toEqual([w, l]);
    }
  });

  it('leaves a square-on plan’s numbers exactly as they were', () => {
    const s = summary(turnedRoom(10.25, 6.5, 0));
    expect(s.widthM).toBe(10.25);
    expect(s.lengthM).toBe(6.5);
  });

  it('reads the main wall angle the same way the phone does', () => {
    expect(mainWallAngle(turnedRoom(12, 8, 30).walls)).toBeCloseTo((30 * Math.PI) / 180, 9);
    // 120° walls are the same walls a quarter turn on.
    expect(mainWallAngle(turnedRoom(12, 8, 120).walls)).toBeCloseTo((30 * Math.PI) / 180, 9);
  });
});
