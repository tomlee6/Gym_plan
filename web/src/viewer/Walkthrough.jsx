import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

import { buildModel, EYE_HEIGHT_M } from './buildModel.js';
import { loadLevel, withWalk } from './level.js';
import { isShown, loadMachineModels, machinePlacements } from './machines.js';
import { distance3, move } from './movement.js';
import { drawMinimap, PlanSvg } from './plan2d.jsx';
import { createScene } from './scene.js';
import './viewer.css';

const DISCLAIMER =
  'Indicative only — this walkthrough is not a certified drawing and must not be used for construction, compliance or lease measurement.';
const LOOK_SPEED = 0.0045;
const TURN_SPEED = 1.8; // Radians a second, arrow keys.
const MINIMAP_W = 192;
const MINIMAP_H = 132;

function hasWebGL() {
  return typeof window !== 'undefined' && Boolean(window.WebGL2RenderingContext || window.WebGLRenderingContext);
}

const levelName = (level) => (level === 0 ? 'Ground' : `Level ${level}`);

/**
 * The browser walkthrough (VIEW-01..08): first-person walk with collision,
 * an overhead view, a two-click measure tool, a minimap, a level selector
 * and the standing disclaimer. Nothing is installed.
 *
 * The level shown is the generated model when the API links one (`modelUrl`,
 * K-01), with its own collision and start; while it loads, a spinner; if it
 * cannot be loaded, the level is drawn in the browser from the approved
 * plan, as before there were generated models.
 *
 * With the generated level come the machines' approved 3D models
 * (`machineModels`, by reference, J-06), loaded alongside it and placed on
 * their footprints; a machine without one stays a box.
 *
 * Props: `plan` (approved plan JSON), `modelUrl` (signed link to the
 * generated level, or null), `machineModels`, `site`, `level`, `meta` (bottom-bar text),
 * `levels` + `onLevel(planId)` + `currentPlanId` for the level pills,
 * `onShare()` resolving to a URL, and `onClose()`.
 */
