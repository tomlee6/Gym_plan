/**
 * The three.js scene for the walkthrough. The level is the generated model
 * (the GLB the 3D generator built, K-01) when there is one; otherwise it is
 * drawn here from buildModel (GEN-02..04): walls raised to the ceiling with
 * openings cut, floor and ceiling planes, objects and columns as plain
 * blocks, one default finish set, mirror walls reflective. Either way the
 * lights and environment (which mirrors reflect) are the same.
 *
 * Plan (x, y) maps to three.js (x, height, y). Geometry that shares a
 * material is merged into one mesh to keep draw calls low (VIEW-09).
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { WALL_THICKNESS_M } from './buildModel.js';
import { hideLevelMachines, placeMachines } from './machines.js';

export const COLOURS = {
  background: 0x0a1114,
  // Behind a generated level, which has its ground and roof: daylight through the windows.
  sky: 0xcfdde6,
  floor: 0x3a4146,
  floorLine: 0x4b5358,
  wall: 0xd8dbd9,
  ceiling: 0xeef0ef,
  column: 0xc4c8c6,
  object: 0x2f4650,
  stairVoid: 0x050707,
  rail: 0x9aa3a6,
  zone: 0xfb485b,
  exit: 0x00c260,
  power: 0xffcc00,
  measure: 0x00cab2,
};

/** A tiled floor texture, one tile per metre, so walking has a sense of pace. */
function floorTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = `#${COLOURS.floor.toString(16).padStart(6, '0')}`;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = `#${COLOURS.floorLine.toString(16).padStart(6, '0')}`;
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** A horizontal polygon at `height`, from plan points. */
function flatShape(points, height) {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const geom = new THREE.ShapeGeometry(shape);
  // (x, y, 0) -> (x, 0, y): the plan lies on the floor.
  geom.rotateX(Math.PI / 2);
  geom.translate(0, height, 0);
  // Texture coordinates in metres, for the tiled floor.
  const pos = geom.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i);
    uv[i * 2 + 1] = pos.getZ(i);
  }
  geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geom;
}

/** A box on the plan: centre (x, y), size w × d, from `bottom` to `top`. */
function block({ x, y, w, d, angle = 0 }, bottom, top) {
  const geom = new THREE.BoxGeometry(w, top - bottom, d);
  geom.rotateY(-angle);
  geom.translate(x, (bottom + top) / 2, y);
  return geom;
}

/** A wall piece: a box along a -> b. */
function wallBox(piece) {
  const dx = piece.b[0] - piece.a[0];
  const dy = piece.b[1] - piece.a[1];
  const len = Math.hypot(dx, dy);
  return block(
    { x: (piece.a[0] + piece.b[0]) / 2, y: (piece.a[1] + piece.b[1]) / 2, w: len + WALL_THICKNESS_M * 0.5, d: WALL_THICKNESS_M, angle: Math.atan2(dy, dx) },
    piece.bottom,
    piece.top,
  );
}

function merged(geometries) {
  if (!geometries.length) return null;
  const g = mergeGeometries(geometries.map((x) => (x.index ? x.toNonIndexed() : x)), false);
  for (const x of geometries) x.dispose();
  return g;
}

/**
 * The level drawn in the browser from the plan, as before there were
 * generated models (and still when a model cannot be loaded). Returns the
 * parts the overhead view hides.
 */
