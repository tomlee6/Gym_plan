/**
 * Email notifications (ACC-04, D-07): plan ready for review (reviewers),
 * plan rejected (owners), walkthrough ready (owners), and invites. Sent
 * after the change has been committed; a failed email never undoes it.
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

async function ownersOf(db, accountId) {
  return many(
    db,
    `SELECT u.email, u.name FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.account_id = ? AND m.role = 'owner' AND u.status = 'active'`,
    [accountId],
  );
}

export function planReadyForReview(db, { label, versionId }) {
  return safely(async () => {
    const reviewers = await many(
      db,
      `SELECT email FROM users WHERE staff_role IN ('reviewer', 'admin') AND status = 'active'`,
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

export function planRejected(db, { accountId, label, reason, note, planId }) {
  return safely(async () => {
    for (const o of await ownersOf(db, accountId)) {
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

export function walkthroughReady(db, { accountId, label, planId }) {
  return safely(async () => {
    for (const o of await ownersOf(db, accountId)) {
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

/** An invite (B-05): access follows the first GoalCert sign-in with this email. */
export function invited({ email, accountName, role, expiresAt }) {
  return safely(() =>
    sendMail({
      to: email,
      subject: `You have been invited to ${accountName} on Flex Gym Scan`,
      text:
        `You have been invited to ${accountName} as ${role === 'owner' ? 'an owner' : 'a surveyor'}.\n\n` +
        `Sign in with your GoalCert account using this email address (${email}) at\n` +
        `${config.publicWebUrl}/login\n\nor in the Flex Gym Scan iPhone app. ` +
        `The invite works until ${expiresAt.toISOString().slice(0, 10)}.`,
    }),
  );
}
