import { OPENING_TYPES, TAG_TYPES } from '@shared/plan/index.js';

import { TAG_LABELS } from '../../lib/format.js';

function Svg({ children }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

/** The editing tools (REV-04) and their shortcuts (REV-11). */
export const TOOLS = [
  { id: 'select', key: 'v', label: 'Select and move', icon: <Svg><path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51z" /></Svg> },
  { id: 'pan', key: 'h', label: 'Pan', icon: <Svg><path d="M18 11V6a2 2 0 0 0-4 0v5" /><path d="M14 10V4a2 2 0 0 0-4 0v6" /><path d="M10 10.5V6a2 2 0 0 0-4 0v8" /><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" /></Svg> },
  { id: 'wall', key: 'w', label: 'Draw walls', icon: <Svg><path d="M4 20 20 4" /><circle cx="4" cy="20" r="2" /><circle cx="20" cy="4" r="2" /></Svg> },
  { id: 'opening', key: 'o', label: 'Add a door or window', icon: <Svg><path d="M3 21h18" /><path d="M6 21V4h9v17" /><path d="M15 4l3 2v15" /></Svg> },
  { id: 'column', key: 'c', label: 'Add a column', icon: <Svg><rect x="7" y="7" width="10" height="10" /></Svg> },
  { id: 'zone', key: 'z', label: 'Draw a no-build zone', icon: <Svg><path d="M4 4h16v16H4z" /><path d="m4 12 8-8" /><path d="m4 20 16-16" /><path d="m12 20 8-8" /></Svg> },
  { id: 'tag', key: 't', label: 'Add a tag', icon: <Svg><path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" /><circle cx="7" cy="7" r="1.5" /></Svg> },
  { id: 'scale', key: 's', label: 'Set or correct the scale', icon: <Svg><path d="M21.3 15.3 8.7 2.7a1 1 0 0 0-1.4 0L2.7 7.3a1 1 0 0 0 0 1.4l12.6 12.6a1 1 0 0 0 1.4 0l4.6-4.6a1 1 0 0 0 0-1.4z" /><path d="m7.5 10.5 2-2" /><path d="m10.5 13.5 2-2" /><path d="m13.5 16.5 2-2" /></Svg> },
];

const HINTS = {
  select: 'Click to select. Drag to move. Alt-click a wall to split it.',
  pan: 'Drag to pan. Scroll to zoom.',
  wall: 'Click to start, click to place each corner. Double-click or Esc to stop. Shift for free angles.',
  opening: 'Click on a wall to place the opening.',
  column: 'Click to place a 0.5 m column.',
  zone: 'Click each corner. Click the first corner, double-click or press Enter to close.',
  tag: 'Click to place the tag.',
  scale: 'Click both ends of a dimension you know, then enter its length.',
};

export default function Toolbar({ tool, onTool, options, onOptions, disabled, zoom, onZoom, onFit, history, showSource, onShowSource, hasSource }) {
  return (
    <div className="ed-toolbar">
      <div className="ed-tools" role="toolbar" aria-label="Tools" aria-orientation="vertical">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`ed-tool ${tool === t.id ? 'on' : ''}`}
            aria-pressed={tool === t.id}
            disabled={disabled && t.id !== 'select' && t.id !== 'pan'}
            onClick={() => onTool(t.id)}
            title={`${t.label} (${t.key.toUpperCase()})`}
          >
            {t.icon}
            <span className="sr-only">
              {t.label} ({t.key.toUpperCase()})
            </span>
          </button>
        ))}
      </div>

      <div className="ed-optbar">
        <span className="ed-hint small muted">{HINTS[tool]}</span>
        {tool === 'opening' && (
          <label className="ed-inline-select small">
            Type
            <select value={options.openingType} onChange={(e) => onOptions({ ...options, openingType: e.target.value })}>
              {OPENING_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        )}
        {tool === 'tag' && (
          <label className="ed-inline-select small">
            Tag
            <select value={options.tagType} onChange={(e) => onOptions({ ...options, tagType: e.target.value })}>
              {TAG_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TAG_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="spacer" />
        {hasSource && (
          <label className="ed-toggle small">
            <input type="checkbox" checked={showSource} onChange={(e) => onShowSource(e.target.checked)} />
            Show source
          </label>
        )}
        {!disabled && (
          <span className="ed-undo">
            <button type="button" className="rv-button ghost small" disabled={!history.canUndo} onClick={history.undo} title="Undo (Ctrl+Z)">
              Undo
            </button>
            <button type="button" className="rv-button ghost small" disabled={!history.canRedo} onClick={history.redo} title="Redo (Ctrl+Shift+Z)">
              Redo
            </button>
          </span>
        )}
        <span className="ed-zoom">
          <button type="button" className="rv-icon-button" onClick={() => onZoom(1 / 1.25)} title="Zoom out (−)">
            −<span className="sr-only">Zoom out</span>
          </button>
          <button type="button" className="ed-zoom-value small" onClick={onFit} title="Fit to screen (0)">
            {zoom ? `${Math.round(zoom)} px/m` : 'Fit'}
          </button>
          <button type="button" className="rv-icon-button" onClick={() => onZoom(1.25)} title="Zoom in (+)">
            +<span className="sr-only">Zoom in</span>
          </button>
        </span>
      </div>
    </div>
  );
}
