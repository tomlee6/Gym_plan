import { Link, useLocation } from 'react-router';

import { meApi, plansApi } from '../lib/client.js';
import { inputLabel, levelLabel } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import { CubeIcon, RefreshIcon, UploadIcon } from '../lib/icons.jsx';
import { useLoader } from '../lib/useLoader.js';
import { useTitle } from '../lib/useTitle.js';
import { groupByFacility, machinesSummary, noteFor, statusOf } from './status.js';
import './owner.css';

const REFRESH_MS = 30_000;

/** Everything the status page shows, in one load, for the current account. */
async function loadStatus() {
  const [me, facilities, list] = await Promise.all([meApi.me(), meApi.facilities(), plansApi.list()]);
  // A rejected plan shows the reviewer's note, which only the detail has.
  const rejected = list.plans.filter((p) => p.status === 'recapture');
  const details = await Promise.all(rejected.map((p) => plansApi.get(p.id).catch(() => null)));
  const notes = new Map(details.filter(Boolean).map((d) => [d.id, d.review?.note ?? null]));
  return {
    // The quota belongs to the account (api-contract-v2: /v1/me `account`).
    quota: me.account ?? me,
    groups: groupByFacility(facilities.facilities, list.plans.map((p) => ({ ...p, note: notes.get(p.id) }))),
  };
}

/**
 * The owner's status page (ACC-03, D-05): every facility, each level's plan
 * and its state in the PRD's words, why a plan was rejected, the
 * walkthrough once one is ready, and how its machines' 3D models are going.
 *
 * Accessibility (H-04): one h1, an h2 per facility (each a labelled
 * region), states in words as well as colour, loading in a live status and
 * load failures as an alert.
 */
export default function PlansPage() {
  useTitle(t('owner.plans.title'));
  const location = useLocation();
  const notice = location.state?.notice;
  const { data, error, loading, reload } = useLoader(loadStatus, 'plans', { intervalMs: REFRESH_MS });
  const quota = data?.quota;

  return (
    <>
      <header className="rv-header">
        <h1>{t('owner.plans.title')}</h1>
        {quota?.planQuota != null && (
          <span className="muted small">{t('owner.plans.quota', { used: quota.plansUsed, quota: quota.planQuota })}</span>
        )}
        <span className="spacer" />
        <button type="button" className="rv-button ghost" onClick={reload} disabled={loading}>
          <RefreshIcon size={15} />
          {loading ? t('common.refreshing') : t('common.refresh')}
        </button>
        <Link to="/upload" className="rv-button primary">
          <UploadIcon size={15} />
          {t('owner.plans.upload')}
        </Link>
      </header>

      <div className="rv-content">
        {notice && (
          <p className="rv-notice" role="status">
            {notice}
          </p>
        )}
        {!data && error ? (
          <div className="rv-empty" role="alert">
            <h2>{t('owner.plans.loadFailed')}</h2>
            <p className="muted">{error.message}</p>
            <button type="button" className="rv-button primary" onClick={reload}>
              {t('common.tryAgain')}
            </button>
          </div>
        ) : !data ? (
          <div className="rv-empty" role="status" aria-live="polite">
            <span className="rv-spinner" aria-hidden="true" />
            <p className="muted">{t('owner.plans.loading')}</p>
          </div>
        ) : data.groups.length === 0 ? (
          <div className="rv-empty">
            <h2>{t('owner.plans.noGyms')}</h2>
            <p className="muted">{t('owner.plans.noGymsBody')}</p>
          </div>
        ) : (
          data.groups.map((g) => <FacilityCard key={g.id} group={g} />)
        )}
      </div>
    </>
  );
}

function FacilityCard({ group }) {
  const headingId = `fac-${group.id}`;
  return (
    <section className="rv-card ow-facility" aria-labelledby={headingId}>
      <div className="ow-facility-head">
        <h2 id={headingId}>{group.name}</h2>
        <span className="muted small">
          {group.plans.length === 0 ? t('owner.plans.noLevels') : t('owner.plans.levels', { count: group.plans.length })}
        </span>
      </div>
      {group.plans.length === 0 ? (
        <p className="muted small ow-empty-row">
          {t('owner.plans.nothingYet')} <Link to="/upload">{t('owner.plans.nothingYetLink')}</Link>.
        </p>
      ) : (
        <ul className="ow-levels">
          {group.plans.map((p) => (
            <PlanRow key={p.id} plan={p} />
          ))}
        </ul>
      )}
    </section>
  );
}

function PlanRow({ plan }) {
  const status = statusOf(plan);
  const note = noteFor(plan);
  const machines = machinesSummary(plan.machines);
  return (
    <li className={`ow-level ${plan.status === 'recapture' ? 'rejected' : ''}`}>
      <div className="ow-level-main">
        <Link to={`/plans/${plan.id}`} className="ow-level-title">
          {levelLabel(plan.level)}
        </Link>
        <span className="muted small">{inputLabel(plan.inputType)}</span>
      </div>
      <div className="ow-level-state">
        <span className={`ow-pill ${status.tone}`}>{status.label}</span>
        {note && <span className="muted small">{note}</span>}
        {machines && <span className="muted small ow-machines-line">{machines}</span>}
      </div>
      <div className="ow-level-action">
        {plan.walkthroughVersion != null && (
          <Link
            to={`/plans/${plan.id}/walkthrough`}
            className="rv-button primary"
            aria-label={`${t('owner.plans.openWalkthrough')}, ${levelLabel(plan.level)}`}
          >
            <CubeIcon size={15} />
            {t('owner.plans.openWalkthrough')}
          </Link>
        )}
      </div>
      {plan.status === 'recapture' && (
        <div className="ow-rejection">
          <div className="eyebrow">{t('owner.plans.reasonCode')}</div>
          <strong>{plan.rejectionReason ?? t('owner.plans.needsRecapture')}</strong>
          {plan.note && <p>{plan.note}</p>}
        </div>
      )}
    </li>
  );
}
