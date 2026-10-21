import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { approvalBlockers, emptyPlan, planFromScan, validate } from '@shared/plan/index.js';

import { useAuth } from '../../lib/auth.jsx';
import { reviewApi } from '../../lib/client.js';
import { duration, inputLabel, levelLabel, stamp, STATUS_LABELS, time } from '../../lib/format.js';
import { BackIcon, CheckIcon, XIcon } from '../../lib/icons.jsx';
import { useLoader, useNow } from '../../lib/useLoader.js';
import { useTitle } from '../../lib/useTitle.js';
import { ApproveDialog, RejectDialog } from '../DecisionDialogs.jsx';
import Canvas from './Canvas.jsx';
import { keyframesIndexFile, readKeyframes } from './keyframes.js';
import { deleteElement, findElement, movePolygon } from './ops.js';
import { floorTriangles, meshFile, parseObj, trianglesPath } from './scanMesh.js';
import Sidebar from './Sidebar.jsx';
import Toolbar, { TOOLS } from './Toolbar.jsx';
import { useActivity, useAutosave, usePlanHistory } from './useEditorState.js';
import './editor.css';

/** Signed file URLs last an hour; fetch fresh ones before they lapse. */
const RENEW_BEFORE_MS = 5 * 60 * 1000;

export default function EditorPage() {
  const { id } = useParams();
  const { data: v, error, reload } = useLoader(() => reviewApi.version(id), id);
  useTitle(v ? `${v.facility} · ${levelLabel(v.level)}` : 'Plan editor');

  useEffect(() => {
    if (!v?.urlsExpireAt) return undefined;
    const renew = () => {
      if (new Date(v.urlsExpireAt).getTime() - Date.now() < RENEW_BEFORE_MS) reload();
    };
    window.addEventListener('focus', renew);
    const timer = setInterval(renew, 60_000);
    return () => {
      window.removeEventListener('focus', renew);
      clearInterval(timer);
    };
  }, [v?.urlsExpireAt, reload]);

  if (!v && error) {
    return (
      <>
        <Header title="Plan" />
        <div className="rv-content">
          <div className="rv-empty">
            <h2>{error.status === 404 ? 'This plan version does not exist' : 'The plan could not be loaded'}</h2>
            <p className="muted">{error.message}</p>
            {error.status !== 404 && (
              <button type="button" className="rv-button primary" onClick={reload}>
                Try again
              </button>
            )}
          </div>
        </div>
      </>
    );
  }
  if (!v) {
    return (
      <>
        <Header title="Plan" />
        <div className="rv-empty" role="status">
          <span className="rv-spinner" aria-hidden="true" />
          <p className="muted">Loading the plan…</p>
        </div>
      </>
    );
  }
  // Remount on each load of a different revision, so history starts clean.
  return <Editor key={`${v.id}:${v.planRevision}:${v.status}:${v.reviewer?.id ?? ''}`} v={v} reload={reload} />;
}

function Header({ title, children }) {
  return (
    <header className="rv-header ed-header">
      <Link to="/review" className="rv-back">
        <BackIcon size={16} />
        Queue
      </Link>
      <h1>{title}</h1>
      {children}
    </header>
  );
}

/** The source underneath (REV-03): the raw scan, or the uploaded drawing. */
function useSource(v) {
  const room = v.files.find((f) => f.kind === 'room');
  const [source, setSource] = useState(null);
  const roomPath = room ? room.url.split('?')[0] : null;
  useEffect(() => {
    if (!room) {
      setSource(null);
      return undefined;
    }
    const controller = new AbortController();
    fetch(room.url, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (json) setSource(planFromScan(json, {}));
      })
      .catch(() => {});
    return () => controller.abort();
    // Re-fetch only when the file changes, not when its URL is re-signed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomPath]);

  const u = v.plan?.underlay;
  const file = u?.fileId ? v.files.find((f) => f.id === u.fileId) : null;
  const underlay =
    file && u.metresPerPixel > 0 && u.widthPx && u.heightPx
      ? { url: file.url, widthM: u.widthPx * u.metresPerPixel, heightM: u.heightPx * u.metresPerPixel }
      : null;
  return { source, underlay };
}

/** The file's address without its signature, so re-signing a URL is not a new file. */
const unsigned = (file) => (file ? file.url.split('?')[0] : null);

/**
 * The scan mesh (H-03), fetched the first time the reviewer turns it on and
 * kept for the rest of the visit: a LiDAR mesh is megabytes, and most
 * reviews never need it. `status` is null until asked, then 'loading',
 * 'ready' or 'error'.
 */
function useScanMesh(v, wanted) {
  const file = meshFile(v.files);
  const key = unsigned(file);
  const [state, setState] = useState({ key: null, status: null, path: '' });
  const url = file?.url;
  useEffect(() => {
    if (!wanted || !url || state.key === key) return undefined;
    const controller = new AbortController();
    setState({ key, status: 'loading', path: '' });
    fetch(url, { signal: controller.signal })
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(String(res.status)))))
      .then((text) => setState({ key, status: 'ready', path: trianglesPath(floorTriangles(parseObj(text))) }))
      .catch((err) => {
        // An abandoned load is forgotten, so turning the mesh on again retries it.
        setState(err?.name === 'AbortError' ? { key: null, status: null, path: '' } : { key, status: 'error', path: '' });
      });
    return () => controller.abort();
    // Fetch once per file, not once per re-signed URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, key]);
  return file ? state : { status: null, path: '' };
}

