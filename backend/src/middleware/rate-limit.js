import { HttpError } from '../errors.js';

/**
 * A small fixed-window limiter kept in memory. Enough to blunt password
 * guessing on one instance; behind a load balancer, move it to a shared
 * store.
 */
export function rateLimit({ windowMs, max, key }) {
  const hits = new Map();

  return (req, _res, next) => {
    const now = Date.now();
    const k = key(req);
    const entry = hits.get(k);
    if (!entry || entry.resetAt <= now) {
      hits.set(k, { count: 1, resetAt: now + windowMs });
    } else if (++entry.count > max) {
      const minutes = Math.ceil((entry.resetAt - now) / 60000);
      return next(
        new HttpError(429, `Too many attempts. Try again in ${minutes} min.`, {
          code: 'rate_limited',
        }),
      );
    }
    // Keep the map from growing without bound.
    if (hits.size > 10000) {
      for (const [hk, v] of hits) if (v.resetAt <= now) hits.delete(hk);
    }
    next();
  };
}
