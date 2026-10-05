import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';

import { adminApi } from '../lib/client.js';
import { stampSeconds } from '../lib/format.js';
import { DownloadIcon } from '../lib/icons.jsx';
import { useLoader } from '../lib/useLoader.js';
import { useTitle } from '../lib/useTitle.js';
import { ActionPill, auditFilename, detailText, saveBlob } from './parts.jsx';
import './admin.css';

const PAGE = 50;

/** A "YYYY-MM-DD" date input as the start of that day, local time, in ISO. */
function dayStart(value, addDays = 0) {
  if (!value) return undefined;
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d + addDays).toISOString();
}

/**
 * The audit log (ACC-06): every state change and approval, with who, when
 * and which version; filterable, pageable and exportable as CSV. The
 * filters live in the URL so a filtered view can be linked to.
 */
export default function AuditPage() {
  useTitle('Audit log');
  const [params, setParams] = useSearchParams();
  const filters = {
    orgId: params.get('orgId') ?? '',
    action: params.get('action') ?? '',
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
  };
  const query = {
    orgId: filters.orgId || undefined,
    action: filters.action || undefined,
    from: dayStart(filters.from),
    // "To" includes the whole of that day.
    to: dayStart(filters.to, 1),
  };
  const key = JSON.stringify(query);

  const accounts = useLoader(adminApi.accounts, 'audit-accounts');
  const [state, setState] = useState({ entries: [], nextBefore: null, actions: [], status: 'loading', error: null });
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);

  const load = useCallback(
    async (before) => {
      setState((s) => ({ ...s, status: before ? 'more' : 'loading', error: null }));
      try {
        const page = await adminApi.audit({ ...JSON.parse(key), limit: PAGE, before });
        setState((s) => ({
          entries: before ? [...s.entries, ...page.entries] : page.entries,
          nextBefore: page.nextBefore,
          actions: page.actions,
          status: 'ready',
          error: null,
        }));
      } catch (error) {
        setState((s) => ({ ...s, status: 'ready', error }));
      }
    },
    [key],
  );

  useEffect(() => {
    load();
  }, [load]);

  function setFilter(name, value) {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    setParams(next, { replace: true });
  }

  async function exportCsv() {
    setExporting(true);
    setExportError(null);
    try {
      const { orgId, action, from, to } = query;
      saveBlob(await adminApi.auditCsv({ orgId, action, from, to }), auditFilename());
    } catch (err) {
      setExportError(err.message);
    } finally {
      setExporting(false);
    }
  }

  const accountName = (id) => accounts.data?.accounts.find((a) => a.id === id)?.name;
  const filtered = Object.values(filters).some(Boolean);

  return (
    <>
      <header className="rv-header">
        <h1>Audit log</h1>
        <span className="muted small">Every state change, with actor, time and version</span>
        <span className="spacer" />
        <button type="button" className="rv-button ghost" onClick={exportCsv} disabled={exporting}>
          <DownloadIcon size={15} />
          {exporting ? 'Exporting…' : filtered ? 'Export these as CSV' : 'Export CSV'}
        </button>
      </header>

      <div className="rv-content">
        <form className="ad-filters" aria-label="Filter the audit log" onSubmit={(e) => e.preventDefault()}>
          <label className="rv-field">
            <span>Account</span>
            <select value={filters.orgId} onChange={(e) => setFilter('orgId', e.target.value)}>
              <option value="">All accounts</option>
              {accounts.data?.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
              {filters.orgId && !accountName(filters.orgId) && <option value={filters.orgId}>{filters.orgId}</option>}
            </select>
          </label>
          <label className="rv-field">
            <span>Action</span>
            <select value={filters.action} onChange={(e) => setFilter('action', e.target.value)}>
              <option value="">All actions</option>
              {state.actions.map((a) => (
                <option key={a} value={a}>
                  {a.replaceAll('_', ' ')}
                </option>
              ))}
              {filters.action && !state.actions.includes(filters.action) && (
                <option value={filters.action}>{filters.action}</option>
              )}
            </select>
          </label>
          <label className="rv-field">
            <span>From</span>
            <input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => setFilter('from', e.target.value)} />
          </label>
          <label className="rv-field">
            <span>To</span>
            <input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => setFilter('to', e.target.value)} />
          </label>
          <button
            type="button"
            className="rv-button ghost"
            onClick={() => setParams(new URLSearchParams(), { replace: true })}
            disabled={!filtered}
          >
            Clear
          </button>
        </form>

        {exportError && (
          <p className="rv-error" role="alert">
            {exportError}
          </p>
        )}
        {state.error && (
          <p className="rv-error" role="alert">
            {state.error.message}
          </p>
        )}

        {state.status === 'loading' ? (
          <div className="rv-empty" role="status">
            <span className="rv-spinner" aria-hidden="true" />
            <p className="muted">Loading the audit log…</p>
          </div>
        ) : state.entries.length === 0 ? (
          <div className="rv-empty">
            <h2>No entries</h2>
            <p className="muted">{filtered ? 'Nothing matches these filters.' : 'Nothing has been recorded yet.'}</p>
          </div>
        ) : (
          <>
            <div className="rv-table-wrap">
              <table className="rv-table">
                <caption className="sr-only">Audit log entries, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">TIME</th>
                    <th scope="col">ACTION</th>
                    <th scope="col">TARGET</th>
                    <th scope="col">ACCOUNT</th>
                    <th scope="col">ACTOR</th>
                    <th scope="col">VERSION</th>
                    <th scope="col">DETAIL</th>
                  </tr>
                </thead>
                <tbody>
                  {state.entries.map((e) => (
                    <tr key={e.id}>
                      <td data-label="Time">
                        <time dateTime={new Date(e.at).toISOString()}>{stampSeconds(e.at)}</time>
                      </td>
                      <td data-label="Action">
                        <ActionPill action={e.action} />
                      </td>
                      <td data-label="Target">
                        {e.targetLabel ?? <span className="ad-mono">{e.targetId ?? e.targetType}</span>}
                      </td>
                      <td data-label="Account">
                        {e.organisation ?? <span className="ad-mono">{e.orgId ?? '—'}</span>}
                      </td>
                      <td data-label="Actor">
                        {e.actorName ?? <span className="ad-mono">{e.actorId ?? 'System'}</span>}
                      </td>
                      <td data-label="Version">{e.version == null ? '—' : `v${e.version}`}</td>
                      <td data-label="Detail" className="small muted">
                        {detailText(e) || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="ad-section-title">
              <span className="small muted">
                {state.entries.length} entr{state.entries.length === 1 ? 'y' : 'ies'} shown
              </span>
              {state.nextBefore && (
                <button
                  type="button"
                  className="rv-button ghost"
                  onClick={() => load(new Date(state.nextBefore).toISOString())}
                  disabled={state.status === 'more'}
                >
                  {state.status === 'more' ? 'Loading…' : 'Load more'}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