/**
 * The scan's keyframes (H-03), loaded the first time a machine is
 * selected. Null while there are none: no keyframes.json, or it could not
 * be read, in which case the inspector simply shows no photos.
 */
function useKeyframes(v, wanted) {
  const file = keyframesIndexFile(v.files);
  const key = unsigned(file);
  const [state, setState] = useState({ key: null, frames: null });
  const url = file?.url;
  useEffect(() => {
    if (!wanted || !url || state.key === key) return undefined;
    const controller = new AbortController();
    setState({ key, frames: null });
    fetch(url, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => setState({ key, frames: json ? readKeyframes(json) : [] }))
      .catch((err) => setState(err?.name === 'AbortError' ? { key: null, frames: null } : { key, frames: [] }));
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, key]);
  return file && state.frames ? { frames: state.frames, files: v.files } : null;
}

function Editor({ v, reload }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canvas = useRef(null);
  const mine = v.status === 'in_review' && v.reviewer?.isMe;
  const readOnly = !mine;
  const history = usePlanHistory(v.plan ?? emptyPlan());
  const plan = history.plan;
  const [tool, setTool] = useState('select');
  const [options, setOptions] = useState({ openingKind: 'single_door', tagType: 'fireExit' });
  // H-02: a machine from the phone waiting for the reviewer to click where it stands.
  const [placing, setPlacing] = useState(null);
  const [showMesh, setShowMesh] = useState(false);
  const [selection, setSelection] = useState(null);
  const [showSource, setShowSource] = useState(true);
  const [zoom, setZoom] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [scaleLine, setScaleLine] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [acting, setActing] = useState(false);
  const loadedAt = useRef(Date.now());
  const { source, underlay } = useSource(v);
  const mesh = useScanMesh(v, showMesh);
  const selectedObject = selection ? plan.objects.find((o) => o.id === selection) : null;
  const keyframes = useKeyframes(v, Boolean(selectedObject));

  const startPlacing = useCallback((item) => {
    setPlacing(item);
    setSelection(null);
    setTool('place');
  }, []);

  // Leaving the placing tool by any route forgets the machine being placed.
  useEffect(() => {
    if (tool !== 'place') setPlacing(null);
  }, [tool]);

  const issues = useMemo(() => validate(plan), [plan]);
  const blockers = useMemo(() => approvalBlockers(plan), [plan]);
  const flagged = useMemo(() => new Set(plan.flags.filter((f) => f.status === 'open').map((f) => f.elementId)), [plan]);
  const problems = useMemo(() => new Set(issues.flatMap((i) => i.ids)), [issues]);

  const save = useAutosave({ versionId: v.id, plan, revision: v.planRevision, enabled: mine });
  useActivity(v.id, mine);

  // Leaving with unsaved edits.
  useEffect(() => {
    const warn = (e) => {
      if (save.status === 'dirty' || save.status === 'saving') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [save.status]);

  const title = `${v.facility} · ${levelLabel(v.level)}`;

  const focus = useCallback((elementId) => {
    setTool('select');
    setSelection(elementId);
  }, []);

  async function act(fn, notice) {
    setActing(true);
    setActionError(null);
    try {
      const result = await fn();
      if (notice) navigate('/review', { state: { notice } });
      else await reload();
      return result;
    } catch (err) {
      setActionError(err.message);
      await reload();
      return null;
    } finally {
      setActing(false);
    }
  }

  // Keyboard shortcuts (REV-11).
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
      if (dialog) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z' && !readOnly) {
        e.preventDefault();
        if (e.shiftKey) history.redo();
        else history.undo();
      } else if (mod && k === 'y' && !readOnly) {
        e.preventDefault();
        history.redo();
      } else if (mod && k === 's') {
        e.preventDefault();
        save.flush();
      } else if (mod) {
        return;
      } else if (e.shiftKey && k === 'a' && mine) {
        setDialog('approve');
      } else if (e.shiftKey && k === 'r' && mine) {
        setDialog('reject');
      } else if ((k === 'delete' || k === 'backspace') && selection && !readOnly) {
        e.preventDefault();
        history.change(deleteElement(plan, selection));
        setSelection(null);
      } else if (k === 'escape') {
        if (tool === 'place') setTool('select');
        else if (canvas.current?.hasDraft()) canvas.current.cancelDraft();
        else if (selection) setSelection(null);
        else setTool('select');
      } else if (k === 'enter') {
        canvas.current?.finishDraft();
      } else if (k === '+' || k === '=') {
        canvas.current?.zoomBy(1.25);
      } else if (k === '-') {
        canvas.current?.zoomBy(1 / 1.25);
      } else if (k === '0') {
        canvas.current?.fit();
      } else if (k.startsWith('arrow') && selection && !readOnly) {
        e.preventDefault();
        nudge(k, e.shiftKey ? 0.1 : 0.01);
      } else {
        const t = TOOLS.find((x) => x.key === k);
        if (t && (!readOnly || t.id === 'select' || t.id === 'pan')) setTool(t.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function nudge(key, step) {
    const d = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] }[key];
    const found = findElement(plan, selection);
    if (!found || !d) return;
    const { kind, el } = found;
    const r = (n) => Math.round(n * 1000) / 1000;
    if (kind === 'walls') {
      history.change({
        ...plan,
        walls: plan.walls.map((w) => (w.id === el.id ? { ...w, a: [r(w.a[0] + d[0]), r(w.a[1] + d[1])], b: [r(w.b[0] + d[0]), r(w.b[1] + d[1])] } : w)),
      });
    } else if (Array.isArray(el.points)) {
      history.change(movePolygon(plan, el.id, d));
    } else if ('x' in el) {
      history.change({ ...plan, [kind]: plan[kind].map((e) => (e.id === el.id ? { ...e, x: r(e.x + d[0]), y: r(e.y + d[1]) } : e)) });
    }
  }

  const activeSeconds = (v.activeSeconds ?? 0) + (mine ? Math.min((Date.now() - loadedAt.current) / 1000, 600) : 0);

  return (
    <div className="ed-page">
      <Header title={title}>
        <span className="ed-sub small muted">
          {inputLabel(v.inputType)}
          {v.areaM2 ? ` · ${Math.round(v.areaM2)} m²` : ''}
          {v.reviewStartedAt && v.status === 'in_review' ? ` · claimed ${time(v.reviewStartedAt)}` : ''}
        </span>
        <span className="rv-chip">
          v{v.version} {v.status === 'in_review' ? 'draft' : STATUS_LABELS[v.status]?.toLowerCase()}
        </span>
        <span className="spacer" />
        {mine && <SaveState save={save} />}
        {mine && <ReviewTimer base={v.activeSeconds ?? 0} />}
        {v.plan && (
          <Link
            className="rv-button ghost"
            to={`/review/versions/${v.id}/walkthrough`}
            title="Walk through this version in 3D: the generated model once it is built, else drawn from the plan"
            onClick={async (e) => {
              // Unsaved edits first, so the 3D shows the plan as it stands.
              e.preventDefault();
              await save.flush();
              navigate(`/review/versions/${v.id}/walkthrough`);
            }}
          >
            Open in 3D
          </Link>
        )}
        <Decisions
          v={v}
          mine={mine}
          acting={acting}
          blockers={blockers}
          onClaim={() => act(() => reviewApi.start(v.id))}
          onRegenerate={() => act(() => reviewApi.regenerate(v.id), `${title}: building the 3D walkthrough again.`)}
          onRelease={async () => {
            await save.flush();
            act(() => reviewApi.release(v.id), `${title} is back in the queue.`);
          }}
          onReject={() => setDialog('reject')}
          onApprove={() => setDialog('approve')}
          onRevise={async () => {
            const r = await act(() => reviewApi.revise(v.id));
            if (r?.id) navigate(`/review/versions/${r.id}`);
          }}
        />
      </Header>

      <Notices v={v} actionError={actionError} saveError={save.status === 'conflict' || save.status === 'error' ? save.error : null} onReload={reload} />

      <div className="ed-body">
        <div className="ed-main">
          <Toolbar
            tool={tool}
            onTool={setTool}
            options={options}
            onOptions={setOptions}
            disabled={readOnly}
            zoom={zoom}
            onZoom={(f) => canvas.current?.zoomBy(f)}
            onFit={() => canvas.current?.fit()}
            history={history}
            showSource={showSource}
            onShowSource={setShowSource}
            hasSource={Boolean(source || underlay)}
            hasMesh={Boolean(meshFile(v.files))}
            showMesh={showMesh}
            onShowMesh={setShowMesh}
            meshStatus={mesh.status}
            placing={placing}
          />
          {scaleLine && (
            <ScaleForm
              line={scaleLine}
              onCancel={() => setScaleLine(null)}
              onApply={(next) => {
                history.change(next(plan));
                setScaleLine(null);
                setTool('select');
              }}
            />
          )}
          <Canvas
            ref={canvas}
            plan={plan}
            source={source}
            underlay={underlay}
            showSource={showSource}
            tool={readOnly ? (tool === 'pan' ? 'pan' : 'select') : tool}
            toolOptions={options}
            selection={selection}
            onSelect={setSelection}
            readOnly={readOnly}
            history={history}
            flagged={flagged}
            problems={problems}
            onScaleLine={(a, b) => setScaleLine({ a, b })}
            onZoomChange={setZoom}
            placing={placing}
            onPlaced={() => setTool('select')}
            meshPath={showMesh ? mesh.path : ''}
          />
        </div>
        <Sidebar
          v={v}
          plan={plan}
          issues={issues}
          readOnly={readOnly}
          selection={selection}
          onSelect={setSelection}
          onFocus={focus}
          history={history}
          placing={placing}
          onPlace={startPlacing}
          keyframes={keyframes}
        />
      </div>

      {dialog === 'approve' && (
        <ApproveDialog
          version={v}
          plan={plan}
          reviewer={user}
          seconds={activeSeconds}
          blockers={blockers}
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            if (!(await save.flush())) throw new Error(save.error ?? 'The plan could not be saved.');
            const r = await reviewApi.approve(v.id);
            navigate('/review', {
              state: { notice: `${title}, version ${v.version} approved · hash ${r.contentHash.slice(0, 12)}…${r.status === 'generating' ? ' · building the 3D walkthrough' : ''}` },
            });
          }}
        />
      )}
      {dialog === 'reject' && (
        <RejectDialog
          version={v}
          reasons={v.rejectReasons}
          onCancel={() => setDialog(null)}
          onConfirm={async (reason, note) => {
            await save.flush();
            await reviewApi.reject(v.id, reason, note);
            navigate('/review', { state: { notice: `${title} sent back for recapture: ${reason}.` } });
          }}
        />
      )}
    </div>
  );
}

