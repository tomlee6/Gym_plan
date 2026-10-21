/**
 * The signed-in session and every call the web app makes to the Gym Plan
 * backend (api-contract-v2).
 *
 * Sign-in goes through the GoalCert Hub (B-07): the page redirects to the
 * Hub with a PKCE challenge, the Hub sends the browser back to
 * /auth/callback with a code, and the backend swaps that code for Flex
 * tokens. Only the backend ever holds the Hub client secret.
 *
 * The access token lives in memory only. The refresh token is kept in the
 * tab's sessionStorage (B-06: web sessions are tab-only), so a reload stays
 * signed in but closing the tab signs out. Refresh tokens rotate and the
 * backend revokes every session if an old one is reused, so only one
 * refresh is ever in flight: every caller that finds the token expired
 * waits on the same one.
 *
 * A user may belong to several gym accounts. Customer calls name the one
 * being worked in with `X-Account-Id`; the choice is kept per tab too.
 */
import { API_URL, HUB_AUTHORIZE_URL, HUB_CLIENT_ID } from '../config.js';
import { codeChallenge, randomString } from './pkce.js';

const REFRESH_KEY = 'gymplan.refresh';
const ACCOUNT_KEY = 'gymplan.account';
const PENDING_KEY = 'gymplan.hubSignIn';

/** Paths that act inside one gym account and so carry X-Account-Id. */
const ACCOUNT_PATHS = [/^\/v1\/plans(\/|\?|$)/, /^\/v1\/captures(\/|\?|$)/, /^\/v1\/facilities(\/|\?|$)/, /^\/v1\/me(\?|$)/];

export class ApiError extends Error {
  constructor(message, status, body = null) {
    super(message);
    this.status = status;
    this.body = body;
  }

  get unauthorised() {
    return this.status === 401;
  }

  /** The backend's machine-readable reason, e.g. 'hub_rejected' or 'no_access'. */
  get code() {
    return this.body?.code ?? null;
  }
}

let accessToken = null;
let refreshing = null;
const listeners = new Set();

function readStore(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key, value) {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    // Storage blocked: the session just will not survive a reload.
  }
}

const readRefresh = () => readStore(REFRESH_KEY);
const writeRefresh = (token) => writeStore(REFRESH_KEY, token);

/** The gym account customer calls act in, or null (staff with none). */
export function currentAccountId() {
  return readStore(ACCOUNT_KEY);
}

/** Chooses the account customer calls act in from now on. */
export function setAccountId(id) {
  writeStore(ACCOUNT_KEY, id ?? null);
}

/**
 * Keeps the chosen account if the user still belongs to it, else picks the
 * first (for most people, the only) one.
 */
export function chooseAccount(accounts) {
  const list = accounts ?? [];
  const current = currentAccountId();
  const keep = list.find((a) => a.id === current);
  const id = keep ? keep.id : (list[0]?.id ?? null);
  setAccountId(id);
  return id;
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
  setAccountId(null);
  if (had) listeners.forEach((l) => l());
}

/**
 * Takes on a token pair from sign-in or refresh. Both answers list the
 * user's accounts, so a membership removed elsewhere drops out of the
 * choice on the next refresh.
 */
export function startSession(tokens) {
  accessToken = tokens.accessToken;
  writeRefresh(tokens.refreshToken);
  if (Array.isArray(tokens.accounts)) chooseAccount(tokens.accounts);
  return tokens;
}

function accountHeader(path) {
  const id = currentAccountId();
  return id && ACCOUNT_PATHS.some((re) => re.test(path)) ? { 'X-Account-Id': id } : {};
}

