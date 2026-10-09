import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';

import AccountPage from './admin/AccountPage.jsx';
import AccountsPage from './admin/AccountsPage.jsx';
import AuditPage from './admin/AuditPage.jsx';
import StaffPage from './admin/StaffPage.jsx';
import App from './App.jsx';
import AuthCallbackPage from './lib/AuthCallbackPage.jsx';
import { homeFor, ROLES, useAuth } from './lib/auth.jsx';
import Layout from './lib/Layout.jsx';
import LoginPage from './lib/LoginPage.jsx';
import RequireRole from './lib/RequireRole.jsx';
import PlanPage from './owner/PlanPage.jsx';
import PlansPage from './owner/PlansPage.jsx';
import UploadPage from './owner/UploadPage.jsx';
import QueuePage from './review/QueuePage.jsx';
import './lib/app.css';

// The editor and the 3D viewer are the heavy pages: load them on demand.
const EditorPage = lazy(() => import('./review/editor/EditorPage.jsx'));
const WalkthroughPage = lazy(() => import('./viewer/WalkthroughPage.jsx'));

function Loading() {
  return (
    <div className="rv-login" role="status">
      <span className="rv-spinner" aria-hidden="true" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}

/** "/" sends a signed-in user to their home, anyone else to sign-in. */
function Home() {
  const { status, user } = useAuth();
  if (status === 'checking') return <Loading />;
  return <Navigate to={status === 'signedIn' ? homeFor(user) : '/login'} replace />;
}

/** The share viewer reads the token from the path itself. */
function ShareRoute() {
  const { pathname } = useLocation();
  return <App pathname={pathname} />;
}

/**
 * Every page of the web module:
 *
 *   /login                        sign-in for every role, through the GoalCert Hub
 *   /auth/callback                where the Hub sends the browser back (B-07)
 *   /s/:token                     share link, no sign-in (VIEW-07)
 *   /plans, /plans/:id, /upload   owner status and uploads (ACC-03, UPL)
 *   /plans/:id/walkthrough        the 3D walkthrough (VIEW)
 *   /review, /review/versions/:id reviewer queue and editor (REV)
 *   /admin, /admin/accounts/:id,
 *   /admin/staff, /admin/audit    accounts, invites, staff roles and the
 *                                 audit log (ACC-05..07, B-09)
 */
export default function Root() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/auth/callback" element={<AuthCallbackPage />} />
        <Route path="/s/:token" element={<ShareRoute />} />
        <Route
          path="/plans/:planId/walkthrough"
          element={
            <RequireRole roles={ROLES.customer}>
              <WalkthroughPage />
            </RequireRole>
          }
        />
        <Route
          element={
            <RequireRole>
              <Layout />
            </RequireRole>
          }
        >
          <Route
            path="/plans"
            element={
              <RequireRole roles={ROLES.customer}>
                <PlansPage />
              </RequireRole>
            }
          />
          <Route
            path="/plans/:planId"
            element={
              <RequireRole roles={ROLES.customer}>
                <PlanPage />
              </RequireRole>
            }
          />
          <Route
            path="/upload"
            element={
              <RequireRole roles={ROLES.customer}>
                <UploadPage />
              </RequireRole>
            }
          />
          <Route
            path="/review"
            element={
              <RequireRole roles={ROLES.review}>
                <QueuePage />
              </RequireRole>
            }
          />
          <Route
            path="/review/versions/:id"
            element={
              <RequireRole roles={ROLES.review}>
                <EditorPage />
              </RequireRole>
            }
          />
          <Route
            path="/admin"
            element={
              <RequireRole roles={ROLES.admin}>
                <AccountsPage />
              </RequireRole>
            }
          />
          <Route
            path="/admin/accounts/:id"
            element={
              <RequireRole roles={ROLES.admin}>
                <AccountPage />
              </RequireRole>
            }
          />
          <Route
            path="/admin/staff"
            element={
              <RequireRole roles={ROLES.admin}>
                <StaffPage />
              </RequireRole>
            }
          />
          <Route
            path="/admin/audit"
            element={
              <RequireRole roles={ROLES.admin}>
                <AuditPage />
              </RequireRole>
            }
          />
        </Route>
        <Route path="*" element={<ShareRoute />} />
      </Routes>
    </Suspense>
  );
}
