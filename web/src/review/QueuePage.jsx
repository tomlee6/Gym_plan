import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { reviewApi } from '../lib/client.js';
import { age, coverageTone, duration, inputLabel, levelLabel, percent, time } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import { RefreshIcon } from '../lib/icons.jsx';
import { useLoader, useNow } from '../lib/useLoader.js';
import { useTitle } from '../lib/useTitle.js';

const REFRESH_MS = 30_000;
const TARGET_SECONDS = 15 * 60;

/** What needs a second look, from the capture's own metadata. */
export function flagsOf(v) {
  const flags = [];
  // E-02: approved, but the 3D build failed; it is back for a reviewer.
  if (v.status === 'generation_failed') flags.push({ label: t('queue.flags.generationFailed'), tone: 'poor' });
  if (v.openFlags > 0) {
    flags.push({ label: t('queue.flags.toConfirm', { count: v.openFlags }), tone: 'fair' });
  }
  if (v.closed === false) flags.push({ label: t('queue.flags.outlineOpen'), tone: 'poor' });
  if (v.overrideReason) flags.push({ label: t('queue.flags.finishedEarly'), tone: 'poor' });
  if (v.weakWallCount > 0) {
    flags.push({ label: t('queue.flags.weakWalls', { count: v.weakWallCount }), tone: 'fair' });
  }
  if (v.source === 'simulated') flags.push({ label: t('queue.flags.simulated'), tone: 'fair' });
  return flags;
}

/**
 * The reviewer queue (REV-01). Accessibility (H-04): one h1, the summary
 * tiles as a labelled region, a captioned table with column headers,
 * every flag and tone in words, loading announced politely and failures as
 * alerts. Rows are not clickable themselves: each has a real button, so
 * the queue works from the keyboard alone.
 */
export default function QueuePage() {
  useTitle(t('queue.title'));
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
        <h1>{t('queue.title')}</h1>
        <span className="muted small">{t('queue.oldestFirst')}</span>
        <span className="spacer" />
        <button type="button" className="rv-button ghost" onClick={reload} disabled={loading}>
          <RefreshIcon size={15} />
          {loading ? t('common.refreshing') : t('common.refresh')}
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
          <div className="rv-empty" role="alert">
            <h2>{t('queue.loadFailed')}</h2>
            <p className="muted">{error.message}</p>
            <button type="button" className="rv-button primary" onClick={reload}>
              {t('common.tryAgain')}
            </button>
          </div>
        ) : !data ? (
          <div className="rv-empty" role="status" aria-live="polite">
            <span className="rv-spinner" aria-hidden="true" />
            <p className="muted">{t('queue.loading')}</p>
          </div>
        ) : (
          <>
            <Stats stats={data.stats} oldest={data.versions[0]} now={now} />
            {data.versions.length === 0 ? (
              <div className="rv-empty">
                <h2>{t('queue.clear')}</h2>
                <p className="muted">{t('queue.clearBody')}</p>
              </div>
            ) : (
              <QueueTable versions={data.versions} now={now} claiming={claiming} onOpen={open} />
            )}
            <p className="rv-footnote">{t('queue.footnote')}</p>
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
      label: t('queue.stats.waiting'),
      value: stats.waiting,
      note: t('queue.stats.unclaimed', { count: stats.unclaimed }),
    },
    {
      label: t('queue.stats.oldest'),
      value: oldest ? age(stats.oldestSubmittedAt, now) : t('common.dash'),
      note: oldest ? `${oldest.facility}, ${levelLabel(oldest.level)}` : t('queue.stats.nothingWaiting'),
      tone: oldestAgeH >= 2 ? 'poor' : undefined,
    },
    {
      label: t('queue.stats.median'),
      value: duration(median),
      note:
        stats.myReviewsThisWeek > 0
          ? t('queue.stats.reviews', { count: stats.myReviewsThisWeek })
          : t('queue.stats.noReviews'),
      tone: median == null ? undefined : median <= TARGET_SECONDS ? 'good' : 'poor',
    },
    {
      label: t('queue.stats.rejected'),
      value: stats.rejectedThisWeek,
      note: t('queue.stats.approved', { count: stats.approvedThisWeek }),
    },
  ];
  return (
    <section className="rv-stats" aria-label={t('queue.summary')}>
      {tiles.map((tile) => (
        <div className="rv-stat" key={tile.label}>
          <h2 className="eyebrow">{tile.label}</h2>
          <div className={`rv-stat-value ${tile.tone ?? ''}`}>
            {tile.value}
            {/* The colour says over or on target; so do these words. */}
            {tile.tone === 'poor' && <span className="sr-only"> {t('queue.stats.overTarget')}</span>}
            {tile.tone === 'good' && <span className="sr-only"> {t('queue.stats.onTarget')}</span>}
          </div>
          <div className="rv-stat-note">{tile.note}</div>
        </div>
      ))}
    </section>
  );
}

