import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Runs `load` now, again whenever `key` changes, every `intervalMs` if
 * given, and on `reload()`. Keeps showing the last data while reloading, so
 * a refresh does not flash the page empty.
 */
export function useLoader(load, key, { intervalMs } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const loadRef = useRef(load);
  loadRef.current = load;
  const run = useRef(0);

  const reload = useCallback(async () => {
    const id = ++run.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await loadRef.current();
      if (id === run.current) setState({ data, error: null, loading: false, at: Date.now() });
    } catch (error) {
      if (id === run.current) setState((s) => ({ ...s, error, loading: false }));
    }
  }, []);

  useEffect(() => {
    setState({ data: null, error: null, loading: true });
    reload();
    if (!intervalMs) return () => run.current++;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') reload();
    }, intervalMs);
    return () => {
      clearInterval(timer);
      run.current++;
    };
  }, [key, intervalMs, reload]);

  return { ...state, reload };
}

/** Re-renders every `ms`, for ages and running timers. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}
