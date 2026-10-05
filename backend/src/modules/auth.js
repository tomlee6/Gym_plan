/**
 * Auth service: sign-in, token refresh, sign-out and password reset.
 *
 * Access tokens are JWTs valid for 30 minutes. Refresh tokens are random,
 * stored hashed, and rotated on every use; reusing an old one revokes every
 * session for that user, since it means the token was copied.
 *
 * The architecture doc moves sign-in to GoalCert. When that lands, replace
 * the password check in /login with the GoalCert exchange; tokens, refresh
 * and everything downstream stay as they are.
 */
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';

import { config } from '../config.js';
import { one, pool, transaction } from '../db/pool.js';
import { badRequest, unauthorised } from '../errors.js';
import { newId, newToken, sha256 } from '../ids.js';
import { sendMail } from '../mailer.js';
import { signAccessToken } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';

export const router = Router();

const BCRYPT_ROUNDS = 12;

// Compared against when the email is unknown, so a miss takes as long as a
// wrong password and does not reveal which emails have accounts.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

export const hashPassword = (password) => bcrypt.hash(password, BCRYPT_ROUNDS);

const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: 'Enter a valid email address.' }));

const password = z.string().min(8, 'Password must be at least 8 characters.').max(200);

export function initialsOf(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0][0], parts.at(-1)[0]] : [parts[0]?.[0] ?? '?'];
  return letters.join('').toUpperCase();
}

async function issueTokens(db, user) {
  const refreshToken = newToken();
  const expires = new Date(Date.now() + config.auth.refreshTokenTtlDays * 86400000);
  await db.query(
    'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)',
    [newId('rt'), user.id, sha256(refreshToken), expires],
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
      role: user.role,
    },
  };
}

const loginLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  // Tests sign in far more often than any person would.
  max: config.env === 'test' ? 1000 : 10,
  key: (req) => `${req.ip}|${String(req.body?.email ?? '').toLowerCase()}`,
});

router.post('/login', loginLimit, async (req, res) => {
  const body = z.object({ email, password: z.string().min(1).max(200) }).parse(req.body);

  const user = await one(pool, 'SELECT * FROM users WHERE email = ?', [body.email]);
  const ok = await bcrypt.compare(body.password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok || !user.active) {
    throw unauthorised('Incorrect email or password.');
  }

  res.json(await issueTokens(pool, user));
});

router.post('/refresh', async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string().min(10) }).parse(req.body);

  const result = await transaction(async (db) => {
    const row = await one(
      db,
      `SELECT rt.*, u.active FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = ? FOR UPDATE`,
      [sha256(refreshToken)],
    );
    if (!row) throw unauthorised();

    if (row.revoked_at) {
      // A rotated-out token came back: treat every session as compromised.
      await db.query(
        'UPDATE refresh_tokens SET revoked_at = NOW(3) WHERE user_id = ? AND revoked_at IS NULL',
        [row.user_id],
      );
      return null;
    }
    if (row.expires_at < new Date() || !row.active) throw unauthorised();

    await db.query('UPDATE refresh_tokens SET revoked_at = NOW(3) WHERE id = ?', [row.id]);
    const user = await one(db, 'SELECT * FROM users WHERE id = ?', [row.user_id]);
    return issueTokens(db, user);
  });

  if (!result) throw unauthorised();
  res.json(result);
});

router.post('/logout', async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string().min(1) }).parse(req.body);
  await pool.query(
    'UPDATE refresh_tokens SET revoked_at = NOW(3) WHERE token_hash = ? AND revoked_at IS NULL',
    [sha256(refreshToken)],
  );
  res.status(204).end();
});

const resetLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, key: (req) => req.ip });

/**
 * Always answers 202, whether or not the address has an account, so the
 * endpoint cannot be used to find out who the customers are.
 */
router.post('/password-reset', resetLimit, async (req, res) => {
  const body = z.object({ email }).parse(req.body);
  const user = await one(pool, 'SELECT id, email, name, active FROM users WHERE email = ?', [
    body.email,
  ]);

  if (user?.active) {
    const token = newToken();
    const expires = new Date(Date.now() + config.auth.passwordResetTtlMinutes * 60000);
    await pool.query(
      'INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)',
      [newId('pr'), user.id, sha256(token), expires],
    );
    await sendMail({
      to: user.email,
      subject: 'Reset your Flex Gym Scan password',
      text:
        `Hi ${user.name},\n\nUse this link to choose a new password. It works for ` +
        `${config.auth.passwordResetTtlMinutes} minutes.\n\n` +
        `${config.publicWebUrl}/reset-password?token=${token}\n\n` +
        'If you did not ask for this, ignore this email.',
    });
  }

  res.status(202).json({ message: 'If that address has an account, a reset link is on its way.' });
});

router.post('/password-reset/confirm', async (req, res) => {
  const body = z.object({ token: z.string().min(10), password }).parse(req.body);

  await transaction(async (db) => {
    const reset = await one(
      db,
      'SELECT * FROM password_resets WHERE token_hash = ? FOR UPDATE',
      [sha256(body.token)],
    );
    if (!reset || reset.used_at || reset.expires_at < new Date()) {
      throw badRequest('This reset link has expired. Ask for a new one.');
    }
    await db.query('UPDATE password_resets SET used_at = NOW(3) WHERE id = ?', [reset.id]);
    await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [
      await hashPassword(body.password),
      reset.user_id,
    ]);
    // Signed-in devices must sign in again with the new password.
    await db.query(
      'UPDATE refresh_tokens SET revoked_at = NOW(3) WHERE user_id = ? AND revoked_at IS NULL',
      [reset.user_id],
    );
  });

  res.status(204).end();
});
