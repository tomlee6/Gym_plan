import { date, levelLabel } from '../lib/format.js';
import { WarningIcon } from './Icons.jsx';

/** The PRD's standing caveat, pinned to the bottom of every walkthrough. */
export default function Disclaimer({ share }) {
  const approved = date(share?.approvedAt);
  return (
    <footer className="disclaimer">
      <span className="disclaimer-icon">
        <WarningIcon />
      </span>
      <span className="disclaimer-text">
        Indicative only — this walkthrough is not a certified drawing and must not be used for
        construction, compliance or lease measurement.
      </span>
      {share && (
        <span className="disclaimer-meta">
          {levelLabel(share.level)} · version {share.version}
          {approved && ` · approved ${approved}`}
        </span>
      )}
    </footer>
  );
}
