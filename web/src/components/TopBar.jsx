import { levelLabel } from '../lib/format.js';

export default function TopBar({ share }) {
  return (
    <header className="topbar">
      <span className="wordmark">FLEX</span>
      <span className="divider" aria-hidden="true" />
      {share ? (
        <h1 className="topbar-title">
          {share.site}
          <span className="topbar-level">{levelLabel(share.level)}</span>
        </h1>
      ) : (
        <span className="topbar-title muted">Gym walkthrough</span>
      )}
      <span className="spacer" />
      <span className="pill">Read-only</span>
    </header>
  );
}
