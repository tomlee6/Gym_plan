import { useState } from 'react';

import { dist, OPENING_TYPES, summary as summarise, TAG_TYPES } from '@shared/plan/index.js';

import { bytes, inputLabel, stamp, STATUS_LABELS, TAG_LABELS } from '../../lib/format.js';
import { CheckIcon, DownloadIcon, FileIcon, TrashIcon } from '../../lib/icons.jsx';
import {
  confirmAllFlags,
  confirmFlag,
  deleteElement,
  findElement,
  joinCandidate,
  joinWalls,
  objectToColumn,
  splitWall,
  updateElement,
} from './ops.js';

const KIND_NAMES = {
  walls: 'Wall',
  openings: 'Opening',
  columns: 'Column',
  objects: 'Object',
  zones: 'No-build zone',
  tags: 'Tag',
};

/**
 * The right-hand panel: what needs confirming, validation, the selected
 * element, and the capture's photos, history and files.
 */
export default function Sidebar({ v, plan, issues, readOnly, selection, onSelect, onFocus, history }) {
  const [tab, setTab] = useState('review');
  const photos = v.files.filter((f) => f.kind === 'photo');
  const tabs = [
    ['review', 'Review'],
    ['photos', `Photos${photos.length ? ` · ${photos.length}` : ''}`],
    ['history', 'History'],
    ['files', 'Files'],
  ];

  return (
    <aside className="ed-side" aria-label="Plan review">
      <div className="ed-tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`ed-tab ${tab === id ? 'on' : ''}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="ed-side-body" role="tabpanel">
        {tab === 'review' && (
          <>
            <Inspector plan={plan} selection={selection} readOnly={readOnly} onSelect={onSelect} history={history} />
            <Flags plan={plan} readOnly={readOnly} onFocus={onFocus} history={history} />
            <Validation plan={plan} issues={issues} onFocus={onFocus} history={history} readOnly={readOnly} />
          </>
        )}
        {tab === 'photos' && <Photos photos={photos} />}
        {tab === 'history' && <History v={v} />}
        {tab === 'files' && <Files files={v.files} />}
      </div>
    </aside>
  );
}

