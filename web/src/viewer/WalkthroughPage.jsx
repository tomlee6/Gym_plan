import { useNavigate, useParams } from 'react-router';

import { plansApi } from '../lib/client.js';
import { area, date, levelLabel } from '../lib/format.js';
import { useLoader } from '../lib/useLoader.js';
import { useTitle } from '../lib/useTitle.js';
import Walkthrough from './Walkthrough.jsx';
import './viewer.css';

/**
 * The owner's walkthrough, `/plans/:planId/walkthrough`: always the newest
 * approved version of the level (GEN-06), with the facility's other
 * approved levels one click away (VIEW-06).
 */
export default function WalkthroughPage() {
  const { planId } = useParams();
  const navigate = useNavigate();
  const { data: model, error, reload } = useLoader(() => plansApi.model(planId), planId);
  useTitle(model ? `${model.site} · ${levelLabel(model.level)} walkthrough` : 'Walkthrough');

  if (!model || !model.plan) {
    const missing = error?.status === 404 || (model && !model.plan);
    return (
      <div className="wt-status" role={error ? undefined : 'status'}>
        <span className="wt-wordmark">FLEX</span>
        {!error && !model ? (
          <>
            <span className="wt-spinner" aria-hidden="true" />
            <p>Loading the walkthrough…</p>
          </>
        ) : (
          <>
            <h1>{missing ? 'No approved walkthrough yet' : 'The walkthrough could not be loaded'}</h1>
            <p>
              {missing
                ? 'A walkthrough appears here once a reviewer approves this plan.'
                : error.message}
            </p>
            <div className="wt-status-actions">
              {!missing && (
                <button type="button" className="wt-button" onClick={reload}>
                  Try again
                </button>
              )}
              <button type="button" className="wt-button" onClick={() => navigate(`/plans/${planId}`)}>
                Back to the plan
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  const meta = [
    levelLabel(model.level),
    `version ${model.version}`,
    model.approvedAt && `approved ${date(model.approvedAt)}`,
    area(model.areaM2),
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Walkthrough
      plan={model.plan}
      site={model.site}
      level={model.level}
      meta={meta}
      levels={model.levels}
      currentPlanId={model.planId}
      onLevel={(id) => navigate(`/plans/${id}/walkthrough`)}
      onShare={async () => (await plansApi.share(model.planId)).url}
      onClose={() => navigate(`/plans/${model.planId}`)}
    />
  );
}
