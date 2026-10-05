import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';

import { useAuth } from '../lib/auth.jsx';
import { adminApi } from '../lib/client.js';
import { date } from '../lib/format.js';
import { AuditIcon, BackIcon, PlusIcon } from '../lib/icons.jsx';
import Modal from '../lib/Modal.jsx';
import { useLoader } from '../lib/useLoader.js';
import { useTitle } from '../lib/useTitle.js';
import { accountNote, QuotaBar } from './parts.jsx';
import './admin.css';

/**
 * One account (ACC-05, ACC-07): its name and monthly quota, users, gyms,
 * and removing its data on request. In this response `users` is the list of
 * users, not the count.
 */
export default function AccountPage() {
  const { id } = useParams();
  const { data: a, error, reload } = useLoader(() => adminApi.account(id), id);
  const [notice, setNotice] = useState(null);
  useTitle(a ? a.name : 'Account');

  const header = (
    <header className="rv-header">
      <Link to="/admin" className="rv-back">
        <BackIcon size={16} />
        Accounts
      </Link>
      <h1>{a ? a.name : 'Account'}</h1>
      <span className="spacer" />
      {a && (
        <Link className="rv-button ghost" to={`/admin/audit?orgId=${encodeURIComponent(a.id)}`}>
          <AuditIcon size={15} />
          Account audit log
        </Link>
      )}
    </header>
  );

  if (!a) {
    return (
      <>
        {header}
        <div className="rv-content">
          {error ? (
            <div className="rv-empty">
              <h2>{error.status === 404 ? 'This account does not exist' : 'The account could not be loaded'}</h2>
              <p className="muted">{error.message}</p>
              {error.status !== 404 && (
                <button type="button" className="rv-button primary" onClick={reload}>
                  Try again
                </button>
              )}
            </div>
          ) : (
            <div className="rv-empty" role="status">
              <span className="rv-spinner" aria-hidden="true" />
              <p className="muted">Loading the account…</p>
            </div>
          )}
        </div>
      </>
    );
  }

  const done = (message) => {
    setNotice(message);
    reload();
  };

  return (
    <>
      {header}
      <div className="rv-content">
        <p className="rv-subtitle muted">
          {accountNote(a)} · {a.region}
        </p>
        {notice && (
          <p className="rv-notice" role="status">
            {notice}
          </p>
        )}
        <div className="ad-grid">
          <div className="ad-stack">
            <UsersCard account={a} onChanged={done} />
            {!a.operator && !a.dataRemovedAt && <FacilitiesCard account={a} onChanged={done} />}
          </div>
          <div className="ad-stack">
            {!a.dataRemovedAt && <DetailsCard account={a} onChanged={done} />}
            <RemovalCard account={a} onRemoved={done} />
          </div>
        </div>
      </div>
    </>
  );
}

function DetailsCard({ account: a, onChanged }) {
  const [name, setName] = useState(a.name);
  const [quota, setQuota] = useState(String(a.planQuota));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    setName(a.name);
    setQuota(String(a.planQuota));
  }, [a.name, a.planQuota]);

  const q = Number(quota);
  const changed = name.trim() !== a.name || (!a.operator && q !== a.planQuota);
  const valid = name.trim().length >= 2 && Number.isInteger(q) && q >= 0 && q <= 10000;

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {};
      if (name.trim() !== a.name) body.name = name.trim();
      if (!a.operator && q !== a.planQuota) body.planQuota = q;
      await adminApi.updateAccount(a.id, body);
      onChanged('Account saved.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rv-card" aria-labelledby="details-title">
      <div className="eyebrow" id="details-title">
        ACCOUNT
      </div>
      <form className="ad-stack" onSubmit={save} noValidate>
        <label className="rv-field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {!a.operator && (
          <>
            <label className="rv-field">
              <span>Monthly plan quota</span>
              <input
                type="number"
                min="0"
                step="1"
                inputMode="numeric"
                value={quota}
                onChange={(e) => setQuota(e.target.value)}
                aria-describedby="quota-use"
              />
            </label>
            <div id="quota-use" className="small">
              <span className="muted">Used this month: </span>
              <QuotaBar used={a.plansUsed} quota={a.planQuota} />
            </div>
          </>
        )}
        {error && (
          <p className="rv-error" role="alert">
            {error}
          </p>
        )}
        <div>
          <button type="submit" className="rv-button primary" disabled={busy || !changed || !valid}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </section>
  );
}

