import { describe, expect, it, vi } from 'vitest';

import { loadLevel, withWalk } from './level.js';

// The loader itself needs a browser; the file it returns is stood in for here.
const gltfs = new Map();
vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    setMeshoptDecoder() {
      return this;
    }
    async loadAsync(url) {
      if (!gltfs.has(url)) throw new Error('404');
      return gltfs.get(url);
    }
  },
}));
vi.mock('three/examples/jsm/libs/meshopt_decoder.module.js', () => ({ MeshoptDecoder: {} }));

const WALK = { eyeHeightM: 1.6, start: { x: 4.9, y: 1.2, heading: 1.5708 }, collision: [[0, 0, 10, 0], [10, 0, 10, 6]] };

describe('the generated level (K-01)', () => {
  it('walks the generated level’s collision and starts where it says', () => {
    const drawn = { floor: [[0, 0], [10, 0], [10, 6]], ceiling: 3, collision: [{ a: [0, 0], b: [1, 1] }], start: { x: 0, y: 0, heading: 0 } };
    const model = withWalk(drawn, WALK);
    expect(model.collision).toEqual([
      { a: [0, 0], b: [10, 0] },
      { a: [10, 0], b: [10, 6] },
    ]);
    expect(model.start).toEqual({ x: 4.9, y: 1.2, heading: 1.5708 });
    // Everything else still comes from the plan.
    expect(model.floor).toBe(drawn.floor);
    expect(model.ceiling).toBe(3);
  });

  it('loads a level file with its walk', async () => {
    const scene = { userData: { walk: WALK } };
    gltfs.set('https://models.example/ok.glb', { scene });
    await expect(loadLevel('https://models.example/ok.glb')).resolves.toEqual({ scene, walk: WALK });
  });

  it('refuses a file that is not a generated level, so the viewer draws the plan instead', async () => {
    gltfs.set('https://models.example/other.glb', { scene: { userData: {} } });
    await expect(loadLevel('https://models.example/other.glb')).rejects.toThrow(/no walk data/);
    await expect(loadLevel('https://models.example/missing.glb')).rejects.toThrow('404');
  });
});
