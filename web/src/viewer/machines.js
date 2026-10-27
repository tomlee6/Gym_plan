/**
 * Machines in the walkthrough (J-06, K-03): each machine's approved 3D
 * model (`machineModels` from the API, by the machine's reference) placed on
 * its footprint from the plan, and a plain box where there is none. The
 * level's own machine blocks are hidden then, so every machine is drawn
 * here. A machine marked the same as another uses that one's model, and a
 * model used many times is loaded once and shared.
 *
 * A model's frame is its footprint's (docs/3d-contract.md, L-06): X along
 * the width, Z along the depth, standing on y = 0, its front settled in
 * review. Plan [x, y] is three.js (x, ·, y), so a footprint turned `angle`
 * on the plan is turned -angle about +Y here.
 *
 * Detail by distance (K-03): each model has levels of detail, nearest
 * first. The farthest (smallest) loads with the level, so every machine
 * shows at once; a nearer one loads when the camera comes within reach of a
 * machine that uses it, and three.js shows whichever fits the distance.
 * Files are kept for the session, across levels, by their path: a model's
 * files are named by their content, so a re-signed link finds the copy.
 */
import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';

import { LEVELS_OF_DETAIL } from '@shared/build3d/budget.js';

/** As the level draws a machine without a height (DEFAULT_OBJECT_HEIGHT_M). */
const DEFAULT_HEIGHT_M = 1.2;
const BOX_COLOUR = 0x2f4650;
/** Metres from the camera from which each level of detail is shown, nearest first (shared/build3d/budget.js). */
export const LOD_DISTANCES = LEVELS_OF_DETAIL.map((l) => l.fromM);
/** A nearer level is fetched this much before it is needed. */
export const PRELOAD_M = 4;
/** The camera is checked against the machines once in this many frames. */
export const CHECK_EVERY = 15;

/** Each named machine on the plan with the model it uses (its own, or the one it is the same as), or null. */
export function machinePlacements(plan, machineModels) {
  const objects = plan?.objects ?? [];
  const byId = new Map(objects.map((o) => [o.id, o]));
  return objects
    .filter((o) => o.equipment && o.w > 0 && o.d > 0 && Number.isFinite(o.x) && Number.isFinite(o.y))
    .map((object) => {
      const other = object.sameAs ? byId.get(object.sameAs) : null;
      const source = other?.equipment ? other : object;
      const model = machineModels?.[source.equipment.equipmentId] ?? null;
      return { object, model: model?.lods?.some((l) => l.url) ? model : null };
    });
}

/**
 * KTX2Loader wants to know which compressed formats the graphics card
 * takes, and asks a renderer; models load before the walkthrough has one,
 * so it asks a WebGL context made for the purpose, then let go.
 */
export function gpuFormats() {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
  const extensions = { has: (name) => Boolean(gl?.getExtension(name)), get: (name) => gl?.getExtension(name) };
  return { renderer: { isWebGPURenderer: false, extensions }, release: () => gl?.getExtension('WEBGL_lose_context')?.loseContext() };
}

let loader = null;
function defaultLoad(url) {
  if (!loader) {
    // Machine models' textures are KTX2 (N-01): transcoded, in a worker, to whatever this card takes.
    const ktx2 = new KTX2Loader();
    const gpu = gpuFormats();
    ktx2.detectSupport(gpu.renderer);
    gpu.release();
    loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(ktx2);
  }
  return loader.loadAsync(url);
}

// The session's model files, by path (not the signature, which changes).
const files = new Map();

/** Forgets every model file held (tests). */
export function forgetMachineModels() {
  files.clear();
}

