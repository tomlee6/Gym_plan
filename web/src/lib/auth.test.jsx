/**
 * B-07 and the account switcher: sign-in through the GoalCert Hub with
 * PKCE, the /auth/callback route, X-Account-Id on customer calls, and
 * switching between gym accounts.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AuthCallbackPage from './AuthCallbackPage.jsx';
import { AuthProvider, hasRole, homeFor } from './auth.jsx';
import * as client from './client.js';
import Layout from './Layout.jsx';
import LoginPage from './LoginPage.jsx';
import { codeChallenge } from './pkce.js';
import RequireRole from './RequireRole.jsx';

const ACCOUNTS = [
  { id: 'acc_ng', name: 'Northgate Group', role: 'owner' },
  { id: 'acc_kh', name: 'Kestrel Health', role: 'surveyor' },
];

const SAM = { id: 'usr_sam', name: 'Sam Okafor', email: 'sam@example.test', initials: 'SO', staffRole: null };
const MAYA = { id: 'usr_maya', name: 'Maya Restrepo', email: 'maya@flex.test', initials: 'MR', staffRole: 'reviewer' };

const CONFIG = {
  authorizeUrl: 'https://hub.test/oauth/authorize',
  clientId: 'flex-gym-web',
  scope: 'openid profile email',
  redirectUris: { web: 'https://gym.test/auth/callback', ios: 'flexgymscan://auth/callback' },
};

/** A fake backend for sign-in. `who` is whoever the Hub signs in as. */
function fakeBackend({ who = SAM, accounts = ACCOUNTS, hubError = null } = {}) {
  const calls = [];
  const json = (status, body) => Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body) });
  const fetch = vi.fn((url, init = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body, headers: init.headers ?? {} });
    if (path === '/v1/auth/hub/config') return json(200, CONFIG);
    if (path === '/v1/auth/hub') {
      if (hubError === 'no_access') return json(403, { code: 'no_access', message: 'No access.' });
      if (hubError === 'hub_rejected') return json(401, { code: 'hub_rejected', message: 'Rejected.' });
      return json(200, { accessToken: 'a1', refreshToken: 'r1', expiresIn: 1800, user: who, accounts });
    }
    if (path === '/v1/auth/logout') return json(204);
    if (path === '/v1/me') {
      const id = init.headers?.['X-Account-Id'];
      const account = accounts.find((a) => a.id === id) ?? null;
      return json(200, { ...who, accounts, account: account && { ...account, plansUsed: 1, planQuota: 10 } });
    }
    if (path === '/v1/plans') return json(200, { plans: [] });
    if (path === '/v1/review/queue') return json(200, { versions: [] });
    return json(404, { message: 'Not found.' });
  });
  fetch.calls = calls;
  return fetch;
}

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname}</div>;
}

function Page({ name }) {
  return <p>{name}</p>;
}

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/auth/callback" element={<AuthCallbackPage />} />
          <Route
            element={
              <RequireRole>
                <Layout />
              </RequireRole>
            }
          >
            <Route
              path="/plans/*"
              element={
                <RequireRole roles={['owner', 'surveyor']}>
                  <Page name="Plans page" />
                </RequireRole>
              }
            />
            <Route
              path="/review"
              element={
                <RequireRole roles={['reviewer', 'admin']}>
                  <Page name="Queue page" />
                </RequireRole>
              }
            />
            <Route path="/admin" element={<Outlet />} />
          </Route>
        </Routes>
        <Where />
      </AuthProvider>
    </MemoryRouter>,
  );
}