function drawPlan(model, add) {
  // Floor and ceiling.
  let ceiling = null;
  if (model.floor?.length >= 3) {
    const tex = floorTexture();
    add(
      flatShape(model.floor, 0),
      new THREE.MeshStandardMaterial({ color: tex ? 0xffffff : COLOURS.floor, map: tex, roughness: 0.95, side: THREE.DoubleSide }),
      { name: 'floor' },
    );
    ceiling = add(
      flatShape(model.floor, model.ceiling),
      new THREE.MeshStandardMaterial({ color: COLOURS.ceiling, roughness: 1, side: THREE.DoubleSide }),
      { name: 'ceiling' },
    );
  }

  // Walls: plain ones merged; mirror walls reflective (GEN-03).
  // Door and window heads are their own mesh so the overhead view can hide
  // them and show the openings.
  const wallMat = new THREE.MeshStandardMaterial({ color: COLOURS.wall, roughness: 0.85 });
  add(merged(model.walls.filter((p) => !p.mirror && p.kind !== 'head').map(wallBox)), wallMat, { name: 'walls' });
  const heads = add(merged(model.walls.filter((p) => p.kind === 'head').map(wallBox)), wallMat.clone(), { name: 'heads' });
  add(
    merged(model.walls.filter((p) => p.mirror && p.kind !== 'head').map(wallBox)),
    new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.03, envMapIntensity: 1.6 }),
    { name: 'mirrors' },
  );

  add(
    merged(model.columns.map((c) => block(c, 0, c.height))),
    new THREE.MeshStandardMaterial({ color: COLOURS.column, roughness: 0.8 }),
    { name: 'columns' },
  );
  add(
    merged(model.objects.map((o) => block(o, 0, o.height))),
    new THREE.MeshStandardMaterial({ color: COLOURS.object, roughness: 0.6, metalness: 0.2 }),
    { name: 'objects' },
  );

  // Stair and lift openings: a void with a rail round it (GEN-04).
  if (model.stairs.length) {
    add(
      merged(model.stairs.map((s) => flatShape(s.corners, 0.005))),
      new THREE.MeshBasicMaterial({ color: COLOURS.stairVoid, side: THREE.DoubleSide }),
      { name: 'stairs' },
    );
    const rails = model.stairs.flatMap((s) =>
      s.corners.map((p, i) => {
        const q = s.corners[(i + 1) % s.corners.length];
        return wallBox({ a: p, b: q, bottom: 0.95, top: 1.05 });
      }),
    );
    add(merged(rails), new THREE.MeshStandardMaterial({ color: COLOURS.rail, metalness: 0.6, roughness: 0.3 }), { name: 'rails' });
  }

  // No-build zones, marked on the floor.
  const zones = model.zones.filter((z) => z.points?.length >= 3);
  if (zones.length) {
    add(
      merged(zones.map((z) => flatShape(z.points, 0.01))),
      new THREE.MeshBasicMaterial({ color: COLOURS.zone, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }),
      { hit: false, name: 'zones' },
    );
  }

  // Fire exit signs above head height, power points low on the wall.
  const exits = model.tags.filter((t) => t.type === 'fireExit');
  if (exits.length) {
    add(
      merged(exits.map((t) => block({ x: t.x, y: t.y, w: 0.45, d: 0.45 }, 2.25, 2.45))),
      new THREE.MeshStandardMaterial({ color: COLOURS.exit, emissive: COLOURS.exit, emissiveIntensity: 0.8 }),
      { hit: false, name: 'exits' },
    );
  }
  const power = model.tags.filter((t) => t.type === 'power');
  if (power.length) {
    add(
      merged(power.map((t) => block({ x: t.x, y: t.y, w: 0.16, d: 0.16 }, 0.3, 0.42))),
      new THREE.MeshStandardMaterial({ color: COLOURS.power, emissive: COLOURS.power, emissiveIntensity: 0.4 }),
      { hit: false, name: 'power' },
    );
  }

  return { ceiling, heads };
}

/** Parts of a generated level the overhead view hides, so you can look down into the rooms. */
export const ABOVE = ['ceilings', 'roof', 'beams'];
/** Parts of a generated level the measure tool passes through. */
const NOT_MEASURED = ['zones', 'signs'];

/**
 * A generated level (the GLB's scene, K-01) placed in the scene, its parts
 * made measurable. Returns as `ceiling` a handle whose `visible` shows or
 * hides every part above head height at once, for the overhead view. The
 * parts stay where they are, so the level can be placed again after a
 * remount.
 */
function addLevel(scene, level, raycastables) {
  scene.add(level);
  for (const part of level.children) {
    if (NOT_MEASURED.includes(part.name)) continue;
    part.traverse((o) => {
      if (o.isMesh) raycastables.push(o);
    });
  }
  const above = ABOVE.map((name) => level.getObjectByName(name)).filter(Boolean);
  const ceiling = {
    set visible(on) {
      for (const part of above) part.visible = on;
    },
  };
  return { ceiling, heads: null };
}

