import { useState } from 'react';
import { Link, useParams } from 'react-router';

import { plansApi } from '../lib/client.js';
import { area, inputLabel, OWNER_STATUS, percent, stamp } from '../lib/format.js';
import { BackIcon, CubeIcon, LinkIcon, TrashIcon } from '../lib/icons.jsx';
import Modal from '../lib/Modal.jsx';
import { useLoader } from '../lib/useLoader.js';
import { useTitle } from '../lib/useTitle.js';
import { noteFor, planTitle, statusOf } from './status.js';
import './owner.css';

/**
 * One plan: where it is, why it was rejected, the walkthrough and its share
 * link (VIEW-07), and every version with who did what and when (REV-09).
 */
export default function PlanPage() {
  const { planId } = useParams();
  const { data: plan, error, reload } = useLoader(() => plansApi.get(planId), planId);
  useTitle(plan ? planTitle(plan) : 'Plan');

  if (!plan) {
    return (
      <>
        <Header title="Plan" />
        <div className="rv-content">
          {error ? (
            <div className="rv-empty">
              <h2>{error.status === 404 ? 'This plan does not exist' : 'The plan could not be loaded'}</h2>
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
              <p className="muted">Loading the plan…</p>
            </div>
          )}
        </div>
      </>
    );
  }

  const status = statusOf(plan);
  const note = noteFor(plan);
  return (
    <>
      <Header title={planTitle(plan)}>
        <span className={`ow-pill ${status.tone}`}>{status.label}</span>
        <span className="spacer" />
        {plan.walkthroughVersion != null && (
          <Link to={`/plans/${plan.id}/walkthrough`} className="rv-button primary">
            <CubeIcon size={15} />
            Open walkthrough
          </Link>
        )}
      </Header>

      <div className="rv-content">
        <p className="rv-subtitle muted">
          {/* A ready plan's note already names its version. */}
          {plan.status === 'ready' ? '' : `Version ${plan.version} · `}
          {inputLabel(plan.inputType)}
          {note && ` · ${note}`}
        </p>

        {plan.status === 'recapture' && (
          <section className="ow-rejection standalone" aria-label="Why it was sent back">
            <div className="eyebrow">NEEDS RECAPTURE · REASON CODE</div>
            <strong>{plan.rejectionReason ?? 'Needs recapture'}</strong>
            {plan.review?.note && <p>{plan.review.note}</p>}
            <p className="small muted">
              Scan this level again with the Gym Scan app, or <Link to="/upload">upload a plan</Link>. The new
              capture becomes version {plan.version + 1}.
            </p>
          </section>
        )}

        <div className="ow-detail-grid">
          <SharePanel plan={plan} onChange={reload} />
          <section className="rv-card" aria-label="Plan facts">
            <div className="eyebrow">PLAN</div>
            <dl className="rv-facts">
              <div>
                <dt>Floor area</dt>
                <dd>{area(plan.areaM2) ?? '—'}</dd>
              </div>
              <div>
                <dt>Scan coverage</dt>
                <dd>{percent(plan.coverage)}</dd>
              </div>
              <div>
                <dt>Walkthrough</dt>
                <dd>{plan.walkthroughVersion != null ? `Version ${plan.walkthroughVersion}` : 'Not yet'}</dd>
              </div>
              <div>
                <dt>Reviewer</dt>
                <dd>{plan.review?.reviewer?.name ?? '—'}</dd>
              </div>
            </dl>
          </section>
        </div>

        <History history={plan.history ?? []} />
      </div>
    </>
  );
}

function Header({ title, children }) {
  return (
    <header className="rv-header">
      <Link to="/plans" className="rv-back">
        <BackIcon size={16} />
        My plans
      </Link>
      <h1>{title}</h1>
      {children}
    </header>
  );
}

