import { useState } from 'react';

import { summary } from '@shared/plan/index.js';

import { duration, inputLabel, levelLabel, stamp } from '../lib/format.js';
import { CheckIcon, XIcon } from '../lib/icons.jsx';
import Modal from '../lib/Modal.jsx';

/** Hint shown under "Other", which needs the note to say why. */
const REASON_HINTS = { Other: 'Explain in the note' };

/**
 * Approve (REV-05..07): only when validation passes and every flag is
 * cleared. Shows exactly what the approval records.
 */
export function ApproveDialog({ version: v, plan, reviewer, seconds, blockers, onCancel, onConfirm }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const s = summary(plan);
  const flags = plan.flags.length;
  const blocked = blockers.length > 0;

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(err.body?.blockers?.join(' ') || err.message);
      setBusy(false);
    }
  }

  const checks = [
    {
      ok: !blockers.some((b) => !/flagged/.test(b)),
      text: 'Validation passed — outline closed, no crossing walls, every opening attached',
    },
    {
      ok: s.openFlags === 0,
      text: flags ? `All ${flags} flagged element${flags > 1 ? 's' : ''} confirmed, edited or deleted` : 'Nothing was flagged',
    },
    {
      ok: true,
      text: `Scale: ${s.scale.toLowerCase()} · ceiling height ${plan.ceilingHeightM.toFixed(2)} m${s.ceilingFromTag ? ' from a tag' : ''}`,
    },
  ];

  return (
    <Modal
      title={`Approve version ${v.version}`}
      subtitle={`${v.facility} · ${levelLabel(v.level)} · ${inputLabel(v.inputType)}`}
      onClose={onCancel}
      busy={busy}
      footer={
        <>
          <button type="button" className="rv-button ghost" onClick={onCancel} disabled={busy}>
            Back to editing
          </button>
          <button type="button" className="rv-button primary" onClick={confirm} disabled={busy || blocked}>
            <CheckIcon size={15} />
            {busy ? 'Approving…' : 'Approve and generate'}
          </button>
        </>
      }
    >
      <ul className="rv-checks">
        {checks.map((c) => (
          <li key={c.text} className={c.ok ? 'good' : 'poor'}>
            {c.ok ? <CheckIcon size={15} /> : <XIcon size={15} />}
            <span>{c.text}</span>
          </li>
        ))}
      </ul>
      {blocked && (
        <div className="rv-error" role="alert">
          <strong>Not yet:</strong>
          <ul className="ed-blockers">
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="eyebrow">THIS APPROVAL IS RECORDED AS</div>
      <dl className="rv-record">
        <div>
          <dt>Reviewer</dt>
          <dd>{reviewer.name}</dd>
        </div>
        <div>
          <dt>Timestamp</dt>
          <dd>{stamp(new Date())}</dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd>{v.version > 1 ? `${v.version} — supersedes ${v.version - 1}` : v.version}</dd>
        </div>
        <div>
          <dt>Content hash</dt>
          <dd>SHA-256 of the plan, set on approval</dd>
        </div>
        <div>
          <dt>Your time on this plan</dt>
          <dd>{duration(seconds)}</dd>
        </div>
        <div>
          <dt>Floor area</dt>
          <dd>{s.areaM2 ? `${s.areaM2} m²` : '—'}</dd>
        </div>
      </dl>
      <p className="small muted">
        Once approved this version becomes read-only and its walkthrough is generated from it. Any later change
        creates version {v.version + 1} and supersedes this one.
      </p>
      {error && (
        <p className="rv-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}

/** Reject (REV-08): a reason code and a note, both shown to the owner. */
export function RejectDialog({ version: v, reasons, onCancel, onConfirm }) {
  const [reason, setReason] = useState(reasons[0]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const noteOk = note.trim().length >= 3;

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason, note.trim());
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Send back for recapture"
      subtitle={`${v.facility} · ${levelLabel(v.level)}`}
      onClose={onCancel}
      busy={busy}
      footer={
        <>
          <button type="button" className="rv-button ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="rv-button danger" onClick={confirm} disabled={busy || !noteOk}>
            {busy ? 'Sending back…' : 'Reject and notify owner'}
          </button>
        </>
      }
    >
      <fieldset className="rv-reasons">
        <legend className="eyebrow">REASON CODE — REQUIRED</legend>
        {reasons.map((r) => (
          <label key={r} className={`rv-reason ${reason === r ? 'selected' : ''}`}>
            <input type="radio" name="reason" value={r} checked={reason === r} onChange={() => setReason(r)} />
            <span>
              {r}
              {REASON_HINTS[r] && <span className="muted"> — {REASON_HINTS[r].toLowerCase()}</span>}
            </span>
          </label>
        ))}
      </fieldset>

      <label className="rv-field">
        <span className="eyebrow">NOTE — THE OWNER READS THIS</span>
        <textarea
          rows={5}
          value={note}
          maxLength={4000}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What is wrong, and how to rescan it. For example: the north-east corner is missing about 6 m of wall; rewalk it slowly with the phone at waist height."
        />
      </label>
      <p className="small muted">
        The owner sees the reason code and this note word for word on their status page and in the app. Both are
        recorded against you and this plan version.
      </p>
      {error && (
        <p className="rv-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
