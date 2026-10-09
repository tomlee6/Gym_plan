import { useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { adminApi } from '../lib/client.js';
import { duration } from '../lib/format.js';
import { DownloadIcon, PlusIcon } from '../lib/icons.jsx';
import Modal from '../lib/Modal.jsx';
import { useLoader } from '../lib/useLoader.js';
import { useTitle } from '../lib/useTitle.js';
import { accountNote, auditFilename, isRemoved, isRemoving, MedianAgainst, QuotaBar, saveBlob } from './parts.jsx';
import './admin.css';

/**
 * Admin home (ACC-05): every account with its members, gyms and monthly quota
 * use, a way to create one, the audit log export, and reviewer time
 * (REV-10) for the operator.
 */
export default function AccountsPage() {
  useTitle('Accounts');
  const navigate = useNavigate();
  const { data, error, reload } = useLoader(adminApi.accounts, 'accounts');
  const [creating, setCreating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);

  async function exportLog() {
    setExporting(true);
    setExportError(null);
    try {
      saveBlob(await adminApi.auditCsv(), auditFilename());
    } catch (err) {
      setExportError(err.message);
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <header className="rv-header">
        <h1>Accounts</h1>
        <span className="spacer" />
        <div className="ad-actions">
          <button type="button" className="rv-button ghost" onClick={exportLog} disabled={exporting}>
            <DownloadIcon size={15} />
            {exporting ? 'Exporting…' : 'Export audit log'}
          </button>
          <button type="button" className="rv-button primary" onClick={() => setCreating(true)}>
            <PlusIcon size={15} />
            New account
          </button>
        </div>
      </header>

      <div className="rv-content">
        {exportError && (
          <p className="rv-error" role="alert">
            {exportError}
          </p>
        )}
        {!data && error ? (
          <div className="rv-empty">
            <h2>The accounts could not be loaded</h2>
            <p className="muted">{error.message}</p>
            <button type="button" className="rv-button primary" onClick={reload}>
              Try again
            </button>
          </div>
        ) : !data ? (
          <div className="rv-empty" role="status">
            <span className="rv-spinner" aria-hidden="true" />
            <p className="muted">Loading accounts…</p>
          </div>
        ) : (
          <AccountsTable accounts={data.accounts} />
        )}

        <ReviewerTime />
      </div>

      {creating && (
        <NewAccountDialog
          onCancel={() => setCreating(false)}
          onCreated={(account) => navigate(`/admin/accounts/${account.id}`)}
        />
      )}
    </>
  );
}

function AccountsTable({ accounts }) {
  if (!accounts.length) {
    return (
      <div className="rv-empty">
        <h2>No accounts yet</h2>
      </div>
    );
  }
  return (
    <div className="rv-table-wrap">
      <table className="rv-table">
        <thead>
          <tr>
            <th scope="col">ACCOUNT</th>
            <th scope="col">MEMBERS</th>
            <th scope="col">FACILITIES</th>
            <th scope="col">MONTHLY PLAN QUOTA</th>
            <th scope="col">DATA REGION</th>
            <th scope="col">
              <span className="sr-only">ACTION</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => {
            const gone = isRemoved(a) || isRemoving(a);
            return (
              <tr key={a.id} className={gone ? 'taken' : undefined}>
                <td data-label="Account">
                  <div className="rv-cell-title">{a.name}</div>
                  <div className="rv-cell-sub">{accountNote(a)}</div>
                </td>
                <td data-label="Members">{gone ? '—' : a.members}</td>
                <td data-label="Facilities">{gone ? '—' : a.facilities}</td>
                <td data-label="Monthly plan quota">
                  {gone ? <span className="muted">—</span> : <QuotaBar used={a.plansUsed} quota={a.planQuota} />}
                </td>
                <td data-label="Data region">{a.region}</td>
                <td className="rv-action">
                  <Link className="rv-button ghost" to={`/admin/accounts/${a.id}`} aria-label={`Manage ${a.name}`}>
                    Manage
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * B-09: a new account and its first owner. Nobody is given a password: the
 * owner gets an invite, and their GoalCert sign-in with that email address
 * (verified at the Hub) joins them to the account.
 */
function NewAccountDialog({ onCancel, onCreated }) {
  const [form, setForm] = useState({
    name: '',
    planQuota: '10',
    region: 'Australia (Sydney)',
    ownerEmail: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const quota = Number(form.planQuota);
  const valid =
    form.name.trim().length >= 2 && Number.isInteger(quota) && quota >= 0 && /\S+@\S+\.\S+/.test(form.ownerEmail);

  async function submit(e) {
    e?.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const account = await adminApi.createAccount({
        name: form.name.trim(),
        planQuota: quota,
        region: form.region.trim() || undefined,
        ownerEmail: form.ownerEmail.trim(),
      });
      onCreated(account);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New account"
      subtitle="A customer account. Its first owner is invited by email and joins by signing in with GoalCert."
      onClose={onCancel}
      busy={busy}
      footer={
        <>
          <button type="button" className="rv-button ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="rv-button primary" onClick={submit} disabled={busy || !valid}>
            {busy ? 'Creating…' : 'Create account'}
          </button>
        </>
      }
    >
      <form className="ad-form-grid" onSubmit={submit} noValidate>
        <label className="rv-field wide">
          <span>Account name</span>
          <input value={form.name} onChange={set('name')} required />
        </label>
        <label className="rv-field">
          <span>Monthly plan quota</span>
          <input type="number" min="0" step="1" inputMode="numeric" value={form.planQuota} onChange={set('planQuota')} />
        </label>
        <label className="rv-field">
          <span>Data region</span>
          <input value={form.region} onChange={set('region')} />
        </label>
        <label className="rv-field wide">
          <span>Owner’s email</span>
          <input
            type="email"
            value={form.ownerEmail}
            onChange={set('ownerEmail')}
            autoComplete="off"
            aria-describedby="new-account-owner-help"
          />
        </label>
        <p id="new-account-owner-help" className="small muted wide">
          The address they sign in to GoalCert with. They are invited as Owner &amp; Surveyor.
        </p>
        {/* Enter submits. */}
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

/** REV-10: each reviewer's median time this week, and the last eight weeks. */
function ReviewerTime() {
  const { data, error } = useLoader(adminApi.reviewers, 'reviewers');
  return (
    <section className="rv-card" aria-labelledby="reviewer-time-title">
      <div className="ad-section-title">
        <h2 id="reviewer-time-title">Reviewer time</h2>
        {data && (
          <span className="small muted">
            Median per plan, idle over 10 min excluded · targets {data.targets.scanSeconds / 60} min for scans,{' '}
            {data.targets.uploadSeconds / 60} min for uploads
          </span>
        )}
      </div>
      {error ? (
        <p className="rv-error">{error.message}</p>
      ) : !data ? (
        <p className="muted small">Loading…</p>
      ) : data.reviewers.length === 0 ? (
        <p className="muted small">No reviewers yet.</p>
      ) : (
        <div className="rv-table-wrap" style={{ marginTop: 12 }}>
          <table className="rv-table">
            <thead>
              <tr>
                <th scope="col">REVIEWER</th>
                <th scope="col">THIS WEEK</th>
                <th scope="col">MEDIAN, SCANS</th>
                <th scope="col">MEDIAN, UPLOADS</th>
                <th scope="col">LAST 8 WEEKS</th>
              </tr>
            </thead>
            <tbody>
              {data.reviewers.map((r) => (
                <tr key={r.id} className={r.active ? undefined : 'taken'}>
                  <td data-label="Reviewer">
                    <div className="rv-cell-title">{r.name}</div>
                    <div className="rv-cell-sub">
                      {r.roleLabel}
                      {!r.active && ' · removed'}
                    </div>
                  </td>
                  <td data-label="This week">
                    {r.thisWeek.reviews} review{r.thisWeek.reviews === 1 ? '' : 's'}
                    {r.thisWeek.medianSeconds != null && <span className="muted"> · {duration(r.thisWeek.medianSeconds)}</span>}
                  </td>
                  <td data-label="Median, scans">
                    <MedianAgainst seconds={r.thisWeek.scanMedianSeconds} target={data.targets.scanSeconds} />
                  </td>
                  <td data-label="Median, uploads">
                    <MedianAgainst seconds={r.thisWeek.uploadMedianSeconds} target={data.targets.uploadSeconds} />
                  </td>
                  <td data-label="Last 8 weeks">
                    <WeekBars weeks={r.weeks} target={data.targets.scanSeconds} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Eight small bars, oldest first; orange where the median missed the target. */
function WeekBars({ weeks, target }) {
  const max = Math.max(target, ...weeks.map((w) => w.medianSeconds ?? 0));
  const summary = weeks
    .map((w) => `${w.weeksAgo === 0 ? 'this week' : `${w.weeksAgo} week${w.weeksAgo > 1 ? 's' : ''} ago`}: ${w.medianSeconds == null ? 'no reviews' : duration(w.medianSeconds)}`)
    .join('; ');
  return (
    <span className="ad-weeks" role="img" aria-label={`Weekly median review time, ${summary}`}>
      {weeks.map((w) =>
        w.medianSeconds == null ? (
          <span key={w.weeksAgo} className="none" title={`${w.weeksAgo} weeks ago: no reviews`} />
        ) : (
          <span
            key={w.weeksAgo}
            className={w.medianSeconds > target ? 'over' : undefined}
            style={{ height: `${Math.max(8, (w.medianSeconds / max) * 100)}%` }}
            title={`${w.weeksAgo === 0 ? 'This week' : `${w.weeksAgo} weeks ago`}: ${duration(w.medianSeconds)} (${w.reviews})`}
          />
        ),
      )}
    </span>
  );
}
