import { Navigate, useLocation } from 'react-router';

import { homeFor, useAuth } from './auth.jsx';

/**
 * Renders `children` for a signed-in user whose role is in `roles`. Anyone
 * signed out goes to sign-in and comes back; a signed-in user without the
 * role goes to their own home.
 */
export default function RequireRole({ roles, children }) {
  const { status, user } = useAuth();
  const location = useLocation();
  if (status === 'checking') {
    return (
      <div className="rv-login" role="status">
        <span className="rv-spinner" aria-hidden="true" />
        <span className="sr-only">Loading…</span>
      </div>
    );
  }
  if (status === 'signedOut') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  if (roles && !roles.includes(user.role)) return <Navigate to={homeFor(user.role)} replace />;
  return children;
}
