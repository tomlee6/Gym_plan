import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../lib/auth.jsx';
import * as client from '../lib/client.js';
import AccountPage from './AccountPage.jsx';
import AccountsPage from './AccountsPage.jsx';
import AuditPage from './AuditPage.jsx';
import StaffPage from './StaffPage.jsx';

const ADMIN = {
  id: 'usr_admin',
  name: 'Jordan Kaur',
  initials: 'JK',
  email: 'admin@flexmotion.app',
  staffRole: 'admin',
  accounts: [],
  account: null,
};

const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();

/** An in-memory admin API (api-contract-v2 section 2). `calls` lists "METHOD path" in order. */
function fakeBackend() {
  const calls = [];
  const bodies = [];
  const accounts = {
    acc_northgate: {
      id: 'acc_northgate', name: 'Northgate Group', region: 'Australia (Sydney)', planQuota: 10,
      plansUsed: 9, status: 'active', createdAt: '2026-02-10T00:00:00Z', removedAt: null,
      members: [{ userId: 'usr_sam', name: 'Sam Okafor', email: 'sam@northgate.example', role: 'owner', status: 'active', createdAt: daysAgo(200) }],
      invites: [{ id: 'inv_1', email: 'priya@northgate.example', role: 'surveyor', expiresAt: daysAgo(-10), createdAt: daysAgo(4) }],
      facilities: [{ id: 'fac_ng', name: 'Northgate Fitness', levels: 3 }],
    },
    acc_gone: {
      id: 'acc_gone', name: 'Removed account acc_gone', region: 'Australia (Sydney)', planQuota: 5,
      plansUsed: 0, status: 'removed', createdAt: daysAgo(400), removedAt: daysAgo(30),
      members: [], invites: [], facilities: [],
    },
  };
  const staff = [
    { id: 'usr_admin', name: 'Jordan Kaur', email: 'admin@flexmotion.app', staffRole: 'admin', status: 'active' },
    { id: 'usr_maya', name: 'Maya Restrepo', email: 'maya@flexmotion.app', staffRole: 'reviewer', status: 'active' },
  ];
  const users = [...staff.map(({ id, name, email }) => ({ id, name, email })), { id: 'usr_tom', name: 'Tom Alder', email: 'tom@flexmotion.app' }];
  const audit = [
    { id: 'a3', at: daysAgo(0.1), accountId: 'acc_northgate', account: 'Northgate Group', actorId: 'usr_maya', actorName: 'Maya Restrepo', action: 'APPROVED', targetType: 'plan', targetId: 'plan_ng2', targetLabel: 'Northgate Fitness · Level 2', version: 3, detail: { contentHash: '4f9c2ae1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad0b7' } },
    { id: 'a2', at: daysAgo(1), accountId: 'acc_x', account: null, actorId: 'usr_x', actorName: null, action: 'REJECTED', targetType: 'plan', targetId: 'plan_x', targetLabel: null, version: 1, detail: null },
    { id: 'a1', at: daysAgo(2), accountId: 'acc_northgate', account: 'Northgate Group', actorId: 'usr_admin', actorName: 'Jordan Kaur', action: 'QUOTA_CHANGED', targetType: 'account', targetId: 'acc_northgate', targetLabel: 'Northgate Group', version: null, detail: { from: 5, to: 10 } },
  ];

  const summary = (a) => {
    const { members, invites, ...rest } = a;
    return { ...rest, members: members.length, facilities: a.facilities.length };
  };
  const json = (status, body) => Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body), blob: () => Promise.resolve(new Blob([body ?? ''])) });

  const fetch = vi.fn((url, init = {}) => {
    const method = init.method ?? 'GET';
    const u = new URL(url, 'http://test');
    const path = u.pathname;
    calls.push(`${method} ${path}${u.search}`);
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (body) bodies.push(body);

    if (path === '/v1/me') return json(200, ADMIN);
    if (path === '/v1/admin/accounts' && method === 'GET') return json(200, { accounts: Object.values(accounts).map(summary) });
    if (path === '/v1/admin/accounts' && method === 'POST') {
      if (body.ownerEmail === 'taken@example.com') return json(409, { message: 'taken@example.com already owns an account.' });
      const a = { id: 'acc_new', name: body.name, region: body.region, planQuota: body.planQuota, plansUsed: 0, status: 'active', createdAt: new Date().toISOString(), removedAt: null, members: [], invites: [{ id: 'inv_o', email: body.ownerEmail, role: 'owner', expiresAt: null, createdAt: new Date().toISOString() }], facilities: [] };
      accounts.acc_new = a;
      return json(201, summary(a));
    }
    if (path === '/v1/admin/staff' && method === 'GET') return json(200, { staff, users });
    const sm = /^\/v1\/admin\/staff\/([^/]+)$/.exec(path);
    if (sm && method === 'PUT') {
      const i = staff.findIndex((s) => s.id === sm[1]);
      if (body.staffRole === null) staff.splice(i, 1);
      else if (i >= 0) staff[i].staffRole = body.staffRole;
      else staff.push({ ...users.find((x) => x.id === sm[1]), staffRole: body.staffRole, status: 'active' });
      return json(204);
    }
    if (path === '/v1/admin/reviewers') {
      return json(200, {
        targets: { scanSeconds: 900, uploadSeconds: 600 },
        reviewers: [{ id: 'usr_maya', name: 'Maya Restrepo', roleLabel: 'Reviewer', active: true, thisWeek: { reviews: 4, medianSeconds: 680, scanMedianSeconds: 680, uploadMedianSeconds: 720 }, weeks: [...Array(8)].map((_, i) => ({ weeksAgo: 7 - i, reviews: i % 3, medianSeconds: i % 3 ? 600 + i * 60 : null })) }],
      });
    }
    if (path === '/v1/admin/audit') {
      let list = audit;
      const accountId = u.searchParams.get('accountId');
      const action = u.searchParams.get('action');
      if (accountId) list = list.filter((e) => e.accountId === accountId);
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
      if (!m[2] && method === 'GET') return json(200, { ...summary(a), members: a.members, invites: a.invites, facilities: a.facilities });
      if (!m[2] && method === 'PATCH') {
        Object.assign(a, body);
        return json(200, summary(a));
      }
      if (m[2] === 'invites' && method === 'POST') {
        if (a.invites.some((i) => i.email === body.email)) return json(409, { code: 'invite_open', message: `${body.email} already has an open invite.` });
        a.invites.push({ id: `inv_${a.invites.length + 2}`, email: body.email, role: body.role, expiresAt: null, createdAt: new Date().toISOString() });
        return json(201, { id: 'inv_x' });
      }
      if (m[2] === 'invites' && method === 'DELETE') {
        a.invites = a.invites.filter((i) => i.id !== m[3]);
        return json(204);
      }
      if (m[2] === 'members' && method === 'PATCH') {
        a.members.find((x) => x.userId === m[3]).role = body.role;
        return json(200, {});
      }
      if (m[2] === 'members' && method === 'DELETE') {
        a.members = a.members.filter((x) => x.userId !== m[3]);
        return json(204);
      }
      if (m[2] === 'facilities') {
        a.facilities.push({ id: 'fac_new', name: body.name, levels: 0 });
        return json(201, { id: 'fac_new' });
      }
      if (m[2] === 'removal') {
        if (body.confirmName !== a.name) return json(400, { message: 'Type the account name exactly to confirm.' });
        a.status = 'removing';
        return json(202, { jobId: 'job_42' });
      }
    }
    return json(404, { message: 'Not found.' });
  });
  fetch.calls = calls;
  fetch.bodies = bodies;
  fetch.accounts = accounts;
  fetch.staff = staff;
  return fetch;
}

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function renderAt(path) {
  client.startSession({ accessToken: 'a', refreshToken: 'r', accounts: [] });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route path="/admin" element={<AccountsPage />} />
          <Route path="/admin/accounts/:id" element={<AccountPage />} />
          <Route path="/admin/staff" element={<StaffPage />} />
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
  it('lists accounts with member counts and quota use, and reviewer time', async () => {
    vi.stubGlobal('fetch', fakeBackend());
    renderAt('/admin');
    const northgate = (await screen.findByText('Northgate Group')).closest('tr');
    expect(northgate).toHaveTextContent('Customer since Feb 2026');
    expect(northgate).toHaveTextContent('9 of 10');
    expect(within(northgate).getByRole('meter')).toHaveAttribute('aria-valuenow', '9');
    const gone = screen.getByText('Removed account acc_gone').closest('tr');
    expect(gone).toHaveTextContent('Data removed');

    expect(await screen.findByText('Reviewer time')).toBeInTheDocument();
    expect(screen.getByText('4 reviews')).toBeInTheDocument();
    expect(screen.getByText('12m 00s')).toHaveClass('poor');
  });

  it('creates an account with an owner’s email, never a password', async () => {
    const fetch = fakeBackend();
    vi.stubGlobal('fetch', fetch);
    renderAt('/admin');
    fireEvent.click(await screen.findByRole('button', { name: 'New account' }));
    const dialog = await screen.findByRole('dialog', { name: 'New account' });
    expect(within(dialog).queryByLabelText(/password/i)).toBeNull();
    const create = within(dialog).getByRole('button', { name: 'Create account' });
    expect(create).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText('Account name'), { target: { value: 'Kestrel Health Clubs' } });
    fireEvent.change(within(dialog).getByLabelText('Monthly plan quota'), { target: { value: '5' } });
    fireEvent.change(within(dialog).getByLabelText('Owner’s email'), { target: { value: 'taken@example.com' } });
    fireEvent.click(create);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('already owns an account');

    fireEvent.change(within(dialog).getByLabelText('Owner’s email'), { target: { value: 'priya@kestrel.example' } });
    fireEvent.click(create);
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/admin/accounts/acc_new'));
    expect(fetch.bodies.at(-1)).toEqual({
      name: 'Kestrel Health Clubs',
      planQuota: 5,
      region: 'Australia (Sydney)',
      ownerEmail: 'priya@kestrel.example',
    });
  });

  it('exports the audit log as a file', async () => {
    const fetch = fakeBackend();
    vi.stubGlobal('fetch', fetch);
    renderAt('/admin');
    fireEvent.click(await screen.findByRole('button', { name: 'Export audit log' }));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    expect(fetch.calls).toContain('GET /v1/admin/audit.csv');
  });
});