let assign;
beforeEach(() => {
  client.resetForTests();
  assign = vi.spyOn(client.browser, 'assign').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Clicks the sign-in button and returns the Hub URL the page went to. */
async function startSignIn() {
  fireEvent.click(await screen.findByRole('button', { name: 'Sign in with GoalCert' }));
  await waitFor(() => expect(assign).toHaveBeenCalled());
  return new URL(assign.mock.calls.at(-1)[0]);
}

describe('signing in through the Hub', () => {
  it('has no password field: only a GoalCert button', async () => {
    vi.stubGlobal('fetch', fakeBackend());
    renderAt('/login');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    expect(screen.queryByText(/forgot/i)).toBeNull();
  });

  it('redirects to the Hub with state, nonce and an S256 PKCE challenge', async () => {
    vi.stubGlobal('fetch', fakeBackend());
    renderAt('/login');
    const url = await startSignIn();
    expect(url.origin + url.pathname).toBe('https://hub.test/oauth/authorize');
    const p = url.searchParams;
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe('flex-gym-web');
    expect(p.get('redirect_uri')).toBe('https://gym.test/auth/callback');
    expect(p.get('scope')).toBe('openid profile email');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('state')).toMatch(/^[A-Za-z0-9\-._~]{32}$/);
    expect(p.get('nonce')).toMatch(/^[A-Za-z0-9\-._~]{32}$/);

    // The verifier stays in this tab; the Hub sees only its SHA-256.
    const pending = JSON.parse(sessionStorage.getItem('gymplan.hubSignIn'));
    expect(pending.state).toBe(p.get('state'));
    expect(pending.nonce).toBe(p.get('nonce'));
    expect(pending.codeVerifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(p.get('code_challenge')).toBe(await codeChallenge(pending.codeVerifier));
    expect(url.toString()).not.toContain(pending.codeVerifier);
  });

  it('falls back to this origin’s /auth/callback when the backend names no web redirect', async () => {
    const fetch = fakeBackend();
    vi.stubGlobal('fetch', fetch);
    const original = fetch.getMockImplementation();
    fetch.mockImplementation((url, init) =>
      url.endsWith('/v1/auth/hub/config')
        ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ...CONFIG, redirectUris: {} }) })
        : original(url, init),
    );
    renderAt('/login');
    const url = await startSignIn();
    expect(url.searchParams.get('redirect_uri')).toBe(`${window.location.origin}/auth/callback`);
  });

  it('finishes on /auth/callback: checks state, redeems the code and goes home', async () => {
    const fetch = fakeBackend();
    vi.stubGlobal('fetch', fetch);
    renderAt('/login');
    const url = await startSignIn();
    cleanup();

    renderAt(`/auth/callback?code=c0de&state=${url.searchParams.get('state')}`);
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/plans'));
    expect(await screen.findByText('Plans page')).toBeInTheDocument();

    const exchange = fetch.calls.find((c) => c.path === '/v1/auth/hub');
    const pending = { nonce: url.searchParams.get('nonce') };
    expect(exchange.body).toMatchObject({ code: 'c0de', redirectUri: 'https://gym.test/auth/callback', nonce: pending.nonce, client: 'web' });
    expect(exchange.body.codeVerifier).toMatch(/^[A-Za-z0-9\-._~]{64}$/);
    // The verifier is single use and gone from storage.
    expect(sessionStorage.getItem('gymplan.hubSignIn')).toBeNull();
    // Tab-only session (B-06): the refresh token is in sessionStorage.
    expect(sessionStorage.getItem('gymplan.refresh')).toBe('r1');
    expect(fetch.calls.filter((c) => c.path === '/v1/auth/hub')).toHaveLength(1);
  });

  it('sends a reviewer to the queue', async () => {
    vi.stubGlobal('fetch', fakeBackend({ who: MAYA, accounts: [] }));
    renderAt('/login');
    const url = await startSignIn();
    cleanup();
    renderAt(`/auth/callback?code=c&state=${url.searchParams.get('state')}`);
    expect(await screen.findByText('Queue page')).toBeInTheDocument();
  });

  it('refuses a callback whose state does not match, and offers a retry', async () => {
    const fetch = fakeBackend();
    vi.stubGlobal('fetch', fetch);
    renderAt('/login');
    await startSignIn();
    cleanup();
    assign.mockClear();

    renderAt('/auth/callback?code=c0de&state=forged');
    expect(await screen.findByRole('alert')).toHaveTextContent(/different tab or has expired/);
    expect(fetch.calls.some((c) => c.path === '/v1/auth/hub')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
  });

  it('explains no_access plainly', async () => {
    vi.stubGlobal('fetch', fakeBackend({ hubError: 'no_access' }));
    renderAt('/login');
    const url = await startSignIn();
    cleanup();
    renderAt(`/auth/callback?code=c&state=${url.searchParams.get('state')}`);
    expect(await screen.findByRole('alert')).toHaveTextContent(/no access to Flex Gym Scan yet/);
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeInTheDocument();
  });

  it('explains hub_rejected plainly', async () => {
    vi.stubGlobal('fetch', fakeBackend({ hubError: 'hub_rejected' }));
    renderAt('/login');
    const url = await startSignIn();
    cleanup();
    renderAt(`/auth/callback?code=c&state=${url.searchParams.get('state')}`);
    expect(await screen.findByRole('alert')).toHaveTextContent(/GoalCert could not confirm this sign-in/);
  });

  it('says so when the person cancels at the Hub', async () => {
    vi.stubGlobal('fetch', fakeBackend());
    renderAt('/login');
    const url = await startSignIn();
    cleanup();
    renderAt(`/auth/callback?error=access_denied&state=${url.searchParams.get('state')}`);
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in was cancelled.');
  });
});

