/**
 * Machine models in the editor (L-08): each named machine's 3D model, the
 * review of it beside its 360 video, and "same as".
 *
 * The panel sits in a machine's equipment section. The review opens in a
 * dialog with the video and the model side by side, every model made for
 * the machine, and what the reviewer can do with one: approve it, reject it
 * with a reason, turn it so its front faces the right way, or build another.
 * Nothing unapproved reaches a walkthrough (docs/3d-contract.md).
 */
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';

import { reviewApi } from '../../lib/client.js';
import { stamp } from '../../lib/format.js';
import Modal from '../../lib/Modal.jsx';
import { frontInModel, modelSource, recordedMachine, sameAsChoices, setSameAs } from './machineModels.js';

// three.js comes into the editor only when a model is looked at.
const ModelPreview = lazy(() => import('./ModelPreview.jsx'));

export const MODEL_STATES = {
  none: 'Not built',
  queued: 'Queued',
  building: 'Building',
  awaiting_review: 'Awaiting review',
  approved: 'Approved',
  rejected: 'Rejected',
  failed: 'Failed',
};
/** How each model was made: TRELLIS.2 from one photo (L-05), or rebuilt from the depth scan (L-04). */
export const ROUTE_LABELS = { generated: 'TRELLIS.2', measured: 'Measured' };
const IN_FLIGHT = ['queued', 'building'];
const BUILT = ['awaiting_review', 'approved', 'rejected'];
/** How often a build in progress is checked on. */
export const POLL_MS = 5000;

const label = (status) => MODEL_STATES[status] ?? status;
/** "TRELLIS.2 · try 2", or "Measured": a measured model is the same every time, so it has no tries to tell apart. */
const madeBy = (m) => (m.route === 'measured' ? ROUTE_LABELS.measured : `${ROUTE_LABELS.generated} · try ${m.seed ?? '—'}`);
const metres = (v) => (v == null ? '—' : `${Number(v).toFixed(2)} m`);

/** The panel in a machine's equipment section. */
export function MachineModelPanel({ plan, object, v, readOnly, history }) {
  const [open, setOpen] = useState(false);
  const source = modelSource(plan, object);
  const copy = source !== object;
  const machine = recordedMachine(v, source);
  const choices = sameAsChoices(plan, object);

  return (
    <section className="mm-panel" aria-label="3D model">
      <div className="ed-card-head">
        <h3>3D model</h3>
        {machine?.machineId && !copy && (
          <button type="button" className="rv-button ghost small" onClick={() => setOpen(true)}>
            Review 3D model
          </button>
        )}
      </div>

      {copy ? (
        <p className="small">
          Uses the model of <strong>{source.equipment.equipmentId}</strong> · {source.equipment.name}
          {machine ? <span className="muted"> ({label(machine.modelStatus ?? 'none').toLowerCase()})</span> : null}
        </p>
      ) : machine?.machineId ? (
        <p className="small">
          <span className={`mm-status ${machine.modelStatus ?? 'none'}`}>{label(machine.modelStatus ?? 'none')}</span>
        </p>
      ) : (
        <p className="muted small">
          No machine was recorded for this on the phone, so there is no video to build a model from. If it is the same
          as one that was, mark it so to use that one’s model.
        </p>
      )}

      <label className="rv-field mm-same-as">
        <span>Same machine as</span>
        {readOnly ? (
          <span>{copy ? `${source.equipment.equipmentId} · ${source.equipment.name}` : 'None: its own model'}</span>
        ) : (
          <select
            value={object.sameAs ?? ''}
            onChange={(e) => history.change(setSameAs(plan, object.id, e.target.value || null))}
          >
            <option value="">None: its own model</option>
            {choices.map((o) => (
              <option key={o.id} value={o.id}>
                {o.equipment.equipmentId} · {o.equipment.name}
              </option>
            ))}
          </select>
        )}
      </label>
      {!readOnly && <p className="muted small">Identical machines share one model: built and approved once, placed for each.</p>}

      {open && <MachineModelDialog machine={machine} front={frontInModel(object)} onClose={() => setOpen(false)} />}
    </section>
  );
}

/** The model to show first: the approved one, else the newest built, else the newest. */
function firstToShow(models) {
  return models.find((m) => m.status === 'approved') ?? models.find((m) => BUILT.includes(m.status)) ?? models[0] ?? null;
}

