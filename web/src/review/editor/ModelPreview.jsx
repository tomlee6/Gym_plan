/**
 * A machine model on its own, for the reviewer (L-08): turned with the
 * mouse, on a 1 m grid, inside the outline of the box the scan measured,
 * with an arrow where the plan says its front faces. The model stands on
 * the floor, centred on its footprint, X along the footprint's width and Z
 * along its depth (docs/3d-contract.md, L-06), so a glance says whether its
 * size is right and whether its front faces the arrow.
 *
 * Loaded on demand (it brings three.js into the editor only when a model is
 * looked at). Meshopt-compressed, like the levels, with KTX2 textures.
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const BOX_COLOUR = 0x00cab2;
const FRONT_COLOUR = 0xffcc00;

function dispose(object) {
  object.traverse((o) => {
    o.geometry?.dispose();
    for (const m of [o.material].flat().filter(Boolean)) {
      for (const value of Object.values(m)) if (value?.isTexture) value.dispose();
      m.dispose();
    }
  });
}

/** The scanned box as an outline standing on the floor, and an arrow out of the side the front should be. */
function guides(box, size, [fx, fz]) {
  const group = new THREE.Group();
  if (box?.w && box?.d && box?.h) {
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(box.w, box.h, box.d));
    const outline = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: BOX_COLOUR }));
    outline.position.y = box.h / 2;
    group.add(outline);
  }
  // From the middle of the side it points out of, a little beyond the model or the box, whichever reaches further.
  const halfX = Math.max(size.x, box?.w ?? 0) / 2;
  const halfZ = Math.max(size.z, box?.d ?? 0) / 2;
  const out = Math.min(halfX / Math.max(Math.abs(fx), 1e-6), halfZ / Math.max(Math.abs(fz), 1e-6)) + 0.05;
  const direction = new THREE.Vector3(fx, 0, fz).normalize();
  group.add(new THREE.ArrowHelper(direction, direction.clone().multiplyScalar(out).setY(0.02), 0.5, FRONT_COLOUR, 0.15, 0.1));
  return group;
}

export default function ModelPreview({ url, box, front = [1, 0], label }) {
  const holder = useRef(null);
  const [state, setState] = useState('loading');

  useEffect(() => {
    if (!url) return undefined;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      setState('nowebgl');
      return undefined;
    }
    const element = holder.current;
    let stopped = false;
    let frame = 0;
    setState('loading');

    const width = element.clientWidth || 480;
    const height = element.clientHeight || 360;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    element.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x050a0c);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const environment = new RoomEnvironment();
    scene.environment = pmrem.fromScene(environment, 0.04).texture;
    const camera = new THREE.PerspectiveCamera(40, width / height, 0.01, 100);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    // Its textures are KTX2 (N-01), transcoded to what this card takes.
    const ktx2 = new KTX2Loader().detectSupport(renderer);
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(ktx2);
    loader
      .loadAsync(url)
      .then((gltf) => {
        if (stopped) return dispose(gltf.scene);
        const model = gltf.scene;
        const bounds = new THREE.Box3().setFromObject(model);
        const size = bounds.getSize(new THREE.Vector3());
        const span = Math.max(size.x, size.y, size.z, box?.w ?? 0, box?.d ?? 0, box?.h ?? 0, 0.5);
        const grid = new THREE.GridHelper(Math.ceil(span * 2 + 1), Math.ceil(span * 2 + 1), 0x3f6773, 0x0f1f25);
        scene.add(grid, model, guides(box, size, front));
        // From the front and to one side, a little above: the view a person gets walking up to it.
        const target = new THREE.Vector3(0, size.y / 2, 0);
        camera.position.set(span * 1.1, span * 0.9 + size.y / 2, span * 1.6);
        controls.target.copy(target);
        controls.update();
        setState('ready');
      })
      .catch(() => {
        if (!stopped) setState('failed');
      });

    const draw = () => {
      if (stopped) return;
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(draw);
    };
    draw();

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      controls.dispose();
      ktx2.dispose();
      dispose(scene);
      environment.dispose?.();
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [url, box?.w, box?.d, box?.h, front[0], front[1]]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="mm-preview" ref={holder} role="img" aria-label={label}>
      {state === 'loading' && url && <p className="mm-preview-note muted small">Loading the model…</p>}
      {state === 'failed' && <p className="mm-preview-note rv-error">The model could not be loaded.</p>}
      {state === 'nowebgl' && <p className="mm-preview-note muted small">This browser cannot show 3D (no WebGL).</p>}
      {!url && <p className="mm-preview-note muted small">Nothing to show yet.</p>}
    </div>
  );
}
