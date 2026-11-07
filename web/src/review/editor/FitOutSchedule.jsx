import { useMemo, useState } from 'react';

import { fitOutSchedule, scheduleCsv } from './fitOut.js';

/** Saves `text` as a file in the browser's downloads. */
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * The fit-out schedule: every machine on the plan, what to order, and any
 * machine short of its safe floor clearance. Shown read-only too, so an
 * installer opening an approved plan can take the schedule away as CSV.
 */
export default function FitOutSchedule({ plan, onSelect, library, fileName = 'fit-out-schedule.csv' }) {
  const [open, setOpen] = useState(false);
  const schedule = useMemo(() => fitOutSchedule(plan, library ?? undefined), [plan, library]);
  if (!schedule.lines.length) return null;

  return (
    <section className="ed-card ed-library" aria-label="Fit-out schedule">
      <button type="button" className="ed-card-head ed-library-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <h2>Fit-out schedule</h2>
        <span className={`ed-count ${schedule.problems ? '' : 'good'}`}>
          {schedule.problems ? `${schedule.problems} to check` : `${schedule.lines.length} machines`}
        </span>
      </button>
      {!open && (
        <p className="muted small">
          {schedule.lines.length} machines on the plan
          {schedule.problems ? `, ${schedule.problems} to check for clearance` : ', all with their safe clearance'}.
        </p>
      )}
      {open && (
        <div className="ed-library-body">
          <button type="button" className="rv-button small" onClick={() => download(fileName, scheduleCsv(schedule))}>
            Download CSV
          </button>
          <div className="ed-library-group">
            <h3>To order</h3>
            <ul className="ed-fitout-counts">
              {schedule.counts.map((c) => (
                <li key={c.name}>
                  <span>{c.name}</span>
                  <strong>× {c.count}</strong>
                </li>
              ))}
            </ul>
          </div>
          <div className="ed-library-group">
            <h3>Machines</h3>
            <ul className="ed-unplaced">
              {schedule.lines.map((l) => (
                <li key={l.id} className={l.issues.length ? 'ed-fitout-issue' : undefined}>
                  <button type="button" className="ed-fitout-line" onClick={() => onSelect?.(l.id)} aria-label={`Select ${l.name} ${l.ref} on the plan`}>
                    <span className="ed-unplaced-text">
                      <strong>
                        {l.name} <span className="muted small">{l.ref}</span>
                      </strong>
                      <span className="muted small">
                        {l.widthM?.toFixed(2)} × {l.depthM?.toFixed(2)} m{l.room ? ` · ${l.room}` : ''}
                        {l.wallGapM != null ? ` · ${l.wallGapM.toFixed(2)} m to wall` : ''}
                      </span>
                      {l.issues.map((issue) => (
                        <span key={issue} className="ed-fitout-warning small">
                          {issue}
                        </span>
                      ))}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
