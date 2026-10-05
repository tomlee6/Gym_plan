import jwt from 'jsonwebtoken';

import { config } from '../config.js';
import { forbidden, unauthorised } from '../errors.js';

/** Issues a short-lived access token. */
export function signAccessToken(user) {
  return jwt.sign(
    { org: user.org_id, role: user.role },
    config.auth.jwtSecret,
    {
      subject: user.id,
      expiresIn: config.auth.accessTokenTtlSeconds,
      algorithm: 'HS256',
    },
  );
}

/**
 * Requires `Authorization: Bearer <access token>` and sets `req.user` to
 * `{ id, orgId, role }`. Every data query must filter on `req.user.orgId`.
 */
export function requireAuth(req, _res, next) {
  const header = req.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return next(unauthorised());
  try {
    const claims = jwt.verify(token, config.auth.jwtSecret, { algorithms: ['HS256'] });
    req.user = { id: claims.sub, orgId: claims.org, role: claims.role };
    next();
  } catch (err) {
    next(
      unauthorised(
        err.name === 'TokenExpiredError' ? 'Your session expired. Sign in again.' : 'Sign in again.',
      ),
    );
  }
}

export function requireRole(...roles) {
  return (req, _res, next) =>
    roles.includes(req.user?.role) ? next() : next(forbidden());
}
