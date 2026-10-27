import { useState } from 'react';

import {
  dist,
  EQUIPMENT_TYPES,
  equipmentLabel,
  summary as summarise,
  TAG_TYPES,
  wallAngleDeg,
  wallLength,
  wallName,
} from '@shared/plan/index.js';

import { bytes, inputLabel, stamp, STATUS_LABELS, TAG_LABELS } from '../../lib/format.js';
import { CheckIcon, DownloadIcon, FileIcon, TrashIcon } from '../../lib/icons.jsx';
import { keyframeUrl, keyframesSeeing } from './keyframes.js';
import { MachineModelPanel } from './MachineModel.jsx';
import { clearanceToWall, nearestEquipment } from './measure.js';
import {
  addMirror,
  confirmAllFlags,
  confirmFlag,
  deleteElement,
  findElement,
  flagElement,
  joinCandidate,
  joinWalls,
  nextEquipmentId,
  objectToColumn,
  removeMirror,
  rotateObject,
  setColumnShape,
  setEquipment,
  setFacing,
  setOpeningKind,
  setWallCurve,
  setWallLength,
  setWallMirror,
  splitWall,
  unplacedEquipment,
  updateElement,
  updateMirror,
} from './ops.js';
import {
  BEAM_KINDS,
  COLUMN_SHAPES,
  FLOOR_FINISHES,
  HINGE_SIDES,
  kindLabel,
  LEVEL_CHANGE_KINDS,
  OPENING_KINDS,
  SPACE_KINDS,
  VOID_KINDS,
  WALL_KINDS,
} from './planKinds.js';

/** RoomPlan reports no swing, so these are the reviewer's to choose. */
const SWINGS = [
  ['inward', 'Opens inward'],
  ['outward', 'Opens outward'],
  ['left', 'Hinged left'],
  ['right', 'Hinged right'],
];

const degreesOf = (radians) => (((((radians ?? 0) * 180) / Math.PI) % 360) + 360) % 360;

/** The 360 video recorded for an object's machine, if there is one. */
function videoFor(v, object) {
  if (!object.equipment) return null;
  const match = (v.equipment ?? []).find((e) => e.equipmentId === object.equipment.equipmentId);
  return match?.video ?? null;
}

const KIND_NAMES = {
  walls: 'Wall',
  openings: 'Opening',
  columns: 'Column',
  objects: 'Object',
  zones: 'No-build zone',
  tags: 'Tag',
  spaces: 'Space',
  ceilingZones: 'Ceiling zone',
  beams: 'Beam or bulkhead',
  levelChanges: 'Level change',
  voids: 'Stair, lift or void',
};

/**
 * The right-hand panel: what needs confirming, validation, the selected
 * element, and the capture's photos, history and files.
 */
