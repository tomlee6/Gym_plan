import { Link, useLocation } from 'react-router';

import { meApi, plansApi } from '../lib/client.js';
import { inputLabel, levelLabel } from '../lib/format.js';
import { CubeIcon, RefreshIcon, UploadIcon } from '../lib/icons.jsx';
import { useLoader } from '../lib/useLoader.js';
import { useTitle } from '../lib/useTitle.js';
import { groupByFacility, noteFor, statusOf } from './status.js';
import './owner.css';

const REFRESH_MS = 30_000;

/** Everything the status page shows, in one load. */
async function loadStatus() {
  const [me, facilities, list] = await Promise.all([meApi.me(), meApi.facilities(), plansApi.list()]);
  // A rejected plan shows the reviewer's note, which only the detail has.
  const rejected = list.plans.filter((p) => p.status === 'recapture');
  const details = await Promise.all(rejected.map((p) => plansApi.get(p.id).catch(() => null)));
  const notes = new Map(details.filter(Boolean).map((d) => [d.id, d.review?.note ?? null]));
  return {
    me,
    groups: groupByFacility(facilities.facilities, list.plans.map((p) => ({ ...p, note: notes.get(p.id) }))),
  };
}

/**
 * The owner's status page (ACC-03): every facility, each level's plan and
 * its state in the PRD's words, why a plan was rejected, and the
 * walkthrough once one is ready.
 */
export default function PlansPage() {
  useTitle('My plans');
  const location = useLocation();
  const notice = location.state?.notice;
  const { data, error, loading, reload } = useLoader(loadStatus, 'plans', { intervalMs: REFRESH_MS });

  return (
    <>
      <header className="rv-header">
        <h1>My plans</h1>
        {data && (
          <span className="muted small">
            {data.me.plansUsed} of {data.me.planQuota} this month
          </span>
        )}
        <span className="spacer" />
        <button type="button" className="rv-button ghost" onClick={reload} disabled={loading}>
          <RefreshIcon size={15} />
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
        <Link to="/upload" className="rv-button primary">
          <UploadIcon size={15} />
          Upload a plan
        </Link>
      </header>

      <div className="rv-content">
        {notice && (
          <p className="rv-notice" role="status">
            {notice}
          </p>
        )}
        {!data && error ? (
          <div className="rv-empty">
            <h2>Your plans could not be loaded</h2>
            <p className="muted">{error.message}</p>
            <button type="button" className="rv-button primary" onClick={reload}>
              Try again
            </button>
          </div>
        ) : !data ? (
          <div className="rv-empty" role="status">
            <span className="rv-spinner" aria-hidden="true" />
            <p className="muted">Loading your plans…</p>
          </div>
        ) : data.groups.length === 0 ? (
          <div className="rv-empty">
            <h2>No gyms on this account yet</h2>
            <p className="muted">Ask Flex to add your facilities, then scan them with the app or upload a plan.</p>
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
          {group.plans.length === 0
            ? 'No levels yet'
            : `${group.plans.length} level${group.plans.length > 1 ? 's' : ''}`}
        </span>
      </div>
      {group.plans.length === 0 ? (
        <p className="muted small ow-empty-row">
          Nothing captured here yet. Scan a level with the Gym Scan app, or{' '}
          <Link to="/upload">upload a plan</Link>.
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
      </div>
      <div className="ow-level-action">
        {plan.walkthroughVersion != null && (
          <Link to={`/plans/${plan.id}/walkthrough`} className="rv-button primary">
            <CubeIcon size={15} />
            Open walkthrough
          </Link>
        )}
      </div>
      {plan.status === 'recapture' && (
        <div className="ow-rejection">
          <div className="eyebrow">REASON CODE</div>
          <strong>{plan.rejectionReason ?? 'Needs recapture'}</strong>
          {plan.note && <p>{plan.note}</p>}
        </div>
      )}
    </li>
  );
}
