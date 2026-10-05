import { useEffect, useId, useRef } from 'react';

/**
 * A modal dialog: focus moves in on open and back on close, Escape and the
 * backdrop close it unless `busy`.
 */
export default function Modal({ title, subtitle, onClose, busy = false, children, footer }) {
  const titleId = useId();
  const panel = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    const before = document.activeElement;
    const first = panel.current?.querySelector(
      'input, textarea, button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    );
    (first ?? panel.current)?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape' && !busyRef.current) closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      before?.focus?.();
    };
  }, []);

  return (
    <div
      className="rv-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="rv-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panel}
        tabIndex={-1}
      >
        <div className="rv-modal-head">
          <h2 id={titleId}>{title}</h2>
          {subtitle && <p className="muted small">{subtitle}</p>}
        </div>
        <div className="rv-modal-body">{children}</div>
        <div className="rv-modal-foot">{footer}</div>
      </div>
    </div>
  );
}