function Decisions({ v, mine, acting, blockers, onClaim, onRelease, onReject, onApprove, onRevise, onRegenerate }) {
  if (mine) {
    return (
      <>
        <button type="button" className="rv-button ghost" disabled={acting} onClick={onRelease} title="Put it back in the queue">
          Release
        </button>
        <button type="button" className="rv-button danger-ghost" disabled={acting} onClick={onReject} title="Reject (Shift+R)">
          <XIcon size={15} />
          Reject
        </button>
        <button
          type="button"
          className="rv-button primary"
          disabled={acting}
          aria-describedby={blockers.length ? 'approve-blocked' : undefined}
          onClick={onApprove}
          title={blockers.length ? blockers.join('\n') : 'Approve (Shift+A)'}
        >
          <CheckIcon size={15} />
          Approve
          {blockers.length > 0 && (
            <span id="approve-blocked" className="ed-badge">
              {blockers.length}
              <span className="sr-only"> things to fix first</span>
            </span>
          )}
        </button>
      </>
    );
  }
  if (v.status === 'processing') {
    return (
      <button type="button" className="rv-button primary" disabled={acting} onClick={onClaim}>
        Claim to review
      </button>
    );
  }
  const newest = v.history[0]?.id === v.id;
  // A failed 3D build (J-09): fix the plan in a new version, or build again
  // once the cause is gone (a storage outage, a generator fix).
  if (v.status === 'generation_failed' && newest) {
    return (
      <>
        <button type="button" className="rv-button ghost" disabled={acting} onClick={onRevise} title="Make a new version from this one, to fix the plan">
          Revise
        </button>
        <button type="button" className="rv-button primary" disabled={acting} onClick={onRegenerate}>
          Build 3D again
        </button>
      </>
    );
  }
  if (v.status === 'ready' && newest) {
    return (
      <button type="button" className="rv-button ghost" disabled={acting} onClick={onRevise} title="Make a new version from this one">
        Revise
      </button>
    );
  }
  return null;
}

