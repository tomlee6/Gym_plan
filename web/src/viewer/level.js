/**
 * The generated level (K-01): the GLB the 3D generator built for the
 * approved plan, fetched through the signed link the API gives
 * (`generatedModel.url`, M-07). Its geometry is meshopt-compressed, so the
 * loader needs three.js's MeshoptDecoder (which is why the app's CSP allows
 * 'wasm-unsafe-eval'). The file also carries the walk: where a walker cannot
 * go and where the walk starts, worked out from exactly what is drawn
 * (docs/3d-contract.md).
 */
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

/** Loads a generated level: `{ scene, walk }`. Rejects if the file is not one. */
export async function loadLevel(url) {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(url);
  const walk = gltf.scene.userData?.walk;
  if (!Array.isArray(walk?.collision) || !walk.start) throw new Error('The model file has no walk data.');
  return { scene: gltf.scene, walk };
}

/**
 * The viewer's model (from buildModel) with the generated level's collision
 * and start in place of its own, so walking matches the model on screen.
 * The rest (floor outline, bounds, ceiling, objects) still comes from the
 * plan, which is the plan the level was built from.
 */
export function withWalk(model, walk) {
  return {
    ...model,
    collision: walk.collision.map(([ax, ay, bx, by]) => ({ a: [ax, ay], b: [bx, by] })),
    start: { x: walk.start.x, y: walk.start.y, heading: walk.start.heading },
  };
}
