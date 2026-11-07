/** Reading accuracy: corners, squaring and openings from a RoomPlan scan. No database. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { dist, planFromScan, summary } from '../../shared/plan/index.js';

/** Column-major 4×4: rotation about y by `deg`, then translation. */
function T(deg, x, z) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x, 1.5, z, 1];
}
const surf = (deg, x, z, w, conf = 'high', h = 3.1) => ({
  confidence: { [conf]: {} },
  dimensions: [w, h, 0],
  transform: T(deg, x, z),
});
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const angle = (w) => (Math.atan2(w.b[1] - w.a[1], w.b[0] - w.a[0]) * 180) / Math.PI;

describe('reading a scan accurately', () => {
  it('runs walls on to a true corner instead of averaging their ends', () => {
    // A 10 × 6 m room; each wall stops 8 cm short of the corner.
    const plan = planFromScan({
      walls: [surf(0, 5, 0, 9.84), surf(90, 10, 3, 5.84), surf(0, 5, 6, 9.84), surf(90, 0, 3, 5.84)],
      doors: [],
      windows: [],
      openings: [],
      objects: [],
    });
    const lengths = plan.walls.map((w) => dist(w.a, w.b)).sort((a, b) => b - a);
    near(lengths[0], 10, 1e-6, 'long wall');
    near(lengths[2], 6, 1e-6, 'short wall');
    const s = summary(plan);
    near(s.areaM2, 60, 0.05, 'area');
  });

  it('squares a wall the scan read a degree out, about its middle', () => {
    const plan = planFromScan({
      walls: [surf(0, 5, 0, 10), surf(91, 10, 3, 6), surf(0, 5, 6, 10), surf(90, 0, 3, 6)],
      doors: [],
      windows: [],
      openings: [],
      objects: [],
    });
    for (const w of plan.walls) {
      const off = Math.abs(angle(w)) % 90;
      assert.ok(Math.min(off, 90 - off) < 1e-6, `wall at ${angle(w)}°`);
    }
  });

  it('leaves a wall built on the skew as it is', () => {
    const plan = planFromScan({
      walls: [surf(0, 5, 0, 10), surf(90, 10, 3, 6), surf(0, 5, 6, 10), surf(90, 0, 3, 6), surf(30, 5, 3, 2)],
      doors: [],
      windows: [],
      openings: [],
      objects: [],
    });
    const skew = plan.walls.find((w) => {
      const off = Math.abs(angle(w)) % 90;
      return Math.min(off, 90 - off) > 10;
    });
    assert.ok(skew, 'the 30° wall is still at 30°');
  });

  it('puts a door near a corner in the wall it runs along', () => {
    // A door 20 cm from the corner, in the north wall (along x).
    const plan = planFromScan({
      walls: [surf(0, 5, 0, 10), surf(90, 10, 3, 6), surf(0, 5, 6, 10), surf(90, 0, 3, 6)],
      doors: [surf(0, 0.65, 0.05, 0.9)],
      windows: [],
      openings: [],
      objects: [],
    });
    const door = plan.openings[0];
    const wall = plan.walls.find((w) => w.id === door.wallId);
    const off = Math.abs(angle(wall)) % 180;
    assert.ok(Math.min(off, 180 - off) < 1, `attached to a wall at ${angle(wall)}°, not the west wall`);
  });

  it('keeps one opening where RoomPlan reported a door and a doorway on the same spot', () => {
    const plan = planFromScan({
      walls: [surf(0, 5, 0, 10), surf(90, 10, 3, 6), surf(0, 5, 6, 10), surf(90, 0, 3, 6)],
      doors: [surf(0, 3, 0, 0.9, 'medium')],
      windows: [surf(0, 7, 0, 1.5)],
      openings: [surf(0, 3.05, 0, 0.95, 'high')],
      objects: [],
    });
    assert.equal(plan.openings.length, 2, 'the door and the window');
    assert.deepEqual(plan.openings.map((o) => o.type).sort(), ['door', 'window']);
  });
});

describe('room names from the phone', () => {
  const walls = [surf(0, 5, 0, 10), surf(90, 10, 3, 6), surf(0, 5, 6, 10), surf(90, 0, 3, 6)];
  // Two rooms side by side, as an iOS 17 scan lists their floors.
  const floor = (x0, x1) => ({
    transform: T(0, 0, 0),
    polygonCorners: [[x0, 0, 0], [x1, 0, 0], [x1, 0, 6], [x0, 0, 6]],
  });
  const scan = { walls, doors: [], windows: [], openings: [], objects: [], floors: [floor(0, 6), floor(6, 10)] };

  it('names each room as the surveyor did', () => {
    const plan = planFromScan(scan, { roomNames: ['  Free   weights ', 'Studio'] });
    assert.deepEqual(plan.spaces.map((s) => s.name), ['Free weights', 'Studio']);
  });

  it('falls back to Room n for a missing, blank, too long or repeated name', () => {
    const plan = planFromScan({ ...scan, floors: [floor(0, 3), floor(3, 6), floor(6, 10)] }, { roomNames: ['Gym', 'gym'] });
    assert.deepEqual(plan.spaces.map((s) => s.name), ['Gym', 'Room 2', 'Room 3']);
    const long = planFromScan(scan, { roomNames: ['x'.repeat(61), '   '] });
    assert.deepEqual(long.spaces.map((s) => s.name), ['Room 1', 'Room 2']);
  });

  it('names a one-room scan, which has no floors listed, too', () => {
    const plan = planFromScan({ ...scan, floors: [] }, { roomNames: ['Main gym'] });
    assert.deepEqual(plan.spaces.map((s) => s.name), ['Main gym']);
    assert.deepEqual(planFromScan({ ...scan, floors: [] }).spaces.map((s) => s.name), ['Gym floor']);
  });
});
