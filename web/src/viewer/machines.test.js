/**
 * Machines in the walkthrough (J-06): which model each machine uses, each
 * model loaded once, and every machine placed on its footprint.
 */
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CHECK_EVERY,
  forgetMachineModels,
  hideLevelMachines,
  isShown,
  loadMachineModels,
  loadModelFile,
  LOD_DISTANCES,
  machinePlacements,
  PRELOAD_M,
  placeMachines,
} from './machines.js';

afterEach(() => {
  vi.restoreAllMocks();
  forgetMachineModels();
});

const machine = (id, equipmentId, extra = {}) => ({
  id,
  x: 4,
  y: 6,
  w: 0.9,
  d: 2,
  angle: Math.PI / 2,
  heightM: 1.5,
  equipment: { equipmentId, type: 'treadmill', name: equipmentId },
  ...extra,
});

const MODEL = {
  modelId: 'model-1',
  lods: [
    { url: 'https://cdn.example/m/near.glb?Signature=1' },
    { url: 'https://cdn.example/m/middle.glb?Signature=1' },
    { url: 'https://cdn.example/m/far.glb?Signature=1' },
  ],
};

/** A loaded model file: one mesh, its geometry named after the file. */
function file(name) {
  const scene = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  mesh.geometry.name = name;
  scene.add(mesh);
  return { scene };
}
const fileName = (url) => new URL(url).pathname.split('/').pop();
const flush = () => new Promise((r) => setTimeout(r, 0));

const plan = {
  objects: [
    machine('a', 'EQ-001'),
    machine('b', 'EQ-002', { sameAs: 'a', x: 8, angle: 0, elevationM: 0.3 }),
    machine('c', 'EQ-003', { heightM: 9 }),
    { id: 'box', x: 1, y: 1, w: 1, d: 1, angle: 0 },
    machine('d', 'EQ-004', { w: null }),
  ],
};