describe('one account', () => {
  it('saves the quota and adds a facility', async () => {
    const fetch = fakeBackend();
    vi.stubGlobal('fetch', fetch);
    renderAt('/admin/accounts/acc_northgate');
    expect(await screen.findByRole('heading', { name: 'Northgate Group' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Monthly plan quota'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Account saved.');
    expect(fetch.bodies.at(-1)).toEqual({ planQuota: 12 });

    fireEvent.change(screen.getByLabelText('New facility'), { target: { value: 'Northgate Carlton' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add facility' }));
    expect(await screen.findByText('Northgate Carlton')).toBeInTheDocument();
  });

  it('invites by email and role, refuses a second open invite, and revokes one', async () => {
    const fetch = fakeBackend();
    vi.stubGlobal('fetch', fetch);
    renderAt('/admin/accounts/acc_northgate');
    const card = await screen.findByRole('region', { name: /INVITES/ });
    expect(within(card).getByRole('list', { name: 'Open invites' })).toHaveTextContent('priya@northgate.example');
    expect(within(card).getAllByRole('option').map((o) => o.value)).toEqual(['owner', 'surveyor']);

    fireEvent.change(within(card).getByLabelText('Email'), { target: { value: 'priya@northgate.example' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Send invite' }));
    expect(await within(card).findByRole('alert')).toHaveTextContent('already has an open invite');

    fireEvent.change(within(card).getByLabelText('Email'), { target: { value: 'lee@northgate.example' } });
    fireEvent.change(within(card).getByLabelText('Role'), { target: { value: 'owner' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Send invite' }));
    expect(await screen.findByText('lee@northgate.example was invited as Owner & Surveyor.')).toBeInTheDocument();
    expect(fetch.bodies.at(-1)).toEqual({ email: 'lee@northgate.example', role: 'owner' });
    expect(fetch.calls).toContain('POST /v1/admin/accounts/acc_northgate/invites');

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke the invite for priya@northgate.example' }));
    await waitFor(() => expect(fetch.calls).toContain('DELETE /v1/admin/accounts/acc_northgate/invites/inv_1'));
    expect(await screen.findByText('The invite for priya@northgate.example was revoked.')).toBeInTheDocument();
  });

  it('changes a member’s role and removes a member', async () => {
    const fetch = fakeBackend();
    vi.stubGlobal('fetch', fetch);
    renderAt('/admin/accounts/acc_northgate');
    const role = await screen.findByRole('combobox', { name: 'Role of Sam Okafor' });
    expect(role).toHaveValue('owner');
    fireEvent.change(role, { target: { value: 'surveyor' } });
    expect(await screen.findByText('Sam Okafor is now Surveyor.')).toBeInTheDocument();
    expect(fetch.calls).toContain('PATCH /v1/admin/accounts/acc_northgate/members/usr_sam');
    expect(fetch.bodies.at(-1)).toEqual({ role: 'surveyor' });

    fireEvent.click(screen.getByRole('button', { name: 'Remove Sam Okafor' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove Sam Okafor?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove from account' }));
    await waitFor(() => expect(fetch.accounts.acc_northgate.members).toHaveLength(0));
    expect(await screen.findByText('Sam Okafor was removed from Northgate Group.')).toBeInTheDocument();
  });

  it('starts account removal as a background job only after the name is typed', async () => {
    const fetch = fakeBackend();
    vi.stubGlobal('fetch', fetch);
    renderAt('/admin/accounts/acc_northgate');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove account data…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove account data' });
    const go = within(dialog).getByRole('button', { name: 'Remove everything' });
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Northgate' } });
    expect(go).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Northgate Group' } });
    fireEvent.click(go);

    expect(await screen.findByText('REMOVAL STARTED')).toBeInTheDocument();
    expect(screen.getByText(/completes in the background; this page/)).toBeInTheDocument();
    expect(fetch.bodies.at(-1)).toEqual({ confirmName: 'Northgate Group' });
  });

  it('shows a removed account as removed, with nothing left to edit', async () => {
    vi.stubGlobal('fetch', fakeBackend());
    renderAt('/admin/accounts/acc_gone');
    expect(await screen.findByText('ACCOUNT DATA REMOVED')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send invite' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove account data…' })).toBeNull();
  });
});

describe('staff', () => {
  it('lists staff, changes a role, removes one and adds someone who has signed in', async () => {
    const fetch = fakeBackend();
    vi.stubGlobal('fetch', fetch);
    renderAt('/admin/staff');
    const table = await screen.findByRole('table', { name: 'Flex staff' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    // An admin cannot change or remove themselves.
    expect(within(rows[0]).queryByRole('combobox')).toBeNull();
    expect(within(rows[0]).queryByRole('button')).toBeNull();

    fireEvent.change(screen.getByRole('combobox', { name: 'Staff role of Maya Restrepo' }), { target: { value: 'admin' } });
    expect(await screen.findByText('Maya Restrepo is now Platform admin.')).toBeInTheDocument();
    expect(fetch.calls).toContain('PUT /v1/admin/staff/usr_maya');
    expect(fetch.bodies.at(-1)).toEqual({ staffRole: 'admin' });

    fireEvent.change(screen.getByLabelText('Person'), { target: { value: 'usr_tom' } });
    fireEvent.change(screen.getByLabelText('Staff role'), { target: { value: 'reviewer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make staff' }));
    expect(await screen.findByText('Tom Alder is now Reviewer.')).toBeInTheDocument();
    expect(fetch.bodies.at(-1)).toEqual({ staffRole: 'reviewer' });

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Maya Restrepo from staff' }));
    expect(await screen.findByText('Maya Restrepo is no longer Flex staff.')).toBeInTheDocument();
    expect(fetch.bodies.at(-1)).toEqual({ staffRole: null });
  });
});

describe('audit log', () => {
  it('shows entries, with ids only for a removed account', async () => {
    vi.stubGlobal('fetch', fakeBackend());
    renderAt('/admin/audit');
    const table = await screen.findByRole('table', { name: /Audit log entries/ });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('APPROVED');
    expect(rows[0]).toHaveTextContent('Hash 4f9c2ae1…d0b7');
    expect(rows[0]).toHaveTextContent('v3');
    expect(rows[1]).toHaveTextContent('plan_x');
    expect(rows[1]).toHaveTextContent('acc_x');
    expect(rows[2]).toHaveTextContent('Quota 5 → 10');
  });

  it('filters by the account in the link, and exports with the same filters', async () => {
    const fetch = fakeBackend();
    vi.stubGlobal('fetch', fetch);
    renderAt('/admin/audit?accountId=acc_northgate');
    const table = await screen.findByRole('table', { name: /Audit log entries/ });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(fetch.calls.some((c) => c.startsWith('GET /v1/admin/audit?accountId=acc_northgate'))).toBe(true);

    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'QUOTA_CHANGED' } });
    await waitFor(() => expect(within(screen.getByRole('table', { name: /Audit log entries/ })).getAllByRole('row')).toHaveLength(2));
    expect(screen.getByTestId('where')).toHaveTextContent('action=QUOTA_CHANGED');

    fireEvent.click(screen.getByRole('button', { name: 'Export these as CSV' }));
    await waitFor(() =>
      expect(fetch.calls).toContain('GET /v1/admin/audit.csv?accountId=acc_northgate&action=QUOTA_CHANGED'),
    );
  });

  it('loads older entries', async () => {
    const fetch = fakeBackend();
    vi.stubGlobal('fetch', fetch);
    fetch.pageSize = 2;
    renderAt('/admin/audit');
    await screen.findByRole('table', { name: /Audit log entries/ });
    expect(screen.getByText('2 entries shown')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('3 entries shown')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(fetch.calls.some((c) => c.includes('before='))).toBe(true);
  });
});
