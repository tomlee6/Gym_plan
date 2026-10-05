import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../lib/auth.jsx';
import * as client from '../lib/client.js';
import AccountPage from './AccountPage.jsx';
import AccountsPage from './AccountsPage.jsx';
import AuditPage from './AuditPage.jsx';

const ADMIN = {
  id: 'usr_admin',
  name: 'Jordan Kaur',
  initials: 'JK',
  role: 'admin',
  roleLabel: 'Platform admin',
  organisation: 'Flex Motion Technologies',
};

const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();

/** An in-memory admin API. `calls` lists "METHOD path" in order. */
function fakeBackend() {
  const calls = [];
  const bodies = [];
  const accounts = {
    org_flex: {
      id: 'org_flex', name: 'Flex Motion Technologies', region: 'Australia (Sydney)', planQuota: 1000,
      plansUsed: 0, operator: true, createdAt: daysAgo(400), dataRemovedAt: null,
      users: [
        { id: 'usr_admin', name: 'Jordan Kaur', email: 'admin@flexmotion.app', role: 'admin', roleLabel: 'Platform admin', active: true },
        { id: 'usr_maya', name: 'Maya Restrepo', email: 'maya@flexmotion.app', role: 'reviewer', roleLabel: 'Reviewer', active: true },
      ],
      facilities: [],
    },
    org_northgate: {
      id: 'org_northgate', name: 'Northgate Group', region: 'Australia (Sydney)', planQuota: 10,
      plansUsed: 9, operator: false, createdAt: '2026-02-10T00:00:00Z', dataRemovedAt: null,
      users: [{ id: 'usr_sam', name: 'Sam Okafor', email: 'sam@northgate.example', role: 'owner', roleLabel: 'Owner & Surveyor', active: true }],
      facilities: [{ id: 'fac_ng', name: 'Northgate Fitness', levels: 3 }],
    },
  };
  const audit = [
    { id: 'a3', at: daysAgo(0.1), orgId: 'org_northgate', organisation: 'Northgate Group', actorId: 'usr_maya', actorName: 'Maya Restrepo', action: 'APPROVED', targetType: 'plan', targetId: 'plan_ng2', targetLabel: 'Northgate Fitness · Level 2', version: 3, detail: { contentHash: '4f9c2ae1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad0b7' } },
    { id: 'a2', at: daysAgo(1), orgId: 'org_gone', organisation: 'Removed account org_gone', actorId: 'usr_x', actorName: null, action: 'REJECTED', targetType: 'plan', targetId: 'plan_x', targetLabel: null, version: 1, detail: null },
    { id: 'a1', at: daysAgo(2), orgId: 'org_northgate', organisation: 'Northgate Group', actorId: 'usr_admin', actorName: 'Jordan Kaur', action: 'QUOTA_CHANGED', targetType: 'account', targetId: 'org_northgate', targetLabel: 'Northgate Group', version: null, detail: { from: 5, to: 10 } },
  ];

  const summary = (a) => ({ ...a, users: a.users.filter((u) => u.active).length, facilities: a.facilities.length });
  const json = (status, body) => Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body), blob: () => Promise.resolve(new Blob([body ?? ''])) });

  const fetch = vi.fn((url, init = {}) => {
    const method = init.method ?? 'GET';
    const u = new URL(url, 'http://test');
    const path = u.pathname;
    calls.push(`${method} ${path}${u.search}`);
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (body) bodies.push(body);

    if (path === '/v1/auth/login') return json(200, { accessToken: 'a', refreshToken: 'r', user: ADMIN });
    if (path === '/v1/me') return json(200, ADMIN);
    if (path === '/v1/admin/accounts' && method === 'GET') return json(200, { accounts: Object.values(accounts).map(summary) });
    if (path === '/v1/admin/accounts' && method === 'POST') {
      if (body.owner.email === 'taken@example.com') return json(409, { message: 'taken@example.com already has an account.' });
      const a = { id: 'org_new', name: body.name, region: body.region, planQuota: body.planQuota, plansUsed: 0, operator: false, createdAt: new Date().toISOString(), dataRemovedAt: null, users: [{ id: 'usr_o', name: body.owner.name, email: body.owner.email, role: 'owner', roleLabel: 'Owner & Surveyor', active: true }], facilities: [] };
      accounts.org_new = a;
      return json(201, summary(a));
    }
    if (path === '/v1/admin/reviewers') {
      return json(200, {
        targets: { scanSeconds: 900, uploadSeconds: 600 },
        reviewers: [{ id: 'usr_maya', name: 'Maya Restrepo', roleLabel: 'Reviewer', active: true, thisWeek: { reviews: 4, medianSeconds: 680, scanMedianSeconds: 680, uploadMedianSeconds: 720 }, weeks: [...Array(8)].map((_, i) => ({ weeksAgo: 7 - i, reviews: i % 3, medianSeconds: i % 3 ? 600 + i * 60 : null })) }],
      });
    }
    if (path === '/v1/admin/audit') {
      let list = audit;
      const orgId = u.searchParams.get('orgId');
      const action = u.searchParams.get('action');
      if (orgId) list = list.filter((e) => e.orgId === orgId);
      if (action) list = list.filter((e) => e.action === action);
      const before = u.searchParams.get('before');
      if (before) list = list.filter((e) => new Date(e.at) < new Date(before));
      const limit = fetch.pageSize ?? Number(u.searchParams.get('limit') ?? 100);
      return json(200, { entries: list.slice(0, limit), nextBefore: list.length > limit ? list[limit - 1].at : null, actions: ['APPROVED', 'QUOTA_CHANGED', 'REJECTED'] });
    }
    if (path === '/v1/admin/audit.csv') return json(200, 'time_utc,action\r\n');

    const m = /^\/v1\/admin\/accounts\/([^/]+)(?:\/(\w+))?(?:\/([^/]+))?$/.exec(path);
    if (m) {
      const a = accounts[m[1]];
      if (!a) return json(404, { message: 'This account does not exist.' });
      if (!m[2] && method === 'GET') return json(200, { ...summary(a), users: a.users, facilities: a.facilities });
      if (!m[2] && method === 'PATCH') {
        Object.assign(a, body);
        return json(200, summary(a));
      }
      if (m[2] === 'users' && method === 'POST') {
        a.users.push({ id: `usr_${a.users.length}`, name: body.name, email: body.email, role: body.role, roleLabel: body.role, active: true });
        return json(201, { id: 'x' });
      }
      if (m[2] === 'users' && method === 'DELETE') {
        a.users.find((x) => x.id === m[3]).active = false;
        return json(204);
      }
      if (m[2] === 'facilities') {
        a.facilities.push({ id: 'fac_new', name: body.name, levels: 0 });
        return json(201, { id: 'fac_new' });
      }
      if (m[2] === 'removal') {
        if (body.confirmName !== a.name) return json(400, { message: 'Type the account name exactly to confirm.' });
        const removed = { plans: 6, versions: 7, captures: 4, files: 9, users: a.users.length };
        Object.assign(a, { dataRemovedAt: new Date().toISOString(), name: `Removed account ${a.id}`, users: [], facilities: [] });
        return json(200, { removed, filesNotDeleted: 0 });
      }
    }
    return json(404, { message: 'Not found.' });
  });
  fetch.calls = calls;
  fetch.bodies = bodies;
  fetch.accounts = accounts;
  return fetch;
}

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

