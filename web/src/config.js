/**
 * Build-time settings (H-05). Everything here is optional: an empty value
 * means "ask the backend" or "same origin".
 *
 * - VITE_API_URL: the backend's base URL. Empty means the same origin: in
 *   development Vite forwards /v1 to the backend (vite.config.js).
 * - VITE_HUB_CLIENT_ID, VITE_HUB_AUTHORIZE_URL: override what
 *   GET /v1/auth/hub/config says about the GoalCert Hub. Normally left unset
 *   so the backend stays the one place the Hub client is configured; set
 *   them only to point a build at a different Hub without touching the API.
 */
const env = import.meta.env ?? {};

const clean = (value) => (typeof value === 'string' ? value.trim() : '');

export const API_URL = clean(env.VITE_API_URL).replace(/\/$/, '');

export const HUB_CLIENT_ID = clean(env.VITE_HUB_CLIENT_ID) || null;

export const HUB_AUTHORIZE_URL = clean(env.VITE_HUB_AUTHORIZE_URL) || null;
