import { useState } from 'react';
import { Link, useParams } from 'react-router';

import { equipmentLabel } from '@shared/plan/index.js';

import { plansApi } from '../lib/client.js';
import { area, inputLabel, percent, stamp } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import { BackIcon, CubeIcon, LinkIcon, TrashIcon } from '../lib/icons.jsx';
import Modal from '../lib/Modal.jsx';
import { useLoader } from '../lib/useLoader.js';
import { useTitle } from '../lib/useTitle.js';
import { modelStatusOf, noteFor, planTitle, statusOf } from './status.js';
import './owner.css';

/** While the walkthrough is being built, look again this often. */
const GENERATING_REFRESH_MS = 20_000;

/**
 * One plan: where it is, why it was rejected, the walkthrough and its share
 * link (VIEW-07), its machines and their 3D models (D-05), and every
 * version with who did what and when (REV-09).
 */
export default function PlanPage() {
  const { planId } = useParams();
  const [poll, setPoll] = useState(false);
  const { data: plan, error, reload } = useLoader(() => plansApi.get(planId), planId, {
    intervalMs: poll ? GENERATING_REFRESH_MS : undefined,
  });
  const generating = plan?.status === 'generating';
  if (generating !== poll) setPoll(generating);
  useTitle(plan ? planTitle(plan) : t('owner.plan.title'));

  if (!plan) {
    return (
      <>
        <Header title={t('owner.plan.title')} />
        <div className="rv-content">
          {error ? (
            <div className="rv-empty" role="alert">
              <h2>{error.status === 404 ? t('owner.plan.notFound') : t('owner.plan.loadFailed')}</h2>
              <p className="muted">{error.message}</p>
              {error.status !== 404 && (
                <button type="button" className="rv-button primary" onClick={reload}>
                  {t('common.tryAgain')}
                </button>
              )}
            </div>
          ) : (
            <div className="rv-empty" role="status" aria-live="polite">
              <span className="rv-spinner" aria-hidden="true" />
              <p className="muted">{t('owner.plan.loading')}</p>
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
            {t('owner.plans.openWalkthrough')}
          </Link>
        )}
      </Header>

      <div className="rv-content">
        <p className="rv-subtitle muted">
          {/* A ready plan's note already names its version. */}
          {plan.status === 'ready' ? '' : t('owner.plan.versionPrefix', { version: plan.version })}
          {inputLabel(plan.inputType)}
          {note && ` · ${note}`}
        </p>

        {generating && (
          <p className="rv-notice ow-generating" role="status" aria-live="polite">
            <span className="rv-spinner" aria-hidden="true" />
            {t('owner.plan.generating')}
          </p>
        )}

        {plan.status === 'recapture' && (
          <section className="ow-rejection standalone" aria-label={t('owner.plan.sentBack')}>
            <div className="eyebrow">{t('owner.plan.sentBackEyebrow')}</div>
            <strong>{plan.rejectionReason ?? t('owner.plans.needsRecapture')}</strong>
            {plan.review?.note && <p>{plan.review.note}</p>}
            <p className="small muted">
              {t('owner.plan.recaptureHelp')} <Link to="/upload">{t('owner.plan.recaptureHelpLink')}</Link>
              {t('owner.plan.recaptureHelpAfter', { next: plan.version + 1 })}
            </p>
          </section>
        )}

        <div className="ow-detail-grid">
          <SharePanel plan={plan} onChange={reload} />
          <section className="rv-card" aria-label={t('owner.plan.facts')}>
            <div className="eyebrow">{t('owner.plan.factsEyebrow')}</div>
            <dl className="rv-facts">
              <div>
                <dt>{t('owner.plan.floorArea')}</dt>
                <dd>{area(plan.areaM2) ?? t('common.dash')}</dd>
              </div>
              <div>
                <dt>{t('owner.plan.coverage')}</dt>
                <dd>{percent(plan.coverage)}</dd>
              </div>
              <div>
                <dt>{t('owner.plan.walkthrough')}</dt>
                <dd>
                  {plan.walkthroughVersion != null
                    ? t('owner.plan.walkthroughVersion', { version: plan.walkthroughVersion })
                    : t('owner.plan.notYet')}
                </dd>
              </div>
              <div>
                <dt>{t('owner.plan.reviewer')}</dt>
                <dd>{plan.review?.reviewer?.name ?? t('common.dash')}</dd>
              </div>
            </dl>
          </section>
        </div>

        {Array.isArray(plan.machines) && <Machines machines={plan.machines} />}

        {plan.timeline?.length > 0 && <Timeline timeline={plan.timeline} />}

        <History history={plan.history ?? []} />
      </div>
    </>
  );
}

/** The plan's story from the audit log: who did what to which version, newest first. */
function Timeline({ timeline }) {
  const sorted = [...timeline].sort((a, b) => new Date(b.at) - new Date(a.at));
  return (
    <section aria-labelledby="timeline-heading">
      <h2 className="ow-section-title" id="timeline-heading">
        {t('owner.plan.timeline')}
      </h2>
      <ol className="ad-list ow-timeline">
        {sorted.map((e, i) => (
          <li key={`${e.at}-${i}`}>
            <span>
              {t(`owner.timeline.${e.action}`) === `owner.timeline.${e.action}`
                ? String(e.action).replaceAll('_', ' ').toLowerCase()
                : t(`owner.timeline.${e.action}`)}
              {e.version != null && ` · v${e.version}`}
              {e.actorName && <span className="muted small"> · {t('owner.plan.by', { name: e.actorName })}</span>}
            </span>
            <time className="muted small" dateTime={e.at}>
              {stamp(e.at)}
            </time>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Header({ title, children }) {
  return (
    <header className="rv-header">
      <Link to="/plans" className="rv-back">
        <BackIcon size={16} />
        {t('owner.plan.back')}
      </Link>
      <h1>{title}</h1>
      {children}
    </header>
  );
}

/**
 * D-05: each machine on the plan and where its 3D model is. A model the
 * Flex team rejected or that failed to build is being redone, which is all
 * the owner needs to know.
 */
function Machines({ machines }) {
  return (
    <section aria-labelledby="machines-heading">
      <h2 className="ow-section-title" id="machines-heading">
        {t('owner.plan.machines')}
      </h2>
      {machines.length === 0 ? (
        <p className="muted small">{t('owner.plan.noMachines')}</p>
      ) : (
        <div className="rv-table-wrap">
          <table className="rv-table">
            <caption className="sr-only">{t('owner.plan.machinesCaption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('owner.plan.machineColumns.ref')}</th>
                <th scope="col">{t('owner.plan.machineColumns.name')}</th>
                <th scope="col">{t('owner.plan.machineColumns.type')}</th>
                <th scope="col">{t('owner.plan.machineColumns.model')}</th>
              </tr>
            </thead>
            <tbody>
              {machines.map((m) => {
                const s = modelStatusOf(m.modelStatus);
                return (
                  <tr key={m.ref}>
                    <td data-label="Reference">
                      <code className="ow-hash">{m.ref}</code>
                    </td>
                    <td data-label="Name">
                      <div className="rv-cell-title">{m.name}</div>
                    </td>
                    <td data-label="Type">{equipmentLabel(m.type)}</td>
                    <td data-label="3D model">
                      <span className={`ow-model ${s.tone}`}>{s.label}</span>
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

/**
 * The share link (VIEW-07, D-06). Tokens are stored hashed, so the backend
 * can show a link's address only in the answer that made it: the page keeps
 * that answer for the visit. Later, a live link shows as "a link exists",
 * and making a new one (which revokes the old) is the way to copy it again.
 */
function SharePanel({ plan, onChange }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [fresh, setFresh] = useState(null);
  const live = plan.shareLink ?? null;
  const link = fresh?.url ?? live?.url ?? null;
  const create = () =>
    run(async () => {
      setFresh(await plansApi.share(plan.id));
    });

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
      setError(t('owner.share.copyBlocked'));
    }
  }

  return (
    <section className="rv-card" aria-labelledby="share-heading">
      <h2 className="eyebrow" id="share-heading">
        {t('owner.share.eyebrow')}
      </h2>
      {plan.walkthroughVersion == null ? (
        <p className="muted small">{t('owner.share.notYet')}</p>
      ) : link ? (
        <>
          <p className="small muted">{t('owner.share.about')}</p>
          <div className="ow-share-row">
            <label htmlFor="share-url" className="sr-only">
              {t('owner.share.label')}
            </label>
            <input id="share-url" className="ow-share-url" readOnly value={link} onFocus={(e) => e.target.select()} />
            <button type="button" className="rv-button primary" onClick={copy} disabled={busy}>
              <LinkIcon size={15} />
              {copied ? t('owner.share.copied') : t('owner.share.copy')}
            </button>
          </div>
          <span role="status" className="sr-only">
            {copied ? t('owner.share.copiedStatus') : ''}
          </span>
          <button
            type="button"
            className="rv-button danger-ghost ow-revoke"
            onClick={() => setConfirm(true)}
            disabled={busy}
          >
            <TrashIcon size={15} />
            {t('owner.share.revoke')}
          </button>
        </>
      ) : live ? (
        <>
          <p className="small muted">
            {t('owner.share.exists', { created: live.createdAt ? stamp(live.createdAt) : t('common.dash') })}
          </p>
          <div className="ow-share-row">
            <button type="button" className="rv-button primary" onClick={create} disabled={busy}>
              <LinkIcon size={15} />
              {busy ? t('owner.share.creating') : t('owner.share.remake')}
            </button>
            <button type="button" className="rv-button danger-ghost" onClick={() => setConfirm(true)} disabled={busy}>
              <TrashIcon size={15} />
              {t('owner.share.revoke')}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="small muted">{t('owner.share.make')}</p>
          <button type="button" className="rv-button primary" onClick={create} disabled={busy}>
            <LinkIcon size={15} />
            {busy ? t('owner.share.creating') : t('owner.share.create')}
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
          title={t('owner.share.confirmTitle')}
          subtitle={t('owner.share.confirmSubtitle')}
          onClose={() => setConfirm(false)}
          busy={busy}
          footer={
            <>
              <button type="button" className="rv-button ghost" onClick={() => setConfirm(false)} disabled={busy}>
                {t('owner.share.keep')}
              </button>
              <button
                type="button"
                className="rv-button danger"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await plansApi.revokeShare(plan.id);
                    setFresh(null);
                    setConfirm(false);
                  })
                }
              >
                {busy ? t('owner.share.revoking') : t('owner.share.revoke')}
              </button>
            </>
          }
        >
          <p className="small muted">{t('owner.share.after')}</p>
        </Modal>
      )}
    </section>
  );
}

function History({ history }) {
  return (
    <section aria-labelledby="history-heading">
      <h2 className="ow-section-title" id="history-heading">
        {t('owner.plan.history')}
      </h2>
      {history.length === 0 ? (
        <p className="muted small">{t('owner.plan.noVersions')}</p>
      ) : (
        <div className="rv-table-wrap">
          <table className="rv-table" aria-labelledby="history-heading">
            <thead>
              <tr>
                <th scope="col">{t('owner.plan.columns.version')}</th>
                <th scope="col">{t('owner.plan.columns.state')}</th>
                <th scope="col">{t('owner.plan.columns.input')}</th>
                <th scope="col">{t('owner.plan.columns.submitted')}</th>
                <th scope="col">{t('owner.plan.columns.reviewed')}</th>
                <th scope="col">{t('owner.plan.columns.hash')}</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => {
                const s = statusOf(h.status);
                return (
                  <tr key={h.id}>
                    <td data-label="Version">
                      <div className="rv-cell-title">v{h.version}</div>
                      {h.origin === 'revision' && <div className="rv-cell-sub">{t('owner.plan.revisedByFlex')}</div>}
                    </td>
                    <td data-label="State">
                      <span className={`ow-pill ${s.tone}`}>{s.label}</span>
                      {h.rejectionReason && <div className="rv-cell-sub">{h.rejectionReason}</div>}
                    </td>
                    <td data-label="Input">{inputLabel(h.inputType)}</td>
                    <td data-label="Submitted">
                      {h.submittedAt ? stamp(h.submittedAt) : t('common.dash')}
                      {h.submittedBy && <div className="rv-cell-sub">{t('owner.plan.by', { name: h.submittedBy })}</div>}
                    </td>
                    <td data-label="Reviewed">
                      {h.reviewedAt ? stamp(h.reviewedAt) : t('common.dash')}
                      {h.reviewerName && <div className="rv-cell-sub">{t('owner.plan.by', { name: h.reviewerName })}</div>}
                    </td>
                    <td data-label="Hash">
                      {h.contentHash ? (
                        <code className="ow-hash" title={h.contentHash}>
                          {h.contentHash.slice(0, 8)}…{h.contentHash.slice(-4)}
                        </code>
                      ) : (
                        t('common.dash')
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
