/**
 * Auth service: sign-in through the provider (Amazon Cognito; see
 * hub/index.js), token refresh and sign-out (B-01, B-06). There are no
 * passwords here any more (B-03): the provider holds them. Users,
 * memberships, invites and sessions all live in this service's database.
 *
 *   GET  /v1/auth/hub/config   where to send the user, for the web and the app
 *   POST /v1/auth/hub          swap the Hub's one-time code for Flex tokens
 *   POST /v1/auth/refresh      rotate the refresh token
 *   POST /v1/auth/logout       end this session
 *
 * Access tokens are JWTs valid for 30 minutes. Refresh tokens are random,
 * stored as SHA-256 only, and replaced on every use; reusing an old one
 * ends every session of that user, since it means the token was copied.
 * Web sessions live for a working day, phone sessions slide for 60 days up
 * to an absolute limit (config.auth).
 */
import { Router } from 'express';
import { z } from 'zod';

import { audit } from '../audit.js';
import { config } from '../config.js';
import { many, one, pool, transaction } from '../db/pool.js';
import { HttpError, badRequest, unauthorised } from '../errors.js';
import { hub, hubRejected, verifyIdentity } from '../hub/index.js';
import { newId, newToken, sha256 } from '../ids.js';
import { signAccessToken } from '../middleware/auth.js';

export const router = Router();

export function initialsOf(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0][0], parts.at(-1)[0]] : [parts[0]?.[0] ?? '?'];
  return letters.join('').toUpperCase();
}

/** The gym accounts a user acts in, with their role in each. */
export function accountsOf(db, userId) {
  return many(
    db,
    `SELECT a.id, a.name, m.role FROM memberships m JOIN accounts a ON a.id = m.account_id
     WHERE m.user_id = ? AND a.status = 'active' ORDER BY a.name`,
    [userId],
  );
}

const DAY = 86400000;

/** How long a session of this client lives: sliding, and absolute. */
function lifetimes(client, now = Date.now()) {
  const rules = config.auth[client];
  const absolute = client === 'web' ? rules.absoluteHours * 3600000 : rules.absoluteDays * DAY;
  return { idle: new Date(now + rules.idleDays * DAY), absolute: new Date(now + absolute) };
}

/**
 * A new refresh token for `user`. `from` is the session being rotated: the
 * new one inherits its client, device and absolute limit, so refreshing can
 * never stretch a session past the limit it started with.
 */
