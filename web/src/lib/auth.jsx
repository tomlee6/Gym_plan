import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import * as client from './client.js';

/**
 * Who is signed in, and which gym account they are working in.
 *
 * One sign-in for everyone, through the GoalCert Hub (B-07). What a person
 * may do comes from two places (api-contract-v2 section 2):
 *
 * - `user.staffRole` ('reviewer' | 'admin' | null): Flex staff, who see
 *   every account through the review and admin pages;
 * - their role in the current account ('owner' | 'surveyor'): gym
 *   customers, who see that account's plans.
 *
 * The current account is chosen per tab (client.currentAccountId) and sent
 * with every customer call as X-Account-Id.
 */
const AuthContext = createContext(null);

export const ROLES = {
  customer: ['owner', 'surveyor'],
  review: ['reviewer', 'admin'],
  admin: ['admin'],
};

/** The user's role in the account they are working in, or null. */
export function accountRoleOf(user) {
  if (!user) return null;
  if (user.account?.role) return user.account.role;
  const id = client.currentAccountId();
  return (user.accounts ?? []).find((a) => a.id === id)?.role ?? null;
}

/**
 * Whether the user holds any of `roles`. Staff roles are checked against
 * staffRole, account roles against the current account: the two sets never
 * overlap, so one list says which area a route belongs to.
 */
export function hasRole(user, roles) {
  if (!user) return false;
  if (!roles) return true;
  return roles.includes(user.staffRole) || roles.includes(accountRoleOf(user));
}

/** Where a person starts: admins on accounts, reviewers on the queue, everyone else on their plans. */
export function homeFor(user) {
  if (user?.staffRole === 'admin') return '/admin';
  if (user?.staffRole === 'reviewer') return '/review';
  return '/plans';
}

/**
 * GET /v1/me for the current account. If the stored account is no longer
 * one of theirs (a membership was removed), switch to the first and ask
 * again so the account block matches.
 */
async function loadMe() {
  const me = await client.meApi.me();
  const accounts = me.accounts ?? [];
  const before = client.currentAccountId();
  const chosen = client.chooseAccount(accounts);
  if (chosen && chosen !== before) return client.meApi.me();
  return me;
}

/** Shared across mounts so StrictMode's double effect restores only once. */
let restoring = null;

function restore() {
  restoring ??= (async () => {
    if (!client.hasStoredSession()) return null;
    try {
      return await loadMe();
    } catch {
      return null;
    }
  })().finally(() => {
    restoring = null;
  });
  return restoring;
}

const signedOut = { status: 'signedOut', user: null, accountId: null };

export function AuthProvider({ children }) {
  const [state, setState] = useState({ status: 'checking', user: null, accountId: null });

  useEffect(() => {
    let live = true;
    restore().then((user) => {
      if (live) setState(user ? { status: 'signedIn', user, accountId: client.currentAccountId() } : signedOut);
    });
    const stop = client.onSignedOut(() => setState(signedOut));
    return () => {
      live = false;
      stop();
    };
  }, []);

  /** Sends the page to the Hub. Resolves only if that fails. */
  const signIn = useCallback((from) => client.beginHubSignIn({ from }), []);

  /** On /auth/callback: redeems the code and loads who signed in. */
  const completeSignIn = useCallback(async (search) => {
    const { from } = await client.completeHubSignIn(search);
    const me = await loadMe();
    setState({ status: 'signedIn', user: me, accountId: client.currentAccountId() });
    return { user: me, from };
  }, []);

  /** Works in a different account; pages keyed on accountId reload. */
  const switchAccount = useCallback(async (accountId) => {
    client.setAccountId(accountId);
    const me = await client.meApi.me();
    setState({ status: 'signedIn', user: me, accountId });
    return me;
  }, []);

  const signOut = useCallback(async () => {
    await client.signOut();
    setState(signedOut);
  }, []);

  const value = useMemo(
    () => ({ ...state, signIn, completeSignIn, switchAccount, signOut }),
    [state, signIn, completeSignIn, switchAccount, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
