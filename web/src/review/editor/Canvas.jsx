import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { bounds, centroid, dist, openingSegment, project, rectCorners } from '@shared/plan/index.js';

import { TAG_LABELS } from '../../lib/format.js';
import { clearanceToWall, nearestEquipment, wallLabels } from './measure.js';
import {
  addBeam,
  addCeilingZone,
  addColumn,
  addLevelChange,
  addOpening,
  addSpace,
  addTag,
  addVoid,
  addWall,
  addZone,
  findElement,
  moveItem,
  movePolygon,
  movePolygonPoint,
  moveWall,
  moveWallEnd,
  placeEquipment,
  setFacing,
  slideOpening,
  spaceAt,
  splitWall,
} from './ops.js';
import { kindLabel, withLists } from './planKinds.js';
import { snapPoint } from './snap.js';
import { POLYGON_TOOLS } from './Toolbar.jsx';
import { stretch, wallPoints } from './wallPath.js';

/** What a finished polygon draft becomes, per drawing tool. */
const POLYGON_ADDERS = {
  zone: (plan, points) => addZone(plan, points),
  space: (plan, points) => addSpace(plan, points),
  beam: (plan, points) => addBeam(plan, points),
  levelChange: (plan, points) => addLevelChange(plan, points),
  void: (plan, points) => addVoid(plan, points),
  // A ceiling zone belongs to the space it is drawn in; the selected space
  // is the fallback for a zone whose first corner was put on the wall line.
  ceilingZone: (plan, points, selection) => {
    const space = spaceAt(plan, centroid(points)) ?? plan.spaces.find((s) => s.id === selection);
    return space ? addCeilingZone(plan, space.id, points) : { plan, id: null };
  },
};

/** data-hit names of the polygon elements, and the list each lives in. */
const POLYGON_HITS = { zone: 'zones', space: 'spaces', czone: 'ceilingZones', beam: 'beams', level: 'levelChanges', void: 'voids' };

/** Degrees anticlockwise from +x, as format 3 stores a machine's facing, to a unit vector. */
const facingVector = (deg) => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];

export const TAG_COLOURS = {
  fireExit: '#FB485B',
  mirror: '#927DE5',
  power: '#FFCC00',
  stair: '#00AAE2',
  ceiling: '#00CAB2',
};

const MIN_SCALE = 2;
const MAX_SCALE = 800;

function polygonPoints(points) {
  return points.map((p) => p.join(',')).join(' ');
}

/** Everything drawn, for fitting the view. */
function planPoints(plan, underlay, source) {
  const pts = [
    ...plan.walls.flatMap((w) => [w.a, w.b]),
    ...plan.columns.flatMap(rectCorners),
    ...plan.objects.flatMap(rectCorners),
    ...plan.zones.flatMap((z) => z.points),
    ...plan.tags.map((t) => [t.x, t.y]),
    ...['spaces', 'beams', 'levelChanges', 'voids'].flatMap((k) => (plan[k] ?? []).flatMap((e) => e.points)),
  ];
  if (underlay) pts.push([0, 0], [underlay.widthM, underlay.heightM]);
  if (source) pts.push(...source.walls.flatMap((w) => [w.a, w.b]));
  return pts;
}

/**
 * The editing surface (REV-03, REV-04): the plan in metres, the source
 * underneath, and a gesture per tool. Every change goes through the
 * history (`change`, or `preview` + `commit` for drags).
 */