/**
 * Builds the scene. Returns what the viewer needs: the scene, the meshes the
 * measure tool can hit, the ceiling (hidden from overhead), the player
 * marker, measure markers, and `dispose` for every GPU resource. `level` is
 * the generated level's scene when it was loaded (loadLevel in level.js);
 * without it the level is drawn from `model`. `machines` (machines.js:
 * placements and the models loaded for them) puts each machine's approved
 * model in place of the level's block for it (J-06); the returned
 * `machines` layer then wants the camera's position each frame (K-03).
 */
export function createScene(model, renderer, { level = null, machines = null } = {}) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(level ? COLOURS.sky : COLOURS.background);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new RoomEnvironment();
  const env = pmrem.fromScene(envScene, 0.04).texture;
  envScene.dispose?.();
  scene.environment = env;
  scene.environmentIntensity = 0.45;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4146, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(0.4, 1, 0.25);
  scene.add(sun);

  const raycastables = [];
  const add = (geometry, material, { hit = true, name } = {}) => {
    if (!geometry) return null;
    const mesh = new THREE.Mesh(geometry, material);
    if (name) mesh.name = name;
    scene.add(mesh);
    if (hit) raycastables.push(mesh);
    return mesh;
  };

  // The level: the generated model when there is one (K-01), else drawn from the plan.
  const { ceiling, heads } = level ? addLevel(scene, level, raycastables) : drawPlan(model, add);

  // Machines with an approved model (J-06): the models in place of the level's blocks, boxes for the
  // rest. Measured against as a group (machineLayer.group), since nearer levels of detail arrive later.
  let machineLayer = null;
  if (level && machines?.loaded?.size) {
    const material = hideLevelMachines(level);
    const hidden = new Set();
    level.getObjectByName('machines')?.traverse((o) => hidden.add(o));
    for (let i = raycastables.length - 1; i >= 0; i--) if (hidden.has(raycastables[i])) raycastables.splice(i, 1);
    machineLayer = placeMachines(scene, machines.placements, machines.loaded, { material, ceiling: model.ceiling });
  }

  // Where you are, seen from overhead.
  const marker = new THREE.Group();
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(0.35, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: COLOURS.measure }),
  );
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.22, 0.5, 3).rotateZ(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: COLOURS.measure }),
  );
  nose.position.set(0.5, 0, 0);
  marker.add(disc, nose);
  marker.position.y = model.ceiling + 0.05;
  marker.visible = false;
  scene.add(marker);

  // The measure tool's two ends and the line between them.
  const dotGeom = new THREE.SphereGeometry(0.06, 16, 12);
  const dotMat = new THREE.MeshBasicMaterial({ color: COLOURS.measure, depthTest: false });
  const ends = [new THREE.Mesh(dotGeom, dotMat), new THREE.Mesh(dotGeom, dotMat)];
  for (const e of ends) {
    e.visible = false;
    e.renderOrder = 10;
    scene.add(e);
  }
  const lineGeom = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
  const line = new THREE.Line(lineGeom, new THREE.LineBasicMaterial({ color: COLOURS.measure, depthTest: false }));
  line.visible = false;
  line.renderOrder = 10;
  scene.add(line);

  function setMeasure(a, b) {
    ends[0].visible = Boolean(a);
    ends[1].visible = Boolean(b);
    line.visible = Boolean(a && b);
    if (a) ends[0].position.set(...a);
    if (b) ends[1].position.set(...b);
    if (a && b) {
      const pos = lineGeom.attributes.position;
      pos.setXYZ(0, ...a);
      pos.setXYZ(1, ...b);
      pos.needsUpdate = true;
      lineGeom.computeBoundingSphere();
    }
  }

  function dispose() {
    scene.traverse((obj) => {
      obj.geometry?.dispose?.();
      const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
      for (const m of mats) {
        m.map?.dispose?.();
        m.dispose?.();
      }
    });
    env.dispose();
    pmrem.dispose();
  }

  return { scene, raycastables, machines: machineLayer, ceiling, heads, marker, ends, setMeasure, dispose };
}