async function raw(method, path, body, token, { accept = 'application/json', headers = {} } = {}) {
  try {
    return await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        Accept: accept,
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(token && accountHeader(path)),
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
      startSession(await res.json());
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

/** A call that needs no sign-in (share links, the Hub settings). */
export async function publicRequest(method, path, body) {
  return decode(await raw(method, path, body, null));
}

/* ------------------------------------------------------------------ */
/* Sign-in through the GoalCert Hub (B-07)                              */

/**
 * The page's own navigation, behind one object so tests can watch it:
 * jsdom will not let window.location.assign be replaced.
 */
export const browser = {
  assign: (url) => window.location.assign(url),
};

/** Where the Hub sends the browser back to: the backend's word, else this origin. */
export function redirectUriFor(config) {
  return config?.redirectUris?.web || `${window.location.origin}/auth/callback`;
}

/** The Hub's settings, with any build-time overrides (H-05) applied. */
export async function hubConfig() {
  const config = await publicRequest('GET', '/v1/auth/hub/config');
  return {
    ...config,
    clientId: HUB_CLIENT_ID ?? config.clientId,
    authorizeUrl: HUB_AUTHORIZE_URL ?? config.authorizeUrl,
  };
}

/**
 * Starts a sign-in: makes state, nonce and a PKCE verifier, keeps them in
 * this tab's sessionStorage for the callback, and sends the whole page to
 * the Hub. `from` is where to land afterwards.
 *
 * Returns the URL it navigated to (useful in tests).
 */
export async function beginHubSignIn({ from = null } = {}) {
  const config = await hubConfig();
  const state = randomString(32);
  const nonce = randomString(32);
  const codeVerifier = randomString(64);
  const redirectUri = redirectUriFor(config);
  writeStore(PENDING_KEY, JSON.stringify({ state, nonce, codeVerifier, redirectUri, from }));

  // A relative URL (the dev Hub behind Vite's proxy) resolves against this page.
  const url = new URL(config.authorizeUrl, window.location.origin);
  const params = {
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: config.scope || 'openid profile email',
    state,
    nonce,
    code_challenge: await codeChallenge(codeVerifier),
    code_challenge_method: 'S256',
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  browser.assign(url.toString());
  return url.toString();
}

/** A sign-in that failed before or at the backend, with a code the page can explain. */
export class SignInError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Finishes a sign-in on /auth/callback. `search` is the callback's query
 * string. Checks `state` against the one this tab sent, then has the
 * backend redeem the code. Resolves to `{ tokens, from }`.
 *
 * The pending values are removed before the exchange: a code is good for
 * one try, and a retry must start a fresh sign-in.
 */
export async function completeHubSignIn(search) {
  const params = new URLSearchParams(search);
  const pending = (() => {
    try {
      return JSON.parse(readStore(PENDING_KEY) ?? 'null');
    } catch {
      return null;
    }
  })();
  writeStore(PENDING_KEY, null);

  const hubError = params.get('error');
  if (hubError) {
    throw new SignInError(hubError === 'access_denied' ? 'cancelled' : 'hub_error', params.get('error_description') ?? hubError);
  }
  const code = params.get('code');
  if (!pending || !code || params.get('state') !== pending.state) {
    throw new SignInError('state_mismatch', 'This sign-in was started in a different tab, or has expired.');
  }
  try {
    const tokens = await publicRequest('POST', '/v1/auth/hub', {
      code,
      codeVerifier: pending.codeVerifier,
      redirectUri: pending.redirectUri,
      nonce: pending.nonce,
      client: 'web',
    });
    startSession(tokens);
    return { tokens, from: pending.from ?? null };
  } catch (err) {
    if (err instanceof ApiError && err.code) throw new SignInError(err.code, err.message);
    throw err;
  }
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

/* ------------------------------------------------------------------ */
/* Endpoints                                                            */

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
  regenerate: (id) => request('POST', `/v1/review/versions/${enc(id)}/regenerate`, {}),
  // Machine models (L-07, L-08).
  machineModels: (machineId) => request('GET', `/v1/review/machines/${enc(machineId)}/models`),
  buildModel: (machineId, route) => request('POST', `/v1/review/machines/${enc(machineId)}/models`, route ? { route } : {}),
  approveModel: (modelId, note) => request('POST', `/v1/review/models/${enc(modelId)}/approve`, note ? { note } : {}),
  rejectModel: (modelId, note) => request('POST', `/v1/review/models/${enc(modelId)}/reject`, { note }),
  turnModel: (modelId, turnDeg) => request('POST', `/v1/review/models/${enc(modelId)}/turn`, { turnDeg }),
};

/** Platform admin (B-09). People are invited by email, never given a password. */
export const adminApi = {
  accounts: () => request('GET', '/v1/admin/accounts'),
  createAccount: (body) => request('POST', '/v1/admin/accounts', body),
  account: (id) => request('GET', `/v1/admin/accounts/${enc(id)}`),
  updateAccount: (id, body) => request('PATCH', `/v1/admin/accounts/${enc(id)}`, body),
  invite: (id, body) => request('POST', `/v1/admin/accounts/${enc(id)}/invites`, body),
  revokeInvite: (id, inviteId) => request('DELETE', `/v1/admin/accounts/${enc(id)}/invites/${enc(inviteId)}`),
  setMemberRole: (id, userId, role) =>
    request('PATCH', `/v1/admin/accounts/${enc(id)}/members/${enc(userId)}`, { role }),
  removeMember: (id, userId) => request('DELETE', `/v1/admin/accounts/${enc(id)}/members/${enc(userId)}`),
  addFacility: (id, name) => request('POST', `/v1/admin/accounts/${enc(id)}/facilities`, { name }),
  removeData: (id, confirmName) => request('POST', `/v1/admin/accounts/${enc(id)}/removal`, { confirmName }),
  staff: () => request('GET', '/v1/admin/staff'),
  setStaffRole: (userId, staffRole) => request('PUT', `/v1/admin/staff/${enc(userId)}`, { staffRole }),
  audit: (params = {}) => request('GET', `/v1/admin/audit${q(params)}`),
  auditCsv: (params = {}) => download(`/v1/admin/audit.csv${q(params)}`),
  reviewers: () => request('GET', '/v1/admin/reviewers'),
};

/** Test hook: forget everything held in memory and in this tab. */
export function resetForTests() {
  accessToken = null;
  refreshing = null;
  listeners.clear();
  writeRefresh(null);
  setAccountId(null);
  writeStore(PENDING_KEY, null);
}
