import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { homeFor, useAuth } from './auth.jsx';
import { t } from './i18n.js';
import { Brand } from './LoginPage.jsx';
import { useTitle } from './useTitle.js';

/**
 * A Hub code can be redeemed once. React's StrictMode runs effects twice in
 * development, so the exchange is shared per callback URL rather than run
 * per mount.
 */
const exchanges = new Map();

function exchangeOnce(search, completeSignIn) {
  if (!exchanges.has(search)) {
    const run = completeSignIn(search);
    exchanges.set(search, run);
    // Forget it once settled, so a later sign-in with the same URL (tests,
    // or a deliberate retry) is a fresh attempt.
    run.catch(() => {}).finally(() => setTimeout(() => exchanges.delete(search), 0));
  }
  return exchanges.get(search);
}

/** Plain words for what went wrong, by the backend's or the client's code. */
function messageFor(err) {
  const known = ['hub_rejected', 'no_access', 'state_mismatch', 'cancelled'];
  if (known.includes(err?.code)) return t(`auth.errors.${err.code}`);
  if (err?.code === 'hub_error') return t('auth.errors.hub_error', { detail: err.message });
  return t('auth.errors.unknown', { detail: err?.message ?? '' });
}

/**
 * /auth/callback (B-07): where the Hub sends the browser back. Checks the
 * state, has the backend redeem the code, then goes on to where the person
 * was heading, or their home.
 */
export default function AuthCallbackPage() {
  useTitle(t('auth.title'));
  const { completeSignIn, signIn } = useAuth();
  const { search } = useLocation();
  const navigate = useNavigate();
  const [error, setError] = useState(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    let live = true;
    exchangeOnce(search, completeSignIn).then(
      ({ user, from }) => {
        if (live) navigate(from ?? homeFor(user), { replace: true });
      },
      (err) => {
        if (live) setError(err);
      },
    );
    return () => {
      live = false;
    };
  }, [search, completeSignIn, navigate]);

  async function retry() {
    setRetrying(true);
    try {
      await signIn(null);
    } catch (err) {
      setError({ code: 'config', message: t('auth.errors.config', { detail: err.message }) });
      setRetrying(false);
    }
  }

  return (
    <main className="rv-login">
      <div className="rv-login-card">
        <Brand />
        {error ? (
          <>
            <h1>{t('auth.failedTitle')}</h1>
            <p className="rv-error" role="alert">
              {error.code === 'config' ? error.message : messageFor(error)}
            </p>
            <button type="button" className="rv-button primary wide" onClick={retry} disabled={retrying}>
              {retrying ? t('auth.redirecting') : t('auth.retry')}
            </button>
          </>
        ) : (
          <div role="status" className="rv-callback-wait">
            <span className="rv-spinner" aria-hidden="true" />
            <span>{t('auth.finishing')}</span>
          </div>
        )}
      </div>
    </main>
  );
}
