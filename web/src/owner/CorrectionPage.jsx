import { libraryPlacement, validate } from '@shared/plan/index.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';

import { plansApi } from '../lib/client.js';
import { BackIcon, CheckIcon } from '../lib/icons.jsx';
import Modal from '../lib/Modal.jsx';
import { useLoader } from '../lib/useLoader.js';
import { useTitle } from '../lib/useTitle.js';
import Canvas from '../review/editor/Canvas.jsx';
import { placeEquipment } from '../review/editor/ops.js';
import Sidebar from '../review/editor/Sidebar.jsx';
import Toolbar from '../review/editor/Toolbar.jsx';
import { useLibrary } from '../review/editor/useLibrary.js';
import { usePlanHistory } from '../review/editor/useEditorState.js';
import '../review/editor/editor.css';
import { planTitle } from './status.js';

/** What the side panel reads from a review version; a correction has none of it. */
const NO_VERSION = { id: null, files: [], equipment: [], history: [] };

/** Shortest note a reviewer can act on. */
export const MIN_NOTE = 5;

/**
 * Correcting an approved plan from site (installers and owners, on a
 * tablet or a computer): the plan editor on the approved version, then
 * "Send correction" with a note saying what was wrong. The correction waits
 * for a reviewer; until it is approved the approved plan stays live.
 */
export default function CorrectionPage() {
  const { planId } = useParams();
  const { data, error, reload } = useLoader(() => Promise.all([plansApi.get(planId), plansApi.model(planId)]), `correct-${planId}`);
  const [plan, model] = data ?? [];
  useTitle(plan ? `Correct · ${planTitle(plan)}` : 'Correct a plan');

  if (!data) {
    return (
      <div className="rv-content">
        {error ? (
          <div className="rv-empty" role="alert">
            <h2>{error.status === 404 ? 'This plan has no approved version to correct' : 'The plan could not be loaded'}</h2>
            <p className="muted">{error.message}</p>
            <button type="button" className="rv-button primary" onClick={reload}>
              Try again
            </button>
          </div>
        ) : (
          <div className="rv-empty" role="status">
            <span className="rv-spinner" aria-hidden="true" />
            <p className="muted">Loading the plan…</p>
          </div>
        )}
      </div>
    );
  }
  return <Corrector plan={plan} model={model} />;
}

function Corrector({ plan, model }) {
  const history = usePlanHistory(model.plan);
  const canvas = useRef(null);
  const library = useLibrary();
  const [tool, setTool] = useState('select');
  const [options, setOptions] = useState({ openingKind: 'single_door', tagType: 'fireExit' });
  const [selection, setSelection] = useState(null);
  const [placing, setPlacing] = useState(null);
  const [zoom, setZoom] = useState(null);
  const [rotation, setRotation] = useState(0);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(null);
  const changed = history.canUndo;
  const issues = useMemo(() => validate(history.plan), [history.plan]);

  // Leaving with unsent changes asks first.
  useEffect(() => {
    if (!changed || sent) return undefined;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [changed, sent]);

  useEffect(() => {
    if (tool !== 'place') setPlacing(null);
  }, [tool]);

  const startPlacing = useCallback((item) => {
    setPlacing(item);
    setSelection(null);
    setTool('place');
  }, []);
  const placeFromLibrary = (entry) => startPlacing(libraryPlacement(entry, history.plan));
  const dropFromLibrary = (key, point) => {
    const entry = library.items.find((i) => i.key === key);
    if (!entry) return;
    const { plan: next, id } = placeEquipment(history.plan, libraryPlacement(entry, history.plan), point);
    if (!id) return;
    history.change(next);
    setTool('select');
    setSelection(id);
  };

  const title = planTitle(plan);
  if (sent) {
    return (
      <div className="rv-content">
        <div className="rv-empty" role="status">
          <CheckIcon size={28} />
          <h2>Correction sent</h2>
          <p className="muted">
            It is version {sent.version} of {title}, waiting for a reviewer. The approved plan stays as it is until the correction is
            approved.
          </p>
          <Link to={`/plans/${plan.id}`} className="rv-button primary">
            Back to the plan
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="ed-page">
      <header className="rv-header ed-header">
        <Link to={`/plans/${plan.id}`} className="rv-back">
          <BackIcon size={16} />
          Plan
        </Link>
        <h1>Correct {title}</h1>
        <span className="muted small">From approved version {model.version}</span>
        <span className="spacer" />
        <button type="button" className="rv-button primary" disabled={!changed} onClick={() => setSending(true)}>
          Send correction
        </button>
      </header>
      <p className="ed-correction-help muted small">
        Change the plan to match the room, then send it with a note. A reviewer checks it before it replaces the approved plan.
      </p>

      <div className="ed-body">
        <div className="ed-main">
          <Toolbar
            tool={tool}
            onTool={setTool}
            options={options}
            onOptions={setOptions}
            disabled={false}
            zoom={zoom}
            onZoom={(f) => canvas.current?.zoomBy(f)}
            onFit={() => canvas.current?.fit()}
            rotation={rotation}
            onRotate={(deg) => canvas.current?.rotateBy(deg)}
            onResetRotation={() => canvas.current?.resetRotation()}
            history={history}
            showSource={false}
            onShowSource={() => {}}
            hasSource={false}
            placing={placing}
          />
          <Canvas
            ref={canvas}
            plan={history.plan}
            source={null}
            underlay={null}
            showSource={false}
            tool={tool}
            toolOptions={options}
            selection={selection}
            onSelect={setSelection}
            readOnly={false}
            history={history}
            flagged={new Set()}
            problems={new Set()}
            onScaleLine={() => {}}
            onZoomChange={setZoom}
            onRotationChange={setRotation}
            placing={placing}
            onPlaced={() => setTool('select')}
            onDropEquipment={dropFromLibrary}
          />
        </div>
        <Sidebar
          v={NO_VERSION}
          plan={history.plan}
          issues={issues}
          readOnly={false}
          selection={selection}
          onSelect={setSelection}
          onFocus={setSelection}
          history={history}
          placing={placing}
          onPlace={startPlacing}
          onPlaceFromLibrary={placeFromLibrary}
          library={library}
        />
      </div>

      {sending && (
        <SendDialog
          title={title}
          onCancel={() => setSending(false)}
          onSend={async (note) => {
            const res = await plansApi.correct(plan.id, { basedOnVersionId: model.versionId, plan: history.plan, note });
            setSent(res);
          }}
        />
      )}
    </div>
  );
}

function SendDialog({ title, onCancel, onSend }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const ok = note.trim().length >= MIN_NOTE;

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await onSend(note.trim());
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Send correction"
      subtitle={`A reviewer checks it before it replaces the approved plan of ${title}.`}
      onClose={onCancel}
      busy={busy}
      footer={
        <>
          <button type="button" className="rv-button ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="rv-button primary" onClick={send} disabled={busy || !ok}>
            {busy ? 'Sending…' : 'Send correction'}
          </button>
        </>
      }
    >
      <label className="rv-field">
        <span>What was wrong?</span>
        <textarea
          rows={4}
          maxLength={1000}
          value={note}
          placeholder="e.g. The column by the rig is 40 cm further east than the plan shows."
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      {error && (
        <p className="rv-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
