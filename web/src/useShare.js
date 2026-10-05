import { useCallback, useEffect, useState } from 'react';

import { fetchShare } from './api.js';

/**
 * Loads a share link. `state.status` is `loading`, `ready` (with `share`)
 * or `error` (with `error`, a ShareError). `retry` loads it again.
 */
export function useShare(token) {
  const [state, setState] = useState({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    fetchShare(token, { signal: controller.signal })
      .then((share) => setState({ status: 'ready', share }))
      .catch((error) => {
        if (error.name !== 'AbortError') setState({ status: 'error', error });
      });
    return () => controller.abort();
  }, [token, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}
