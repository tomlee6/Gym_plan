/** H-03: which scan frames look at a machine. */
import { describe, expect, it } from 'vitest';

import { cameraPose, keyframesIndexFile, keyframesSeeing, keyframeUrl, readKeyframes } from './keyframes.js';

/**
 * A camera-to-world matrix, column-major, for a phone at (x, height, z)
 * looking along `heading` on the floor. The camera looks down its own -Z,
 * so the third column is minus the view direction.
 */
function pose(x, z, heading) {
  const [hx, hz] = heading;
  const len = Math.hypot(hx, hz);
  const f = [hx / len, 0, hz / len];
  const back = [-f[0], -f[1], -f[2]];
  const right = [-back[2], 0, back[0]];
  return [right[0], right[1], right[2], 0, 0, 1, 0, 0, back[0], back[1], back[2], 0, x, 1.4, z, 1];
}

const machine = { x: 5, y: 5, w: 1, d: 2 };

describe('cameraPose', () => {
  it('reads where the camera stood on the plan and which way it looked', () => {
    const p = cameraPose(pose(1, 2, [1, 0]));
    expect(p.position).toEqual([1, 2]);
    expect(p.forward[0]).toBeCloseTo(1);
    expect(p.forward[1]).toBeCloseTo(0);
    expect(cameraPose([1, 2, 3])).toBeNull();
  });
});

describe('keyframesSeeing', () => {
  const frames = [
    { id: 'far', t: 1, file: 'f1.jpg', transform: pose(5, 14, [0, -1]) }, // 9 m away, facing it
    { id: 'behind', t: 2, file: 'f2.jpg', transform: pose(5, 2, [0, -1]) }, // 3 m away, facing away
    { id: 'near', t: 3, file: 'f3.jpg', transform: pose(5, 3, [0, 1]) }, // 2 m away, facing it
    { id: 'mid', t: 4, file: 'f4.jpg', transform: pose(1, 5, [1, 0.3]) }, // 4 m away, nearly facing it
    { id: 'side', t: 5, file: 'f5.jpg', transform: pose(5, 9, [1, 0]) }, // 4 m away, looking sideways
  ];

  it('keeps cameras in front of the machine and within 8 m, nearest first', () => {
    expect(keyframesSeeing(frames, machine).map((s) => s.frame.id)).toEqual(['near', 'mid']);
  });

  it('gives the distance and honours the limit and range', () => {
    const [first] = keyframesSeeing(frames, machine);
    expect(first.distanceM).toBeCloseTo(2);
    expect(keyframesSeeing(frames, machine, { limit: 1 })).toHaveLength(1);
    expect(keyframesSeeing(frames, machine, { maxDistanceM: 10 }).map((s) => s.frame.id)).toEqual(['near', 'mid', 'far']);
  });

  it('copes with no frames or no machine', () => {
    expect(keyframesSeeing(undefined, machine)).toEqual([]);
    expect(keyframesSeeing(frames, null)).toEqual([]);
  });
});

describe('files', () => {
  const files = [
    { id: '1', name: 'keyframes.json', kind: 'keyframes', url: 'https://s/keyframes.json?sig' },
    { id: '2', name: 'keyframes/f3.jpg', kind: 'keyframes', url: 'https://s/f3.jpg?sig' },
  ];

  it('finds the index and each frame’s signed image', () => {
    expect(keyframesIndexFile(files).id).toBe('1');
    expect(keyframesIndexFile([])).toBeNull();
    expect(keyframeUrl(files, { file: 'f3.jpg' })).toBe('https://s/f3.jpg?sig');
    expect(keyframeUrl(files, { file: 'f9.jpg' })).toBeNull();
  });

  it('reads only usable frames from keyframes.json', () => {
    const json = { frames: [{ id: 'a', file: 'a.jpg', transform: pose(0, 0, [1, 0]) }, { id: 'b', file: 'b.jpg', transform: [] }, null] };
    expect(readKeyframes(json).map((f) => f.id)).toEqual(['a']);
    expect(readKeyframes(null)).toEqual([]);
  });
});
