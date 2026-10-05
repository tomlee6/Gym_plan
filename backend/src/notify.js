/**
 * Email notifications (ACC-04): plan ready for review (reviewers), plan
 * rejected (owner), walkthrough ready (owner). Sent after the change has
 * been committed; a failed email never undoes a review.
 */
import { config } from './config.js';
import { many } from './db/pool.js';
import { sendMail } from './mailer.js';

async function safely(send) {
  try {
    await send();
  } catch (err) {
    console.error('Notification failed:', err);
  }
}

async function ownersOf(db, orgId) {
  return many(
    db,
    `SELECT email, name FROM users WHERE org_id = ? AND role = 'owner' AND active = 1`,
    [orgId],
  );
}

export function planReadyForReview(db, { label, versionId }) {
  return safely(async () => {
    const reviewers = await many(
      db,
      `SELECT email FROM users WHERE role IN ('reviewer', 'admin') AND active = 1`,
    );
    for (const r of reviewers) {
      await sendMail({
        to: r.email,
        subject: `Ready for review: ${label}`,
        text: `${label} is in the reviewer queue.\n\n${config.publicWebUrl}/review/versions/${versionId}`,
      });
    }
  });
}

export function planRejected(db, { orgId, label, reason, note, planId }) {
  return safely(async () => {
    for (const o of await ownersOf(db, orgId)) {
      await sendMail({
        to: o.email,
        subject: `Needs recapture: ${label}`,
        text:
          `Hi ${o.name},\n\n${label} was sent back for recapture.\n\n` +
          `Reason: ${reason}\n\n${note}\n\n${config.publicWebUrl}/plans/${planId}`,
      });
    }
  });
}

export function walkthroughReady(db, { orgId, label, planId }) {
  return safely(async () => {
    for (const o of await ownersOf(db, orgId)) {
      await sendMail({
        to: o.email,
        subject: `Walkthrough ready: ${label}`,
        text:
          `Hi ${o.name},\n\nThe plan for ${label} was approved and its walkthrough is ready.\n\n` +
          `${config.publicWebUrl}/plans/${planId}/walkthrough`,
      });
    }
  });
}
