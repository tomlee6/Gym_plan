import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import * as client from './client.js';

/**
 * Who is signed in. One sign-in for every role (PRD section 3): owners and
 * surveyors land on their plans, reviewers on the queue, admins on accounts.
 * Sign-in goes through the backend's own accounts today; swapping to
 * GoalCert sign-in only changes `client.signIn`.
 */
const AuthContext = createContext(null);

export const ROLES = {
  customer: ['owner', 'surveyor'],
  review: ['reviewer', 'admin'],
  admin: ['admin'],
};

/** Where a role starts. */
export function homeFor(role) {
  if (role === 'admin') return '/admin';
  if (role === 'reviewer') return '/review';
  return '/plans';
}

/** Shared across mounts so StrictMode's double effect restores only once. */
let restoring = null;

function restore() {
  restoring ??= (async () => {
    if (!client.hasStoredSession()) return null;
    try {
      return await client.meApi.me();
    } catch {
      return null;
    }
  })().finally(() => {
    restoring = null;
  });
  return restoring;
}

export function AuthProvider({ children }) {
  const [state, setState] = useState({ status: 'checking', user: null });

  useEffect(() => {
    let live = true;
    restore().then((user) => {
      if (live) setState({ status: user ? 'signedIn' : 'signedOut', user });
    });
    const stop = client.onSignedOut(() => setState({ status: 'signedOut', user: null }));
    return () => {
      live = false;
      stop();
    };
  }, []);

  const signIn = useCallback(async (email, password) => {
    await client.signIn(email, password);
    const me = await client.meApi.me();
    setState({ status: 'signedIn', user: me });
    return me;
  }, []);

  const signOut = useCallback(async () => {
    await client.signOut();
    setState({ status: 'signedOut', user: null });
  }, []);

  const value = useMemo(() => ({ ...state, signIn, signOut }), [state, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
