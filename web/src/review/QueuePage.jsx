import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { reviewApi } from '../lib/client.js';
import { age, coverageTone, duration, inputLabel, levelLabel, percent, time } from '../lib/format.js';
import { RefreshIcon } from '../lib/icons.jsx';
import { useLoader, useNow } from '../lib/useLoader.js';
import { useTitle } from '../lib/useTitle.js';

const REFRESH_MS = 30_000;
const TARGET_SECONDS = 15 * 60;

/** What needs a second look, from the capture's own metadata. */
export function flagsOf(v) {
  const flags = [];
  if (v.openFlags > 0) {
    flags.push({ label: `${v.openFlags} to confirm`, tone: 'fair' });
  }
  if (v.closed === false) flags.push({ label: 'Outline open', tone: 'poor' });
  if (v.overrideReason) flags.push({ label: 'Finished early', tone: 'poor' });
  if (v.weakWallCount > 0) {
    flags.push({ label: `${v.weakWallCount} weak wall${v.weakWallCount > 1 ? 's' : ''}`, tone: 'fair' });
  }
  if (v.source === 'simulated') flags.push({ label: 'Simulated', tone: 'fair' });
  return flags;
}

export default function QueuePage() {
  useTitle('Reviewer queue');
  const navigate = useNavigate();
  const location = useLocation();
  const { data, error, loading, reload } = useLoader(reviewApi.queue, 'queue', {
    intervalMs: REFRESH_MS,
  });
  const now = useNow(REFRESH_MS);
  const [claiming, setClaiming] = useState(null);
  const [claimError, setClaimError] = useState(null);
  const notice = location.state?.notice;

  async function open(v) {
    if (v.reviewer?.isMe) return navigate(`/review/versions/${v.id}`);
    setClaiming(v.id);
    setClaimError(null);
    try {
      await reviewApi.start(v.id);
      navigate(`/review/versions/${v.id}`);
    } catch (err) {
      setClaimError(err.message);
      setClaiming(null);
      reload();
    }
  }

  return (
    <>
      <header className="rv-header">
        <h1>Reviewer queue</h1>
        <span className="muted small">Oldest first</span>
        <span className="spacer" />
        <button type="button" className="rv-button ghost" onClick={reload} disabled={loading}>
          <RefreshIcon size={15} />
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      <div className="rv-content">
        {notice && (
          <p className="rv-notice" role="status">
            {notice}
          </p>
        )}
        {claimError && (
          <p className="rv-error" role="alert">
            {claimError}
          </p>
        )}

        {!data && error ? (
          <div className="rv-empty">
            <h2>The queue could not be loaded</h2>
            <p className="muted">{error.message}</p>
            <button type="button" className="rv-button primary" onClick={reload}>
              Try again
            </button>
          </div>
        ) : !data ? (
          <div className="rv-empty" role="status">
            <span className="rv-spinner" aria-hidden="true" />
            <p className="muted">Loading the queue…</p>
          </div>
        ) : (
          <>
            <Stats stats={data.stats} oldest={data.versions[0]} now={now} />
            {data.versions.length === 0 ? (
              <div className="rv-empty">
                <h2>The queue is clear</h2>
                <p className="muted">New scans appear here once their upload is confirmed.</p>
              </div>
            ) : (
              <QueueTable versions={data.versions} now={now} claiming={claiming} onOpen={open} />
            )}
            <p className="rv-footnote">
              Opening a plan claims it. Releasing it without approving or rejecting puts it back in
              the queue.
            </p>
          </>
        )}
      </div>
    </>
  );
}

