import { useNavigate, useParams } from 'react-router';

import { reviewApi } from '../lib/client.js';
import { levelLabel } from '../lib/format.js';
import { useLoader } from '../lib/useLoader.js';
import { useTitle } from '../lib/useTitle.js';
import Walkthrough from '../viewer/Walkthrough.jsx';
import '../viewer/viewer.css';

/** What the reviewer is looking at, in the bottom bar. */
function modelNote(model) {
  if (!model) return 'no 3D model built';
  if (model.status === 'building') return '3D model still building: drawn from the plan for now';
  if (model.status === 'failed') return '3D build failed: drawn from the plan';
  if (!model.url) return 'drawn from the plan';
  return `generated model ${model.generatorVersion}`;
}

/**
 * A version's walkthrough for the reviewer (K-06), `/review/versions/:id/walkthrough`:
 * the 3D model generated from exactly this version, so it can be checked
 * before (or after) customers see it. Reviewers are Flex staff, not members
 * of the customer's account, so this goes through the review API rather
 * than the owner's walkthrough page. Without a stored model the level is
 * drawn from this version's plan, and the bottom bar says so.
 */
export default function ReviewWalkthroughPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data: v, error, reload } = useLoader(() => reviewApi.version(id), id);
  useTitle(v ? `${v.facility} · ${levelLabel(v.level)} · version ${v.version} in 3D` : 'Walkthrough');
  const back = () => navigate(`/review/versions/${id}`);

  if (!v || !v.plan) {
    return (
      <div className="wt-status" role={error ? undefined : 'status'}>
        <span className="wt-wordmark">FLEX</span>
        {!error && !v ? (
          <>
            <span className="wt-spinner" aria-hidden="true" />
            <p>Loading the walkthrough…</p>
          </>
        ) : (
          <>
            <h1>{v ? 'This version has no plan to walk through' : 'The walkthrough could not be loaded'}</h1>
            {error && <p>{error.message}</p>}
            <div className="wt-status-actions">
              {error && (
                <button type="button" className="wt-button" onClick={reload}>
                  Try again
                </button>
              )}
              <button type="button" className="wt-button" onClick={back}>
                Back to the editor
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  const meta = [`Review · version ${v.version}`, levelLabel(v.level), modelNote(v.generatedModel)].join(' · ');
  return (
    <Walkthrough
      plan={v.plan}
      modelUrl={v.generatedModel?.url ?? null}
      machineModels={v.machineModels ?? null}
      site={v.facility}
      level={v.level}
      meta={meta}
      onClose={back}
    />
  );
}
