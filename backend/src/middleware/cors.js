import { config } from '../config.js';

/**
 * Lets the web app (web/: share viewer and reviewer pages) call the API
 * from its own origin, PUBLIC_WEB_URL, and no other. Bearer tokens travel
 * in the Authorization header, not cookies, so credentials stay off.
 */
export function cors(req, res, next) {
  res.vary('Origin');
  if (req.get('origin') !== config.publicWebUrl) return next();

  res.set('Access-Control-Allow-Origin', config.publicWebUrl);
  if (req.method === 'OPTIONS') {
    res.set({
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key',
      'Access-Control-Max-Age': '600',
    });
    return res.status(204).end();
  }
  next();
}