function Stats({ stats, oldest, now }) {
  const median = stats.myMedianSecondsThisWeek;
  const oldestAgeH = oldest ? (now - new Date(oldest.submittedAt).getTime()) / 3_600_000 : 0;
  const tiles = [
    {
      label: 'WAITING FOR REVIEW',
      value: stats.waiting,
      note: `${stats.unclaimed} unclaimed`,
    },
    {
      label: 'OLDEST IN QUEUE',
      value: oldest ? age(stats.oldestSubmittedAt, now) : '—',
      note: oldest ? `${oldest.facility}, ${levelLabel(oldest.level)}` : 'Nothing waiting',
      tone: oldestAgeH >= 2 ? 'poor' : undefined,
    },
    {
      label: 'YOUR MEDIAN THIS WEEK',
      value: duration(median),
      note:
        stats.myReviewsThisWeek > 0
          ? `${stats.myReviewsThisWeek} review${stats.myReviewsThisWeek > 1 ? 's' : ''} · target under 15 min`
          : 'No reviews yet this week',
      tone: median == null ? undefined : median <= TARGET_SECONDS ? 'good' : 'poor',
    },
    {
      label: 'REJECTED THIS WEEK',
      value: stats.rejectedThisWeek,
      note: `${stats.approvedThisWeek} approved, all reviewers`,
    },
  ];
  return (
    <section className="rv-stats" aria-label="Queue summary">
      {tiles.map((t) => (
        <div className="rv-stat" key={t.label}>
          <div className="eyebrow">{t.label}</div>
          <div className={`rv-stat-value ${t.tone ?? ''}`}>{t.value}</div>
          <div className="rv-stat-note">{t.note}</div>
        </div>
      ))}
    </section>
  );
}

function QueueTable({ versions, now, claiming, onOpen }) {
  return (
    <div className="rv-table-wrap">
      <table className="rv-table">
        <thead>
          <tr>
            <th scope="col">FACILITY AND LEVEL</th>
            <th scope="col">INPUT</th>
            <th scope="col">CONFIDENCE</th>
            <th scope="col">FLAGS</th>
            <th scope="col">AGE</th>
            <th scope="col">REVIEWER</th>
            <th scope="col">
              <span className="sr-only">ACTION</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => {
            const flags = flagsOf(v);
            const taken = v.reviewer && !v.reviewer.isMe;
            return (
              <tr key={v.id} className={taken ? 'taken' : undefined}>
                <td data-label="Facility">
                  <div className="rv-cell-title">
                    {v.facility} · {levelLabel(v.level)}
                    {v.version > 1 && <span className="rv-chip">v{v.version}</span>}
                  </div>
                  <div className="rv-cell-sub">
                    {v.organisation} · submitted {time(v.submittedAt)}
                  </div>
                </td>
                <td data-label="Input">
                  {inputLabel(v.inputType)}
                  {v.origin === 'revision' && <div className="rv-cell-sub">Revision</div>}
                </td>
                <td data-label="Coverage">
                  <span className={`rv-coverage ${coverageTone(v.coverage)}`}>
                    <span className="rv-bar">
                      <span style={{ width: percent(v.coverage === null ? 0 : v.coverage) }} />
                    </span>
                    {percent(v.coverage)}
                  </span>
                </td>
                <td data-label="Flags">
                  {flags.length === 0 ? (
                    <span className="good">None</span>
                  ) : (
                    <span className="rv-flags">
                      {flags.map((f) => (
                        <span key={f.label} className={`rv-flag ${f.tone}`}>
                          {f.label}
                        </span>
                      ))}
                    </span>
                  )}
                </td>
                <td data-label="Age">{age(v.submittedAt, now)}</td>
                <td data-label="Reviewer" className={v.reviewer ? 'muted' : undefined}>
                  {v.reviewer ? (v.reviewer.isMe ? 'You' : v.reviewer.name) : 'Unclaimed'}
                </td>
                <td className="rv-action">
                  {taken ? (
                    <span className="rv-button disabled" aria-disabled="true">
                      Taken
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="rv-button primary"
                      onClick={() => onOpen(v)}
                      disabled={claiming !== null}
                      aria-label={`${v.reviewer?.isMe ? 'Continue' : 'Open'} ${v.facility}, ${levelLabel(v.level)}`}
                    >
                      {claiming === v.id ? 'Opening…' : v.reviewer?.isMe ? 'Continue' : 'Open'}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