function QueueTable({ versions, now, claiming, onOpen }) {
  return (
    <div className="rv-table-wrap">
      <table className="rv-table">
        <caption className="sr-only">{t('queue.caption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('queue.columns.facility')}</th>
            <th scope="col">{t('queue.columns.input')}</th>
            <th scope="col">{t('queue.columns.confidence')}</th>
            <th scope="col">{t('queue.columns.flags')}</th>
            <th scope="col">{t('queue.columns.age')}</th>
            <th scope="col">{t('queue.columns.reviewer')}</th>
            <th scope="col">
              <span className="sr-only">{t('queue.columns.action')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => {
            const flags = flagsOf(v);
            const taken = v.reviewer && !v.reviewer.isMe;
            const action = v.reviewer?.isMe ? t('queue.continue') : t('queue.open');
            return (
              <tr key={v.id} className={taken ? 'taken' : undefined}>
                <td data-label="Facility">
                  <div className="rv-cell-title">
                    {v.facility} · {levelLabel(v.level)}
                    {v.version > 1 && <span className="rv-chip">v{v.version}</span>}
                  </div>
                  <div className="rv-cell-sub">
                    {t('queue.submitted', { organisation: v.organisation ?? v.account ?? '', time: time(v.submittedAt) })}
                  </div>
                </td>
                <td data-label="Input">
                  {inputLabel(v.inputType)}
                  {v.origin === 'revision' && <div className="rv-cell-sub">{t('queue.revision')}</div>}
                </td>
                <td data-label="Coverage">
                  <span className={`rv-coverage ${coverageTone(v.coverage)}`}>
                    <span className="rv-bar" aria-hidden="true">
                      <span style={{ width: percent(v.coverage === null ? 0 : v.coverage) }} />
                    </span>
                    {percent(v.coverage)}
                  </span>
                </td>
                <td data-label="Flags">
                  {flags.length === 0 ? (
                    <span className="good">{t('queue.none')}</span>
                  ) : (
                    <span className="rv-flags">
                      {flags.map((f) => (
                        <span key={f.label} className={`rv-flag ${f.tone}`}>
                          {f.label}
                        </span>
                      ))}
                    </span>
                  )}
                  {v.status === 'generation_failed' && (
                    <span className="rv-flag-failed">
                      {t('queue.failureReason', { reason: v.failureReason || t('queue.failureUnknown') })}
                    </span>
                  )}
                </td>
                <td data-label="Age">{age(v.submittedAt, now)}</td>
                <td data-label="Reviewer" className={v.reviewer ? 'muted' : undefined}>
                  {v.reviewer ? (v.reviewer.isMe ? t('queue.you') : v.reviewer.name) : t('queue.unclaimed')}
                </td>
                <td className="rv-action">
                  {taken ? (
                    <span className="rv-button disabled" aria-disabled="true">
                      {t('queue.taken')}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="rv-button primary"
                      onClick={() => onOpen(v)}
                      disabled={claiming !== null}
                      aria-label={t('queue.openLabel', { action, facility: v.facility, level: levelLabel(v.level) })}
                    >
                      {claiming === v.id ? t('queue.opening') : action}
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