async function renderAt(path) {
  await client.signIn('admin@flexmotion.app', 'admin1234');
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route path="/admin" element={<AccountsPage />} />
          <Route path="/admin/accounts/:id" element={<AccountPage />} />
          <Route path="/admin/audit" element={<AuditPage />} />
        </Routes>
        <Where />
      </AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  client.resetForTests();
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('accounts', () => {
  it('lists accounts with quota use, and reviewer time', async () => {
    vi.stubGlobal('fetch', fakeBackend());
    await renderAt('/admin');
    const northgate = (await screen.findByText('Northgate Group')).closest('tr');
    expect(northgate).toHaveTextContent('Customer since Feb 2026');
    expect(northgate).toHaveTextContent('9 of 10');
    expect(within(northgate).getByRole('meter')).toHaveAttribute('aria-valuenow', '9');
    const flex = screen.getByText('Flex Motion Technologies').closest('tr');
    expect(flex).toHaveTextContent('Operator account');
    expect(flex).toHaveTextContent('Not metered');

    expect(await screen.findByText('Reviewer time')).toBeInTheDocument();
    expect(screen.getByText('4 reviews')).toBeInTheDocument();
    // Uploads over their 10-minute target show as missed.
    expect(screen.getByText('12m 00s')).toHaveClass('poor');
    expect(screen.getByRole('img', { name: /Weekly median review time/ })).toBeInTheDocument();
  });

  it('creates an account and opens it; shows the server’s refusal', async () => {
    const fetch = fakeBackend();
    vi.stubGlobal('fetch', fetch);
    await renderAt('/admin');
    fireEvent.click(await screen.findByRole('button', { name: 'New account' }));
    const dialog = await screen.findByRole('dialog', { name: 'New account' });
    const create = within(dialog).getByRole('button', { name: 'Create account' });
    expect(create).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText('Account name'), { target: { value: 'Kestrel Health Clubs' } });
    fireEvent.change(within(dialog).getByLabelText('Monthly plan quota'), { target: { value: '5' } });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Priya Nair' } });
    fireEvent.change(within(dialog).getByLabelText('Email'), { target: { value: 'taken@example.com' } });
    fireEvent.change(within(dialog).getByLabelText('Temporary password'), { target: { value: 'short' } });
    expect(create).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Temporary password'), { target: { value: 'kestrel-pass' } });
    fireEvent.click(create);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('already has an account');

    fireEvent.change(within(dialog).getByLabelText('Email'), { target: { value: 'priya@kestrel.example' } });
    fireEvent.click(create);
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/admin/accounts/org_new'));
    expect(fetch.bodies.at(-1)).toEqual({
      name: 'Kestrel Health Clubs',
      planQuota: 5,
      region: 'Australia (Sydney)',
      owner: { name: 'Priya Nair', email: 'priya@kestrel.example', password: 'kestrel-pass' },
    });
  });

  it('exports the audit log as a file', async () => {
    const fetch = fakeBackend();
    vi.stubGlobal('fetch', fetch);
    await renderAt('/admin');
    fireEvent.click(await screen.findByRole('button', { name: 'Export audit log' }));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    expect(fetch.calls).toContain('GET /v1/admin/audit.csv');
  });
});

