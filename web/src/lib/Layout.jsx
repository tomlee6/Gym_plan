import { Link, NavLink, Outlet, useLocation } from 'react-router';

import { ROLES, useAuth } from './auth.jsx';
import { AccountsIcon, AuditIcon, PlansIcon, QueueIcon, SignOutIcon, UploadIcon } from './icons.jsx';

/**
 * The prototype's web shell: a sidebar with a section per role the user
 * holds, and who is signed in. Owners see their plans; reviewers the queue;
 * admins the queue and the admin pages.
 */
export default function Layout() {
  const { user, signOut } = useAuth();
  const { pathname } = useLocation();
  const sections = [
    ROLES.customer.includes(user.role) && {
      title: 'MY GYMS',
      links: [
        { to: '/plans', label: 'My plans', icon: PlansIcon },
        { to: '/upload', label: 'Upload a plan', icon: UploadIcon },
      ],
    },
    ROLES.review.includes(user.role) && {
      title: 'REVIEWER',
      links: [{ to: '/review', label: 'Queue', icon: QueueIcon }],
    },
    ROLES.admin.includes(user.role) && {
      title: 'ADMIN',
      links: [
        // Also lit on an account's own page, but not on the audit log.
        {
          to: '/admin',
          label: 'Accounts',
          icon: AccountsIcon,
          active: (path) => path === '/admin' || path.startsWith('/admin/accounts'),
        },
        { to: '/admin/audit', label: 'Audit log', icon: AuditIcon },
      ],
    },
  ].filter(Boolean);

  return (
    <div className="rv-shell">
      <nav className="rv-sidebar" aria-label="Main">
        <div className="rv-brand">
          <div className="rv-wordmark">FLEX</div>
          <div className="rv-product">GYM SCAN</div>
        </div>
        {sections.map((s) => (
          <div className="rv-nav-group" key={s.title}>
            <div className="rv-section">{s.title}</div>
            {s.links.map(({ to, label, icon: NavIcon, active }) =>
              active ? (
                <Link
                  key={to}
                  to={to}
                  className={`rv-nav ${active(pathname) ? 'active' : ''}`}
                  aria-current={active(pathname) ? 'page' : undefined}
                >
                  <NavIcon />
                  <span className="rv-nav-label">{label}</span>
                </Link>
              ) : (
                <NavLink key={to} to={to} className="rv-nav">
                  <NavIcon />
                  <span className="rv-nav-label">{label}</span>
                </NavLink>
              ),
            )}
          </div>
        ))}

        <div className="rv-user">
          <span className="rv-avatar" aria-hidden="true">
            {user.initials}
          </span>
          <span className="rv-user-text">
            <span className="rv-user-name">{user.name}</span>
            <span className="rv-user-role">
              {user.roleLabel} · {user.organisation}
            </span>
          </span>
          <button type="button" className="rv-icon-button" onClick={signOut} title="Sign out">
            <SignOutIcon size={16} />
            <span className="sr-only">Sign out</span>
          </button>
        </div>
      </nav>
      <div className="rv-main">
        <Outlet />
      </div>
    </div>
  );
}
