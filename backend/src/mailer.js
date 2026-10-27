/**
 * Outgoing email (D-07): Amazon SES in Sydney in production, the console
 * everywhere else.
 *
 * SES is reached through its v2 API with the task's IAM role; the sending
 * domain's SPF, DKIM and DMARC records are set up by the infrastructure
 * (M-09). Bounces and complaints go to the configuration set's event
 * destination (see docs/runbooks/ses-bounces.md).
 *
 * Tests read `sentMail` to check what would have gone out.
 */
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';

import { config } from './config.js';

export const sentMail = [];

let ses;

/** Tests may swap the SES client for a fake. */
export function setSesClient(client) {
  ses = client;
}

export async function sendMail({ to, subject, text }) {
  sentMail.push({ to, subject, text });
  if (config.env === 'test' && config.mail.driver !== 'ses') return;
  if (config.mail.driver !== 'ses') {
    console.log(`\n--- email to ${to}: ${subject}\n${text}\n---\n`);
    return;
  }
  ses ??= new SESv2Client({ region: config.awsRegion });
  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: config.mail.from,
      Destination: { ToAddresses: [to] },
      ...(config.mail.configurationSet && { ConfigurationSetName: config.mail.configurationSet }),
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: { Text: { Data: text, Charset: 'UTF-8' } },
        },
      },
    }),
  );
}
