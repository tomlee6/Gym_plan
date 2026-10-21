import { useState } from 'react';

import { useAuth } from '../lib/auth.jsx';
import { adminApi } from '../lib/client.js';
import { useLoader } from '../lib/useLoader.js';
import { useTitle } from '../lib/useTitle.js';
import './admin.css';

/** Flex staff roles (api-contract-v2 section 2). None means not staff. */
export const STAFF_ROLES = [
  ['reviewer', 'Reviewer'],
  ['admin', 'Platform admin'],
];

const staffLabel = (role) => STAFF_ROLES.find(([v]) => v === role)?.[1] ?? 'Not staff';

/**
 * Flex staff (B-09, /admin/staff): who reviews plans and who runs the
 * platform. Staff see every account through the review and admin pages, so
 * the role is granted here, to someone who has already signed in with
 * GoalCert, and never through an account invite.
 *
 * An admin cannot change their own role, so the last admin cannot lock
 * everyone out by accident.
 */
export default function StaffPage() {
  useTitle('Staff');
  const { user: me } = useAuth();
  const { data, error, reload } = useLoader(adminApi.staff, 'staff');
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);
  const [actionError, setActionError] = useState(null);

  async function setRole(person, staffRole) {
    setBusy(person.id);
    setActionError(null);
    try {
      await adminApi.setStaffRole(person.id, staffRole);
      setNotice(
        staffRole
          ? `${person.name ?? person.email} is now ${staffLabel(staffRole)}.`
          : `${person.name ?? person.email} is no longer Flex staff.`,
      );
      await reload();
    } catch (err) {
      setActionError(err.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <header className="rv-header">
        <h1>Staff</h1>
        <span className="muted small">Reviewers and platform admins</span>
      </header>
      <div className="rv-content">
        {notice && (
          <p className="rv-notice" role="status">
            {notice}
          </p>
        )}
        {actionError && (
          <p className="rv-error" role="alert">
            {actionError}
          </p>
        )}
        {!data && error ? (
          <div className="rv-empty" role="alert">
            <h2>Staff could not be loaded</h2>
            <p className="muted">{error.message}</p>
            <button type="button" className="rv-button primary" onClick={reload}>
              Try again
            </button>
          </div>
        ) : !data ? (
          <div className="rv-empty" role="status">
            <span className="rv-spinner" aria-hidden="true" />
            <p className="muted">Loading staff…</p>
          </div>
        ) : (
          <>
            <StaffTable staff={data.staff} me={me} busy={busy} onRole={setRole} />
            <AddStaff staff={data.staff} users={data.users ?? []} busy={busy !== null} onAdd={setRole} />
          </>
        )}
      </div>
    </>
  );
}

function StaffTable({ staff, me, busy, onRole }) {
  if (!staff.length) {
    return (
      <div className="rv-empty">
        <h2>No staff yet</h2>
      </div>
    );
  }
  return (
    <div className="rv-table-wrap">
      <table className="rv-table" aria-label="Flex staff">
        <thead>
          <tr>
            <th scope="col">NAME</th>
            <th scope="col">STAFF ROLE</th>
            <th scope="col">STATUS</th>
            <th scope="col">
              <span className="sr-only">ACTION</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {staff.map((s) => {
            const self = s.id === me?.id;
            const name = s.name ?? s.email;
            return (
              <tr key={s.id}>
                <td data-label="Name">
                  <div className="rv-cell-title">
                    {name}
                    {self && <span className="rv-chip">You</span>}
                  </div>
                  <div className="rv-cell-sub">{s.email}</div>
                </td>
                <td data-label="Staff role">
                  {self ? (
                    staffLabel(s.staffRole)
                  ) : (
                    <select
                      className="ad-role-select"
                      value={s.staffRole}
                      disabled={busy === s.id}
                      onChange={(e) => onRole(s, e.target.value)}
                      aria-label={`Staff role of ${name}`}
                    >
                      {STAFF_ROLES.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td data-label="Status">{s.status === 'disabled' ? 'Disabled' : 'Active'}</td>
                <td className="rv-action">
                  {!self && (
                    <button
                      type="button"
                      className="rv-button danger-ghost"
                      disabled={busy === s.id}
                      onClick={() => onRole(s, null)}
                      aria-label={`Remove ${name} from staff`}
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Grants a staff role to someone who has signed in but is not staff yet. */
function AddStaff({ staff, users, busy, onAdd }) {
  const staffIds = new Set(staff.map((s) => s.id));
  const candidates = users.filter((u) => !staffIds.has(u.id));
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState('reviewer');
  const person = candidates.find((u) => u.id === userId);

  return (
    <section className="rv-card" aria-labelledby="add-staff-title" style={{ marginTop: 16 }}>
      <h2 className="eyebrow" id="add-staff-title">
        ADD STAFF
      </h2>
      {candidates.length === 0 ? (
        <p className="muted small">Everyone who has signed in is already staff. A person must sign in once before they can be made staff.</p>
      ) : (
        <form
          className="ad-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (person) {
              onAdd(person, role);
              setUserId('');
            }
          }}
        >
          <label className="rv-field">
            <span>Person</span>
            <select value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Choose someone…</option>
              {candidates.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name ? `${u.name} (${u.email})` : u.email}
                </option>
              ))}
            </select>
          </label>
          <label className="rv-field">
            <span>Staff role</span>
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              {STAFF_ROLES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="rv-button ghost" disabled={busy || !person}>
            Make staff
          </button>
        </form>
      )}
    </section>
  );
}
