/**
 * The signed-in session and every call the web app makes to the Gym Plan
 * backend.
 *
 * The access token lives in memory only. The refresh token is kept in
 * sessionStorage so a reload stays signed in but closing the tab signs out.
 * Refresh tokens rotate and the backend revokes every session if an old one
 * is reused, so only one refresh is ever in flight: every caller that finds
 * the token expired waits on the same one.
 */
import { API_URL } from '../config.js';

const REFRESH_KEY = 'gymplan.refresh';

export class ApiError extends Error {
  constructor(message, status, body = null) {
    super(message);
    this.status = status;
    this.body = body;
  }

  get unauthorised() {
    return this.status === 401;
  }
}

let accessToken = null;
let refreshing = null;
const listeners = new Set();

function readRefresh() {
  try {
    return sessionStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

function writeRefresh(token) {
  try {
    if (token) sessionStorage.setItem(REFRESH_KEY, token);
    else sessionStorage.removeItem(REFRESH_KEY);
  } catch {
    // Storage blocked: the session just will not survive a reload.
  }
}

/** Called with no arguments when the session ends. */
export function onSignedOut(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function endSession() {
  const had = accessToken !== null || readRefresh() !== null;
  accessToken = null;
  writeRefresh(null);
  if (had) listeners.forEach((l) => l());
}

function adopt(tokens) {
  accessToken = tokens.accessToken;
  writeRefresh(tokens.refreshToken);
  return tokens;
}

async function raw(method, path, body, token, { accept = 'application/json', headers = {} } = {}) {
  try {
    return await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        Accept: accept,
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...(token && { Authorization: `Bearer ${token}` }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('We could not reach the server. Check your connection.', null);
  }
}

async function decode(res) {
  if (res.status === 204) return null;
  const json = await res.json().catch(() => null);
  if (res.ok) return json;
  throw new ApiError(json?.message ?? `The server returned an error (${res.status}).`, res.status, json);
}

/** Swaps the stored refresh token for a new pair. False if the session is over. */
export function refresh() {
  refreshing ??= (async () => {
    const token = readRefresh();
    if (!token) return false;
    try {
      const res = await raw('POST', '/v1/auth/refresh', { refreshToken: token });
      if (!res.ok) {
        if (res.status === 401) endSession();
        return false;
      }
      adopt(await res.json());
      return true;
    } catch {
      return false;
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** An authenticated call, refreshing an expired access token once. Returns the Response. */
async function authed(method, path, body, options) {
  if (!accessToken && !(await refresh())) {
    throw new ApiError('Sign in to continue.', 401);
  }
  let res = await raw(method, path, body, accessToken, options);
  if (res.status === 401 && (await refresh())) {
    res = await raw(method, path, body, accessToken, options);
  }
  if (res.status === 401) endSession();
  return res;
}

/** An authenticated JSON call. */
export async function request(method, path, body) {
  return decode(await authed(method, path, body));
}

/** An authenticated download, as a Blob (e.g. the audit log CSV). */
export async function download(path) {
  const res = await authed('GET', path, undefined, { accept: '*/*' });
  if (!res.ok) await decode(res);
  return res.blob();
}

/** A call that needs no sign-in (share links). */
export async function publicRequest(method, path, body) {
  return decode(await raw(method, path, body, null));
}

export async function signIn(email, password) {
  const res = await raw('POST', '/v1/auth/login', { email: email.trim(), password });
  return adopt(await decode(res));
}

export async function signOut() {
  const token = readRefresh();
  endSession();
  if (token) {
    // Best effort: offline, the token simply expires.
    await raw('POST', '/v1/auth/logout', { refreshToken: token }).catch(() => {});
  }
}

export function hasStoredSession() {
  return readRefresh() !== null;
}

const q = (params) => {
  const s = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ).toString();
  return s ? `?${s}` : '';
};
const enc = encodeURIComponent;

export const meApi = {
  me: () => request('GET', '/v1/me'),
  facilities: () => request('GET', '/v1/facilities'),
};

/** Owner: status, history, walkthrough model, share links, uploads. */
export const plansApi = {
  list: () => request('GET', '/v1/plans'),
  get: (id) => request('GET', `/v1/plans/${enc(id)}`),
  model: (id) => request('GET', `/v1/plans/${enc(id)}/model`),
  share: (id) => request('POST', `/v1/plans/${enc(id)}/share-links`, {}),
  revokeShare: (id) => request('DELETE', `/v1/plans/${enc(id)}/share-links`),
};

/** Owner: uploading a drawing (mobile/docs/upload-api.md, via /drawings). */
export const capturesApi = {
  registerDrawing: (body, idempotencyKey) =>
    authed('POST', '/v1/captures/drawings', body, { headers: { 'Idempotency-Key': idempotencyKey } }).then(
      decode,
    ),
  openUploads: (captureId, body) => request('POST', `/v1/captures/${enc(captureId)}/uploads`, body),
  refreshParts: (captureId, body) =>
    request('POST', `/v1/captures/${enc(captureId)}/uploads/refresh`, body),
  complete: (captureId) => request('POST', `/v1/captures/${enc(captureId)}/complete`, {}),
};

/** Reviewer. */
export const reviewApi = {
  queue: () => request('GET', '/v1/review/queue'),
  version: (id) => request('GET', `/v1/review/versions/${enc(id)}`),
  start: (id) => request('POST', `/v1/review/versions/${enc(id)}/start`, {}),
  release: (id) => request('POST', `/v1/review/versions/${enc(id)}/release`, {}),
  activity: (id) => request('POST', `/v1/review/versions/${enc(id)}/activity`, {}),
  savePlan: (id, plan, revision) => request('PUT', `/v1/review/versions/${enc(id)}/plan`, { plan, revision }),
  approve: (id) => request('POST', `/v1/review/versions/${enc(id)}/approve`, {}),
  reject: (id, reason, note) => request('POST', `/v1/review/versions/${enc(id)}/reject`, { reason, note }),
  revise: (id) => request('POST', `/v1/review/versions/${enc(id)}/revise`, {}),
};

/** Platform admin. */
export const adminApi = {
  accounts: () => request('GET', '/v1/admin/accounts'),
  createAccount: (body) => request('POST', '/v1/admin/accounts', body),
  account: (id) => request('GET', `/v1/admin/accounts/${enc(id)}`),
  updateAccount: (id, body) => request('PATCH', `/v1/admin/accounts/${enc(id)}`, body),
  addUser: (id, body) => request('POST', `/v1/admin/accounts/${enc(id)}/users`, body),
  removeUser: (id, userId) => request('DELETE', `/v1/admin/accounts/${enc(id)}/users/${enc(userId)}`),
  addFacility: (id, name) => request('POST', `/v1/admin/accounts/${enc(id)}/facilities`, { name }),
  removeData: (id, confirmName) => request('POST', `/v1/admin/accounts/${enc(id)}/removal`, { confirmName }),
  audit: (params = {}) => request('GET', `/v1/admin/audit${q(params)}`),
  auditCsv: (params = {}) => download(`/v1/admin/audit.csv${q(params)}`),
  reviewers: () => request('GET', '/v1/admin/reviewers'),
};

/** Test hook: forget everything held in memory. */
export function resetForTests() {
  accessToken = null;
  refreshing = null;
  listeners.clear();
  writeRefresh(null);
}
