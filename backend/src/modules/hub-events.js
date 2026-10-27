/**
 * Events from the GoalCert Hub (B-02).
 *
 *   POST /v1/hub/events
 *
 * The Hub signs each delivery: `X-Hub-Timestamp` (Unix seconds) and
 * `X-Hub-Signature: sha256=<hex>`, the HMAC-SHA256 of
 * `<timestamp>.<raw body>` with the shared events secret. A delivery more
 * than five minutes old is refused, so a captured one cannot be replayed
 * later; each event id is recorded and processed once, so the Hub may
 * safely deliver the same event twice.
 *
 * Body: `{ id, type, data: { sub, email?, name?, sid? } }`
 *
 *   user.updated   refresh the name and email
 *   user.disabled  switch the user off and end every Flex session
 *   user.deleted   the same; the row stays so approvals remain attributable
 *   user.enabled   switch them back on
 *   session.ended  a Hub sign-out: ends the web sessions from that Hub
 *                  session (the phone's are kept: O-03 decides otherwise)
 */
import { createHmac } from 'node:crypto';

import express, { Router } from 'express';
import { z } from 'zod';

import { audit } from '../audit.js';
import { config } from '../config.js';
import { one, transaction } from '../db/pool.js';
import { HttpError } from '../errors.js';
import { safeEqual } from '../ids.js';
import { revokeSessions } from './auth.js';

export const router = Router();

const MAX_SKEW_SECONDS = 300;

/** The signature header value for a body, as the Hub computes it. */
export function signHubEvent(body, timestamp, secret = config.hub.eventsSecret) {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

const badSignature = () => new HttpError(401, 'Bad signature.', { code: 'bad_signature' });

const eventBody = z.object({
  id: z.string().min(1).max(64),
  type: z.string().min(1).max(40),
  data: z
    .object({
      sub: z.string().min(1).max(64).optional(),
      email: z.string().max(254).optional(),
      name: z.string().max(200).optional(),
      sid: z.string().max(64).optional(),
    })
    .passthrough()
    .default({}),
});

// The signature covers the exact bytes, so this route reads the raw body.
router.post('/events', express.raw({ type: '*/*', limit: '64kb' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const timestamp = Number(req.get('x-hub-timestamp'));
  const signature = req.get('x-hub-signature') ?? '';
  if (!config.hub.eventsSecret || !Number.isInteger(timestamp)) throw badSignature();
  if (Math.abs(Date.now() / 1000 - timestamp) > MAX_SKEW_SECONDS) throw badSignature();
  if (!safeEqual(signature, signHubEvent(raw, timestamp))) throw badSignature();

  let event;
  try {
    event = eventBody.parse(JSON.parse(raw));
  } catch {
    throw new HttpError(400, 'The event is not valid.', { code: 'invalid' });
  }

  const outcome = await transaction(async (db) => {
    const [ins] = await db.query('INSERT IGNORE INTO hub_events (event_id, type) VALUES (?, ?)', [
      event.id,
      event.type,
    ]);
    if (!ins.affectedRows) return 'duplicate';

    const user = event.data.sub
      ? await one(db, 'SELECT * FROM users WHERE hub_user_id = ? FOR UPDATE', [event.data.sub])
      : null;
    if (!user) return 'ignored';

    const log = (action, detail = null) =>
      audit(db, {
        accountId: null,
        actor: null,
        action,
        target: { type: 'user', id: user.id, label: `${user.name} <${user.email}>` },
        detail: { hubEvent: event.id, ...detail },
      });

    switch (event.type) {
      case 'user.updated': {
        const email = event.data.email?.trim().toLowerCase() || user.email;
        const name = event.data.name?.trim() || user.name;
        await db.query('UPDATE users SET email = ?, name = ? WHERE id = ?', [email, name, user.id]);
        await log('USER_UPDATED_BY_HUB');
        return 'applied';
      }
      case 'user.disabled':
      case 'user.deleted':
        await db.query(`UPDATE users SET status = 'disabled' WHERE id = ?`, [user.id]);
        await revokeSessions(db, user.id);
        await log(event.type === 'user.deleted' ? 'USER_DELETED_BY_HUB' : 'USER_DISABLED_BY_HUB');
        return 'applied';
      case 'user.enabled':
        await db.query(`UPDATE users SET status = 'active' WHERE id = ?`, [user.id]);
        await log('USER_ENABLED_BY_HUB');
        return 'applied';
      case 'session.ended':
        if (event.data.sid) {
          await db.query(
            `UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3)
             WHERE user_id = ? AND hub_session_id = ? AND client = 'web' AND revoked_at IS NULL`,
            [user.id, event.data.sid],
          );
        }
        return 'applied';
      default:
        return 'ignored';
    }
  });

  res.json({ received: true, outcome });
});