describe('machines in the walkthrough', () => {
  it('gives each named machine the model it uses: its own, or the one it is the same as', () => {
    const placed = machinePlacements(plan, { 'EQ-001': MODEL });
    expect(placed.map((p) => [p.object.id, p.model?.modelId ?? null])).toEqual([
      ['a', 'model-1'],
      ['b', 'model-1'],
      ['c', null],
    ]);
    expect(machinePlacements(plan, null).every((p) => p.model === null)).toBe(true);
  });

  it('loads each model once, its farthest level of detail first, and leaves out one that fails', async () => {
    const load = vi.fn(async (url) => {
      if (url.includes('bad')) throw new Error('404');
      return file(fileName(url));
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const placed = machinePlacements(plan, { 'EQ-001': MODEL, 'EQ-003': { modelId: 'model-3', lods: [{ url: 'https://cdn.example/bad.glb' }] } });
    const loaded = await loadMachineModels(placed, load);
    expect(load.mock.calls.map(([url]) => fileName(url)).sort()).toEqual(['bad.glb', 'far.glb']);
    expect([...loaded.keys()]).toEqual(['model-1']);
    expect(loaded.get('model-1').children[0].geometry.name).toBe('far.glb');
  });

  it('keeps model files for the session, by path, so a re-signed link or another level finds them', async () => {
    const load = vi.fn(async (url) => file(fileName(url)));
    const first = await loadModelFile('https://cdn.example/m/far.glb?Signature=1&Expires=100', load);
    const again = await loadModelFile('https://cdn.example/m/far.glb?Signature=2&Expires=200', load);
    expect(again).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
    // A failed file is tried again next time.
    const failing = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(file('x'));
    await expect(loadModelFile('https://cdn.example/m/x.glb', failing)).rejects.toThrow('offline');
    await loadModelFile('https://cdn.example/m/x.glb', failing);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('places each machine with a model as a level-of-detail node on its footprint, and a box where there is none', async () => {
    const scene = new THREE.Scene();
    const material = new THREE.MeshStandardMaterial();
    const loaded = new Map([['model-1', file('far.glb').scene]]);
    const { group } = placeMachines(scene, machinePlacements(plan, { 'EQ-001': MODEL }), loaded, { material, ceiling: 3 });

    expect(group.name).toBe('machine-models');
    expect(scene.children).toContain(group);
    const [a, b, c] = group.children;
    // Plan [x, y] is (x, ·, y); a footprint turned on the plan turns the other way about +Y.
    expect(a.isLOD).toBe(true);
    expect(a.name).toBe('machine:EQ-001');
    expect(a.position.toArray()).toEqual([4, 0, 6]);
    expect(a.rotation.y).toBeCloseTo(-Math.PI / 2);
    expect(a.userData.modelId).toBe('model-1');
    // Only the farthest level so far, shown at any distance until a nearer one arrives.
    expect(a.levels.map((l) => l.distance)).toEqual([LOD_DISTANCES[2]]);
    // The same as EQ-001: the same model, sharing its geometry.
    expect(b.position.toArray()).toEqual([8, 0.3, 6]);
    expect(b.levels[0].object.children[0].geometry).toBe(a.levels[0].object.children[0].geometry);
    // No model: a box, standing on the floor, never through the ceiling.
    expect(c.isMesh).toBe(true);
    expect(c.material).toBe(material);
    expect(c.userData.modelId).toBeNull();
    c.geometry.computeBoundingBox();
    expect(c.geometry.boundingBox.min.y).toBeCloseTo(0);
    expect(c.geometry.boundingBox.max.y).toBeCloseTo(3);
    expect(c.geometry.boundingBox.max.x - c.geometry.boundingBox.min.x).toBeCloseTo(0.9);
  });

  it('fetches nearer levels of detail as the camera comes up to a machine, once each', async () => {
    const load = vi.fn(async (url) => file(fileName(url)));
    const placed = machinePlacements(plan, { 'EQ-001': MODEL });
    const loaded = await loadMachineModels(placed, load);
    const layer = placeMachines(new THREE.Scene(), placed, loaded, { load });
    const [a, b] = layer.group.children;
    const at = (x, y) => new THREE.Vector3(x, 1.6, y);
    const step = async (position) => {
      for (let i = 0; i < CHECK_EVERY; i++) layer.update(position);
      await flush();
    };

    await step(at(40, 40));
    expect(load).toHaveBeenCalledTimes(1);
    // Within reach of the middle level (shown from LOD_DISTANCES[2] in, fetched PRELOAD_M before that).
    await step(at(4, 6 + LOD_DISTANCES[2] + PRELOAD_M - 1));
    expect(load.mock.calls.map(([url]) => fileName(url))).toEqual(['far.glb', 'middle.glb']);
    expect(a.levels.map((l) => l.distance)).toEqual([LOD_DISTANCES[1], LOD_DISTANCES[2]]);
    expect(b.levels.map((l) => l.distance)).toEqual([LOD_DISTANCES[1], LOD_DISTANCES[2]]);
    // Up to it: the nearest, for every machine that uses the model.
    await step(at(4, 6 + LOD_DISTANCES[1] + PRELOAD_M - 1));
    await step(at(4, 8));
    expect(load.mock.calls.map(([url]) => fileName(url))).toEqual(['far.glb', 'middle.glb', 'near.glb']);
    expect(a.levels.map((l) => l.object.children[0].geometry.name)).toEqual(['near.glb', 'middle.glb', 'far.glb']);
    expect(b.levels).toHaveLength(3);
    // three.js shows the level that fits the distance.
    const camera = new THREE.PerspectiveCamera();
    camera.position.copy(at(4, 7));
    a.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    a.update(camera);
    expect(a.levels.map((l) => l.object.visible)).toEqual([true, false, false]);
    expect(isShown(a.levels[1].object.children[0])).toBe(false);
    expect(isShown(a.levels[0].object.children[0])).toBe(true);
  });

  it('hides the level’s own machine blocks and hands back their look', () => {
    const level = new THREE.Group();
    const material = new THREE.MeshStandardMaterial();
    const blocks = new THREE.Mesh(new THREE.BufferGeometry(), material);
    blocks.name = 'machines';
    level.add(blocks);
    expect(hideLevelMachines(level)).toBe(material);
    expect(blocks.visible).toBe(false);
    expect(hideLevelMachines(new THREE.Group())).toBeNull();
  });
});
