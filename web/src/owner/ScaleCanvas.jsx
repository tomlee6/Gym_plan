import { useEffect, useRef, useState } from 'react';

const ZOOMS = [1, 2, 4];

/** Distance between two points, in pixels. */
export function lineLength(a, b) {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/**
 * The drawing with the scale line over it (UPL-02). Both ends drag with the
 * mouse or a finger, and move with the arrow keys (Shift for 10 px). Points
 * are in the image's own pixels, whatever the zoom.
 */
export default function ScaleCanvas({ src, width, height, a, b, onChange }) {
  const svg = useRef(null);
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(null);
  const [shownPx, setShownPx] = useState(null);

  // Handles are sized in screen pixels (a 44 px touch target), whatever the
  // image size or zoom, so they stay easy to grab on a phone.
  useEffect(() => {
    const el = svg.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([entry]) => setShownPx(entry.contentRect.width || null));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const px = shownPx ? width / shownPx : Math.max(width, height) / 600;

  const clamp = (p) => [
    Math.round(Math.min(Math.max(p[0], 0), width)),
    Math.round(Math.min(Math.max(p[1], 0), height)),
  ];

  function toImage(e) {
    const el = svg.current;
    const ctm = el.getScreenCTM();
    if (!ctm) return null;
    const pt = el.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(ctm.inverse());
    return clamp([p.x, p.y]);
  }

  function move(end, p) {
    onChange(end === 'a' ? { a: p, b } : { a, b: p });
  }

  function onPointerDown(end) {
    return (e) => {
      e.preventDefault();
      e.currentTarget.focus();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      setDragging(end);
    };
  }

  function onPointerMove(e) {
    if (!dragging) return;
    const p = toImage(e);
    if (p) move(dragging, p);
  }

  function onKeyDown(end) {
    return (e) => {
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!d) return;
      e.preventDefault();
      const p = end === 'a' ? a : b;
      move(end, clamp([p[0] + d[0], p[1] + d[1]]));
    };
  }

  const handle = (end, p, label) => (
    <g
      className={`ow-handle ${dragging === end ? 'active' : ''}`}
      tabIndex={0}
      role="button"
      aria-label={`${label} of the scale line, at ${p[0]}, ${p[1]} pixels. Drag, or use the arrow keys to move it.`}
      onPointerDown={onPointerDown(end)}
      onKeyDown={onKeyDown(end)}
    >
      <circle cx={p[0]} cy={p[1]} r={px * 22} className="ow-handle-hit" />
      <circle cx={p[0]} cy={p[1]} r={px * 6} className="ow-handle-dot" />
    </g>
  );

  return (
    <div className="ow-scale">
      <div className="ow-zoom" role="group" aria-label="Zoom">
        {ZOOMS.map((z) => (
          <button
            key={z}
            type="button"
            className={`rv-button ${zoom === z ? 'primary' : 'ghost'}`}
            aria-pressed={zoom === z}
            onClick={() => setZoom(z)}
          >
            {z === 1 ? 'Fit' : `${z}×`}
          </button>
        ))}
      </div>
      <div className="ow-scale-viewport">
        <div
          className="ow-scale-stage"
          // Fit shows the whole drawing: as wide as the box, but never taller than it.
          style={{ width: zoom === 1 ? `min(100%, calc(var(--ow-scale-h) * ${width / height}))` : `${zoom * 100}%` }}
        >
          <img src={src} alt="The drawing to scale" className="ow-scale-img" draggable={false} />
          <svg
            ref={svg}
            className="ow-scale-svg"
            viewBox={`0 0 ${width} ${height}`}
            onPointerMove={onPointerMove}
            onPointerUp={() => setDragging(null)}
            onPointerCancel={() => setDragging(null)}
          >
            <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} className="ow-scale-line-halo" />
            <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} className="ow-scale-line" />
            {handle('a', a, 'Start')}
            {handle('b', b, 'End')}
          </svg>
        </div>
      </div>
      <p className="small muted">
        Line length: {Math.round(lineLength(a, b))} px. Drag either end to sit exactly on the dimension you know.
        Everything else on the plan scales from this one line.
      </p>
    </div>
  );
}