export default function Walkthrough({ plan, modelUrl = null, machineModels = null, site, level, meta, levels = [], currentPlanId, onLevel, onShare, onClose }) {
  const [webgl] = useState(hasWebGL);
  const drawn = useMemo(() => buildModel(plan), [plan]);
  // The generated level: null (none linked), loading, ready, or failed (then the plan is drawn).
  const [generated, setGenerated] = useState(() => (modelUrl && webgl ? { url: modelUrl, status: 'loading' } : null));
  useEffect(() => {
    if (!modelUrl || !webgl) {
      setGenerated(null);
      return undefined;
    }
    let live = true;
    setGenerated((g) => (g?.url === modelUrl ? g : { url: modelUrl, status: 'loading' }));
    // The machines' models load alongside the level; one that fails stays a box.
    const placements = machinePlacements(plan, machineModels);
    Promise.all([loadLevel(modelUrl), loadMachineModels(placements)]).then(
      ([loaded, models]) => live && setGenerated({ url: modelUrl, status: 'ready', ...loaded, machines: { placements, loaded: models } }),
      (err) => {
        if (!live) return;
        console.warn('Could not load the generated 3D model; drawing the level from the plan instead.', err);
        setGenerated({ url: modelUrl, status: 'failed' });
      },
    );
    return () => {
      live = false;
    };
  }, [modelUrl, webgl, plan, machineModels]);
  const ready = generated?.status === 'ready' ? generated : null;
  const loadingModel = generated?.status === 'loading';
  const model = useMemo(() => (ready ? withWalk(drawn, ready.walk) : drawn), [drawn, ready]);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState('walk');
  // The outside view's dollhouse: roof, ceilings and beams lifted off.
  const [roofOff, setRoofOff] = useState(false);
  const [measuring, setMeasuring] = useState(false);
  const [measured, setMeasured] = useState(null);
  const [share, setShare] = useState(null);

  const stage = useRef(null);
  const canvas = useRef(null);
  const label = useRef(null);
  const minimap = useRef(null);
  const knob = useRef(null);
  const sim = useRef(null);
  const built3d = useRef(null);

  // Mutable state the render loop reads every frame.
  if (!sim.current || sim.current.model !== model) {
    sim.current = {
      model,
      pos: [model.start.x, model.start.y],
      yaw: model.start.heading,
      pitch: 0,
      keys: new Set(),
      joy: { x: 0, y: 0 },
      view: 'walk',
      measuring: false,
      measure: { a: null, b: null },
      zoom: 1,
      pan: [0, 0],
      // Outside view: round the middle of the building, from the south-east, up a little.
      orbit: { yaw: -Math.PI / 4, pitch: 0.55, dist: 1.6 * Math.max(model.bounds.maxX - model.bounds.minX, model.bounds.maxY - model.bounds.minY, 8) },
      roofOff: false,
    };
  }
  useEffect(() => {
    sim.current.view = view;
  }, [view]);
  useEffect(() => {
    sim.current.roofOff = roofOff;
  }, [roofOff]);
  useEffect(() => {
    sim.current.measuring = measuring;
  }, [measuring]);

  // Reset the measurement and view when the level changes.
  useEffect(() => {
    setMeasured(null);
    setMeasuring(false);
    setView('walk');
    setRoofOff(false);
  }, [model]);

  useEffect(() => {
    if (!webgl || !canvas.current || loadingModel) return undefined;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvas.current, antialias: true, powerPreference: 'high-performance' });
    } catch {
      setFailed(true);
      return undefined;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const s = sim.current;
    const built = createScene(model, renderer, { level: ready?.scene ?? null, machines: ready?.machines ?? null });
    built3d.current = built;
    const persp = new THREE.PerspectiveCamera(70, 1, 0.05, 500);
    const ortho = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 500);
    ortho.up.set(0, 0, -1);
    const centre = [(model.bounds.minX + model.bounds.maxX) / 2, (model.bounds.minY + model.bounds.maxY) / 2];
    const raycaster = new THREE.Raycaster();
    let width = 1;
    let height = 1;

    function fitOrtho() {
      const aspect = width / height;
      const bw = model.bounds.maxX - model.bounds.minX;
      const bh = model.bounds.maxY - model.bounds.minY;
      const halfH = Math.max(bh / 2, bw / 2 / aspect) * 1.15 + 1;
      ortho.left = -halfH * aspect;
      ortho.right = halfH * aspect;
      ortho.top = halfH;
      ortho.bottom = -halfH;
      ortho.zoom = s.zoom;
      ortho.updateProjectionMatrix();
    }

    function resize() {
      const rect = stage.current.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      renderer.setSize(width, height, false);
      persp.aspect = width / height;
      persp.updateProjectionMatrix();
      fitOrtho();
    }
    const observer = new ResizeObserver(resize);
    observer.observe(stage.current);
    resize();

    const camera = () => (s.view === 'overhead' ? ortho : persp);

    // Pointer: drag to look (or pan from overhead), click to measure.
    let drag = null;
    const el = canvas.current;
    function onDown(e) {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      drag = { x: e.clientX, y: e.clientY, moved: 0, id: e.pointerId };
      el.setPointerCapture?.(e.pointerId);
    }
    function onMove(e) {
      if (!drag || drag.id !== e.pointerId) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      if (s.view === 'overhead') {
        const perPx = (ortho.right - ortho.left) / ortho.zoom / width;
        s.pan[0] -= dx * perPx;
        s.pan[1] -= dy * perPx;
      } else if (s.view === 'outside') {
        s.orbit.yaw += dx * LOOK_SPEED;
        s.orbit.pitch = Math.max(0.05, Math.min(1.5, s.orbit.pitch + dy * LOOK_SPEED));
      } else {
        s.yaw += dx * LOOK_SPEED;
        s.pitch = Math.max(-1.3, Math.min(1.3, s.pitch - dy * LOOK_SPEED));
      }
    }
    function onUp(e) {
      if (!drag || drag.id !== e.pointerId) return;
      const click = drag.moved < 6;
      drag = null;
      if (!click || !s.measuring) return;
      const rect = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera());
      const hits = raycaster.intersectObjects(built.raycastables, false);
      // Machines as a whole: their nearer levels of detail arrive after the scene is built (K-03).
      if (built.machines) hits.push(...raycaster.intersectObject(built.machines.group, true));
      const hit = hits.sort((a, b) => a.distance - b.distance).find((h) => isShown(h.object));
      if (!hit) return;
      const p = [hit.point.x, hit.point.y, hit.point.z];
      const m = s.measure;
      if (!m.a || m.b) {
        s.measure = { a: p, b: null };
        setMeasured({ a: p, b: null, metres: null });
      } else {
        s.measure = { a: m.a, b: p };
        setMeasured({ a: m.a, b: p, metres: distance3(m.a, p) });
      }
      built.setMeasure(s.measure.a, s.measure.b);
    }
    function onWheel(e) {
      if (s.view === 'outside') {
        e.preventDefault();
        s.orbit.dist = Math.max(3, Math.min(250, s.orbit.dist * (e.deltaY > 0 ? 1.1 : 0.9)));
        return;
      }
      if (s.view !== 'overhead') return;
      e.preventDefault();
      s.zoom = Math.max(0.5, Math.min(8, s.zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
      ortho.zoom = s.zoom;
      ortho.updateProjectionMatrix();
    }
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });

    // Keyboard: WASD or arrows to walk and turn, Shift to go faster.
    const typing = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    function onKey(e) {
      if (typing(e.target)) return;
      const k = e.key.toLowerCase();
      const known = ['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift'];
      if (!known.includes(k)) return;
      if (e.type === 'keydown') {
        s.keys.add(k);
        if (k.startsWith('arrow')) e.preventDefault();
      } else s.keys.delete(k);
    }
    const clearKeys = () => s.keys.clear();
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', clearKeys);

    // The loop.
    let raf = 0;
    let last = performance.now();
    let lastMap = 0;
    const look = new THREE.Vector3();
    const mid = new THREE.Vector3();
    const mapCtx = minimap.current?.getContext?.('2d') ?? null;

    function frame(now) {
      raf = requestAnimationFrame(frame);
      // Movement sub-steps, so a slow frame keeps pace without passing through walls.
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      const k = s.keys;

      if (s.view === 'walk') {
        const turn = (k.has('arrowleft') || k.has('q') ? -1 : 0) + (k.has('arrowright') || k.has('e') ? 1 : 0);
        s.yaw += turn * TURN_SPEED * dt;
        const forward = (k.has('w') || k.has('arrowup') ? 1 : 0) - (k.has('s') || k.has('arrowdown') ? 1 : 0) + s.joy.y;
        const strafe = (k.has('d') ? 1 : 0) - (k.has('a') ? 1 : 0) + s.joy.x;
        s.pos = move(s.pos, s.yaw, { forward, strafe, run: k.has('shift') }, dt, model.collision);
      }

      persp.position.set(s.pos[0], EYE_HEIGHT_M, s.pos[1]);
      look.set(
        s.pos[0] + Math.cos(s.yaw) * Math.cos(s.pitch),
        EYE_HEIGHT_M + Math.sin(s.pitch),
        s.pos[1] + Math.sin(s.yaw) * Math.cos(s.pitch),
      );
      persp.lookAt(look);
      if (s.view === 'outside') {
        const { yaw, pitch, dist } = s.orbit;
        persp.position.set(
          centre[0] + Math.cos(yaw) * Math.cos(pitch) * dist,
          Math.sin(pitch) * dist,
          centre[1] + Math.sin(yaw) * Math.cos(pitch) * dist,
        );
        persp.lookAt(centre[0], 1, centre[1]);
      }
      ortho.position.set(centre[0] + s.pan[0], model.ceiling + 40, centre[1] + s.pan[1]);
      ortho.lookAt(centre[0] + s.pan[0], 0, centre[1] + s.pan[1]);

      const overhead = s.view === 'overhead';
      const lidOff = overhead || (s.view === 'outside' && s.roofOff);
      if (built.ceiling) built.ceiling.visible = !lidOff;
      if (built.heads) built.heads.visible = !overhead;
      built.marker.visible = s.view !== 'walk';
      built.marker.position.set(s.pos[0], model.ceiling + 0.05, s.pos[1]);
      built.marker.rotation.y = -s.yaw;

      const cam = camera();
      // Nearer levels of detail for the machines the camera is coming up to (K-03).
      built.machines?.update(cam.position);
      // Measure ends stay the same size on screen, near or far.
      for (const end of built.ends) {
        if (!end.visible) continue;
        const k = overhead ? 4 / ortho.zoom : Math.max(0.15, end.position.distanceTo(persp.position) * 0.2);
        end.scale.setScalar(k);
      }
      renderer.render(built.scene, cam);

      // The measurement label follows the line's midpoint on screen.
      const m = s.measure;
      if (label.current) {
        if (m.a && m.b) {
          mid.set((m.a[0] + m.b[0]) / 2, (m.a[1] + m.b[1]) / 2, (m.a[2] + m.b[2]) / 2).project(cam);
          const onScreen = mid.z < 1 && Math.abs(mid.x) <= 1.2 && Math.abs(mid.y) <= 1.2;
          label.current.style.display = onScreen ? 'block' : 'none';
          label.current.style.transform = `translate(${((mid.x + 1) / 2) * width}px, ${((1 - mid.y) / 2) * height}px) translate(-50%, -50%)`;
        } else {
          label.current.style.display = 'none';
        }
      }

      if (mapCtx && now - lastMap > 80) {
        lastMap = now;
        drawMinimap(mapCtx, model, s.pos, s.yaw, MINIMAP_W, MINIMAP_H);
      }
    }
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', clearKeys);
      built3d.current = null;
      built.dispose();
      renderer.dispose();
    };
  }, [model, webgl, loadingModel, ready]);

  // Measure mode on and off; turning it on starts a fresh measurement.
  const toggleMeasure = useCallback(() => {
    setMeasuring((on) => {
      if (on) {
        // Leaving measure mode clears the line.
        sim.current.measure = { a: null, b: null };
        built3d.current?.setMeasure(null, null);
        setMeasured(null);
      }
      return !on;
    });
  }, []);

  // Touch joystick (VIEW-02): drag the knob to walk.
  const joyStart = useRef(null);
  function onJoyDown(e) {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const r = e.currentTarget.getBoundingClientRect();
    joyStart.current = { cx: r.left + r.width / 2, cy: r.top + r.height / 2, radius: r.width / 2 };
    onJoyMove(e);
  }
  function onJoyMove(e) {
    const j = joyStart.current;
    if (!j) return;
    let dx = (e.clientX - j.cx) / j.radius;
    let dy = (e.clientY - j.cy) / j.radius;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    sim.current.joy = { x: dx, y: -dy };
    if (knob.current) knob.current.style.transform = `translate(${dx * j.radius * 0.6}px, ${dy * j.radius * 0.6}px)`;
  }
  function onJoyUp() {
    joyStart.current = null;
    sim.current.joy = { x: 0, y: 0 };
    if (knob.current) knob.current.style.transform = '';
  }

  async function doShare() {
    setShare({ status: 'busy' });
    try {
      const url = await onShare();
      try {
        await navigator.clipboard.writeText(url);
        setShare({ status: 'copied', url });
      } catch {
        setShare({ status: 'ready', url });
      }
    } catch (err) {
      setShare({ status: 'error', message: err.message });
    }
  }

  const title = `${site} · ${levelName(level)}`;
  const showLevels = levels.length > 1 && onLevel;
  const noGl = !webgl || failed;

  return (
    <div className="wt">
      <header className="wt-top">
        <span className="wt-wordmark">FLEX</span>
        <span className="wt-divider" aria-hidden="true" />
        <h1 className="wt-title">
          {site}
          <span className="wt-muted"> · {levelName(level)}</span>
        </h1>
        <span className="wt-spacer" />
        {showLevels && (
          <div className="wt-pills" role="group" aria-label="Level">
            {levels.map((l) => (
              <button
                key={l.planId}
                type="button"
                className={`wt-pill ${l.planId === currentPlanId ? 'on' : ''}`}
                aria-pressed={l.planId === currentPlanId}
                onClick={() => l.planId !== currentPlanId && onLevel(l.planId)}
              >
                {levelName(l.level)}
              </button>
            ))}
          </div>
        )}
        {onShare && (
          <button type="button" className="wt-button" onClick={doShare} disabled={share?.status === 'busy'}>
            {share?.status === 'copied' ? 'Link copied' : share?.status === 'busy' ? 'Creating…' : 'Share link'}
          </button>
        )}
        {onClose && (
          <button type="button" className="wt-button" onClick={onClose}>
            Close
          </button>
        )}
      </header>
      {share?.status === 'ready' && (
        <p className="wt-toast" role="status">
          Share link: <a href={share.url}>{share.url}</a>
        </p>
      )}
      {share?.status === 'error' && (
        <p className="wt-toast error" role="alert">
          {share.message}
        </p>
      )}

      <div className={`wt-stage ${measuring ? 'measuring' : ''} ${view}`} ref={stage}>
        {noGl ? (
          <div className="wt-fallback">
            <PlanSvg model={model} title={`Plan of ${title}`} />
            <p>
              This browser cannot show 3D (WebGL is off or not supported), so here is the plan from above. Open the
              link in a current Chrome, Edge, Safari or Firefox to walk through it.
            </p>
          </div>
        ) : (
          <>
            {loadingModel && (
              <div className="wt-loading" role="status">
                <span className="wt-spinner" aria-hidden="true" />
                <p>Loading the 3D model…</p>
              </div>
            )}
            <canvas
              ref={canvas}
              className="wt-canvas"
              tabIndex={0}
              aria-label={`3D walkthrough of ${title}. Use W A S D or the arrow keys to walk, and drag to look around.`}
            />
            <div className="wt-label" ref={label} aria-hidden="true">
              {measured?.metres != null && `${measured.metres.toFixed(2)} m`}
            </div>

            <aside className="wt-panel wt-minimap" aria-label="Minimap">
              <div className="wt-eyebrow">MINIMAP</div>
              <canvas
                ref={minimap}
                width={MINIMAP_W * 2}
                height={MINIMAP_H * 2}
                style={{ width: MINIMAP_W, height: MINIMAP_H }}
                role="img"
                aria-label="Minimap with your position and facing"
              />
            </aside>

            {(measuring || measured) && (
              <aside className="wt-panel wt-measure" aria-live="polite">
                <div className="wt-eyebrow">MEASURE</div>
                <div className="wt-measure-value">
                  {measured?.metres != null ? `${measured.metres.toFixed(2)} m` : '—'}
                </div>
                <p className="wt-measure-help">
                  {!measured?.a
                    ? 'Click a first point on a wall, floor or object.'
                    : !measured?.b
                      ? 'Now click the second point.'
                      : 'Click again to start a new measurement.'}
                </p>
              </aside>
            )}

            <div
              className="wt-joystick"
              onPointerDown={onJoyDown}
              onPointerMove={onJoyMove}
              onPointerUp={onJoyUp}
              onPointerCancel={onJoyUp}
              aria-hidden="true"
            >
              <span className="wt-knob" ref={knob} />
            </div>

            <div className="wt-toolbar" role="toolbar" aria-label="View">
              <button type="button" className={`wt-tool ${view === 'walk' ? 'on' : ''}`} aria-pressed={view === 'walk'} onClick={() => setView('walk')}>
                <WalkIcon />
                Walk
              </button>
              <button
                type="button"
                className={`wt-tool ${view === 'overhead' ? 'on' : ''}`}
                aria-pressed={view === 'overhead'}
                onClick={() => setView('overhead')}
              >
                <OverheadIcon />
                Overhead
              </button>
              {ready && (
                <button
                  type="button"
                  className={`wt-tool ${view === 'outside' ? 'on' : ''}`}
                  aria-pressed={view === 'outside'}
                  onClick={() => setView('outside')}
                >
                  <OutsideIcon />
                  Outside
                </button>
              )}
              {ready && view === 'outside' && (
                <button type="button" className={`wt-tool ${roofOff ? 'on' : ''}`} aria-pressed={roofOff} onClick={() => setRoofOff((on) => !on)}>
                  <RoofIcon />
                  Roof off
                </button>
              )}
              <span className="wt-sep" aria-hidden="true" />
              <button type="button" className={`wt-tool ${measuring ? 'on' : ''}`} aria-pressed={measuring} onClick={toggleMeasure}>
                <RulerIcon />
                Measure
              </button>
              <span className="wt-sep wt-keys-only" aria-hidden="true" />
              <span className="wt-keys wt-keys-only">
                <span className="wt-keycaps">
                  <kbd>W</kbd>
                  <kbd>A</kbd>
                  <kbd>S</kbd>
                  <kbd>D</kbd>
                </span>
                to move
              </span>
            </div>
          </>
        )}
      </div>

      <footer className="wt-disclaimer">
        <span className="wt-warn" aria-hidden="true">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4" />
            <path d="M12 16h.01" />
          </svg>
        </span>
        <span className="wt-disclaimer-text">{DISCLAIMER}</span>
        {meta && <span className="wt-meta">{meta}</span>}
      </footer>
    </div>
  );
}

