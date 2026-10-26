import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { homeFor, useAuth } from './auth.jsx';
import { t } from './i18n.js';
import { SignInFrame } from './LoginPage.jsx';
import { useTitle } from './useTitle.js';

/** A page of this app to go on to: a path on this site, never another. */
export const safePath = (path) => (typeof path === 'string' && /^\/(?!\/)/.test(path) ? path : null);

/** The token, page and account an iPhone app link carries in its fragment. */
export function readLink(hash) {
  const params = new URLSearchParams(String(hash ?? '').replace(/^#/, ''));
  return { token: params.get('token'), next: safePath(params.get('next')), accountId: params.get('account') };
}

/**
 * A link's token can be swapped once. React's StrictMode runs effects twice
 * in development, so the sign-in is shared per token rather than run per
 * mount.
 */
const signIns = new Map();

function signInOnce(link, completeLinkSignIn) {
  if (!signIns.has(link.token)) {
    const run = completeLinkSignIn(link);
    signIns.set(link.token, run);
    run.catch(() => {}).finally(() => setTimeout(() => signIns.delete(link.token), 0));
  }
  return signIns.get(link.token);
}

/**
 * /auth/link: where the iPhone app's "Open walkthrough in Safari" lands
 * (POST /v1/auth/web-link). The fragment carries a one-time token for a web
 * session of whoever is signed in on the phone, the page to open and the
 * gym account. The token leaves the address bar at once; then the tab is
 * signed in and goes on to the page, so nobody signs in twice.
 */
export default function AppLinkPage() {
  useTitle(t('auth.title'));
  const { completeLinkSignIn, signIn } = useAuth();
  const { hash } = useLocation();
  const navigate = useNavigate();
  // Read once: the fragment is cleared straight away.
  const [link] = useState(() => readLink(hash));
  const [failed, setFailed] = useState(!link.token);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!link.token) return undefined;
    let live = true;
    navigate('/auth/link', { replace: true });
    signInOnce(link, completeLinkSignIn).then(
      (user) => {
        if (live) navigate(link.next ?? homeFor(user), { replace: true });
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [link, completeLinkSignIn, navigate]);

  async function signInHere() {
    setBusy(true);
    try {
      await signIn(link.next);
    } catch {
      setBusy(false);
    }
  }

  return (
    <SignInFrame>
      {failed ? (
        <>
          <h1>{t('auth.link.failedTitle')}</h1>
          <p className="muted">{t('auth.link.expired')}</p>
          <button type="button" className="rv-button primary wide" onClick={signInHere} disabled={busy}>
            {busy ? t('auth.redirecting') : t('auth.button')}
          </button>
        </>
      ) : (
        <div role="status" className="rv-callback-wait">
          <span className="rv-spinner" aria-hidden="true" />
          <span>{t('auth.link.opening')}</span>
        </div>
      )}
    </SignInFrame>
  );
}