/** The review: the video and the model side by side, and what to do with the model. */
export function MachineModelDialog({ machine, front = [1, 0], onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');

  const show = useCallback((body) => {
    setData(body);
    setSelectedId((id) => (body.models.some((m) => m.modelId === id) ? id : firstToShow(body.models)?.modelId ?? null));
  }, []);

  const load = useCallback(async () => {
    try {
      show(await reviewApi.machineModels(machine.machineId));
    } catch (err) {
      setError(err.message);
    }
  }, [machine.machineId, show]);

  useEffect(() => {
    load();
  }, [load]);

  // A build or a turn in progress is checked on until it is done.
  const working = data?.models.some((m) => IN_FLIGHT.includes(m.status));
  useEffect(() => {
    if (!working) return undefined;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [working, load]);

  async function act(call, then) {
    setBusy(true);
    setError(null);
    try {
      const body = await call();
      show(body);
      if (body.modelId) setSelectedId(body.modelId);
      then?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const model = data?.models.find((m) => m.modelId === selectedId) ?? null;
  const box = machine.widthM && machine.depthM && machine.heightM ? { w: machine.widthM, d: machine.depthM, h: machine.heightM } : null;
  const turn = (by) => act(() => reviewApi.turnModel(model.modelId, (((model.turnDeg ?? 0) + by) % 360 + 360) % 360));
  // A measured model is built once: offered while there is none, or the last one failed.
  const measuredDone = data?.models.some((m) => m.route === 'measured' && m.status !== 'failed');

  return (
    <Modal
      title={`3D model · ${machine.equipmentId}`}
      subtitle={machine.name}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          {data?.canBuild && !working && (
            <button
              type="button"
              className="rv-button ghost"
              disabled={busy}
              onClick={() => act(() => reviewApi.buildModel(machine.machineId))}
              title="TRELLIS.2 invents the sides the video does not show: another try gives another model to choose from"
            >
              {data.models.length ? 'Build another' : 'Build the model'}
            </button>
          )}
          {data?.canMeasure && !working && !measuredDone && (
            <button
              type="button"
              className="rv-button ghost"
              disabled={busy}
              onClick={() => act(() => reviewApi.buildModel(machine.machineId, 'measured'))}
              title="Rebuild it from the walk-round's depth: its real shape and size, with gaps where the walk never looked"
            >
              Build from the depth scan
            </button>
          )}
          <button type="button" className="rv-button" onClick={onClose} disabled={busy}>
            Done
          </button>
        </>
      }
    >
      <div className="mm-review">
        <div className="mm-sides">
          <figure className="mm-side">
            {machine.video?.url ? (
              <video src={machine.video.url} poster={machine.video.thumbnailUrl ?? undefined} controls preload="metadata" playsInline />
            ) : (
              <p className="muted small">{machine.video ? `The 360° video is ${machine.video.status}.` : 'No 360° video was recorded.'}</p>
            )}
            <figcaption className="muted small">360° walkaround</figcaption>
          </figure>
          <figure className="mm-side">
            {model && BUILT.includes(model.status) && model.url ? (
              <Suspense fallback={<div className="mm-preview" />}>
                <ModelPreview url={model.url} box={box} front={front} label={`3D model of ${machine.name}`} />
              </Suspense>
            ) : (
              <div className="mm-preview">
                <p className="mm-preview-note muted small">
                  {!data
                    ? 'Loading…'
                    : !model
                      ? 'No model has been built for this machine yet.'
                      : IN_FLIGHT.includes(model.status)
                        ? `${label(model.status)}… this takes a few minutes.`
                        : model.failureReason ?? label(model.status)}
                </p>
              </div>
            )}
            <figcaption className="muted small">
              Outline: the size the scan measured. Arrow: where the plan says its front faces.
            </figcaption>
          </figure>
        </div>

        {model && (
          <section className="mm-details" aria-label="This model">
            <div className="mm-details-head">
              <span className={`mm-status ${model.status}`}>{label(model.status)}</span>
              <span className="muted small">
                {madeBy(model)} · {stamp(model.createdAt)}
                {model.triangleCount ? ` · ${model.triangleCount.toLocaleString()} triangles` : ''}
              </span>
            </div>

            {model.flags?.length > 0 && (
              <ul className="mm-flags">
                {model.flags.map((f) => (
                  <li key={f.code}>{f.message}</li>
                ))}
              </ul>
            )}

            {model.sizeM && (
              <dl className="ed-facts">
                <div>
                  <dt>Width</dt>
                  <dd>
                    {metres(model.sizeM.w)} <span className="muted">scan {metres(machine.widthM)}</span>
                  </dd>
                </div>
                <div>
                  <dt>Depth</dt>
                  <dd>
                    {metres(model.sizeM.d)} <span className="muted">scan {metres(machine.depthM)}</span>
                  </dd>
                </div>
                <div>
                  <dt>Height</dt>
                  <dd>
                    {metres(model.sizeM.h)} <span className="muted">scan {metres(machine.heightM)}</span>
                  </dd>
                </div>
                {model.scaleErrorPct != null && (
                  <div>
                    <dt>Off the scan</dt>
                    <dd>{model.scaleErrorPct.toFixed(1)} %</dd>
                  </div>
                )}
              </dl>
            )}

            {model.reviewNote && (
              <p className="small">
                <span className="muted">{model.reviewedBy?.name ?? 'Reviewer'}:</span> {model.reviewNote}
              </p>
            )}

            {BUILT.includes(model.status) && !rejecting && (
              <div className="ed-actions mm-actions">
                {model.status !== 'approved' && (
                  <button type="button" className="rv-button small" disabled={busy} onClick={() => act(() => reviewApi.approveModel(model.modelId))}>
                    Approve
                  </button>
                )}
                {model.status !== 'rejected' && (
                  <button type="button" className="rv-button danger-ghost small" disabled={busy} onClick={() => setRejecting(true)}>
                    Reject…
                  </button>
                )}
                <span className="mm-turns" role="group" aria-label="Turn the model">
                  <button type="button" className="rv-button ghost small" disabled={busy} onClick={() => turn(90)} title="A quarter turn anticlockwise, seen from above">
                    ↺ 90°
                  </button>
                  <button type="button" className="rv-button ghost small" disabled={busy} onClick={() => turn(-90)} title="A quarter turn clockwise, seen from above">
                    ↻ 90°
                  </button>
                  <button type="button" className="rv-button ghost small" disabled={busy} onClick={() => turn(180)} title="Front to back">
                    180°
                  </button>
                </span>
              </div>
            )}
            {BUILT.includes(model.status) && (
              <p className="muted small">Turn it until its front faces the arrow. Turning makes the model again, so it comes back for review.</p>
            )}

            {rejecting && (
              <div className="mm-reject">
                <label className="rv-field">
                  <span>Why is it rejected?</span>
                  <textarea
                    rows={3}
                    maxLength={500}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="For example: the seat is missing, or it is the wrong machine."
                  />
                </label>
                <div className="ed-actions">
                  <button
                    type="button"
                    className="rv-button danger small"
                    disabled={busy || !note.trim()}
                    onClick={() =>
                      act(
                        () => reviewApi.rejectModel(model.modelId, note.trim()),
                        () => {
                          setRejecting(false);
                          setNote('');
                        },
                      )
                    }
                  >
                    Reject
                  </button>
                  <button type="button" className="rv-button ghost small" disabled={busy} onClick={() => setRejecting(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

        {data?.models.length > 1 && (
          <section aria-label="Every model made for this machine">
            <h4 className="eyebrow">ALL MODELS</h4>
            <ul className="mm-list">
              {data.models.map((m) => (
                <li key={m.modelId}>
                  <button
                    type="button"
                    className={`mm-list-item ${m.modelId === selectedId ? 'selected' : ''}`}
                    onClick={() => setSelectedId(m.modelId)}
                    aria-pressed={m.modelId === selectedId}
                  >
                    <span className={`mm-status ${m.status}`}>{label(m.status)}</span>
                    <span className="muted small">
                      {madeBy(m)} · {stamp(m.createdAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {data && !data.canBuild && !data.models.length && (
          <p className="muted small">A model is built from the machine’s 360° video once it has finished uploading.</p>
        )}
        {error && (
          <p className="rv-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