export default function Sidebar({
  v,
  plan,
  issues,
  readOnly,
  selection,
  onSelect,
  onFocus,
  history,
  placing = null,
  onPlace,
  keyframes = null,
}) {
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
            <Inspector
              v={v}
              plan={plan}
              selection={selection}
              readOnly={readOnly}
              onSelect={onSelect}
              history={history}
              keyframes={keyframes}
            />
            <Unplaced v={v} plan={plan} readOnly={readOnly} placing={placing} onPlace={onPlace} />
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

/**
 * H-02: machines the surveyor recorded on the phone without standing at
 * them (`placed: false`). They have a name, a type and often a 360 video,
 * but no position, so the reviewer clicks one and then clicks where it
 * stands on the plan. Once placed it leaves this list and is an ordinary
 * machine on the plan, linked to its video by its reference.
 */
function Unplaced({ v, plan, readOnly, placing, onPlace }) {
  const list = unplacedEquipment(plan, v.equipment ?? []);
  if (!list.length) return null;
  return (
    <section className="ed-card" aria-label="Unplaced machines">
      <div className="ed-card-head">
        <h2>Unplaced machines</h2>
        <span className="ed-count fair">{list.length}</span>
      </div>
      <p className="muted small">
        Recorded on the phone without a position. {readOnly ? '' : 'Choose one, then click where it stands on the plan.'}
      </p>
      <ul className="ed-unplaced">
        {list.map((e) => {
          const active = placing?.equipmentId === e.equipmentId;
          return (
            <li key={e.equipmentId} className={active ? 'on' : undefined}>
              <span className="ed-unplaced-text">
                <strong>{e.name ?? e.equipmentId}</strong>
                <span className="muted small">
                  {equipmentLabel(e.type)} · {e.equipmentId}
                  {e.video ? ' · 360° video' : ''}
                </span>
              </span>
              {!readOnly && (
                <button
                  type="button"
                  className={`rv-button small ${active ? 'primary' : 'ghost'}`}
                  aria-pressed={active}
                  aria-label={`Place ${e.name ?? e.equipmentId} on the plan`}
                  onClick={() => onPlace?.(e)}
                >
                  {active ? 'Click the plan…' : 'Place'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A select over a format 3 vocabulary, with "Not recorded" when the value may be empty. */
function KindSelect({ label, value, options, onChange, disabled, allowNone = false, noneLabel = 'Not recorded', labelFor = kindLabel }) {
  return (
    <label className="rv-field">
      <span>{label}</span>
      <select value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
        {(allowNone || !value) && <option value="">{noneLabel}</option>}
        {options.map((o) => (
          <option key={o} value={o}>
            {labelFor(o)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A text input that applies on Enter or blur, so typing a name is one undo step. */
function TextField({ label, value, onCommit, disabled }) {
  const [text, setText] = useState(null);
  const shown = text ?? value ?? '';
  const commit = () => {
    if (text !== null && text.trim() !== (value ?? '') && text.trim()) onCommit(text.trim());
    setText(null);
  };
  return (
    <label className="rv-field">
      <span>{label}</span>
      <input
        value={shown}
        disabled={disabled}
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
    </label>
  );
}

/** One numeric fact in an `ed-facts` list: a field when editable, the reading otherwise. */
function Fact({ label, value, ro, onCommit, min = 0, max = 100, suffix = 'm', clearable = true, step = 0.01, blank = 'Not measured' }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {ro ? (
          value === null || value === undefined ? (
            <span className="muted">{blank}</span>
          ) : (
            `${Number(value).toFixed(2)} ${suffix}`
          )
        ) : (
          <NumberField value={value} min={min} max={max} step={step} suffix={suffix} label={label} clearable={clearable} onCommit={onCommit} />
        )}
      </dd>
    </div>
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
/**
 * A measurement that was never taken shows as blank, never as 0: RoomPlan
 * does not measure every wall's thickness, and a nought would read as a
 * measurement of nothing rather than nothing measured (CHANGE 1).
 *
 * With `clearable`, emptying the box puts it back to not measured.
 */
function Measured({ value, suffix = 'm' }) {
  if (value === null || value === undefined) return <span className="muted">Not measured</span>;
  return `${Number(value).toFixed(2)} ${suffix}`;
}

function NumberField({ id, value, min, max, step = 0.01, suffix, onCommit, label, clearable = false }) {
  const [text, setText] = useState(null);
  const blank = value === null || value === undefined;
  const shown = text ?? (blank ? '' : String(Math.round(value * 1000) / 1000));
  const commit = () => {
    if (text === null) return;
    if (text.trim() === '') {
      if (clearable && !blank) onCommit(null);
      setText(null);
      return;
    }
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

function Inspector({ v, plan, selection, readOnly, onSelect, history, keyframes }) {
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
              <dd>
                {ro ? (
                  `${dist(el.a, el.b).toFixed(2)} m`
                ) : (
                  /*
                   * Typing a length slides the far end along the wall's own
                   * direction (CHANGE 1.7), so the reviewer can enter the
                   * dimension they measured instead of dragging a corner
                   * until the readout happens to agree.
                   */
                  <NumberField
                    value={Number(dist(el.a, el.b).toFixed(3))}
                    min={0.1}
                    max={200}
                    suffix="m"
                    label="Wall length"
                    onCommit={(n) => history.change(setWallLength(plan, el.id, n))}
                  />
                )}
              </dd>
            </div>
            <div>
              <dt>Bearing</dt>
              <dd>{wallAngleDeg(el).toFixed(1)}°</dd>
            </div>
            <div>
              <dt>Height</dt>
              <dd>
                {ro ? (
                  <Measured value={el.heightM} />
                ) : (
                  <NumberField value={el.heightM} min={1} max={20} suffix="m" label="Wall height" clearable onCommit={(n) => set({ heightM: n })} />
                )}
              </dd>
            </div>
            <div>
              <dt>Thickness</dt>
              <dd>
                {ro ? (
                  <Measured value={el.thicknessM} />
                ) : (
                  <NumberField value={el.thicknessM} min={0.01} max={2} suffix="m" label="Wall thickness" clearable onCommit={(n) => set({ thicknessM: n })} />
                )}
              </dd>
            </div>
            <div>
              <dt>Read confidence</dt>
              <dd>{el.confidence.toFixed(2)}</dd>
            </div>
          </dl>
          {(el.heightM === null || el.heightM === undefined || el.thicknessM === null || el.thicknessM === undefined) && !ro && (
            <p className="muted small">
              RoomPlan reports a wall as a flat surface, so it rarely measures a thickness. Type one in if you
              took it on site.
            </p>
          )}
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
          {/* Format 3: what the wall is, and whether it bows. */}
          <KindSelect label="Wall kind" value={el.kind} options={WALL_KINDS} disabled={ro} allowNone onChange={(k) => set({ kind: k })} />
          <dl className="ed-facts">
            <div>
              <dt>Curve</dt>
              <dd>
                {ro ? (
                  el.curveM ? `${el.curveM.toFixed(2)} m` : 'Straight'
                ) : (
                  <NumberField
                    value={el.curveM ?? null}
                    min={-50}
                    max={50}
                    suffix="m"
                    label="Wall curve"
                    clearable
                    onCommit={(n) => history.change(setWallCurve(plan, el.id, n))}
                  />
                )}
              </dd>
            </div>
            {el.curveM ? (
              <div>
                <dt>Length along the arc</dt>
                <dd>{wallLength(el).toFixed(2)} m</dd>
              </div>
            ) : null}
          </dl>
          {!ro && (
            <p className="muted small">
              Curve is how far the middle of the wall bows off the straight line between its ends, positive to the left
              walking from start to end. Leave it blank for a straight wall.
            </p>
          )}
          <label className="ed-check">
            <input
              type="checkbox"
              checked={Boolean(el.mirror)}
              disabled={ro}
              onChange={(e) => history.change(setWallMirror(plan, el.id, e.target.checked))}
            />
            Mirror wall (rendered reflective)
          </label>
          <Mirrors plan={plan} wall={el} readOnly={ro} history={history} />
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
          {/*
            Format 3: the kind says exactly what it is; the older door /
            window / opening type follows from it (setOpeningKind).
          */}
          <KindSelect
            label="Opening kind"
            value={el.kind}
            options={OPENING_KINDS}
            disabled={ro}
            noneLabel={`Not set (${el.type})`}
            onChange={(k) => k && history.change(setOpeningKind(plan, el.id, k))}
          />
          <dl className="ed-facts">
            <div>
              <dt>Width</dt>
              <dd>{ro ? `${el.width.toFixed(2)} m` : <NumberField value={el.width} min={0.3} max={20} suffix="m" onCommit={(n) => set({ width: n })} label="Width" />}</dd>
            </div>
            <div>
              <dt>From wall start</dt>
              <dd>{ro ? `${el.offset.toFixed(2)} m` : <NumberField value={el.offset} min={0} max={1000} suffix="m" onCommit={(n) => set({ offset: n })} label="Offset from wall start" />}</dd>
            </div>
            {/* CHANGE 1.3 and 1.4: an opening's height, and a window's sill. */}
            <div>
              <dt>Height</dt>
              <dd>
                {ro ? (
                  <Measured value={el.heightM} />
                ) : (
                  <NumberField value={el.heightM} min={0.1} max={10} suffix="m" label="Opening height" clearable onCommit={(n) => set({ heightM: n })} />
                )}
              </dd>
            </div>
            {el.type === 'window' && (
              <div>
                <dt>Sill height</dt>
                <dd>
                  {ro ? (
                    <Measured value={el.sillHeightM} />
                  ) : (
                    <NumberField value={el.sillHeightM} min={0} max={10} suffix="m" label="Sill height" clearable onCommit={(n) => set({ sillHeightM: n })} />
                  )}
                </dd>
              </div>
            )}
          </dl>
          {el.type === 'door' && (
            <label className="rv-field">
              <span>Swing</span>
              <select value={el.swing ?? ''} disabled={ro} onChange={(e) => set({ swing: e.target.value || null })}>
                {/* RoomPlan does not report a swing, so it starts unknown. */}
                <option value="">Not recorded</option>
                {SWINGS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {el.type === 'door' && (
            <>
              <KindSelect
                label="Leaves"
                value={el.leaves == null ? null : String(el.leaves)}
                options={['1', '2']}
                disabled={ro}
                allowNone
                labelFor={(n) => (n === '1' ? 'One leaf' : 'Two leaves')}
                onChange={(n) => set({ leaves: n ? Number(n) : null })}
              />
              <KindSelect
                label="Hinge side"
                value={el.hinge}
                options={HINGE_SIDES}
                disabled={ro}
                allowNone
                labelFor={(h) => `Hinged ${h}, seen from the start of the wall`}
                onChange={(h) => set({ hinge: h })}
              />
              <KindSelect
                label="Swings into"
                value={el.swingInto}
                options={(plan.spaces ?? []).map((s) => s.id)}
                disabled={ro || !(plan.spaces ?? []).length}
                allowNone
                noneLabel={(plan.spaces ?? []).length ? 'Not recorded' : 'Draw the spaces first'}
                labelFor={(id) => {
                  const s = plan.spaces.find((x) => x.id === id);
                  return s ? s.name || kindLabel(s.kind) : id;
                }}
                onChange={(id) => set({ swingInto: id })}
              />
            </>
          )}
          <p className="muted small">
            On the {el.wallId ? wallName(plan, plan.walls.find((w) => w.id === el.wallId) ?? { a: [0, 0], b: [1, 0] }).toLowerCase() : 'no wall yet'}.
          </p>
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
          {kind === 'columns' && (
            <>
              <KindSelect
                label="Column shape"
                value={el.shape ?? 'rect'}
                options={COLUMN_SHAPES}
                disabled={ro}
                labelFor={(s) => (s === 'round' ? 'Round' : 'Rectangular')}
                onChange={(s) => s && history.change(setColumnShape(plan, el.id, s))}
              />
              <dl className="ed-facts">
                <Fact
                  label="Column height"
                  value={el.heightM ?? null}
                  ro={ro}
                  min={0.1}
                  max={20}
                  blank="Full height"
                  onCommit={(n) => set({ heightM: n })}
                />
              </dl>
              {!ro && <p className="muted small">Leave the height blank for a column that runs floor to ceiling.</p>}
            </>
          )}
          {kind === 'objects' && (
            <>
              {/* CHANGE 1.5: turning a machine to an exact bearing. */}
              <dl className="ed-facts">
                <div>
                  <dt>Rotation</dt>
                  <dd>
                    {ro ? (
                      `${degreesOf(el.angle).toFixed(1)}°`
                    ) : (
                      <NumberField
                        value={Number(degreesOf(el.angle).toFixed(1))}
                        min={-360}
                        max={360}
                        step={1}
                        suffix="°"
                        label="Rotation"
                        onCommit={(n) => history.change(rotateObject(plan, el.id, n))}
                      />
                    )}
                  </dd>
                </div>
                {/*
                  Format 3: which way the machine's front faces, separate
                  from the footprint's rotation (a square rack can face any
                  of four ways). Also set by dragging the arrow on the plan.
                */}
                <div>
                  <dt>Facing</dt>
                  <dd>
                    {ro ? (
                      el.facingDeg == null ? <span className="muted">Not set</span> : `${el.facingDeg.toFixed(1)}°`
                    ) : (
                      <NumberField
                        value={el.facingDeg ?? null}
                        min={-360}
                        max={360}
                        step={1}
                        suffix="°"
                        label="Facing"
                        clearable
                        onCommit={(n) => history.change(setFacing(plan, el.id, n))}
                      />
                    )}
                  </dd>
                </div>
              </dl>
              <Equipment plan={plan} object={el} readOnly={ro} history={history} video={videoFor(v, el)} v={v} />
              <Keyframes object={el} keyframes={keyframes} />
              {!ro && (
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
        </>
      )}

      {kind === 'zones' && <p className="muted small">{el.points.length} corners. Nothing may be placed inside a no-build zone.</p>}

      {kind === 'spaces' && (
        <>
          <TextField label="Space name" value={el.name} disabled={ro} onCommit={(name) => set({ name })} />
          <KindSelect label="Space kind" value={el.kind} options={SPACE_KINDS} disabled={ro} onChange={(k) => k && set({ kind: k })} />
          <KindSelect
            label="Floor finish"
            value={el.floorFinish}
            options={FLOOR_FINISHES}
            disabled={ro}
            allowNone
            onChange={(f) => set({ floorFinish: f })}
          />
          <dl className="ed-facts">
            <Fact
              label="Space ceiling height"
              value={el.ceilingHeightM ?? null}
              ro={ro}
              min={1.5}
              max={30}
              blank={`Plan default (${Number(plan.ceilingHeightM ?? 3).toFixed(2)} m)`}
              onCommit={(n) => set({ ceilingHeightM: n })}
            />
          </dl>
          <CeilingZones space={el} readOnly={ro} onSelect={onSelect} history={history} plan={plan} />
          <p className="muted small">{el.points.length} corners. Drag a corner on the plan to move it.</p>
        </>
      )}

      {kind === 'ceilingZones' && (
        <>
          <dl className="ed-facts">
            <Fact label="Zone ceiling height" value={el.heightM ?? null} ro={ro} min={1.5} max={30} onCommit={(n) => set({ heightM: n })} />
          </dl>
          <p className="muted small">
            In {plan.spaces.find((s) => s.id === found.spaceId)?.name ?? 'its space'}. {el.points.length} corners.
          </p>
        </>
      )}

      {kind === 'beams' && (
        <>
          <KindSelect label="Beam kind" value={el.kind} options={BEAM_KINDS} disabled={ro} onChange={(k) => k && set({ kind: k })} />
          <dl className="ed-facts">
            <Fact label="Underside height" value={el.bottomM ?? null} ro={ro} min={0.5} max={30} onCommit={(n) => set({ bottomM: n })} />
          </dl>
          <p className="muted small">The outline is where the beam crosses the floor plan; the height is to its underside.</p>
        </>
      )}

      {kind === 'levelChanges' && (
        <>
          <KindSelect label="Level change kind" value={el.kind} options={LEVEL_CHANGE_KINDS} disabled={ro} onChange={(k) => k && set({ kind: k })} />
          <dl className="ed-facts">
            <Fact label="Rise" value={el.heightM ?? null} ro={ro} min={-5} max={5} clearable={false} onCommit={(n) => set({ heightM: n })} />
            {el.kind === 'ramp' && (
              <Fact
                label="Ramp angle"
                value={el.rampAngleDeg ?? null}
                ro={ro}
                min={0.5}
                max={45}
                step={0.5}
                suffix="°"
                onCommit={(n) => set({ rampAngleDeg: n })}
              />
            )}
          </dl>
          <p className="muted small">Rise is the height above the surrounding floor; negative for a sunken area.</p>
        </>
      )}

      {kind === 'voids' && (
        <>
          <KindSelect label="Void kind" value={el.kind} options={VOID_KINDS} disabled={ro} onChange={(k) => k && set({ kind: k })} />
          <dl className="ed-facts">
            <Fact label="Rail height" value={el.railHeightM ?? null} ro={ro} min={0.3} max={3} blank="No rail" onCommit={(n) => set({ railHeightM: n })} />
          </dl>
        </>
      )}

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

/**
 * A wall's mirror spans (format 3): where along the wall the glass starts
 * and stops, and how high it runs. A gym's mirror rarely covers a wall end
 * to end, and the walkthrough reflects exactly these stretches.
 */
function Mirrors({ plan, wall, readOnly, history }) {
  const mirrors = wall.mirrors ?? [];
  if (!mirrors.length && readOnly) return null;
  const len = wallLength(wall);
  const edit = (m, field) => (n) => history.change(updateMirror(plan, wall.id, m.id, { [field]: n }));
  return (
    <fieldset className="ed-mirrors" disabled={readOnly}>
      <legend className="small muted">Mirror spans (m along the wall from its start)</legend>
      {mirrors.length === 0 && <p className="muted small">No mirrors on this wall.</p>}
      {mirrors.map((m, i) => (
        <div key={m.id} className="ed-mirror-row">
          <span className="small muted">#{i + 1}</span>
          {[
            ['fromM', 'From', 0, len],
            ['toM', 'To', 0, len],
            ['bottomM', 'Bottom', 0, 20],
            ['topM', 'Top', 0, 20],
          ].map(([field, label, min, max]) =>
            readOnly ? (
              <span key={field} className="small">
                {label} {Number(m[field]).toFixed(2)}
              </span>
            ) : (
              <NumberField
                key={field}
                value={m[field]}
                min={min}
                max={max}
                label={`Mirror ${i + 1} ${label.toLowerCase()}`}
                onCommit={edit(m, field)}
              />
            ),
          )}
          {!readOnly && (
            <button
              type="button"
              className="rv-icon-button"
              title="Remove this mirror span"
              onClick={() => history.change(removeMirror(plan, wall.id, m.id))}
            >
              <TrashIcon size={14} />
              <span className="sr-only">Remove mirror {i + 1}</span>
            </button>
          )}
        </div>
      ))}
      {!readOnly && (
        <button type="button" className="rv-button ghost small" onClick={() => history.change(addMirror(plan, wall.id).plan)}>
          Add mirror span
        </button>
      )}
    </fieldset>
  );
}

/** The ceiling zones of a space: parts of the room with another ceiling height. */
function CeilingZones({ plan, space, readOnly, onSelect, history }) {
  const zones = space.ceilingZones ?? [];
  return (
    <section className="ed-subsection" aria-label="Ceiling zones">
      <h3>Ceiling zones</h3>
      {zones.length === 0 ? (
        <p className="muted small">
          {readOnly ? 'None.' : 'None. Use the ceiling zone tool (U) to draw one inside this space.'}
        </p>
      ) : (
        <ul className="ed-zone-list">
          {zones.map((z, i) => (
            <li key={z.id}>
              <button type="button" className="ed-link" onClick={() => onSelect(z.id)}>
                Zone {i + 1}
              </button>
              <span className="small muted">{z.heightM == null ? 'height not set' : `${Number(z.heightM).toFixed(2)} m`}</span>
              {!readOnly && (
                <button
                  type="button"
                  className="rv-icon-button"
                  title="Delete this ceiling zone"
                  onClick={() => history.change(deleteElement(plan, z.id))}
                >
                  <TrashIcon size={14} />
                  <span className="sr-only">Delete ceiling zone {i + 1}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * H-03: the scan's still frames that look at the selected machine, nearest
 * first, so the reviewer can see what it is without leaving the editor.
 * Nothing shows when the capture kept no keyframes.
 */
function Keyframes({ object, keyframes }) {
  if (!keyframes) return null;
  const seen = keyframesSeeing(keyframes.frames, object)
    .map((s) => ({ ...s, url: keyframeUrl(keyframes.files, s.frame) }))
    .filter((s) => s.url);
  return (
    <section className="ed-subsection" aria-label="Scan photos of this machine">
      <h3>From the scan</h3>
      {seen.length === 0 ? (
        <p className="muted small">No scan frame looks at this machine from within 8 m.</p>
      ) : (
        <div className="ed-keyframes">
          {seen.map(({ frame, url, distanceM }) => (
            <a key={frame.id ?? frame.file} href={url} target="_blank" rel="noopener noreferrer">
              <img src={url} alt={`Scan frame ${distanceM.toFixed(1)} m from the machine`} loading="lazy" />
              <span className="small muted">{distanceM.toFixed(1)} m</span>
            </a>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * The equipment panel (CHANGE 2 and CHANGE 5): what this machine is, how
 * much room is around it, and the 360 walk round it if one was recorded.
 *
 * RoomPlan recognises a shape but has no gym machine categories at all, so
 * every machine is named here or on the phone. The catalogue is a list of
 * suggestions, not a closed set: any name may be typed in.
 */
function Equipment({ plan, object, readOnly, history, video, v }) {
  const current = object.equipment;
  const [draft, setDraft] = useState(null);
  const open = draft !== null;

  const start = () =>
    setDraft(
      current
        ? { ...current }
        : { equipmentId: nextEquipmentId(plan), type: EQUIPMENT_TYPES[0], name: equipmentLabel(EQUIPMENT_TYPES[0]) },
    );
  const save = () => {
    history.change(setEquipment(plan, object.id, draft));
    setDraft(null);
  };

  const flaggedWrong = plan.flags.some(
    (f) => f.elementId === object.id && f.kind === 'equipment_wrong' && f.status === 'open',
  );
  const wall = clearanceToWall(plan, object);
  const neighbour = nearestEquipment(plan, object);

  return (
    <section className="ed-equipment">
      <div className="ed-card-head">
        <h3>Equipment</h3>
        {!readOnly && !open && (
          <button type="button" className="rv-button ghost small" onClick={start}>
            {current ? 'Change' : 'Name this machine'}
          </button>
        )}
      </div>

      {!open && !current && <p className="muted small">Not identified. RoomPlan cannot name a gym machine.</p>}

      {!open && current && (
        <>
          <dl className="ed-facts">
            <div>
              <dt>Name</dt>
              <dd>{current.name}</dd>
            </div>
            <div>
              <dt>Type</dt>
              <dd>{equipmentLabel(current.type)}</dd>
            </div>
            <div>
              <dt>Reference</dt>
              <dd>{current.equipmentId}</dd>
            </div>
          </dl>
          {!readOnly && (
            <div className="ed-actions">
              <button type="button" className="rv-button ghost small" onClick={() => history.change(setEquipment(plan, object.id, null))}>
                Not a machine
              </button>
              {/*
                CHANGE 5: a machine that does not match the scan or the 360
                video is flagged, which blocks approval until it is settled.
              */}
              <button
                type="button"
                className="rv-button ghost small"
                disabled={flaggedWrong}
                onClick={() =>
                  history.change(
                    flagElement(plan, object.id, {
                      title: `${current.name} looks wrong`,
                      detail: 'The machine on the plan does not match the scan or the 360° video. Check it on site.',
                    }),
                  )
                }
              >
                {flaggedWrong ? 'Flagged' : 'Flag as wrong'}
              </button>
            </div>
          )}
        </>
      )}

      {open && (
        <div className="ed-equipment-form">
          <label className="rv-field">
            <span>Type</span>
            <input
              list="equipment-types"
              value={draft.type}
              onChange={(e) => {
                const type = e.target.value;
                // Keep the name following the type until it is edited by hand.
                const followed = draft.name === equipmentLabel(draft.type);
                setDraft({ ...draft, type, name: followed ? equipmentLabel(type) : draft.name });
              }}
            />
          </label>
          <datalist id="equipment-types">
            {EQUIPMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {equipmentLabel(t)}
              </option>
            ))}
          </datalist>
          <label className="rv-field">
            <span>Name</span>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label className="rv-field">
            <span>Reference</span>
            <input value={draft.equipmentId} onChange={(e) => setDraft({ ...draft, equipmentId: e.target.value })} />
          </label>
          <div className="ed-actions">
            <button type="button" className="rv-button small" disabled={!draft.type.trim() || !draft.name.trim() || !draft.equipmentId.trim()} onClick={save}>
              Save
            </button>
            <button type="button" className="rv-button ghost small" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* CHANGE 1.7: the clearances that say whether the floor works. */}
      {current && (
        <dl className="ed-facts">
          {wall && (
            <div>
              <dt>To nearest wall</dt>
              <dd>{wall.distanceM.toFixed(2)} m</dd>
            </div>
          )}
          {neighbour && (
            <div>
              <dt>To {neighbour.object.equipment.name}</dt>
              <dd>{neighbour.distanceM.toFixed(2)} m</dd>
            </div>
          )}
        </dl>
      )}

      {current && <EquipmentVideo video={video} />}
      {/* L-08: its 3D model, reviewed beside the video, or another machine's reused. */}
      {current && v && <MachineModelPanel plan={plan} object={object} v={v} readOnly={readOnly} history={history} />}
    </section>
  );
}

/** The 360 walk round a machine, or why there is not one (CHANGE 5). */
function EquipmentVideo({ video }) {
  if (!video) return <p className="muted small">No 360° video was recorded for this machine.</p>;
  if (video.status !== 'ready' || !video.url) {
    return (
      <p className="muted small">
        360° video {video.status === 'failed' ? `failed: ${video.failureReason ?? 'unknown reason'}` : video.status}.
      </p>
    );
  }
  return (
    <figure className="ed-video">
      {/* Controls only: a reviewer plays it when they choose to. */}
      <video src={video.url} poster={video.thumbnailUrl ?? undefined} controls preload="none" playsInline />
      <figcaption className="muted small">
        360° walkaround{video.durationSeconds ? ` · ${Math.round(video.durationSeconds)} s` : ''}
      </figcaption>
    </figure>
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
  mesh: 'Scan mesh (OBJ)',
  keyframes: 'Scan keyframe',
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
