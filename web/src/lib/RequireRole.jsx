import { Navigate, useLocation } from 'react-router';

import { hasRole, homeFor, useAuth } from './auth.jsx';
import { t } from './i18n.js';

/**
 * Renders `children` for a signed-in user who holds one of `roles`: a
 * staff role (reviewer, admin) for the review and admin areas, or a role in
 * the current account (owner, surveyor) for the customer area. Anyone
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
        <span className="sr-only">{t('common.loading')}</span>
      </div>
    );
  }
  if (status === 'signedOut') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  if (roles && !hasRole(user, roles)) {
    const home = homeFor(user);
    // A customer with no role in the current account has nowhere to go but
    // a page saying so, rather than a redirect loop back to /plans.
    if (home === location.pathname) return <NoAccess />;
    return <Navigate to={home} replace />;
  }
  return children;
}

function NoAccess() {
  return (
    <div className="rv-content">
      <div className="rv-empty" role="alert">
        <h1>{t('auth.noAccess.title')}</h1>
        <p className="muted">{t('auth.noAccess.body')}</p>
      </div>
    </div>
  );
}
