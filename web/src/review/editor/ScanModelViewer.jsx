/**
 * The scanned room in 3D, for the reviewer to compare with the room video
 * (ScanCheck): the capture's own files, as the phone made them.
 *
 * - A room scan: RoomPlan's `scan.usdz` (kind `model`), read with three.js's USD
 *   loader (USDZ, binary USDC inside).
 * - A 3D Space scan: the coloured LiDAR mesh (kind `mesh`, OBJ with vertex
 *   colours).
 *
 * Drag to turn, scroll or pinch to zoom, right-drag (or two fingers) to pan
 * (OrbitControls); "Reset view" goes back to the first view. On a 1 m grid
 * on the floor, so sizes can be judged at a glance.
 *
 * Loaded on demand, like ModelPreview: three.js and the loaders come into
 * the editor only when the scan check is open.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { USDLoader } from 'three/examples/jsm/loaders/USDLoader.js';

function dispose(object) {
  object.traverse((o) => {
    o.geometry?.dispose();
    for (const m of [o.material].flat().filter(Boolean)) {
      for (const value of Object.values(m)) if (value?.isTexture) value.dispose();
      m.dispose();
    }
  });
}

/** Loads a file as three.js objects. `kind` is the capture file kind. */
async function load(kind, url) {
  if (kind === 'mesh') {
    const group = await new OBJLoader().loadAsync(url);
    // The mesh carries a colour per vertex, taken from the camera on the phone.
    group.traverse((o) => {
      if (!o.isMesh) return;
      const coloured = Boolean(o.geometry.getAttribute('color'));
      o.material = new THREE.MeshStandardMaterial({
        vertexColors: coloured,
        color: coloured ? 0xffffff : 0x9fb3ba,
        roughness: 0.9,
        side: THREE.DoubleSide,
      });
    });
    return group;
  }
  const group = await new USDLoader().loadAsync(url);
  // RoomPlan's walls are thin boxes; seen from inside they need both faces.
  group.traverse((o) => {
    for (const m of [o.material].flat().filter(Boolean)) m.side = THREE.DoubleSide;
  });
  return group;
}

/** Where the camera starts: above one corner, looking down across the room. */
function homeView(bounds) {
  const size = bounds.getSize(new THREE.Vector3());
  const centre = bounds.getCenter(new THREE.Vector3());
  const span = Math.max(size.x, size.z, 1);
  const target = new THREE.Vector3(centre.x, bounds.min.y + size.y * 0.3, centre.z);
  const position = new THREE.Vector3(centre.x + span * 0.7, bounds.min.y + span * 0.9 + size.y, centre.z + span * 0.9);
  return { target, position, span };
}

export default function ScanModelViewer({ file, label }) {
  const holder = useRef(null);
  const reset = useRef(null);
  const [state, setState] = useState('loading');
  const [stats, setStats] = useState(null);
  // Load once per file, not again each time its link is re-signed.
  const key = file ? `${file.kind}:${file.url.split('?')[0]}` : null;

  useEffect(() => {
    if (!file) return undefined;
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
    setStats(null);

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    element.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x050a0c);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const environment = new RoomEnvironment();
    scene.environment = pmrem.fromScene(environment, 0.04).texture;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x223038, 0.6));
    const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 500);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.screenSpacePanning = true;

    const fit = () => {
      const width = element.clientWidth || 480;
      const height = element.clientHeight || 360;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    fit();
    const resized = new ResizeObserver(fit);
    resized.observe(element);

    load(file.kind, file.url)
      .then((model) => {
        if (stopped) return dispose(model);
        const bounds = new THREE.Box3().setFromObject(model);
        if (bounds.isEmpty()) throw new Error('empty');
        const size = bounds.getSize(new THREE.Vector3());
        const centre = bounds.getCenter(new THREE.Vector3());
        const cells = Math.ceil(Math.max(size.x, size.z) + 2);
        const grid = new THREE.GridHelper(cells, cells, 0x3f6773, 0x0f1f25);
        grid.position.set(Math.round(centre.x), bounds.min.y, Math.round(centre.z));
        scene.add(grid, model);

        const home = homeView(bounds);
        controls.maxDistance = home.span * 6;
        reset.current = () => {
          camera.position.copy(home.position);
          controls.target.copy(home.target);
          controls.update();
        };
        reset.current();
        setStats({ w: size.x, d: size.z, h: size.y });
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
      reset.current = null;
      cancelAnimationFrame(frame);
      resized.disconnect();
      controls.dispose();
      dispose(scene);
      environment.dispose?.();
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const onReset = useCallback(() => reset.current?.(), []);

  return (
    <div className="sc-model" ref={holder} role="img" aria-label={label}>
      {state === 'loading' && <p className="sc-note muted small">Loading the 3D scan…</p>}
      {state === 'failed' && (
        <p className="sc-note rv-error">
          The 3D scan could not be shown here.{' '}
          <a href={file.url} download>
            Download it
          </a>
        </p>
      )}
      {state === 'nowebgl' && <p className="sc-note muted small">This browser cannot show 3D (no WebGL).</p>}
      {state === 'ready' && (
        <div className="sc-model-bar">
          {stats && (
            <span className="small muted">
              {stats.w.toFixed(1)} × {stats.d.toFixed(1)} m, {stats.h.toFixed(1)} m high
            </span>
          )}
          <button type="button" className="rv-button ghost small" onClick={onReset}>
            Reset view
          </button>
        </div>
      )}
    </div>
  );
}
