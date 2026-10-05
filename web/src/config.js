/**
 * The backend's base URL. Empty means the same origin: in development Vite
 * forwards /v1 to the backend (vite.config.js). Set VITE_API_URL at build
 * time when the API lives elsewhere.
 */
export const API_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
