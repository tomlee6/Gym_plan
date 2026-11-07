import { emptyPlan } from '@shared/plan/index.js';
import { describe, expect, it } from 'vitest';

import { buildModel } from './buildModel.js';
import { FINISHES, finishOf, machineColour, paintFinish } from './materials.js';

/** Records what is drawn, enough to tell two paintings apart. */
function fakeContext() {
  const calls = [];
  const ctx = new Proxy(
    {},
    {
      get: (_, k) => (k === 'calls' ? calls : (...args) => calls.push([k, ...args])),
      set: (_, k, v) => (calls.push([`=${String(k)}`, v]), true),
    },
  );
  return ctx;
}

describe('3D finishes', () => {
  it('floors each room in its own finish, or one suited to its kind', () => {
    expect(finishOf({ finish: 'timber', kind: 'gym_floor' })).toBe('timber');
    expect(finishOf({ finish: null, kind: 'studio' })).toBe('timber');
    expect(finishOf({ finish: null, kind: 'changing' })).toBe('tile');
    expect(finishOf({ finish: null, kind: null })).toBe('rubber');
  });

  it('paints every finish, the same way every time', () => {
    for (const finish of Object.keys(FINISHES)) {
      const a = fakeContext();
      const b = fakeContext();
      paintFinish(a, 64, finish);
      paintFinish(b, 64, finish);
      expect(a.calls.length).toBeGreaterThan(1);
      expect(a.calls).toEqual(b.calls);
    }
  });

  it('colours machines by kind and plain objects apart from them', () => {
    expect(machineColour({ type: 'treadmill' })).not.toBe(machineColour({ type: 'legPress' }));
    expect(machineColour({ type: 'something new' })).toBeTypeOf('number');
    expect(machineColour({ type: null })).not.toBe(machineColour({ type: 'treadmill' }));
  });

  it('carries rooms and machine types into the 3D model', () => {
    const wall = (id, a, b) => ({ id, a, b, confidence: 1, mirror: false });
    const m = buildModel(
      emptyPlan({
        walls: [wall('n', [0, 0], [8, 0]), wall('e', [8, 0], [8, 6]), wall('s', [8, 6], [0, 6]), wall('w', [0, 6], [0, 0])],
        spaces: [{ id: 's1', name: 'Studio', kind: 'studio', floorFinish: 'timber', points: [[0, 0], [8, 0], [8, 6], [0, 6]] }],
        objects: [{ id: 'b1', x: 2, y: 2, w: 1, d: 2, angle: 0, heightM: 1.5, category: 'equipment', confidence: 1, equipment: { equipmentId: 'LIB-001', type: 'treadmill', name: 'Treadmill' } }],
      }),
    );
    expect(m.spaces).toEqual([{ points: [[0, 0], [8, 0], [8, 6], [0, 6]], finish: 'timber', kind: 'studio' }]);
    expect(m.objects[0].type).toBe('treadmill');
  });
});