describe('accounts', () => {
  it('sends X-Account-Id on customer calls, not on review calls', async () => {
    const fetch = fakeBackend({ who: { ...SAM, staffRole: 'reviewer' } });
    vi.stubGlobal('fetch', fetch);
    client.startSession({ accessToken: 'a', refreshToken: 'r', accounts: ACCOUNTS });
    expect(client.currentAccountId()).toBe('acc_ng');

    await client.plansApi.list();
    await client.meApi.me();
    await client.reviewApi.queue();
    const header = (path) => fetch.calls.find((c) => c.path === path).headers['X-Account-Id'];
    expect(header('/v1/plans')).toBe('acc_ng');
    expect(header('/v1/me')).toBe('acc_ng');
    expect(header('/v1/review/queue')).toBeUndefined();
  });

  it('keeps the chosen account across a refresh if still a member, else the first', () => {
    client.startSession({ accessToken: 'a', refreshToken: 'r', accounts: ACCOUNTS });
    client.setAccountId('acc_kh');
    client.startSession({ accessToken: 'b', refreshToken: 'r2', accounts: ACCOUNTS });
    expect(client.currentAccountId()).toBe('acc_kh');
    client.startSession({ accessToken: 'c', refreshToken: 'r3', accounts: [ACCOUNTS[0]] });
    expect(client.currentAccountId()).toBe('acc_ng');
  });

  it('switches account from the layout and reloads the page for it', async () => {
    const fetch = fakeBackend();
    vi.stubGlobal('fetch', fetch);
    client.startSession({ accessToken: 'a', refreshToken: 'r', accounts: ACCOUNTS });
    renderAt('/plans');
    const select = await screen.findByRole('combobox', { name: 'Switch account' });
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Northgate Group', 'Kestrel Health']);
    expect(select).toHaveValue('acc_ng');
    expect(screen.getByText(/Owner & Surveyor/)).toBeInTheDocument();

    fireEvent.change(select, { target: { value: 'acc_kh' } });
    await waitFor(() => expect(client.currentAccountId()).toBe('acc_kh'));
    await waitFor(() => expect(fetch.calls.at(-1)).toMatchObject({ path: '/v1/me', headers: { 'X-Account-Id': 'acc_kh' } }));
    expect(await screen.findByText(/^Surveyor$/)).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('shows no switcher to someone in one account', async () => {
    vi.stubGlobal('fetch', fakeBackend({ accounts: [ACCOUNTS[0]] }));
    client.startSession({ accessToken: 'a', refreshToken: 'r', accounts: [ACCOUNTS[0]] });
    renderAt('/plans');
    expect(await screen.findByText('Plans page')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Switch account' })).toBeNull();
    expect(screen.getByText('Northgate Group')).toBeInTheDocument();
  });

  it('keeps a customer out of the reviewer pages, and staff out of nothing they hold', async () => {
    vi.stubGlobal('fetch', fakeBackend());
    client.startSession({ accessToken: 'a', refreshToken: 'r', accounts: ACCOUNTS });
    renderAt('/review');
    expect(await screen.findByText('Plans page')).toBeInTheDocument();
  });
});

describe('roles', () => {
  it('homeFor follows the staff role, then the account', () => {
    expect(homeFor({ staffRole: 'admin' })).toBe('/admin');
    expect(homeFor({ staffRole: 'reviewer' })).toBe('/review');
    expect(homeFor({ staffRole: null })).toBe('/plans');
  });

  it('hasRole checks staffRole for staff areas and the account role for customer areas', () => {
    const owner = { staffRole: null, account: { role: 'owner' } };
    expect(hasRole(owner, ['owner', 'surveyor'])).toBe(true);
    expect(hasRole(owner, ['reviewer', 'admin'])).toBe(false);
    const reviewer = { staffRole: 'reviewer', account: null, accounts: [] };
    expect(hasRole(reviewer, ['reviewer', 'admin'])).toBe(true);
    expect(hasRole(reviewer, ['admin'])).toBe(false);
    expect(hasRole(reviewer, ['owner', 'surveyor'])).toBe(false);
  });
});
