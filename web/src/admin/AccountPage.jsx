import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';

import { useAuth } from '../lib/auth.jsx';
import { adminApi } from '../lib/client.js';
import { date } from '../lib/format.js';
import { AuditIcon, BackIcon, PlusIcon } from '../lib/icons.jsx';
import Modal from '../lib/Modal.jsx';
import { useLoader } from '../lib/useLoader.js';
import { useTitle } from '../lib/useTitle.js';
import { accountNote, isRemoved, isRemoving, QuotaBar } from './parts.jsx';
import './admin.css';

/** The roles a person can hold in a gym account (api-contract-v2 section 2). */
export const ACCOUNT_ROLES = [
  ['owner', 'Owner & Surveyor'],
  ['surveyor', 'Surveyor'],
];

const roleLabel = (role) => ACCOUNT_ROLES.find(([value]) => value === role)?.[1] ?? role;

/**
 * One account (ACC-05, ACC-07, B-09): its name and monthly quota, who is in
 * it and with what role, open invites, gyms, and removing its data.
 *
 * People join by invite only. An invite names an email address and a role;
 * whoever signs in with GoalCert under that verified address takes it up.
 * Nobody here is ever given a password.
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
        <Link className="rv-button ghost" to={`/admin/audit?accountId=${encodeURIComponent(a.id)}`}>
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
            <div className="rv-empty" role="alert">
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
  const gone = isRemoved(a) || isRemoving(a);

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
            <MembersCard account={a} onChanged={done} />
            {!gone && <InvitesCard account={a} onChanged={done} />}
            {!gone && <FacilitiesCard account={a} onChanged={done} />}
          </div>
          <div className="ad-stack">
            {!gone && <DetailsCard account={a} onChanged={done} />}
            <RemovalCard account={a} onStarted={done} />
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
  const changed = name.trim() !== a.name || q !== a.planQuota;
  const valid = name.trim().length >= 2 && Number.isInteger(q) && q >= 0 && q <= 10000;

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {};
      if (name.trim() !== a.name) body.name = name.trim();
      if (q !== a.planQuota) body.planQuota = q;
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
      <h2 className="eyebrow" id="details-title">
        ACCOUNT
      </h2>
      <form className="ad-stack" onSubmit={save} noValidate>
        <label className="rv-field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
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

/** Who is in the account: change a role, or take someone out of it. */
function MembersCard({ account: a, onChanged }) {
  const { user: me } = useAuth();
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const members = a.members ?? [];
  const gone = isRemoved(a) || isRemoving(a);

  async function changeRole(m, role) {
    setBusy(m.userId);
    setError(null);
    try {
      await adminApi.setMemberRole(a.id, m.userId, role);
      onChanged(`${m.name ?? m.email} is now ${roleLabel(role)}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rv-card" aria-labelledby="members-title">
      <div className="rv-card-head">
        <h2 className="eyebrow" id="members-title">
          MEMBERS · {members.length}
        </h2>
      </div>
      {members.length === 0 ? (
        <p className="muted small">
          {gone ? 'The members were removed with the account’s data.' : 'Nobody has joined yet. Invite the owner below.'}
        </p>
      ) : (
        <div className="rv-table-wrap">
          <table className="rv-table">
            <thead>
              <tr>
                <th scope="col">NAME</th>
                <th scope="col">ROLE</th>
                <th scope="col">
                  <span className="sr-only">ACTION</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.userId} className={m.status && m.status !== 'active' ? 'taken' : undefined}>
                  <td data-label="Name">
                    <div className="rv-cell-title">{m.name ?? m.email}</div>
                    <div className="rv-cell-sub">
                      {m.email}
                      {m.status && m.status !== 'active' ? ` · ${m.status}` : ''}
                    </div>
                  </td>
                  <td data-label="Role">
                    {gone ? (
                      roleLabel(m.role)
                    ) : (
                      <select
                        className="ad-role-select"
                        value={m.role}
                        disabled={busy === m.userId}
                        onChange={(e) => changeRole(m, e.target.value)}
                        aria-label={`Role of ${m.name ?? m.email}`}
                      >
                        {ACCOUNT_ROLES.map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="rv-action">
                    {!gone && m.userId !== me?.id && (
                      <button
                        type="button"
                        className="rv-button danger-ghost"
                        onClick={() => setRemoving(m)}
                        aria-label={`Remove ${m.name ?? m.email}`}
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
      {error && (
        <p className="rv-error" role="alert" style={{ marginTop: 10 }}>
          {error}
        </p>
      )}
      {removing && (
        <RemoveMemberDialog
          account={a}
          member={removing}
          onCancel={() => setRemoving(null)}
          onRemoved={() => {
            setRemoving(null);
            onChanged(`${removing.name ?? removing.email} was removed from ${a.name}.`);
          }}
        />
      )}
    </section>
  );
}

function RemoveMemberDialog({ account: a, member, onCancel, onRemoved }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const name = member.name ?? member.email;

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await adminApi.removeMember(a.id, member.userId);
      onRemoved();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Remove ${name}?`}
      subtitle={member.email}
      onClose={onCancel}
      busy={busy}
      footer={
        <>
          <button type="button" className="rv-button ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="rv-button danger" onClick={confirm} disabled={busy}>
            {busy ? 'Removing…' : 'Remove from account'}
          </button>
        </>
      }
    >
      <p className="small muted">
        They lose access to {a.name}’s plans straight away. Their sign-in and any other gym accounts they
        belong to are not affected. What they captured stays attributed to them.
      </p>
      {error && (
        <p className="rv-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}

/**
 * B-09: invite someone by email with a role. Open invites are listed until
 * taken up or revoked; the backend refuses a second open invite for the
 * same address (409) and its message is shown as is.
 */
function InvitesCard({ account: a, onChanged }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('surveyor');
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState(null);
  const [error, setError] = useState(null);
  const invites = a.invites ?? [];
  const valid = /\S+@\S+\.\S+/.test(email.trim());

  async function invite(e) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const address = email.trim();
      await adminApi.invite(a.id, { email: address, role });
      setEmail('');
      onChanged(`${address} was invited as ${roleLabel(role)}.`);
    } catch (err) {
      setError(err.status === 409 && !err.body?.message ? `${email.trim()} already has an open invite.` : err.message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(inv) {
    setRevoking(inv.id);
    setError(null);
    try {
      await adminApi.revokeInvite(a.id, inv.id);
      onChanged(`The invite for ${inv.email} was revoked.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setRevoking(null);
    }
  }

  return (
    <section className="rv-card" aria-labelledby="invites-title">
      <h2 className="eyebrow" id="invites-title">
        INVITES · {invites.length} OPEN
      </h2>
      {invites.length === 0 ? (
        <p className="muted small">No open invites.</p>
      ) : (
        <ul className="ad-list" aria-label="Open invites">
          {invites.map((inv) => (
            <li key={inv.id}>
              <span>
                {inv.email}
                <span className="muted small">
                  {' '}
                  · {roleLabel(inv.role)}
                  {inv.expiresAt ? ` · expires ${date(inv.expiresAt)}` : ''}
                </span>
              </span>
              <button
                type="button"
                className="rv-button danger-ghost small"
                onClick={() => revoke(inv)}
                disabled={revoking === inv.id}
                aria-label={`Revoke the invite for ${inv.email}`}
              >
                {revoking === inv.id ? 'Revoking…' : 'Revoke'}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="ad-inline-form" onSubmit={invite} style={{ marginTop: 12 }} noValidate>
        <label className="rv-field">
          <span>Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
        </label>
        <label className="rv-field">
          <span>Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {ACCOUNT_ROLES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="rv-button ghost" disabled={busy || !valid}>
          <PlusIcon size={15} />
          {busy ? 'Inviting…' : 'Send invite'}
        </button>
      </form>
      <p className="small muted" style={{ marginTop: 8 }}>
        They get an email with a temporary password and join by signing in with this email address.
      </p>
      {error && (
        <p className="rv-error" role="alert" style={{ marginTop: 10 }}>
          {error}
        </p>
      )}
    </section>
  );
}

function FacilitiesCard({ account: a, onChanged }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const facilities = a.facilities ?? [];

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
      <h2 className="eyebrow" id="facilities-title">
        FACILITIES · {facilities.length}
      </h2>
      {facilities.length === 0 ? (
        <p className="muted small">No gyms yet. Add one so the account can capture it.</p>
      ) : (
        <ul className="ad-list">
          {facilities.map((f) => (
            <li key={f.id}>
              <span>{f.name}</span>
              {f.levels != null && (
                <span className="muted">
                  {f.levels} level{f.levels === 1 ? '' : 's'}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
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
      {error && (
        <p className="rv-error" role="alert" style={{ marginTop: 10 }}>
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * ACC-07: delete plans, scans, models and files; keep the log by id only.
 * Removal is a background job (202 {jobId}): the page says it has started
 * and finishes on its own, rather than waiting for every file to go.
 */
function RemovalCard({ account: a, onStarted }) {
  const [confirming, setConfirming] = useState(false);
  const [jobId, setJobId] = useState(null);

  if (isRemoved(a)) {
    return (
      <section className="rv-card ad-danger" aria-labelledby="removal-title">
        <h2 className="eyebrow" id="removal-title">
          ACCOUNT DATA REMOVED
        </h2>
        <p>
          Removed{a.removedAt ? ` on ${date(a.removedAt)}` : ''}. Plans, scans, models, files and memberships are gone.
          The audit log keeps this account’s entries with identifiers only.
        </p>
      </section>
    );
  }

  if (isRemoving(a) || jobId) {
    return (
      <section className="rv-card ad-danger" aria-labelledby="removal-title">
        <h2 className="eyebrow" id="removal-title">
          REMOVAL STARTED
        </h2>
        <p role="status">
          Removal started. It completes in the background; this page shows the account as removed once every plan,
          scan and file is gone.
        </p>
        {jobId && <p className="small muted">Job {jobId}</p>}
      </section>
    );
  }

  return (
    <section className="rv-card ad-danger" aria-labelledby="removal-title">
      <h2 className="eyebrow" id="removal-title">
        REMOVE ACCOUNT DATA
      </h2>
      <p>
        Deletes every plan, scan, model and file, and ends every membership. The audit log is kept with identifiers
        only, so approvals stay attributable. This cannot be undone.
      </p>
      <button type="button" className="rv-button danger-ghost" onClick={() => setConfirming(true)}>
        Remove account data…
      </button>
      {confirming && (
        <RemovalDialog
          account={a}
          onCancel={() => setConfirming(false)}
          onStarted={(res) => {
            setConfirming(false);
            setJobId(res?.jobId ?? 'started');
            onStarted('Removal started. It completes in the background.');
          }}
        />
      )}
    </section>
  );
}

function RemovalDialog({ account: a, onCancel, onStarted }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const matches = typed.trim() === a.name;
  const facilities = a.facilities?.length ?? 0;
  const members = a.members?.length ?? 0;

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      onStarted(await adminApi.removeData(a.id, typed.trim()));
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
            {busy ? 'Starting…' : 'Remove everything'}
          </button>
        </>
      }
    >
      <p className="small muted">
        {facilities} facilit{facilities === 1 ? 'y' : 'ies'} and {members} member{members === 1 ? '' : 's'} will be
        removed with every plan, scan and file. The audit log is kept with identifiers only.
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
