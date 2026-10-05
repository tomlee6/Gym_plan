import { CubeIcon, LinkOffIcon, WarningIcon } from './Icons.jsx';

export function Loading() {
  return (
    <div className="status" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <p className="muted">Loading walkthrough…</p>
    </div>
  );
}

export function Unavailable() {
  return (
    <div className="status">
      <div className="empty-card">
        <span className="empty-icon">
          <LinkOffIcon size={26} />
        </span>
        <h2>This link is no longer available</h2>
        <p>
          It may have expired, been revoked or mistyped. Ask the person who shared it for a new
          link.
        </p>
      </div>
    </div>
  );
}

/** Approved, but the walkthrough cannot be built from it yet. */
export function NotReady() {
  return (
    <div className="status">
      <div className="empty-card">
        <span className="empty-icon">
          <CubeIcon size={26} />
        </span>
        <h2>The 3D walkthrough is on its way</h2>
        <p>This plan has been approved and its walkthrough is still being generated. Open this link again in a little while.</p>
      </div>
    </div>
  );
}

export function LoadFailed({ error, onRetry }) {
  return (
    <div className="status">
      <div className="empty-card">
        <span className="empty-icon warn">
          <WarningIcon size={26} />
        </span>
        <h2>The walkthrough could not be loaded</h2>
        <p>{error.message}</p>
        {error.retryable && (
          <button type="button" className="primary-button" onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}
