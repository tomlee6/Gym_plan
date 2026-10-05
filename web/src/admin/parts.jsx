/** Small pieces shared by the admin pages. */
import { date, duration } from '../lib/format.js';

/** Saves a Blob as a file, as the browser's own download would. */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function auditFilename() {
  return `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
}

/** Teal under 85 %, orange from 85 %, red once the quota is used up. */
export function quotaTone(used, quota) {
  if (quota <= 0 || used >= quota) return 'full';
  return used / quota >= 0.85 ? 'near' : 'ok';
}

/** "6 of 10" with a bar, as the prototype shows monthly quota. */
export function QuotaBar({ used, quota }) {
  const tone = quotaTone(used, quota);
  const pct = quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 100;
  return (
    <span className={`ad-quota ${tone}`}>
      <span className="ad-quota-text">
        {used} of {quota}
        {tone === 'full' && <span className="sr-only"> (used up)</span>}
      </span>
      <span
        className="ad-quota-bar"
        role="meter"
        aria-label="Monthly plans used"
        aria-valuemin={0}
        aria-valuemax={quota}
        aria-valuenow={Math.min(used, quota)}
      >
        <span style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

/** "Customer since Feb 2026", the operator account, or a removed one. */
export function accountNote(a) {
  if (a.dataRemovedAt) return `Data removed ${date(a.dataRemovedAt)}`;
  if (a.operator) return 'Operator account · Flex staff';
  const d = date(a.createdAt);
  return d ? `Customer since ${d.split(' ').slice(1).join(' ')}` : 'Customer';
}

const ACTION_TONES = {
  APPROVED: 'good',
  REJECTED: 'bad',
  ACCOUNT_DATA_REMOVED: 'bad',
  USER_REMOVED: 'bad',
  SHARE_LINK_REVOKED: 'bad',
  CLAIMED: 'info',
  CORRECTED: 'info',
  RELEASED: 'info',
  REVISED: 'info',
  SUPERSEDED: 'muted',
};

export function ActionPill({ action }) {
  return <span className={`ad-action ${ACTION_TONES[action] ?? 'accent'}`}>{action.replaceAll('_', ' ')}</span>;
}

/** One short line for an entry's detail. */
export function detailText(e) {
  const d = e.detail;
  if (!d) return '';
  if (e.action === 'QUOTA_CHANGED') return `Quota ${d.from} → ${d.to}`;
  if (e.action === 'ACCOUNT_RENAMED') return `Was “${d.from}”`;
  if (e.action === 'ACCOUNT_CREATED') return `Quota ${d.planQuota}`;
  if (e.action === 'USER_ADDED') return `Role ${d.role}`;
  if (e.action === 'REJECTED') return d.reason ?? '';
  if (e.action === 'APPROVED' && d.contentHash) return `Hash ${d.contentHash.slice(0, 8)}…${d.contentHash.slice(-4)}`;
  if (e.action === 'SUPERSEDED') return `By version ${d.by}`;
  if (e.action === 'REVISED') return `From version ${d.from}`;
  if (e.action === 'CAPTURED') return d.input ? `Input ${d.input}` : '';
  if (e.action === 'PLAN_PRODUCED') return `${d.walls ?? 0} walls, ${d.flags ?? 0} flags`;
  if (e.action === 'ACCOUNT_DATA_REMOVED') {
    return `${d.plans} plans, ${d.versions} versions, ${d.files} files, ${d.users} users`;
  }
  return Object.entries(d)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(', ');
}

/** "11m 20s" against a target, coloured by whether it meets it. */
export function MedianAgainst({ seconds, target }) {
  if (seconds == null) return <span className="muted">—</span>;
  return <span className={seconds <= target ? 'good' : 'poor'}>{duration(seconds)}</span>;
}