const Canvas = forwardRef(function Canvas(
  {
    plan: planProp,
    source,
    underlay,
    showSource,
    tool,
    toolOptions,
    selection,
    onSelect,
    readOnly,
    history,
    flagged,
    problems,
    showMeasurements = true,
    onScaleLine,
    onZoomChange,
    placing = null,
    onPlaced,
    meshPath = '',
  },
  ref,
) {
  // Plans saved before format 3 have no spaces, beams, level changes or voids.
  const plan = useMemo(() => withLists(planProp), [planProp]);
  const host = useRef(null);
  const svg = useRef(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState(null); // { cx, cy, s } — s is px per metre.
  const [hover, setHover] = useState(null);
  const [draft, setDraft] = useState(null);
  const gesture = useRef(null);
  const spaceDown = useRef(false);

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return undefined;
    const measure = () => setSize({ w: el.clientWidth || 800, h: el.clientHeight || 600 });
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(() => {
    const b = bounds(planPoints(plan, underlay, showSource ? source : null));
    if (!b) {
      setView({ cx: 10, cy: 10, s: 30 });
      return;
    }
    const w = Math.max(b.maxX - b.minX, 2);
    const h = Math.max(b.maxY - b.minY, 2);
    const s = Math.min(size.w / (w * 1.15), size.h / (h * 1.15));
    setView({ cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, s: Math.max(MIN_SCALE, Math.min(MAX_SCALE, s)) });
  }, [plan, underlay, source, showSource, size]);

  // Fit once the size is known, and again when a different plan loads.
  const fittedFor = useRef(null);
  useEffect(() => {
    const key = `${size.w}x${size.h}`;
    if (!view || fittedFor.current !== key) {
      if (!view) fit();
      fittedFor.current = key;
    }
  }, [size, view, fit]);

  useEffect(() => {
    if (view) onZoomChange?.(view.s);
  }, [view, onZoomChange]);

  const zoomBy = useCallback(
    (factor, at) => {
      setView((v) => {
        if (!v) return v;
        const s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.s * factor));
        if (!at) return { ...v, s };
        // Keep the point under the cursor where it is.
        return { s, cx: at[0] - ((at[0] - v.cx) * v.s) / s, cy: at[1] - ((at[1] - v.cy) * v.s) / s };
      });
    },
    [],
  );

  const cancelDraft = useCallback(() => setDraft(null), []);

  const finishDraft = useCallback(() => {
    if (draft?.kind === 'polygon' && draft.points.length >= 3) {
      const { plan: next, id } = POLYGON_ADDERS[draft.tool](plan, draft.points, selection);
      if (id) {
        history.change(next);
        onSelect(id);
      }
    }
    setDraft(null);
  }, [draft, plan, history, onSelect, selection]);

  useImperativeHandle(ref, () => ({ fit, zoomBy, cancelDraft, finishDraft, hasDraft: () => draft !== null }), [
    fit,
    zoomBy,
    cancelDraft,
    finishDraft,
    draft,
  ]);

  // A tool change abandons a half-drawn wall or zone.
  useEffect(() => setDraft(null), [tool]);

  useEffect(() => {
    const down = (e) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        spaceDown.current = true;
      }
    };
    const up = (e) => {
      if (e.code === 'Space') spaceDown.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // Wheel zoom needs a non-passive listener to stop the page scrolling.
  useEffect(() => {
    const el = svg.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      zoomBy(Math.exp(-e.deltaY * 0.0015), toPlan(e));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  if (!view) {
    return <div className="ed-canvas" ref={host} />;
  }

  const vb = [view.cx - size.w / 2 / view.s, view.cy - size.h / 2 / view.s, size.w / view.s, size.h / view.s];
  const px = (n) => n / view.s; // Screen pixels in metres.

  function toPlan(e) {
    const el = svg.current;
    const r = el.getBoundingClientRect();
    return [vb[0] + ((e.clientX - r.left) / r.width) * vb[2], vb[1] + ((e.clientY - r.top) / r.height) * vb[3]];
  }

  const snap = (p, opts = {}) => snapPoint(plan, p, { pxPerM: view.s, ...opts });

  function hitOf(e) {
    const el = e.target.closest?.('[data-hit]');
    if (!el) return null;
    const [kind, id, end] = el.getAttribute('data-hit').split(':');
    return { kind, id, end };
  }

  function onPointerDown(e) {
    if (e.button === 1 || e.button === 2 || spaceDown.current || tool === 'pan') {
      startPan(e);
      return;
    }
    if (e.button !== 0) return;
    const p = toPlan(e);
    const hit = hitOf(e);

    if (tool === 'select' || readOnly) {
      if (!hit) {
        startPan(e, { deselect: true });
        return;
      }
      onSelect(hit.id);
      if (readOnly) return;
      if (hit.kind === 'end') {
        const ignore = new Set(
          plan.walls.flatMap((w) =>
            ['a', 'b'].filter((k) => dist(w[k], plan.walls.find((x) => x.id === hit.id)[hit.end]) < 0.05).map((k) => `${w.id}:${k}`),
          ),
        );
        begin(e, { type: 'end', id: hit.id, end: hit.end, ignore, base: plan, detach: e.altKey });
      } else if (hit.kind === 'wall' && e.altKey) {
        const w = plan.walls.find((x) => x.id === hit.id);
        const { plan: next, ids } = splitWall(plan, hit.id, project(p, w.a, w.b).t);
        if (ids.length) {
          history.change(next);
          onSelect(ids[1]);
        }
      } else if (hit.kind === 'wall') {
        begin(e, { type: 'wall', id: hit.id, from: p, base: plan });
      } else if (hit.kind === 'opening') {
        begin(e, { type: 'opening', id: hit.id, base: plan });
      } else if (['column', 'object', 'tag'].includes(hit.kind)) {
        const item = [...plan.columns, ...plan.objects, ...plan.tags].find((x) => x.id === hit.id);
        begin(e, { type: 'item', id: hit.id, offset: [p[0] - item.x, p[1] - item.y], base: plan });
      } else if (hit.kind === 'vertex') {
        begin(e, { type: 'vertex', id: hit.id, index: Number(hit.end), base: plan });
      } else if (hit.kind === 'facing') {
        begin(e, { type: 'facing', id: hit.id, base: plan });
      } else if (hit.kind === 'space') {
        // A space covers the whole floor under everything else, so dragging
        // it pans, as dragging empty floor always has; its corners move it.
        startPan(e);
      } else if (POLYGON_HITS[hit.kind]) {
        begin(e, { type: 'polygon', id: hit.id, from: p, base: plan });
      }
      return;
    }

    if (tool === 'place') {
      if (!placing) return;
      const { plan: next, id } = placeEquipment(plan, placing, snap(p, { free: true }).point);
      if (id) {
        history.change(next);
        onSelect(id);
        onPlaced?.(id);
      }
      return;
    }

    if (POLYGON_TOOLS.includes(tool)) {
      const s = snap(p, { anchor: draft?.points?.at(-1), free: e.shiftKey });
      const first = draft?.points?.[0];
      if (first && draft.points.length >= 3 && dist(first, s.point) < px(12)) {
        finishDraft();
      } else {
        setDraft({ kind: 'polygon', tool, points: [...(draft?.points ?? []), s.point] });
      }
      return;
    }

    if (tool === 'wall') {
      const s = snap(p, { anchor: draft?.anchor, free: e.shiftKey });
      if (draft?.anchor) {
        const { plan: next, id } = addWall(plan, draft.anchor, s.point);
        if (id) {
          history.change(next);
          onSelect(id);
        }
        // Keep drawing from here, unless the outline just closed on a corner.
        setDraft(s.kind === 'corner' && id ? null : { kind: 'wall', anchor: s.point });
      } else {
        setDraft({ kind: 'wall', anchor: s.point });
      }
    } else if (tool === 'opening') {
      const kind = toolOptions.openingKind ?? 'single_door';
      const width = { double_door: 1.8, sliding_door: 1.8, roller_shutter: 3, window: 1.5, fixed_glazing: 2, opening: 1.2 }[kind] ?? 0.9;
      const { plan: next, id } = addOpening(plan, p, { kind, width, tolerance: px(20) });
      if (id) {
        history.change(next);
        onSelect(id);
      }
    } else if (tool === 'column') {
      const { plan: next, id } = addColumn(plan, snap(p, { free: true }).point);
      history.change(next);
      onSelect(id);
    } else if (tool === 'tag') {
      const type = toolOptions.tagType;
      const { plan: next, id } = addTag(plan, snap(p, { free: true }).point, type, type === 'ceiling' ? plan.ceilingHeightM : null);
      history.change(next);
      onSelect(id);
    } else if (tool === 'scale') {
      const s = snap(p, { anchor: draft?.a, free: e.shiftKey });
      if (draft?.a) {
        if (dist(draft.a, s.point) > 0.01) onScaleLine(draft.a, s.point);
        setDraft(null);
      } else {
        setDraft({ kind: 'scale', a: s.point });
      }
    }
  }

  function begin(e, g) {
    svg.current.setPointerCapture?.(e.pointerId);
    gesture.current = { ...g, moved: false, pointerId: e.pointerId };
  }

  function startPan(e, extra = {}) {
    svg.current.setPointerCapture?.(e.pointerId);
    gesture.current = { type: 'pan', x: e.clientX, y: e.clientY, view, moved: false, ...extra };
  }

  function onPointerMove(e) {
    const p = toPlan(e);
    const g = gesture.current;
    if (!g) {
      const anchor = draft?.anchor ?? draft?.a ?? draft?.points?.at(-1);
      setHover(tool === 'select' || tool === 'pan' ? null : { ...snap(p, { anchor, free: e.shiftKey }), raw: p });
      return;
    }
    if (g.type === 'pan') {
      const dx = e.clientX - g.x;
      const dy = e.clientY - g.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) g.moved = true;
      setView({ ...g.view, cx: g.view.cx - dx / g.view.s, cy: g.view.cy - dy / g.view.s });
      return;
    }
    g.moved = true;
    if (g.type === 'end') {
      const w = g.base.walls.find((x) => x.id === g.id);
      const other = w[g.end === 'a' ? 'b' : 'a'];
      const s = snap(p, { anchor: other, ignore: g.ignore, free: e.shiftKey });
      setHover(s);
      history.preview(moveWallEnd(g.base, g.id, g.end, s.point, { detach: g.detach }));
    } else if (g.type === 'wall') {
      const d = [Math.round((p[0] - g.from[0]) * 100) / 100, Math.round((p[1] - g.from[1]) * 100) / 100];
      history.preview(moveWall(g.base, g.id, d));
    } else if (g.type === 'opening') {
      history.preview(slideOpening(g.base, g.id, p));
    } else if (g.type === 'item') {
      history.preview(moveItem(g.base, g.id, [p[0] - g.offset[0], p[1] - g.offset[1]]));
    } else if (g.type === 'vertex') {
      const s = snap(p, { free: e.shiftKey });
      setHover(s);
      history.preview(movePolygonPoint(g.base, g.id, g.index, s.point));
    } else if (g.type === 'polygon') {
      const d = [Math.round((p[0] - g.from[0]) * 100) / 100, Math.round((p[1] - g.from[1]) * 100) / 100];
      history.preview(movePolygon(g.base, g.id, d));
    } else if (g.type === 'facing') {
      const o = g.base.objects.find((x) => x.id === g.id);
      if (!o) return;
      const deg = (Math.atan2(p[1] - o.y, p[0] - o.x) * 180) / Math.PI;
      // Whole 5° steps unless Shift is held, like walls square up unless freed.
      history.preview(setFacing(g.base, g.id, e.shiftKey ? deg : Math.round(deg / 5) * 5));
    }
  }

  function onPointerUp() {
    const g = gesture.current;
    gesture.current = null;
    setHover(null);
    if (!g) return;
    if (g.type === 'pan') {
      if (!g.moved && g.deselect) onSelect(null);
      return;
    }
    if (g.moved) history.commit();
  }

  function onDoubleClick() {
    if (draft?.kind === 'polygon') finishDraft();
    else if (draft?.kind === 'wall') setDraft(null);
  }

  const cursor = gesture.current?.type === 'pan' ? 'grabbing' : tool === 'select' || readOnly ? 'default' : tool === 'pan' ? 'grab' : 'crosshair';
  const selected = selection;
  const gridStep = view.s < 8 ? 10 : view.s < 30 ? 5 : 1;
  const gridLines = [];
  for (let x = Math.floor(vb[0] / gridStep) * gridStep; x <= vb[0] + vb[2]; x += gridStep) gridLines.push(['v', x]);
  for (let y = Math.floor(vb[1] / gridStep) * gridStep; y <= vb[1] + vb[3]; y += gridStep) gridLines.push(['h', y]);

  const wallColour = (w) => {
    if (w.id === selected) return '#00CAB2';
    if (problems.has(w.id)) return '#FB485B';
    if (flagged.has(w.id)) return '#FF7A1C';
    if (w.mirror) return '#B9A8F5';
    return '#FFFFFF';
  };
  const selectedWall = plan.walls.find((w) => w.id === selected);
  const selectedObject = plan.objects.find((o) => o.id === selected);
  const anchor = draft?.anchor ?? draft?.a ?? draft?.points?.at(-1);
  // The selected polygon (space, beam, ceiling zone, …) shows a handle on each corner.
  const selectedFound = selected ? findElement(plan, selected) : null;
  const selectedPolygon = selectedFound?.el?.points ? selectedFound.el : null;
  const ceilingZones = plan.spaces.flatMap((s) => s.ceilingZones ?? []);

  return (
    <div className="ed-canvas" ref={host}>
      <svg
        ref={svg}
        className="ed-svg"
        viewBox={vb.join(' ')}
        style={{ cursor }}
        role="application"
        aria-label={`Plan editor. ${plan.walls.length} walls, ${plan.openings.length} openings. Use the side panel to edit any element with the keyboard.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          gesture.current = null;
          history.cancel();
        }}
        onPointerLeave={() => !gesture.current && setHover(null)}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
      >
        {showSource && underlay && (
          <image
            href={underlay.url}
            x={0}
            y={0}
            width={underlay.widthM}
            height={underlay.heightM}
            preserveAspectRatio="none"
            opacity={0.55}
          />
        )}

        <g className="ed-grid">
          {gridLines.map(([d, at]) =>
            d === 'v' ? (
              <line key={`v${at}`} x1={at} y1={vb[1]} x2={at} y2={vb[1] + vb[3]} />
            ) : (
              <line key={`h${at}`} x1={vb[0]} y1={at} x2={vb[0] + vb[2]} y2={at} />
            ),
          )}
        </g>

        {showSource && source && (
          <g className="ed-source" aria-hidden="true">
            {source.walls.map((w, i) => (
              <line key={`sw${i}`} x1={w.a[0]} y1={w.a[1]} x2={w.b[0]} y2={w.b[1]} />
            ))}
            {source.objects.map((o, i) => (
              <polygon key={`so${i}`} points={polygonPoints(rectCorners(o))} />
            ))}
          </g>
        )}

        {/* H-03: the LiDAR mesh flattened onto the floor, faint, under everything drawn. */}
        {meshPath && <path className="ed-mesh" d={meshPath} aria-hidden="true" />}

        {/*
          Format 3 spaces first: each room's floor, labelled with its name
          and kind, under everything that stands on it.
        */}
        {plan.spaces.map((s) => (
          <polygon
            key={s.id}
            data-hit={`space:${s.id}`}
            className={`ed-space ${s.kind ?? ''} ${s.id === selected ? 'selected' : ''} ${flagged.has(s.id) ? 'flagged' : ''} ${problems.has(s.id) ? 'problem' : ''}`}
            points={polygonPoints(s.points)}
          />
        ))}
        {ceilingZones.map((z) => (
          <polygon
            key={z.id}
            data-hit={`czone:${z.id}`}
            className={`ed-ceiling-zone ${z.id === selected ? 'selected' : ''}`}
            points={polygonPoints(z.points)}
          />
        ))}
        {plan.levelChanges.map((l) => (
          <polygon
            key={l.id}
            data-hit={`level:${l.id}`}
            className={`ed-level ${l.kind} ${l.id === selected ? 'selected' : ''} ${problems.has(l.id) ? 'problem' : ''}`}
            points={polygonPoints(l.points)}
          />
        ))}
        {plan.voids.map((v) => (
          <polygon
            key={v.id}
            data-hit={`void:${v.id}`}
            className={`ed-void ${v.kind} ${v.id === selected ? 'selected' : ''} ${problems.has(v.id) ? 'problem' : ''}`}
            points={polygonPoints(v.points)}
          />
        ))}

        {plan.zones.map((z) => (
          <polygon
            key={z.id}
            data-hit={`zone:${z.id}`}
            className={`ed-zone ${z.id === selected ? 'selected' : ''}`}
            points={polygonPoints(z.points)}
          />
        ))}

        {plan.objects.map((o) => (
          <polygon
            key={o.id}
            data-hit={`object:${o.id}`}
            className={`ed-object ${o.id === selected ? 'selected' : ''} ${flagged.has(o.id) ? 'flagged' : ''} ${o.equipment ? 'equipment' : ''} ${problems.has(o.id) ? 'problem' : ''}`}
            points={polygonPoints(rectCorners(o))}
          />
        ))}

        {plan.columns.map((c) =>
          c.shape === 'round' ? (
            <ellipse
              key={c.id}
              data-hit={`column:${c.id}`}
              className={`ed-column ${c.id === selected ? 'selected' : ''}`}
              cx={c.x}
              cy={c.y}
              rx={c.w / 2}
              ry={c.d / 2}
              transform={c.angle ? `rotate(${(c.angle * 180) / Math.PI} ${c.x} ${c.y})` : undefined}
            />
          ) : (
            <polygon
              key={c.id}
              data-hit={`column:${c.id}`}
              className={`ed-column ${c.id === selected ? 'selected' : ''}`}
              points={polygonPoints(rectCorners(c))}
            />
          ),
        )}

        {/* Beams hang overhead, so they are an outline over the floor rather than a filled shape. */}
        {plan.beams.map((b) => (
          <polygon
            key={b.id}
            data-hit={`beam:${b.id}`}
            className={`ed-beam ${b.kind} ${b.id === selected ? 'selected' : ''}`}
            points={polygonPoints(b.points)}
          />
        ))}

        {plan.walls.map((w) => {
          const pts = wallPoints(w);
          const len = pts.reduce((sum, p, i) => (i ? sum + dist(pts[i - 1], p) : 0), 0);
          return (
            <g key={w.id} className={w.kind ? `ed-wall-kind ${w.kind}` : undefined}>
              {pts.length > 2 ? (
                <polyline className="ed-wall" points={polygonPoints(pts)} stroke={wallColour(w)} fill="none" />
              ) : (
                <line className="ed-wall" x1={w.a[0]} y1={w.a[1]} x2={w.b[0]} y2={w.b[1]} stroke={wallColour(w)} />
              )}
              {/* Mirror spans: the stretch of wall that is glass, drawn on the wall's room face. */}
              {(w.mirrors ?? []).map((m) => {
                const part = stretch(pts, m.fromM, Math.min(m.toM, len));
                return part.length > 1 ? (
                  <polyline key={m.id} className="ed-mirror-span" points={polygonPoints(part)} fill="none" aria-hidden="true" />
                ) : null;
              })}
              {pts.length > 2 ? (
                <polyline className="ed-hit" data-hit={`wall:${w.id}`} points={polygonPoints(pts)} fill="none" />
              ) : (
                <line className="ed-hit" data-hit={`wall:${w.id}`} x1={w.a[0]} y1={w.a[1]} x2={w.b[0]} y2={w.b[1]} />
              )}
            </g>
          );
        })}

        {plan.openings.map((o) => {
          const seg = openingSegment(plan, o);
          if (!seg) return null;
          const cls = `ed-opening ${o.type} ${o.id === selected ? 'selected' : ''} ${flagged.has(o.id) ? 'flagged' : ''} ${problems.has(o.id) ? 'problem' : ''}`;
          return (
            <g key={o.id}>
              <line className="ed-opening-gap" x1={seg.a[0]} y1={seg.a[1]} x2={seg.b[0]} y2={seg.b[1]} />
              <line className={cls} x1={seg.a[0]} y1={seg.a[1]} x2={seg.b[0]} y2={seg.b[1]} />
              {o.type === 'door' && o.kind !== 'sliding_door' && o.kind !== 'roller_shutter' && (
                <DoorSwing seg={seg} leaves={o.leaves ?? 1} hinge={o.hinge} swing={o.swing} />
              )}
              <line className="ed-hit" data-hit={`opening:${o.id}`} x1={seg.a[0]} y1={seg.a[1]} x2={seg.b[0]} y2={seg.b[1]} />
            </g>
          );
        })}

        {/*
          Which way each machine faces (format 3): an arrow from its centre
          to its front. The selected machine's arrow has a handle at the
          tip that turns it; a machine whose facing is not set yet shows a
          faint handle along its footprint's angle to start from.
        */}
        {plan.objects.map((o) => {
          const isSelected = o.id === selected;
          if (o.facingDeg == null && !(isSelected && !readOnly)) return null;
          const deg = o.facingDeg ?? ((o.angle ?? 0) * 180) / Math.PI;
          const [fx, fy] = facingVector(deg);
          const reach = Math.max(o.w, o.d) / 2 + px(16);
          const tip = [o.x + fx * reach, o.y + fy * reach];
          const head = px(6);
          const left = [tip[0] - fx * head - fy * head * 0.7, tip[1] - fy * head + fx * head * 0.7];
          const right = [tip[0] - fx * head + fy * head * 0.7, tip[1] - fy * head - fx * head * 0.7];
          return (
            <g key={`f${o.id}`} className={`ed-facing ${o.facingDeg == null ? 'unset' : ''} ${isSelected ? 'selected' : ''}`}>
              <line x1={o.x} y1={o.y} x2={tip[0]} y2={tip[1]} aria-hidden="true" />
              <polygon points={polygonPoints([tip, left, right])} aria-hidden="true" />
              {isSelected && !readOnly && (
                <circle className="ed-facing-handle" data-hit={`facing:${o.id}`} cx={tip[0]} cy={tip[1]} r={px(7)}>
                  <title>Drag to turn the machine’s front</title>
                </circle>
              )}
            </g>
          );
        })}

        {/* Space names, centred, so the reviewer can see which room is which. */}
        {view.s > 8 &&
          plan.spaces.map((s) => {
            const c = centroid(s.points);
            return c ? (
              <text key={`l${s.id}`} className="ed-space-label" x={c[0]} y={c[1]} fontSize={px(11)} strokeWidth={px(3)} textAnchor="middle" aria-hidden="true">
                {s.name || kindLabel(s.kind)}
              </text>
            ) : null;
          })}

        {plan.tags.map((t) => {
          const colour = TAG_COLOURS[t.type] ?? '#fff';
          return (
            <g key={t.id} data-hit={`tag:${t.id}`} className={`ed-tag ${t.id === selected ? 'selected' : ''}`}>
              <circle cx={t.x} cy={t.y} r={px(9)} fill="transparent" stroke={colour} />
              <circle cx={t.x} cy={t.y} r={px(4.5)} fill={colour} />
              <text x={t.x + px(12)} y={t.y + px(4)} fontSize={px(11)} strokeWidth={px(3)} fill={colour}>
                {TAG_LABELS[t.type]}
                {t.type === 'ceiling' && t.heightM ? ` ${Number(t.heightM).toFixed(2)} m` : ''}
              </text>
            </g>
          );
        })}

        {/*
          Measurements on the plan itself (CHANGE 1.7), so the reviewer can
          read a dimension off the drawing and check it against the gym
          without selecting anything first.

          Labels are hidden below a zoom where they would overlap each other
          into noise, and the selected wall keeps its own label either way.
        */}
        {showMeasurements && view.s > 14 && (
          <g className="ed-measure" aria-hidden="true">
            {wallLabels(plan, { minLengthM: px(44) }).map((label) => (
              <text
                key={label.id}
                className={label.id === selected ? 'on' : ''}
                x={label.mid[0] + label.normal[0] * px(11)}
                y={label.mid[1] + label.normal[1] * px(11)}
                fontSize={px(11)}
                strokeWidth={px(3)}
                textAnchor="middle"
                transform={`rotate(${label.angleDeg} ${label.mid[0] + label.normal[0] * px(11)} ${label.mid[1] + label.normal[1] * px(11)})`}
              >
                {label.text}
              </text>
            ))}
            {plan.objects
              .filter((o) => o.equipment)
              .map((o) => (
                <text
                  key={o.id}
                  className="ed-equipment-label"
                  x={o.x}
                  y={o.y + px(4)}
                  fontSize={px(10)}
                  strokeWidth={px(3)}
                  textAnchor="middle"
                >
                  {o.equipment.name}
                </text>
              ))}
          </g>
        )}

        {/*
          How far the selected machine stands from the wall behind it and
          from its nearest neighbour: the two numbers that say whether a gym
          floor actually works.
        */}
        {showMeasurements && selectedObject?.equipment && (
          <g className="ed-clearance" aria-hidden="true">
            {[clearanceToWall(plan, selectedObject), nearestEquipment(plan, selectedObject)]
              .filter((near) => near && near.distanceM < 12)
              .map((near, i) => (
                <text
                  key={i}
                  x={selectedObject.x}
                  y={selectedObject.y + px(16) + i * px(13)}
                  fontSize={px(10)}
                  strokeWidth={px(3)}
                  textAnchor="middle"
                >
                  {near.wall ? 'wall' : near.object.equipment.name} · {near.distanceM.toFixed(2)} m
                </text>
              ))}
          </g>
        )}

        {selectedWall && (
          <g className="ed-selected-wall">
            <text
              x={(selectedWall.a[0] + selectedWall.b[0]) / 2}
              y={(selectedWall.a[1] + selectedWall.b[1]) / 2 - px(10)}
              fontSize={px(12)}
              strokeWidth={px(3)}
              textAnchor="middle"
            >
              {dist(selectedWall.a, selectedWall.b).toFixed(2)} m
            </text>
          </g>
        )}

        {!readOnly &&
          plan.walls.map((w) =>
            ['a', 'b'].map((end) => (
              <circle
                key={`${w.id}${end}`}
                data-hit={`end:${w.id}:${end}`}
                className={`ed-handle ${w.id === selected ? 'selected' : ''}`}
                cx={w[end][0]}
                cy={w[end][1]}
                r={px(w.id === selected ? 6 : 4)}
              />
            )),
          )}

        {plan.scale?.a && plan.scale?.b && tool === 'scale' && (
          <line className="ed-scale-line" x1={plan.scale.a[0]} y1={plan.scale.a[1]} x2={plan.scale.b[0]} y2={plan.scale.b[1]} />
        )}

        {!readOnly &&
          selectedPolygon &&
          selectedPolygon.points.map((p, i) => (
            <circle
              key={`v${i}`}
              data-hit={`vertex:${selectedPolygon.id}:${i}`}
              className="ed-handle selected"
              cx={p[0]}
              cy={p[1]}
              r={px(5)}
            />
          ))}

        {draft?.kind === 'polygon' && (
          <polyline className="ed-draft" points={polygonPoints([...draft.points, ...(hover ? [hover.point] : [])])} />
        )}
        {anchor && hover && draft?.kind !== 'polygon' && (
          <g>
            <line className="ed-draft" x1={anchor[0]} y1={anchor[1]} x2={hover.point[0]} y2={hover.point[1]} />
            <text
              className="ed-draft-label"
              x={(anchor[0] + hover.point[0]) / 2}
              y={(anchor[1] + hover.point[1]) / 2 - px(10)}
              fontSize={px(12)}
              strokeWidth={px(3)}
              textAnchor="middle"
            >
              {dist(anchor, hover.point).toFixed(2)} m
            </text>
          </g>
        )}
        {hover && hover.kind !== 'free' && (
          <circle className={`ed-snap ${hover.kind}`} cx={hover.point[0]} cy={hover.point[1]} r={px(7)} />
        )}
      </svg>
    </div>
  );
});

/**
 * A door's swing: a quarter circle per leaf from its hinge. One leaf hangs
 * on the hinge side the reviewer chose (the start of the opening unless
 * `hinge` is 'right'); a double door has a leaf on each side meeting in
 * the middle. "Outward" swings to the other face of the wall.
 */
function DoorSwing({ seg, leaves = 1, hinge = null, swing = null }) {
  const w = dist(seg.a, seg.b);
  if (!(w > 0)) return null;
  const side = swing === 'outward' ? -1 : 1;
  const leaf = (h, t) => {
    const r = dist(h, t);
    const ux = (t[0] - h[0]) / r;
    const uy = (t[1] - h[1]) / r;
    // The side normal is fixed by the opening's direction, so both leaves of a double door open the same way.
    const nx = (-(seg.b[1] - seg.a[1]) / w) * side;
    const ny = ((seg.b[0] - seg.a[0]) / w) * side;
    const open = [h[0] + nx * r, h[1] + ny * r];
    const sweep = (open[0] - h[0]) * uy - (open[1] - h[1]) * ux > 0 ? 1 : 0;
    return (
      <g key={`${h[0]},${h[1]}`}>
        <line x1={h[0]} y1={h[1]} x2={open[0]} y2={open[1]} />
        <path d={`M ${open[0]} ${open[1]} A ${r} ${r} 0 0 ${sweep} ${t[0]} ${t[1]}`} fill="none" />
      </g>
    );
  };
  const middle = [(seg.a[0] + seg.b[0]) / 2, (seg.a[1] + seg.b[1]) / 2];
  const right = hinge === 'right' || (!hinge && swing === 'right');
  return (
    <g className="ed-door-swing" aria-hidden="true">
      {leaves === 2 ? [leaf(seg.a, middle), leaf(seg.b, middle)] : right ? leaf(seg.b, seg.a) : leaf(seg.a, seg.b)}
    </g>
  );
}

export default Canvas;
