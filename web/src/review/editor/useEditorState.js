import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { reviewApi } from '../../lib/client.js';

/**
 * The plan being edited, with undo and redo (REV-12).
 *
 * `change(plan)` records a step. During a drag, `preview(plan)` shows each
 * move without recording it, and `commit()` records the whole drag as one
 * step, so a single undo puts a dragged corner back.
 */
const LIMIT = 200;

function reducer(state, action) {
  switch (action.type) {
    case 'reset':
      return { past: [], present: action.plan, future: [], base: null };
    case 'preview':
      return { ...state, base: state.base ?? state.present, present: action.plan };
    case 'commit': {
      if (!state.base) return state;
      if (state.base === state.present) return { ...state, base: null };
      return { past: [...state.past, state.base].slice(-LIMIT), present: state.present, future: [], base: null };
    }
    case 'cancel':
      return state.base ? { ...state, present: state.base, base: null } : state;
    case 'change':
      if (action.plan === state.present) return state;
      return { past: [...state.past, state.present].slice(-LIMIT), present: action.plan, future: [], base: null };
    case 'undo':
      if (!state.past.length) return state;
      return { past: state.past.slice(0, -1), present: state.past.at(-1), future: [state.present, ...state.future], base: null };
    case 'redo':
      if (!state.future.length) return state;
      return { past: [...state.past, state.present], present: state.future[0], future: state.future.slice(1), base: null };
    default:
      return state;
  }
}

export function usePlanHistory(initial) {
  const [state, dispatch] = useReducer(reducer, { past: [], present: initial, future: [], base: null });
  return {
    plan: state.present,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    dragging: state.base !== null,
    change: useCallback((plan) => dispatch({ type: 'change', plan }), []),
    preview: useCallback((plan) => dispatch({ type: 'preview', plan }), []),
    commit: useCallback(() => dispatch({ type: 'commit' }), []),
    cancel: useCallback(() => dispatch({ type: 'cancel' }), []),
    undo: useCallback(() => dispatch({ type: 'undo' }), []),
    redo: useCallback(() => dispatch({ type: 'redo' }), []),
    reset: useCallback((plan) => dispatch({ type: 'reset', plan }), []),
  };
}

const AUTOSAVE_MS = 1500;

/**
 * Saves the plan shortly after each change, one save at a time. The server
 * refuses a save made from an out-of-date copy (409); that stops autosave
 * and asks the reviewer to reload rather than overwrite someone's work.
 *
 * `status`: 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'.
 */
export function useAutosave({ versionId, plan, revision, enabled, onSaved }) {
  const [status, setStatusState] = useState('saved');
  const statusRef = useRef('saved');
  const setStatus = useCallback((next) => {
    statusRef.current = next;
    setStatusState(next);
  }, []);
  const [error, setError] = useState(null);
  const [savedAt, setSavedAt] = useState(null);
  const saved = useRef(plan);
  const rev = useRef(revision);
  const latest = useRef(plan);
  const inFlight = useRef(null);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  latest.current = plan;

  // A new version or a reload starts clean.
  useEffect(() => {
    saved.current = latest.current;
    rev.current = revision;
    setStatus('saved');
    setError(null);
  }, [versionId, revision, setStatus]);

  const save = useCallback(async () => {
    if (inFlight.current) await inFlight.current.catch(() => {});
    const plan = latest.current;
    if (plan === saved.current) return true;
    setStatus('saving');
    const run = reviewApi.savePlan(versionId, plan, rev.current);
    inFlight.current = run;
    try {
      const result = await run;
      rev.current = result.revision;
      saved.current = plan;
      setSavedAt(new Date());
      setError(null);
      setStatus(latest.current === plan ? 'saved' : 'dirty');
      onSavedRef.current?.(result);
      return true;
    } catch (err) {
      setError(err.message);
      setStatus(err.status === 409 ? 'conflict' : 'error');
      return false;
    } finally {
      inFlight.current = null;
    }
  }, [versionId, setStatus]);

  useEffect(() => {
    if (!enabled || plan === saved.current || statusRef.current === 'conflict') return undefined;
    if (statusRef.current !== 'saving') setStatus('dirty');
    const timer = setTimeout(() => {
      if (statusRef.current !== 'conflict') save();
    }, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [plan, enabled, save, setStatus]);

  /** Saves now if anything is unsaved. False if the save failed. */
  const flush = useCallback(async () => (latest.current === saved.current ? true : save()), [save]);

  return { status, error, savedAt, flush, revision: rev };
}

/**
 * Tells the server the reviewer is working (REV-10), at most once a minute
 * and only after real input, so idle time is not counted.
 */
export function useActivity(versionId, enabled) {
  const last = useRef(0);
  useEffect(() => {
    if (!enabled) return undefined;
    const ping = () => {
      const now = Date.now();
      if (now - last.current < 60_000) return;
      last.current = now;
      reviewApi.activity(versionId).catch(() => {});
    };
    const events = ['pointerdown', 'keydown', 'wheel'];
    events.forEach((e) => window.addEventListener(e, ping, { passive: true }));
    return () => events.forEach((e) => window.removeEventListener(e, ping));
  }, [versionId, enabled]);
}