async function issueTokens(db, user, { client, deviceLabel = null, hubSessionId = null, from = null }) {
  const refreshToken = newToken();
  const life = lifetimes(client);
  const absolute = from ? from.absolute_expires_at : life.absolute;
  const expires = life.idle < absolute ? life.idle : absolute;
  await db.query(
    `INSERT INTO sessions
       (id, user_id, token_hash, client, device_label, hub_session_id, expires_at, absolute_expires_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
    [newId(), user.id, sha256(refreshToken), client, deviceLabel, hubSessionId, expires, absolute],
  );
  return {
    accessToken: signAccessToken(user),
    refreshToken,
    expiresIn: config.auth.accessTokenTtlSeconds,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      initials: initialsOf(user.name),
      staffRole: user.staff_role ?? null,
    },
    accounts: await accountsOf(db, user.id),
  };
}

/** Ends every session a user has, e.g. when the Hub disables them. */
export function revokeSessions(db, userId) {
  return db.query(
    'UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL',
    [userId],
  );
}

router.get('/hub/config', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300').json({
    authorizeUrl: config.hub.authorizeUrl,
    clientId: config.hub.clientId,
    scope: config.hub.scope,
    redirectUris: { web: config.hub.webRedirectUri, ios: config.hub.iosRedirectUri },
  });
});

const hubBody = z.object({
  code: z.string().min(1).max(2000),
  // RFC 7636: 43 to 128 unreserved characters.
  codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/, 'A PKCE code verifier is required.'),
  redirectUri: z.string().url().max(500),
  nonce: z.string().min(8).max(200),
  client: z.enum(['web', 'ios']),
  deviceLabel: z.string().trim().max(100).nullish(),
});

/**
 * Links every open invite for this email to the user (B-05). Only a
 * verified email may claim an invite; after that the user is matched by
 * their Hub id alone, so a later change of email at the Hub changes nothing
 * here.
 */
async function acceptInvites(db, user, identity) {
  if (!identity.emailVerified || !identity.email) return;
  const invites = await many(
    db,
    `SELECT i.*, a.name AS account_name FROM invites i JOIN accounts a ON a.id = i.account_id
     WHERE i.open_email = ? AND i.expires_at > UTC_TIMESTAMP(3) AND a.status = 'active' FOR UPDATE`,
    [identity.email],
  );
  for (const inv of invites) {
    await db.query(
      `INSERT INTO memberships (account_id, user_id, role, created_by) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE role = memberships.role`,
      [inv.account_id, user.id, inv.role, inv.invited_by],
    );
    await db.query(
      'UPDATE invites SET accepted_at = UTC_TIMESTAMP(3), accepted_user_id = ? WHERE id = ?',
      [user.id, inv.id],
    );
    await audit(db, {
      accountId: inv.account_id,
      actor: { id: user.id, name: user.name },
      action: 'INVITE_ACCEPTED',
      target: { type: 'user', id: user.id, label: `${user.name} <${user.email}>` },
      detail: { role: inv.role },
    });
  }
}

router.post('/hub', async (req, res) => {
  const body = hubBody.parse(req.body);
  const allowed = body.client === 'web' ? config.hub.webRedirectUri : config.hub.iosRedirectUri;
  if (body.redirectUri !== allowed) throw badRequest('That sign-in came back to the wrong address.');

  let idToken;
  try {
    ({ idToken } = await hub().exchange(body));
  } catch {
    throw hubRejected('Your sign-in has expired or was already used. Sign in again.');
  }
  const identity = await verifyIdentity(idToken, { nonce: body.nonce });

  const result = await transaction(async (db) => {
    let user = await one(db, 'SELECT * FROM users WHERE hub_user_id = ? FOR UPDATE', [identity.sub]);
    if (!user) {
      const id = newId();
      await db.query('INSERT INTO users (id, hub_user_id, email, name) VALUES (?, ?, ?, ?)', [
        id,
        identity.sub,
        identity.email,
        identity.name,
      ]);
      user = await one(db, 'SELECT * FROM users WHERE id = ?', [id]);
    }
    if (user.status !== 'active') {
      throw new HttpError(403, 'Your access to Flex Gym Scan has been switched off.', { code: 'no_access' });
    }
    await db.query(
      'UPDATE users SET name = ?, email = ?, last_sign_in_at = UTC_TIMESTAMP(3) WHERE id = ?',
      [identity.name, identity.email || user.email, user.id],
    );
    user = { ...user, name: identity.name, email: identity.email || user.email };

    await acceptInvites(db, user, identity);
    const accounts = await accountsOf(db, user.id);
    if (!accounts.length && !user.staff_role) {
      // Rolls back the new user row too: nobody is created without access.
      throw new HttpError(
        403,
        'Your account has no access to Flex Gym Scan yet. Ask your account owner for an invite.',
        { code: 'no_access' },
      );
    }
    return issueTokens(db, user, {
      client: body.client,
      deviceLabel: body.deviceLabel ?? null,
      hubSessionId: identity.sid,
    });
  });

  res.json(result);
});

router.post('/refresh', async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string().min(10).max(200) }).parse(req.body);

  const result = await transaction(async (db) => {
    const row = await one(
      db,
      `SELECT s.*, u.status AS user_status FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? FOR UPDATE`,
      [sha256(refreshToken)],
    );
    if (!row) throw unauthorised();

    if (row.revoked_at) {
      // A rotated-out token came back: treat every session as compromised.
      await revokeSessions(db, row.user_id);
      return null;
    }
    const now = new Date();
    if (row.expires_at < now || row.absolute_expires_at < now || row.user_status !== 'active') {
      throw unauthorised();
    }

    await db.query('UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE id = ?', [row.id]);
    const user = await one(db, 'SELECT * FROM users WHERE id = ?', [row.user_id]);
    const accounts = await accountsOf(db, user.id);
    // Removed from every account since signing in: nothing left to do here.
    if (!accounts.length && !user.staff_role) throw unauthorised('You no longer have access. Sign in again.');
    return issueTokens(db, user, {
      client: row.client,
      deviceLabel: row.device_label,
      hubSessionId: row.hub_session_id,
      from: row,
    });
  });

  if (!result) throw unauthorised();
  res.json(result);
});

router.post('/logout', async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string().min(1).max(200) }).parse(req.body);
  await pool.query(
    'UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE token_hash = ? AND revoked_at IS NULL',
    [sha256(refreshToken)],
  );
  res.status(204).end();
});
