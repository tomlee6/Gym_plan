import { config } from './config.js';

/**
 * Outgoing email. The PRD says notifications go through GoalCert; until that
 * is wired up, messages are logged outside production so the flow can be
 * tested, and dropped in production with a warning.
 *
 * Tests read `sentMail` to check what would have gone out.
 */
export const sentMail = [];

export async function sendMail({ to, subject, text }) {
  sentMail.push({ to, subject, text });
  if (config.env === 'test') return;
  if (config.isProduction) {
    console.warn(`Email to ${to} not sent: no mail provider is configured.`);
    return;
  }
  console.log(`\n--- email to ${to}: ${subject}\n${text}\n---\n`);
}
