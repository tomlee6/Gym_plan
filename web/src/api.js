/**
 * The one backend call this page makes: `GET /v1/share/:token`
 * (backend/src/modules/share.js). No sign-in; the token is the credential.
 */
import { API_URL } from './config.js';

/** Why a share could not be loaded, and whether trying again can help. */
export class ShareError extends Error {
  constructor(message, { notFound = false, retryable = true } = {}) {
    super(message);
    this.notFound = notFound;
    this.retryable = retryable;
  }
}

export async function fetchShare(token, { signal } = {}) {
  let res;
  try {
    res = await fetch(`${API_URL}/v1/share/${encodeURIComponent(token)}`, {
      headers: { Accept: 'application/json' },
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ShareError('We could not reach the server. Check your connection.');
  }

  const body = await res.json().catch(() => null);
  if (res.ok && body) return body;
  if (res.status === 404) {
    throw new ShareError('This link is no longer available.', { notFound: true, retryable: false });
  }
  throw new ShareError(body?.message ?? `The server returned an error (${res.status}).`, {
    retryable: res.status >= 500 || res.status === 429,
  });
}

/** The token from a `/s/<token>` path, or null. */
export function tokenFromPath(pathname) {
  const match = /^\/s\/([A-Za-z0-9_-]{8,128})\/?$/.exec(pathname);
  return match ? match[1] : null;
}