function Notices({ v, actionError, saveError, onReload }) {
  const takenBy = v.status === 'in_review' && !v.reviewer?.isMe ? v.reviewer : null;
  const approved = v.status === 'ready' || v.status === 'superseded';
  return (
    <div className="ed-notices">
      {takenBy && (
        <p className="rv-notice" role="status">
          {takenBy.name} is reviewing this plan. You can look, but only they can change or decide it.
        </p>
      )}
      {approved && (
        <p className="rv-notice good" role="status">
          <CheckIcon size={15} /> {v.status === 'superseded' ? 'Superseded. ' : ''}Approved by {v.reviewer?.name ?? 'a reviewer'} ·{' '}
          {stamp(v.reviewedAt)} · {duration(v.reviewSeconds)}
          {v.contentHash && <code className="small"> · {v.contentHash.slice(0, 16)}…</code>}. Read-only.
        </p>
      )}
      {v.status === 'generation_failed' && (
        <p className="rv-error" role="status">
          The 3D build failed: {v.generatedModel?.failureReason ?? v.failureReason ?? 'no reason was recorded'}
        </p>
      )}
      {v.status === 'recapture' && (
        <p className="rv-error" role="status">
          Sent back: {v.rejectionReason}. “{v.reviewerNote}”
        </p>
      )}
      {!v.plan && <p className="rv-error">No plan was produced for this version. Draw it by hand, or reject it.</p>}
      {actionError && (
        <p className="rv-error" role="alert">
          {actionError}
        </p>
      )}
      {saveError && (
        <p className="rv-error" role="alert">
          {saveError}{' '}
          <button type="button" className="ed-link" onClick={onReload}>
            Reload the plan
          </button>
        </p>
      )}
    </div>
  );
}

