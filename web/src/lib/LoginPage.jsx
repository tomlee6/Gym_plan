import { useState } from 'react';
import { Navigate, useLocation } from 'react-router';

import { homeFor, useAuth } from './auth.jsx';
import { t } from './i18n.js';
import { useTitle } from './useTitle.js';

/** The FLEX · GYM SCAN mark the sign-in pages share. */
export function Brand() {
  return (
    <div className="rv-brand">
      <div className="rv-wordmark">FLEX</div>
      <div className="rv-product">GYM SCAN</div>
    </div>
  );
}

/**
 * Sign-in for every role (B-07). There is no password here: the button
 * sends the page to the GoalCert Hub, which brings the browser back to
 * /auth/callback. Where the person was heading is carried through the Hub
 * in this tab's sessionStorage.
 */
export default function LoginPage() {
  useTitle(t('auth.title'));
  const { status, user, signIn } = useAuth();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const from = location.state?.from ?? null;

  if (status === 'signedIn') return <Navigate to={from ?? homeFor(user)} replace />;

  async function go() {
    setBusy(true);
    setError(null);
    try {
      await signIn(from);
      // The page is navigating away; stay busy until it does.
    } catch (err) {
      setError(t('auth.errors.config', { detail: err.message }));
      setBusy(false);
    }
  }

  return (
    <main className="rv-login">
      <div className="rv-login-card">
        <Brand />
        <h1>{t('auth.title')}</h1>
        <p className="muted">{t('auth.lead')}</p>
        <div aria-live="assertive">
          {error && (
            <p className="rv-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <button type="button" className="rv-button primary wide" onClick={go} disabled={busy || status === 'checking'}>
          {busy ? t('auth.redirecting') : t('auth.button')}
        </button>
      </div>
    </main>
  );
}