const icon = { width: 17, height: 17, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };

function WalkIcon() {
  return (
    <svg {...icon}>
      <circle cx="12" cy="5" r="2" />
      <path d="m9 20 3-6 3 6" />
      <path d="m6 11 6-3 6 3" />
      <path d="M12 8v6" />
    </svg>
  );
}

function OverheadIcon() {
  return (
    <svg {...icon}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 12h18" />
      <path d="M12 3v18" />
    </svg>
  );
}

function OutsideIcon() {
  return (
    <svg {...icon}>
      <path d="M3 11 12 4l9 7" />
      <path d="M5 10v10h14V10" />
      <path d="M10 20v-5h4v5" />
    </svg>
  );
}

function RoofIcon() {
  return (
    <svg {...icon}>
      <path d="M3 9 12 3l9 6" />
      <path d="M5 13v8h14v-8" />
      <path d="M12 6v4" />
    </svg>
  );
}

function RulerIcon() {
  return (
    <svg {...icon}>
      <path d="M21.3 8.7 8.7 21.3a1 1 0 0 1-1.4 0l-4.6-4.6a1 1 0 0 1 0-1.4L15.3 2.7a1 1 0 0 1 1.4 0l4.6 4.6a1 1 0 0 1 0 1.4z" />
      <path d="m7.5 10.5 2 2" />
      <path d="m10.5 7.5 2 2" />
      <path d="m13.5 4.5 2 2" />
    </svg>
  );
}