function SaveState({ save }) {
  const text = {
    saved: save.savedAt ? `Saved ${time(save.savedAt)}` : 'All changes saved',
    dirty: 'Unsaved changes',
    saving: 'Saving…',
    error: 'Not saved',
    conflict: 'Changed elsewhere',
  }[save.status];
  return (
    <span className={`ed-save ${save.status}`} role="status" aria-live="polite">
      {text}
    </span>
  );
}

function ReviewTimer({ base }) {
  const now = useNow(1000);
  const [start] = useState(() => Date.now());
  // Counts from what the server has recorded, plus this session.
  return (
    <span className="rv-timer" title="Your time on this plan, idle spells over 10 minutes excluded">
      {duration(base + (now - start) / 1000)}
    </span>
  );
}

/** REV-04 set or correct scale: the drawn line is really this long. */
function ScaleForm({ line, onCancel, onApply }) {
  const measured = Math.hypot(line.b[0] - line.a[0], line.b[1] - line.a[1]);
  const [value, setValue] = useState(measured.toFixed(2));
  const n = Number(value);
  const ok = Number.isFinite(n) && n > 0.05 && n < 1000;
  return (
    <form
      className="ed-scale-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ok) return;
        const { rescale } = await import('./ops.js');
        onApply((plan) => rescale(plan, line.a, line.b, n));
      }}
    >
      <label className="small">
        The line you drew reads {measured.toFixed(2)} m. Its real length is
        <input type="number" step="0.01" min="0.05" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />m
      </label>
      <button type="submit" className="rv-button primary small" disabled={!ok}>
        Rescale the plan
      </button>
      <button type="button" className="rv-button ghost small" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}