describe('one account', () => {
  it('saves the quota, adds a facility and a user, and removes a user', async () => {
    const fetch = fakeBackend();
    vi.stubGlobal('fetch', fetch);
    await renderAt('/admin/accounts/org_northgate');
    expect(await screen.findByRole('heading', { name: 'Northgate Group' })).toBeInTheDocument();

    const quota = screen.getByLabelText('Monthly plan quota');
    fireEvent.change(quota, { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Account saved.');
    expect(fetch.bodies.at(-1)).toEqual({ planQuota: 12 });

    fireEvent.change(screen.getByLabelText('New facility'), { target: { value: 'Northgate Carlton' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add facility' }));
    expect(await screen.findByText('Northgate Carlton')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add user' }));
    const add = await screen.findByRole('dialog', { name: 'Add user' });
    // A customer account offers customer roles only.
    expect(within(add).getAllByRole('option').map((o) => o.value)).toEqual(['owner', 'surveyor']);
    fireEvent.change(within(add).getByLabelText('Name'), { target: { value: 'Sam Surveyor' } });
    fireEvent.change(within(add).getByLabelText('Email'), { target: { value: 'sam.s@northgate.example' } });
    fireEvent.change(within(add).getByLabelText('Role'), { target: { value: 'surveyor' } });
    fireEvent.change(within(add).getByLabelText('Temporary password'), { target: { value: 'surveyor-1' } });
    fireEvent.click(within(add).getByRole('button', { name: 'Add user' }));
    expect(await screen.findByText('Sam Surveyor')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Sam Okafor' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove Sam Okafor?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove user' }));
    await waitFor(() => expect(fetch.accounts.org_northgate.users[0].active).toBe(false));
    expect(await screen.findByRole('status')).toHaveTextContent('Sam Okafor was removed');
  });

  it('removes account data only after the name is typed, and shows what went', async () => {
    const fetch = fakeBackend();
    vi.stubGlobal('fetch', fetch);
    await renderAt('/admin/accounts/org_northgate');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove account data…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove account data' });
    const go = within(dialog).getByRole('button', { name: 'Remove everything' });
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Northgate' } });
    expect(go).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Northgate Group' } });
    fireEvent.click(go);

    expect(await screen.findByText('ACCOUNT DATA REMOVED')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.getByText('Deleted')).toBeInTheDocument();
    expect(screen.getByText('files')).toBeInTheDocument();
    expect(fetch.bodies.at(-1)).toEqual({ confirmName: 'Northgate Group' });
  });

  it('offers staff roles on the operator account, which cannot be removed', async () => {
    vi.stubGlobal('fetch', fakeBackend());
    await renderAt('/admin/accounts/org_flex');
    expect(await screen.findByText(/cannot be removed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove account data…' })).toBeNull();
    // An admin cannot remove themselves.
    expect(screen.queryByRole('button', { name: 'Remove Jordan Kaur' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }));
    const add = await screen.findByRole('dialog', { name: 'Add user' });
    expect(within(add).getAllByRole('option').map((o) => o.value)).toEqual(['reviewer', 'admin']);
  });
});

describe('audit log', () => {
  it('shows entries, with ids only for a removed account', async () => {
    vi.stubGlobal('fetch', fakeBackend());
    await renderAt('/admin/audit');
    const table = await screen.findByRole('table', { name: /Audit log entries/ });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('APPROVED');
    expect(rows[0]).toHaveTextContent('Hash 4f9c2ae1…d0b7');
    expect(rows[0]).toHaveTextContent('v3');
    expect(rows[1]).toHaveTextContent('plan_x');
    expect(rows[1]).toHaveTextContent('usr_x');
    expect(rows[2]).toHaveTextContent('Quota 5 → 10');
  });

  it('filters by the account in the link, and exports with the same filters', async () => {
    const fetch = fakeBackend();
    vi.stubGlobal('fetch', fetch);
    await renderAt('/admin/audit?orgId=org_northgate');
    const table = await screen.findByRole('table', { name: /Audit log entries/ });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(fetch.calls.some((c) => c.startsWith('GET /v1/admin/audit?orgId=org_northgate'))).toBe(true);

    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'QUOTA_CHANGED' } });
    await waitFor(() => expect(within(screen.getByRole('table', { name: /Audit log entries/ })).getAllByRole('row')).toHaveLength(2));
    expect(screen.getByTestId('where')).toHaveTextContent('action=QUOTA_CHANGED');

    fireEvent.click(screen.getByRole('button', { name: 'Export these as CSV' }));
    await waitFor(() =>
      expect(fetch.calls).toContain('GET /v1/admin/audit.csv?orgId=org_northgate&action=QUOTA_CHANGED'),
    );
  });

  it('loads older entries', async () => {
    const fetch = fakeBackend();
    vi.stubGlobal('fetch', fetch);
    fetch.pageSize = 2;
    await renderAt('/admin/audit');
    await screen.findByRole('table', { name: /Audit log entries/ });
    expect(screen.getByText('2 entries shown')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('3 entries shown')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(fetch.calls.some((c) => c.includes('before='))).toBe(true);
  });
});