function SharePanel({ plan, onChange }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const link = plan.shareLink?.url;

  async function run(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      document.getElementById('share-url')?.select();
      setError('Copying was blocked. The link is selected: press Ctrl+C to copy it.');
    }
  }

  return (
    <section className="rv-card" aria-labelledby="share-heading">
      <div className="eyebrow" id="share-heading">
        SHARE LINK
      </div>
      {plan.walkthroughVersion == null ? (
        <p className="muted small">Sharing becomes available once the walkthrough is approved.</p>
      ) : link ? (
        <>
          <p className="small muted">
            Anyone with this link can open the walkthrough without an account. It always shows the newest approved
            version.
          </p>
          <div className="ow-share-row">
            <label htmlFor="share-url" className="sr-only">
              Share link
            </label>
            <input id="share-url" className="ow-share-url" readOnly value={link} onFocus={(e) => e.target.select()} />
            <button type="button" className="rv-button primary" onClick={copy} disabled={busy}>
              <LinkIcon size={15} />
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
          <span role="status" className="sr-only">
            {copied ? 'Link copied' : ''}
          </span>
          <button
            type="button"
            className="rv-button danger-ghost ow-revoke"
            onClick={() => setConfirm(true)}
            disabled={busy}
          >
            <TrashIcon size={15} />
            Revoke link
          </button>
        </>
      ) : (
        <>
          <p className="small muted">
            Make a view-only link for a colleague or investor. They need no account, and you can revoke it at any time.
          </p>
          <button type="button" className="rv-button primary" onClick={() => run(() => plansApi.share(plan.id))} disabled={busy}>
            <LinkIcon size={15} />
            {busy ? 'Creating…' : 'Create share link'}
          </button>
        </>
      )}
      {error && (
        <p className="rv-error ow-gap" role="alert">
          {error}
        </p>
      )}
      {confirm && (
        <Modal
          title="Revoke the share link?"
          subtitle="Anyone using it will see that it is no longer available."
          onClose={() => setConfirm(false)}
          busy={busy}
          footer={
            <>
              <button type="button" className="rv-button ghost" onClick={() => setConfirm(false)} disabled={busy}>
                Keep it
              </button>
              <button
                type="button"
                className="rv-button danger"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await plansApi.revokeShare(plan.id);
                    setConfirm(false);
                  })
                }
              >
                {busy ? 'Revoking…' : 'Revoke link'}
              </button>
            </>
          }
        >
          <p className="small muted">You can create a new link afterwards; it will have a different address.</p>
        </Modal>
      )}
    </section>
  );
}

function History({ history }) {
  return (
    <section aria-labelledby="history-heading">
      <h2 className="ow-section-title" id="history-heading">
        Version history
      </h2>
      {history.length === 0 ? (
        <p className="muted small">No versions yet.</p>
      ) : (
        <div className="rv-table-wrap">
          <table className="rv-table">
            <thead>
              <tr>
                <th scope="col">VERSION</th>
                <th scope="col">STATE</th>
                <th scope="col">INPUT</th>
                <th scope="col">SUBMITTED</th>
                <th scope="col">REVIEWED</th>
                <th scope="col">CONTENT HASH</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => {
                const s = OWNER_STATUS[h.status] ?? { label: h.status, tone: 'muted' };
                return (
                  <tr key={h.id}>
                    <td data-label="Version">
                      <div className="rv-cell-title">v{h.version}</div>
                      {h.origin === 'revision' && <div className="rv-cell-sub">Revised by Flex</div>}
                    </td>
                    <td data-label="State">
                      <span className={`ow-pill ${s.tone}`}>{s.label}</span>
                      {h.rejectionReason && <div className="rv-cell-sub">{h.rejectionReason}</div>}
                    </td>
                    <td data-label="Input">{inputLabel(h.inputType)}</td>
                    <td data-label="Submitted">
                      {h.submittedAt ? stamp(h.submittedAt) : '—'}
                      {h.submittedBy && <div className="rv-cell-sub">by {h.submittedBy}</div>}
                    </td>
                    <td data-label="Reviewed">
                      {h.reviewedAt ? stamp(h.reviewedAt) : '—'}
                      {h.reviewerName && <div className="rv-cell-sub">by {h.reviewerName}</div>}
                    </td>
                    <td data-label="Hash">
                      {h.contentHash ? (
                        <code className="ow-hash" title={h.contentHash}>
                          {h.contentHash.slice(0, 8)}…{h.contentHash.slice(-4)}
                        </code>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