function fileOf(url) {
  try {
    const u = new URL(url, 'http://local');
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

/** One model file's scene, loaded once for the session. */
export function loadModelFile(url, load = defaultLoad) {
  const key = fileOf(url);
  let scene = files.get(key);
  if (!scene) {
    scene = Promise.resolve(load(url)).then((gltf) => gltf.scene);
    files.set(key, scene);
    // A failed load is not kept, so the next level tries again.
    scene.catch(() => files.delete(key));
  }
  return scene;
}

const farthest = (model) => model.lods.length - 1;
const distanceOf = (index) => LOD_DISTANCES[Math.min(index, LOD_DISTANCES.length - 1)];

/**
 * Loads the farthest level of detail of each model the placements use,
 * once: `Map(modelId -> scene)`. A model that cannot be loaded is left out,
 * and its machines stay boxes.
 */
export async function loadMachineModels(placements, load = defaultLoad) {
  const wanted = new Map();
  for (const { model } of placements) if (model && !wanted.has(model.modelId)) wanted.set(model.modelId, model);
  const loaded = new Map();
  await Promise.all(
    [...wanted.values()].map(async (model) => {
      try {
        loaded.set(model.modelId, await loadModelFile(model.lods[farthest(model)].url, load));
      } catch (err) {
        console.warn(`Could not load machine model ${model.modelId}; drawing a box instead.`, err);
      }
    }),
  );
  return loaded;
}

/**
 * Adds the machines to the scene, under one group named `machine-models`:
 * a level-of-detail node per machine with a model that loaded (sharing its
 * geometry and textures), a box otherwise. `ceiling` keeps a box under the
 * ceiling, as the level does. Returns the group and `update(position)`, for
 * the render loop to call with the camera's position: it fetches nearer
 * levels of detail as the camera comes within reach of them.
 */
export function placeMachines(scene, placements, loaded, { material = null, ceiling = Infinity, load = defaultLoad } = {}) {
  const group = new THREE.Group();
  group.name = 'machine-models';
  const boxMaterial = material ?? new THREE.MeshStandardMaterial({ color: BOX_COLOUR, roughness: 0.6, metalness: 0.2 });
  // Per model: its machines' nodes, and which of its levels have been asked for.
  const byModel = new Map();
  for (const { object: o, model } of placements) {
    const template = model ? loaded.get(model.modelId) : null;
    const bottom = o.elevationM > 0 ? o.elevationM : 0;
    let node;
    if (template) {
      node = new THREE.LOD();
      node.addLevel(template.clone(true), distanceOf(farthest(model)));
      if (!byModel.has(model.modelId)) byModel.set(model.modelId, { model, nodes: [], asked: new Set([farthest(model)]) });
      byModel.get(model.modelId).nodes.push(node);
    } else {
      const height = Math.min(o.heightM > 0 ? o.heightM : DEFAULT_HEIGHT_M, Math.max(0.01, ceiling - bottom));
      node = new THREE.Mesh(new THREE.BoxGeometry(o.w, height, o.d).translate(0, height / 2, 0), boxMaterial);
    }
    node.name = `machine:${o.equipment.equipmentId}`;
    node.userData.modelId = template ? model.modelId : null;
    node.position.set(o.x, bottom, o.y);
    node.rotation.y = -(o.angle ?? 0);
    group.add(node);
  }
  scene.add(group);

  let frame = 0;
  function update(position) {
    if (frame++ % CHECK_EVERY) return;
    for (const entry of byModel.values()) {
      const { lods } = entry.model;
      // Nearer levels in turn: each is shown inside the next one's distance.
      for (let i = lods.length - 2; i >= 0; i--) {
        if (entry.asked.has(i)) continue;
        const reach = distanceOf(i + 1) + PRELOAD_M;
        if (!entry.nodes.some((n) => n.position.distanceTo(position) < reach)) break;
        entry.asked.add(i);
        loadModelFile(lods[i].url, load).then(
          (level) => {
            for (const n of entry.nodes) n.addLevel(level.clone(true), distanceOf(i));
          },
          (err) => console.warn(`Could not load a nearer level of machine model ${entry.model.modelId}.`, err),
        );
      }
    }
  }
  return { group, update };
}

/** The level's own machine blocks, hidden: the machines are drawn by placeMachines instead. Returns their material. */
export function hideLevelMachines(level) {
  const blocks = level?.getObjectByName('machines');
  if (!blocks) return null;
  blocks.visible = false;
  let material = null;
  blocks.traverse((o) => {
    if (!material && o.isMesh) material = o.material;
  });
  return material;
}

/** Whether an object is drawn: it and everything it hangs from visible (a level of detail not in use is not). */
export function isShown(object) {
  for (let o = object; o; o = o.parent) if (!o.visible) return false;
  return true;
}