function Flags({ plan, readOnly, onFocus, history }) {
  const open = plan.flags.filter((f) => f.status === 'open');
  const resolved = plan.flags.length - open.length;
  if (!plan.flags.length) return null;
  return (
    <section className="ed-card" aria-label="Needs confirmation">
      <div className="ed-card-head">
        <h2>Needs confirmation</h2>
        <span className={`ed-count ${open.length ? 'poor' : 'good'}`}>{open.length}</span>
      </div>
      {open.length === 0 ? (
        <div className="ed-cleared">
          <CheckIcon size={16} />
          <div>
            <strong>All {plan.flags.length} flags cleared</strong>
            <p className="muted small">Approve is unlocked once the plan passes validation.</p>
          </div>
        </div>
      ) : (
        <>
          <p className="muted small">
            The reader was unsure about these. Every one has to be confirmed, edited or deleted before the plan
            can be approved.
          </p>
          <ol className="ed-flags">
            {open.map((f, i) => (
              <li key={f.id} className="ed-flag">
                <span className="ed-flag-n">{i + 1}</span>
                <div className="ed-flag-text">
                  <strong>{f.title}</strong>
                  <span className="muted small">{f.detail}</span>
                  {!readOnly && (
                    <span className="ed-flag-actions">
                      <button type="button" className="rv-button ghost small" onClick={() => history.change(confirmFlag(plan, f.id))}>
                        Confirm
                      </button>
                      {f.elementId && findElement(plan, f.elementId) && (
                        <button type="button" className="rv-button ghost small" onClick={() => onFocus(f.elementId)}>
                          Edit
                        </button>
                      )}
                      {f.elementId && findElement(plan, f.elementId) && (
                        <button
                          type="button"
                          className="rv-button danger-ghost small"
                          onClick={() => history.change(deleteElement(plan, f.elementId))}
                        >
                          Delete
                        </button>
                      )}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ol>
          {!readOnly && open.length > 1 && (
            <button type="button" className="rv-button ghost wide-sm" onClick={() => history.change(confirmAllFlags(plan))}>
              Confirm all remaining
            </button>
          )}
        </>
      )}
      {resolved > 0 && open.length > 0 && <p className="muted small">{resolved} already resolved.</p>}
    </section>
  );
}

function Validation({ plan, issues, onFocus, history, readOnly }) {
  const s = summarise(plan);
  return (
    <section className="ed-card" aria-label="Validation">
      <div className="ed-card-head">
        <h2>Validation</h2>
        <span className={`ed-pill ${issues.length ? 'poor' : 'good'}`}>{issues.length ? `${issues.length} to fix` : 'Passed'}</span>
      </div>
      {issues.length > 0 && (
        <ul className="ed-issues">
          {issues.map((i, n) => (
            <li key={`${i.code}${n}`}>
              {i.ids.length > 0 ? (
                <button type="button" className="ed-link" onClick={() => onFocus(i.ids[0])}>
                  {i.message}
                </button>
              ) : (
                i.message
              )}
            </li>
          ))}
        </ul>
      )}
      <dl className="ed-facts">
        <div>
          <dt>Outline</dt>
          <dd className={s.areaM2 ? 'good' : 'poor'}>{s.areaM2 ? `Closed · ${s.areaM2} m²` : 'Open'}</dd>
        </div>
        <div>
          <dt>Walls / openings</dt>
          <dd>
            {s.walls} / {s.openings}
          </dd>
        </div>
        <div>
          <dt>Columns / objects</dt>
          <dd>
            {s.columns} / {s.objects}
          </dd>
        </div>
        <div>
          <dt>No-build zones / tags</dt>
          <dd>
            {s.zones} / {s.tags}
          </dd>
        </div>
        <div>
          <dt>Scale</dt>
          <dd>{s.scale}</dd>
        </div>
        <div>
          <dt>
            <label htmlFor="ceiling">Ceiling height</label>
          </dt>
          <dd>
            {readOnly ? (
              `${plan.ceilingHeightM.toFixed(2)} m${s.ceilingFromTag ? ' (tagged)' : ''}`
            ) : (
              <NumberField
                id="ceiling"
                value={plan.ceilingHeightM}
                min={2}
                max={12}
                step={0.01}
                suffix="m"
                onCommit={(n) => history.change({ ...plan, ceilingHeightM: n })}
              />
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

/** A number input that applies on Enter or blur, so typing is one undo step. */
function NumberField({ id, value, min, max, step = 0.01, suffix, onCommit, label }) {
  const [text, setText] = useState(null);
  const shown = text ?? String(Math.round(value * 1000) / 1000);
  const commit = () => {
    if (text === null) return;
    const n = Number(text);
    if (Number.isFinite(n) && n >= min && n <= max && n !== value) onCommit(n);
    setText(null);
  };
  return (
    <span className="ed-number">
      <input
        id={id}
        type="number"
        inputMode="decimal"
        value={shown}
        min={min}
        max={max}
        step={step}
        aria-label={label}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            e.currentTarget.blur();
          }
          if (e.key === 'Escape') setText(null);
        }}
      />
      {suffix && <span className="muted small">{suffix}</span>}
    </span>
  );
}

function Inspector({ plan, selection, readOnly, onSelect, history }) {
  const found = selection ? findElement(plan, selection) : null;
  if (!found) {
    return (
      <section className="ed-card ed-inspector-empty">
        <p className="muted small">
          Select an element to edit it. Drag a wall end to move a corner (Alt drags it free), drag a wall to move it,
          Alt-click a wall to split it.
        </p>
      </section>
    );
  }
  const { kind, el } = found;
  const flag = plan.flags.find((f) => f.elementId === el.id && f.status === 'open');
  const set = (fields) => history.change(updateElement(plan, el.id, fields));
  const remove = () => {
    history.change(deleteElement(plan, el.id));
    onSelect(null);
  };
  const ro = readOnly;

  return (
    <section className="ed-card" aria-label={`Selected ${KIND_NAMES[kind]}`}>
      <div className="ed-card-head">
        <h2>{KIND_NAMES[kind]}</h2>
        {!ro && (
          <button type="button" className="rv-icon-button" onClick={remove} title="Delete (Del)">
            <TrashIcon size={16} />
            <span className="sr-only">Delete {KIND_NAMES[kind].toLowerCase()}</span>
          </button>
        )}
      </div>
      {flag && <p className="ed-inline-flag small">Flagged: {flag.title}</p>}

      {kind === 'walls' && (
        <>
          <dl className="ed-facts">
            <div>
              <dt>Length</dt>
              <dd>{dist(el.a, el.b).toFixed(2)} m</dd>
            </div>
            <div>
              <dt>Read confidence</dt>
              <dd>{el.confidence.toFixed(2)}</dd>
            </div>
          </dl>
          <fieldset className="ed-coords" disabled={ro}>
            <legend className="small muted">Ends (m)</legend>
            {['a', 'b'].map((end) => (
              <div key={end} className="ed-coord-row">
                <span className="small muted">{end === 'a' ? 'Start' : 'End'}</span>
                {[0, 1].map((axis) => (
                  <NumberField
                    key={axis}
                    label={`${end === 'a' ? 'Start' : 'End'} ${axis ? 'y' : 'x'}`}
                    value={el[end][axis]}
                    min={-10000}
                    max={10000}
                    suffix={axis ? 'y' : 'x'}
                    onCommit={(n) => {
                      const p = [...el[end]];
                      p[axis] = n;
                      set({ [end]: p });
                    }}
                  />
                ))}
              </div>
            ))}
          </fieldset>
          <label className="ed-check">
            <input type="checkbox" checked={el.mirror} disabled={ro} onChange={(e) => set({ mirror: e.target.checked })} />
            Mirror wall (rendered reflective)
          </label>
          {!ro && (
            <div className="ed-actions">
              <button
                type="button"
                className="rv-button ghost small"
                onClick={() => {
                  const r = splitWall(plan, el.id, 0.5);
                  history.change(r.plan);
                  onSelect(r.ids[0]);
                }}
              >
                Split in half
              </button>
              <button
                type="button"
                className="rv-button ghost small"
                disabled={!joinCandidate(plan, el.id)}
                onClick={() => {
                  const r = joinWalls(plan, el.id);
                  history.change(r.plan);
                  onSelect(r.id);
                }}
              >
                Join with next
              </button>
            </div>
          )}
        </>
      )}

      {kind === 'openings' && (
        <>
          <label className="rv-field">
            <span>Type</span>
            <select value={el.type} disabled={ro} onChange={(e) => set({ type: e.target.value })}>
              {OPENING_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t[0].toUpperCase() + t.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <dl className="ed-facts">
            <div>
              <dt>Width</dt>
              <dd>{ro ? `${el.width.toFixed(2)} m` : <NumberField value={el.width} min={0.3} max={20} suffix="m" onCommit={(n) => set({ width: n })} label="Width" />}</dd>
            </div>
            <div>
              <dt>From wall start</dt>
              <dd>{ro ? `${el.offset.toFixed(2)} m` : <NumberField value={el.offset} min={0} max={1000} suffix="m" onCommit={(n) => set({ offset: n })} label="Offset from wall start" />}</dd>
            </div>
          </dl>
        </>
      )}

      {(kind === 'columns' || kind === 'objects') && (
        <>
          <dl className="ed-facts">
            {[
              ['x', 'Centre x'],
              ['y', 'Centre y'],
              ['w', 'Width'],
              ['d', 'Depth'],
              ...(kind === 'objects' ? [['heightM', 'Height']] : []),
            ].map(([key, label]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>
                  {ro ? (
                    `${el[key].toFixed(2)} m`
                  ) : (
                    <NumberField
                      value={el[key]}
                      min={key === 'x' || key === 'y' ? -10000 : 0.05}
                      max={key === 'x' || key === 'y' ? 10000 : 100}
                      suffix="m"
                      label={label}
                      onCommit={(n) => set({ [key]: n })}
                    />
                  )}
                </dd>
              </div>
            ))}
          </dl>
          {kind === 'objects' && !ro && (
            <button
              type="button"
              className="rv-button ghost small"
              onClick={() => {
                const r = objectToColumn(plan, el.id);
                history.change(r.plan);
                onSelect(r.id);
              }}
            >
              It is a column
            </button>
          )}
        </>
      )}

      {kind === 'zones' && <p className="muted small">{el.points.length} corners. Nothing may be placed inside a no-build zone.</p>}

      {kind === 'tags' && (
        <>
          <label className="rv-field">
            <span>Type</span>
            <select value={el.type} disabled={ro} onChange={(e) => set({ type: e.target.value })}>
              {TAG_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TAG_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          {el.type === 'ceiling' && (
            <dl className="ed-facts">
              <div>
                <dt>Height</dt>
                <dd>
                  {ro ? (
                    `${(el.heightM ?? 0).toFixed(2)} m`
                  ) : (
                    <NumberField
                      value={el.heightM ?? plan.ceilingHeightM}
                      min={2}
                      max={12}
                      suffix="m"
                      label="Ceiling height at tag"
                      onCommit={(n) => history.change({ ...updateElement(plan, el.id, { heightM: n }), ceilingHeightM: n })}
                    />
                  )}
                </dd>
              </div>
            </dl>
          )}
        </>
      )}
    </section>
  );
}

function Photos({ photos }) {
  if (!photos.length) return <p className="muted small ed-pad">No reference photos came with this capture.</p>;
  return (
    <div className="ed-photos">
      <p className="muted small">Photos may include people. They are only shown here, in the reviewer editor.</p>
      {photos.map((p) => (
        <a key={p.id} href={p.url} target="_blank" rel="noopener noreferrer">
          <img src={p.url} alt={`Reference photo ${p.name}`} loading="lazy" />
        </a>
      ))}
    </div>
  );
}

function History({ v }) {
  return (
    <ol className="ed-history">
      {v.history.map((h) => (
        <li key={h.id} className={h.id === v.id ? 'current' : ''}>
          <div className="ed-history-head">
            <strong>v{h.version}</strong>
            <span className={`rv-status ${h.status}`}>{STATUS_LABELS[h.status] ?? h.status}</span>
            {h.origin === 'revision' && <span className="rv-chip">Revision</span>}
          </div>
          <span className="small muted">
            {inputLabel(h.inputType)}
            {h.submittedBy ? ` · by ${h.submittedBy}` : ''} · {stamp(h.submittedAt ?? h.createdAt)}
          </span>
          {h.reviewedAt && (
            <span className="small muted">
              {h.status === 'recapture' ? 'Sent back' : 'Reviewed'} by {h.reviewerName ?? '—'} · {stamp(h.reviewedAt)}
            </span>
          )}
          {h.supersededAt && <span className="small muted">Superseded {stamp(h.supersededAt)}</span>}
          {h.contentHash && <code className="small">{h.contentHash.slice(0, 12)}…</code>}
        </li>
      ))}
    </ol>
  );
}

const FILE_KINDS = {
  model: '3D model (USDZ)',
  room: 'Room data (RoomPlan JSON)',
  photo: 'Photo',
  source: 'Uploaded drawing (original)',
  source_image: 'Drawing page, as traced',
};

function Files({ files }) {
  if (!files.length) return <p className="muted small ed-pad">No files were uploaded with this version.</p>;
  return (
    <ul className="rv-files">
      {files.map((f) => (
        <li key={f.id}>
          <FileIcon size={16} />
          <span className="rv-file-text">
            <span className="rv-file-name">{f.name}</span>
            <span className="muted small">
              {FILE_KINDS[f.kind] ?? f.kind} · {bytes(f.bytes)}
            </span>
          </span>
          <a className="rv-icon-button" href={f.url} download={f.name} title={`Download ${f.name}`}>
            <DownloadIcon size={16} />
            <span className="sr-only">Download {f.name}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
