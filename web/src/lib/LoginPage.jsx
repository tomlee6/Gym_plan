import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';

import { homeFor, useAuth } from './auth.jsx';
import { useTitle } from './useTitle.js';

/** One sign-in for owners, reviewers and admins; each lands on their home. */
export default function LoginPage() {
  useTitle('Sign in');
  const { status, user, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const from = location.state?.from;

  if (status === 'signedIn') return <Navigate to={from ?? homeFor(user.role)} replace />;

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await signIn(email, password);
      navigate(from ?? homeFor(me.role), { replace: true });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="rv-login">
      <form className="rv-login-card" onSubmit={submit} noValidate>
        <div className="rv-brand">
          <div className="rv-wordmark">FLEX</div>
          <div className="rv-product">GYM SCAN</div>
        </div>
        <h1>Sign in</h1>
        <p className="muted">Gym owners, reviewers and Flex staff all sign in here.</p>

        <label className="rv-field">
          <span>Email</span>
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </label>
        <label className="rv-field">
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>

        {error && (
          <p className="rv-error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="rv-button primary wide" disabled={busy || !email || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
