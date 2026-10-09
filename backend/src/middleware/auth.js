import jwt from 'jsonwebtoken';

import { config } from '../config.js';
import { one, pool } from '../db/pool.js';
import { HttpError, forbidden, unauthorised } from '../errors.js';
import { isId } from '../ids.js';

/**
 * Issues a short-lived access token. It names the person and, for Flex
 * staff, their staff role; it never names an account, because one person
 * may act in several (B-04): each request says which with X-Account-Id.
 */
export function signAccessToken(user) {
  return jwt.sign({ staff: user.staff_role ?? null }, config.auth.jwtSecret, {
    subject: user.id,
    expiresIn: config.auth.accessTokenTtlSeconds,
    algorithm: 'HS256',
  });
}

/**
 * Requires `Authorization: Bearer <access token>` and sets `req.user` to
 * `{ id, staffRole }`.
 */
export function requireAuth(req, _res, next) {
  const header = req.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return next(unauthorised());
  try {
    const claims = jwt.verify(token, config.auth.jwtSecret, { algorithms: ['HS256'] });
    req.user = { id: claims.sub, staffRole: claims.staff ?? null };
    next();
  } catch (err) {
    next(
      unauthorised(
        err.name === 'TokenExpiredError' ? 'Your session expired. Sign in again.' : 'Sign in again.',
      ),
    );
  }
}

/** Flex staff only: reviewers and admins see every account. */
export function requireStaff(...roles) {
  return (req, _res, next) => (roles.includes(req.user?.staffRole) ? next() : next(forbidden()));
}

const noAccount = (msg) => new HttpError(403, msg, { code: 'no_account' });

/** The membership behind an `X-Account-Id`, or null. */
export function membershipOf(db, userId, accountId) {
  return one(
    db,
    `SELECT m.role, a.id, a.name FROM memberships m
     JOIN accounts a ON a.id = m.account_id
     JOIN users u ON u.id = m.user_id
     WHERE m.user_id = ? AND m.account_id = ? AND a.status = 'active' AND u.status = 'active'`,
    [userId, accountId],
  );
}

/**
 * Customer routes: the request names the gym account it acts on in
 * `X-Account-Id`, and the caller must be a member of it with one of
 * `roles`. Sets `req.account` to `{ id, name, role }`; every data query
 * then filters on `req.account.id` (tenant isolation, B-10).
 */
export function requireAccount(...roles) {
  return async (req, _res, next) => {
    try {
      const accountId = req.get('x-account-id');
      if (!accountId) throw noAccount('Choose an account to work in.');
      if (!isId(accountId)) throw noAccount('You do not have access to this account.');
      const m = await membershipOf(pool, req.user.id, accountId);
      if (!m) throw noAccount('You do not have access to this account.');
      if (roles.length && !roles.includes(m.role)) throw forbidden();
      req.account = { id: m.id, name: m.name, role: m.role };
      next();
    } catch (err) {
      next(err);
    }
  };
}
