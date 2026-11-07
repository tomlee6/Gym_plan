import { EQUIPMENT_LIBRARY, searchLibrary } from '@shared/plan/index.js';
import { useState } from 'react';

import { categoriesOf } from './useLibrary.js';

/** The drag payload type: a library entry's key. */
export const LIBRARY_DRAG_TYPE = 'application/x-flex-equipment';

const size = (i) => `${i.widthM.toFixed(1)} × ${i.depthM.toFixed(1)} m`;
const clearance = (i) =>
  i.clearance.behindM > i.clearance.aroundM
    ? `${i.clearance.aroundM} m round, ${i.clearance.behindM} m behind`
    : `${i.clearance.aroundM} m round`;

/**
 * The equipment library (fit-out planning): standard machines to put on
 * the plan. Drag one onto the plan, or choose Place and click where it
 * goes (the way that also works with a finger on a tablet).
 */
export default function EquipmentLibrary({ readOnly, placing, onPlace, library = EQUIPMENT_LIBRARY, failed = false }) {
  const [query, setQuery] = useState('');
  // Closed until wanted: the review panel is for checking the plan first.
  const [open, setOpen] = useState(false);
  if (readOnly) return null;
  const found = searchLibrary(query, library);
  const groups = categoriesOf(found).map((c) => [c, found.filter((i) => i.category === c)]);

  return (
    <section className="ed-card ed-library" aria-label="Equipment library">
      <button type="button" className="ed-card-head ed-library-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <h2>Equipment library</h2>
        <span className="ed-count">{library.length}</span>
      </button>
      {!open && <p className="muted small">Standard machines to drag onto the plan for a fit-out.</p>}
      {open && (
        <div className="ed-library-body">
          <p className="muted small">
            Drag a machine onto the plan, or choose Place and click where it stands. Generic machines have typical sizes; a maker's machines
            have their own.
          </p>
          {failed && (
            <p className="muted small" role="status">
              The library could not be loaded, so this is the built-in list.
            </p>
          )}
          <label className="rv-field">
            <span>Search equipment</span>
            <input type="search" value={query} placeholder="e.g. rack, bike, press" onChange={(e) => setQuery(e.target.value)} />
          </label>
          {groups.length === 0 && <p className="muted small">Nothing in the library matches “{query}”.</p>}
          {groups.map(([category, list]) => (
            <div key={category} className="ed-library-group">
              <h3>{category}</h3>
              <ul className="ed-unplaced">
                {list.map((i) => {
                  const active = placing?.entryKey === i.key;
                  return (
                    <li
                      key={i.key}
                      className={`ed-library-item ${active ? 'on' : ''}`}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData(LIBRARY_DRAG_TYPE, i.key);
                        e.dataTransfer.setData('text/plain', i.name);
                        e.dataTransfer.effectAllowed = 'copy';
                      }}
                      title={`Drag ${i.name} onto the plan`}
                    >
                      <span className="ed-unplaced-text">
                        <strong>{i.name}</strong>
                        {i.manufacturer && (
                          <span className="muted small">
                            {i.manufacturer.name}
                            {i.modelCode ? ` · ${i.modelCode}` : ''}
                          </span>
                        )}
                        <span className="muted small">
                          {size(i)} · {i.heightM.toFixed(1)} m high · clear {clearance(i)}
                        </span>
                      </span>
                      <button
                        type="button"
                        className={`rv-button small ${active ? 'primary' : 'ghost'}`}
                        aria-pressed={active}
                        aria-label={`Place a ${i.name} on the plan`}
                        onClick={() => onPlace?.(i)}
                      >
                        {active ? 'Click the plan…' : 'Place'}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
