import { useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';

import { accountRoleOf, ROLES, useAuth } from './auth.jsx';
import { t } from './i18n.js';
import { AccountsIcon, AuditIcon, PlansIcon, QueueIcon, SignOutIcon, StaffIcon, UploadIcon } from './icons.jsx';

/**
 * The prototype's web shell: a sidebar with a section per role the user
 * holds, the gym account being worked in, and who is signed in. Customers
 * see their plans; reviewers the queue; admins the queue and the admin
 * pages.
 *
 * The page area is keyed on the current account, so switching accounts
 * remounts it and every page loads that account's data afresh.
 */
export default function Layout() {
  const { user, accountId, signOut } = useAuth();
  const { pathname } = useLocation();
  const accountRole = accountRoleOf(user);
  const sections = [
    ROLES.customer.includes(accountRole) && {
      title: 'MY GYMS',
      links: [
        { to: '/plans', label: 'My plans', icon: PlansIcon },
        { to: '/upload', label: 'Upload a plan', icon: UploadIcon },
      ],
    },
    ROLES.review.includes(user.staffRole) && {
      title: 'REVIEWER',
      links: [{ to: '/review', label: 'Queue', icon: QueueIcon }],
    },
    ROLES.admin.includes(user.staffRole) && {
      title: 'ADMIN',
      links: [
        // Also lit on an account's own page, but not on the audit log.
        {
          to: '/admin',
          label: 'Accounts',
          icon: AccountsIcon,
          active: (path) => path === '/admin' || path.startsWith('/admin/accounts'),
        },
        { to: '/admin/staff', label: 'Staff', icon: StaffIcon },
        { to: '/admin/audit', label: 'Audit log', icon: AuditIcon },
      ],
    },
  ].filter(Boolean);

  const roleLine = [
    user.staffRole && t(`layout.staffRoles.${user.staffRole}`),
    accountRole && t(`layout.accountRoles.${accountRole}`),
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="rv-shell">
      <nav className="rv-sidebar" aria-label="Main">
        <div className="rv-brand">
          <div className="rv-wordmark">FLEX</div>
          <div className="rv-product">GYM SCAN</div>
        </div>
        <AccountSwitcher />
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
                <NavLink key={to} to={to} end className="rv-nav">
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
            {roleLine && <span className="rv-user-role">{roleLine}</span>}
          </span>
          <button type="button" className="rv-icon-button" onClick={signOut} title={t('layout.signOut')}>
            <SignOutIcon size={16} />
            <span className="sr-only">{t('layout.signOut')}</span>
          </button>
        </div>
      </nav>
      <main className="rv-main" key={accountId ?? 'none'}>
        <Outlet />
      </main>
    </div>
  );
}

/**
 * The gym account being worked in. Someone in one account sees its name;
 * someone in several can switch, which reloads every page's data for the
 * new account (X-Account-Id). A plan page belongs to one account, so
 * switching from one goes back to the plan list.
 */
export function AccountSwitcher() {
  const { user, accountId, switchAccount } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const accounts = user.accounts ?? [];
  if (accounts.length === 0) return null;
  const current = accounts.find((a) => a.id === accountId) ?? accounts[0];

  if (accounts.length === 1) {
    return (
      <div className="rv-account">
        <span className="rv-section">{t('layout.account').toUpperCase()}</span>
        <span className="rv-account-name">{current.name}</span>
      </div>
    );
  }

  async function change(e) {
    const id = e.target.value;
    setBusy(true);
    setError(null);
    try {
      await switchAccount(id);
      if (pathname.startsWith('/plans/') || pathname === '/upload') navigate('/plans');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rv-account">
      <span className="rv-section" aria-hidden="true">
        {t('layout.account').toUpperCase()}
      </span>
      <select
        id="account-switcher"
        className="rv-account-select"
        value={current.id}
        onChange={change}
        disabled={busy}
        aria-label={t('layout.switchAccount')}
      >
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      {error && (
        <p className="rv-error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