function UsersCard({ account: a, onChanged }) {
  const { user: me } = useAuth();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(null);
  const users = a.users ?? [];
  const active = users.filter((u) => u.active).length;
  const removed = Boolean(a.dataRemovedAt);

  return (
    <section className="rv-card" aria-labelledby="users-title">
      <div className="rv-card-head">
        <div className="eyebrow" id="users-title">
          USERS · {active} ACTIVE
        </div>
        {!removed && (
          <button type="button" className="rv-button ghost" onClick={() => setAdding(true)}>
            <PlusIcon size={15} />
            Add user
          </button>
        )}
      </div>
      {users.length === 0 ? (
        <p className="muted small">{removed ? 'The users were removed with the account’s data.' : 'No users yet.'}</p>
      ) : (
        <div className="rv-table-wrap">
          <table className="rv-table">
            <thead>
              <tr>
                <th scope="col">NAME</th>
                <th scope="col">ROLE</th>
                <th scope="col">STATUS</th>
                <th scope="col">
                  <span className="sr-only">ACTION</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className={u.active ? undefined : 'taken'}>
                  <td data-label="Name">
                    <div className="rv-cell-title">{u.name}</div>
                    <div className="rv-cell-sub">{u.email}</div>
                  </td>
                  <td data-label="Role">{u.roleLabel}</td>
                  <td data-label="Status">{u.active ? 'Active' : 'Removed'}</td>
                  <td className="rv-action">
                    {u.active && u.id !== me?.id && (
                      <button
                        type="button"
                        className="rv-button danger-ghost"
                        onClick={() => setRemoving(u)}
                        aria-label={`Remove ${u.name}`}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && (
        <AddUserDialog
          account={a}
          onCancel={() => setAdding(false)}
          onAdded={(name) => {
            setAdding(false);
            onChanged(`${name} was added.`);
          }}
        />
      )}
      {removing && (
        <RemoveUserDialog
          account={a}
          user={removing}
          onCancel={() => setRemoving(null)}
          onRemoved={() => {
            setRemoving(null);
            onChanged(`${removing.name} was removed. Their sessions have ended.`);
          }}
        />
      )}
    </section>
  );
}

const ROLE_OPTIONS = {
  customer: [
    ['owner', 'Owner & Surveyor'],
    ['surveyor', 'Surveyor'],
  ],
  operator: [
    ['reviewer', 'Reviewer'],
    ['admin', 'Platform admin'],
  ],
};

function AddUserDialog({ account: a, onCancel, onAdded }) {
  const roles = a.operator ? ROLE_OPTIONS.operator : ROLE_OPTIONS.customer;
  const [form, setForm] = useState({ name: '', email: '', role: roles[0][0], password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const valid = form.name.trim().length >= 2 && /\S+@\S+\.\S+/.test(form.email) && form.password.length >= 8;

  async function submit(e) {
    e?.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await adminApi.addUser(a.id, { ...form, name: form.name.trim(), email: form.email.trim() });
      onAdded(form.name.trim());
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add user"
      subtitle={a.name}
      onClose={onCancel}
      busy={busy}
      footer={
        <>
          <button type="button" className="rv-button ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="rv-button primary" onClick={submit} disabled={busy || !valid}>
            {busy ? 'Adding…' : 'Add user'}
          </button>
        </>
      }
    >
      <form className="ad-form-grid" onSubmit={submit} noValidate>
        <label className="rv-field wide">
          <span>Name</span>
          <input value={form.name} onChange={set('name')} autoComplete="off" />
        </label>
        <label className="rv-field wide">
          <span>Email</span>
          <input type="email" value={form.email} onChange={set('email')} autoComplete="off" />
        </label>
        <label className="rv-field">
          <span>Role</span>
          <select value={form.role} onChange={set('role')}>
            {roles.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="rv-field">
          <span>Temporary password</span>
          <input
            type="password"
            value={form.password}
            onChange={set('password')}
            autoComplete="new-password"
            aria-describedby="add-user-password-help"
          />
        </label>
        <p id="add-user-password-help" className="small muted wide">
          At least 8 characters.
        </p>
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
      {error && (
        <p className="rv-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}

function RemoveUserDialog({ account: a, user, onCancel, onRemoved }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await adminApi.removeUser(a.id, user.id);
      onRemoved();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Remove ${user.name}?`}
      subtitle={user.email}
      onClose={onCancel}
      busy={busy}
      footer={
        <>
          <button type="button" className="rv-button ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="rv-button danger" onClick={confirm} disabled={busy}>
            {busy ? 'Removing…' : 'Remove user'}
          </button>
        </>
      }
    >
      <p className="small muted">
        They can no longer sign in to the app or the web, and their current sessions end. What they captured
        or approved stays attributed to them.
      </p>
      {error && (
        <p className="rv-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}

function FacilitiesCard({ account: a, onChanged }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const removed = Boolean(a.dataRemovedAt);

  async function add(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await adminApi.addFacility(a.id, name.trim());
      const added = name.trim();
      setName('');
      onChanged(`${added} was added.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rv-card" aria-labelledby="facilities-title">
      <div className="eyebrow" id="facilities-title">
        FACILITIES · {a.facilities.length}
      </div>
      {a.facilities.length === 0 ? (
        <p className="muted small">No gyms yet. Add one so the account can capture it.</p>
      ) : (
        <ul className="ad-list">
          {a.facilities.map((f) => (
            <li key={f.id}>
              <span>{f.name}</span>
              <span className="muted">
                {f.levels} level{f.levels === 1 ? '' : 's'}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!removed && (
        <form className="ad-inline-form" onSubmit={add} style={{ marginTop: 12 }}>
          <label className="rv-field">
            <span>New facility</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Kestrel Fitzroy" />
          </label>
          <button type="submit" className="rv-button ghost" disabled={busy || name.trim().length < 2}>
            <PlusIcon size={15} />
            {busy ? 'Adding…' : 'Add facility'}
          </button>
        </form>
      )}
      {error && (
        <p className="rv-error" role="alert" style={{ marginTop: 10 }}>
          {error}
        </p>
      )}
    </section>
  );
}

const TALLY = [
  ['plans', 'plans'],
  ['versions', 'versions'],
  ['captures', 'captures'],
  ['files', 'files'],
  ['users', 'users'],
];

/** ACC-07: delete plans, scans, models and files; keep the log by id only. */
function RemovalCard({ account: a, onRemoved }) {
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState(null);

  if (a.dataRemovedAt) {
    return (
      <section className="rv-card ad-danger" aria-labelledby="removal-title">
        <div className="eyebrow" id="removal-title">
          ACCOUNT DATA REMOVED
        </div>
        <p>
          Removed on {date(a.dataRemovedAt)}. Plans, scans, models, files and users are gone. The audit log keeps
          this account’s entries with identifiers only.
        </p>
        {result && <Tally result={result} />}
      </section>
    );
  }

  return (
    <section className="rv-card ad-danger" aria-labelledby="removal-title">
      <div className="eyebrow" id="removal-title">
        REMOVE ACCOUNT DATA
      </div>
      {a.operator ? (
        <p>The operator account holds Flex staff, not customer data, and cannot be removed.</p>
      ) : (
        <>
          <p>
            Deletes every plan, scan, model and file, and removes the account’s users. The audit log is kept with
            identifiers only, so approvals stay attributable. This cannot be undone.
          </p>
          <button type="button" className="rv-button danger-ghost" onClick={() => setConfirming(true)}>
            Remove account data…
          </button>
        </>
      )}
      {confirming && (
        <RemovalDialog
          account={a}
          onCancel={() => setConfirming(false)}
          onRemoved={(res) => {
            setConfirming(false);
            setResult(res);
            onRemoved('The account’s data was removed.');
          }}
        />
      )}
    </section>
  );
}

function Tally({ result }) {
  return (
    <>
      <p className="ad-tally-title">Deleted</p>
      <div className="ad-tally">
        {TALLY.map(([key, label]) => (
          <div key={key}>
            <strong>{result.removed[key]}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>
      {result.filesNotDeleted > 0 && (
        <p className="rv-error" style={{ marginTop: 10 }}>
          {result.filesNotDeleted} stored file(s) could not be deleted and are listed in the server log.
        </p>
      )}
    </>
  );
}

function RemovalDialog({ account: a, onCancel, onRemoved }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const matches = typed.trim() === a.name;

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      onRemoved(await adminApi.removeData(a.id, typed.trim()));
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Remove account data"
      subtitle={a.name}
      onClose={onCancel}
      busy={busy}
      footer={
        <>
          <button type="button" className="rv-button ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="rv-button danger" onClick={confirm} disabled={busy || !matches}>
            {busy ? 'Removing…' : 'Remove everything'}
          </button>
        </>
      }
    >
      <p className="small muted">
        {a.facilities.length} facilit{a.facilities.length === 1 ? 'y' : 'ies'} and {a.users.length} user
        {a.users.length === 1 ? '' : 's'} will be deleted with every plan, scan and file. The audit log is kept with
        identifiers only.
      </p>
      <label className="rv-field">
        <span>
          Type <strong>{a.name}</strong> to confirm
        </span>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
      </label>
      {error && (
        <p className="rv-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
