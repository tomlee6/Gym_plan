import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../lib/auth.jsx';
import * as client from '../lib/client.js';
import LoginPage from '../lib/LoginPage.jsx';
import RequireRole from '../lib/RequireRole.jsx';
import EditorPage from './editor/EditorPage.jsx';
import QueuePage from './QueuePage.jsx';

const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();

const MAYA = {
  id: 'usr_maya',
  name: 'Maya Restrepo',
  initials: 'MR',
  email: 'maya.restrepo@flexmotion.app',
  role: 'reviewer',
  roleLabel: 'Reviewer',
  organisation: 'Flex Motion Technologies',
};

const wall = (id, a, b, confidence = 0.95) => ({ id, a, b, confidence, mirror: false });

/** A 10 × 6 m room with a door, one weak wall flagged, and a block to check. */
function readPlan() {
  return {
    format: 'gymplan/1',
    scale: { source: 'scan' },
    underlay: null,
    ceilingHeightM: 3.1,
    walls: [wall('n', [0, 0], [10, 0]), wall('e', [10, 0], [10, 6], 0.4), wall('s', [10, 6], [0, 6]), wall('w', [0, 6], [0, 0])],
    openings: [{ id: 'd', wallId: 'n', type: 'door', offset: 1, width: 0.9, confidence: 0.95 }],
    columns: [],
    objects: [{ id: 'b', x: 5, y: 3, w: 0.6, d: 0.6, angle: 0, heightM: 3, category: 'storage', confidence: 0.95 }],
    zones: [],
    tags: [{ id: 't', type: 'fireExit', x: 10, y: 3, heightM: null }],
    flags: [
      { id: 'f1', kind: 'low_confidence', elementId: 'e', title: 'East wall, low confidence', detail: 'Read at 0.40 over 6.0 m.', status: 'open' },
      { id: 'f2', kind: 'column_or_object', elementId: 'b', title: 'Column or object?', detail: 'A 0.6 m square block.', status: 'open' },
    ],
  };
}

const REASONS = ['Incomplete coverage', 'Wrong scale', 'Unreadable source', 'Wrong facility or level', 'Other'];

/** An in-memory fake of the review API. `calls` lists "METHOD path". */
function fakeBackend({ role = 'reviewer' } = {}) {
  const calls = [];
  const bodies = {};
  const versions = {
    pv_rv1_1: {
      id: 'pv_rv1_1', planId: 'plan_rv1', version: 1, status: 'processing', origin: 'capture',
      facility: 'Riverside Gym', organisation: 'Northgate Group', level: 1, submittedAt: hoursAgo(3.2),
      source: 'lidar', inputType: 'lidar', coverage: 0.94, closed: true, overrideReason: null,
      weakWallCount: 1, openFlags: 2, reviewStartedAt: null, reviewer: null, plan: readPlan(), planRevision: 0,
    },
    pv_ng2_1: {
      id: 'pv_ng2_1', planId: 'plan_ng2', version: 1, status: 'in_review', origin: 'capture',
      facility: 'Northgate Fitness', organisation: 'Northgate Group', level: 2, submittedAt: hoursAgo(1),
      source: 'lidar', inputType: 'pdf', coverage: 0.61, closed: false, overrideReason: 'Wall behind fixed rig',
      weakWallCount: 0, openFlags: 0, reviewStartedAt: hoursAgo(0.5), reviewer: { id: 'usr_tom', name: 'Tom Alder', isMe: false },
      plan: readPlan(), planRevision: 3,
    },
    pv_eb0_1: {
      id: 'pv_eb0_1', planId: 'plan_eb0', version: 1, status: 'ready', origin: 'capture',
      facility: 'Eastbrook Athletic Club', organisation: 'Northgate Group', level: 0, submittedAt: hoursAgo(300),
      source: 'lidar', inputType: 'lidar', reviewStartedAt: hoursAgo(290), reviewer: { id: 'usr_maya', name: 'Maya Restrepo', isMe: true },
      reviewedAt: hoursAgo(288), reviewSeconds: 485, contentHash: 'ab'.repeat(32), plan: { ...readPlan(), flags: [] }, planRevision: 2,
    },
  };

  const detail = (v) => ({
    ...v,
    receivedAt: v.submittedAt,
    areaM2: 60,
    activeSeconds: 120,
    reviewedAt: v.reviewedAt ?? null,
    reviewSeconds: v.reviewSeconds ?? null,
    rejectionReason: v.rejectionReason ?? null,
    reviewerNote: v.reviewerNote ?? null,
    contentHash: v.contentHash ?? null,
    capture: { tags: [], floorToFloorM: 3.4 },
    rejectReasons: REASONS,
    history: [{ id: v.id, version: v.version, status: v.status, inputType: v.inputType, submittedAt: v.submittedAt, createdAt: v.submittedAt }],
    urlsExpireAt: new Date(Date.now() + 3_600_000).toISOString(),
    files: [
      { id: 'f1', name: 'scan.usdz', kind: 'model', bytes: 312475648, contentType: 'model/vnd.usdz+zip', url: 'http://files/scan.usdz?sig=1' },
      { id: 'f3', name: 'photo-1.jpg', kind: 'photo', bytes: 2811004, contentType: 'image/jpeg', url: 'http://files/photo-1.jpg?sig=1' },
    ],
  });

  const json = (status, body) => Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body) });

  const fetch = vi.fn((url, init = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    calls.push(`${method} ${path}`);
    const body = init.body ? JSON.parse(init.body) : undefined;
    bodies[`${method} ${path}`] = body;

    if (path === '/v1/auth/login') {
      if (body.password !== 'review1234') return json(401, { message: 'Incorrect email or password.' });
      return json(200, { accessToken: 'a1', refreshToken: 'r1', user: { ...MAYA, role } });
    }
    if (path === '/v1/auth/logout') return json(204);
    if (path === '/v1/me') return json(200, { ...MAYA, role });
    if (path === '/v1/review/queue') {
      const list = Object.values(versions).filter((v) => ['processing', 'in_review'].includes(v.status));
      return json(200, {
        versions: list,
        stats: { waiting: list.length, unclaimed: list.filter((v) => !v.reviewer).length, oldestSubmittedAt: list[0]?.submittedAt ?? null, myMedianSecondsThisWeek: 680, myReviewsThisWeek: 3, approvedThisWeek: 5, rejectedThisWeek: 2 },
      });
    }
    const m = /^\/v1\/review\/versions\/([^/]+)(?:\/(\w+))?$/.exec(path);
    if (m) {
      const v = versions[m[1]];
      if (!v) return json(404, { message: 'Not found.' });
      const action = m[2];
      if (!action && method === 'GET') return json(200, detail(v));
      if (v.reviewer && !v.reviewer.isMe && action !== 'revise') return json(409, { message: `${v.reviewer.name} is reviewing this plan.` });
      if (action === 'start') Object.assign(v, { status: 'in_review', reviewStartedAt: new Date().toISOString(), reviewer: { id: MAYA.id, name: MAYA.name, isMe: true } });
      else if (action === 'release') Object.assign(v, { status: 'processing', reviewer: null });
      else if (action === 'activity') return json(204);
      else if (action === 'plan') {
        if (body.revision !== v.planRevision) return json(409, { message: 'This plan was saved from somewhere else.' });
        Object.assign(v, { plan: body.plan, planRevision: v.planRevision + 1 });
        return json(200, { revision: v.planRevision, savedAt: new Date().toISOString(), issues: [], blockers: [], summary: {} });
      } else if (action === 'approve') {
        if (v.plan.flags.some((f) => f.status === 'open')) return json(409, { message: 'This plan cannot be approved yet.', blockers: ['flags'] });
        Object.assign(v, { status: 'ready', contentHash: 'cd'.repeat(32) });
        return json(200, { contentHash: v.contentHash });
      } else if (action === 'reject') Object.assign(v, { status: 'recapture', rejectionReason: body.reason, reviewerNote: body.note });
      else if (action === 'revise') {
        versions.pv_eb0_2 = { ...v, id: 'pv_eb0_2', version: 2, status: 'in_review', origin: 'revision', planRevision: 0, contentHash: null, reviewedAt: null };
        return json(201, { id: 'pv_eb0_2' });
      }
      return json(204);
    }
    return json(404, { message: 'Not found.' });
  });
  fetch.calls = calls;
  fetch.bodies = bodies;
  fetch.versions = versions;
  return fetch;
}

function renderApp(path = '/review') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/plans" element={<p>Owner home</p>} />
          <Route
            path="/review"
            element={
              <RequireRole roles={['reviewer', 'admin']}>
                <QueuePage />
              </RequireRole>
            }
          />
          <Route
            path="/review/versions/:id"
            element={
              <RequireRole roles={['reviewer', 'admin']}>
                <EditorPage />
              </RequireRole>
            }
          />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

async function signIn(password = 'review1234') {
  fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'maya.restrepo@flexmotion.app' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

beforeEach(() => client.resetForTests());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('sign-in', () => {
  it('shows the backend’s message on a wrong password', async () => {
    vi.stubGlobal('fetch', fakeBackend());
    renderApp();
    await signIn('wrong');
    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect email or password.');
  });

  it('sends a gym owner to their own home, not the queue', async () => {
    const fetch = fakeBackend({ role: 'owner' });
    vi.stubGlobal('fetch', fetch);
    renderApp();
    await signIn();
    expect(await screen.findByText('Owner home')).toBeInTheDocument();
    expect(fetch.calls).not.toContain('GET /v1/review/queue');
  });
});

describe('reviewer queue', () => {
  it('lists plans oldest first with input, confidence, flags and who holds them', async () => {
    vi.stubGlobal('fetch', fakeBackend());
    renderApp();
    await signIn();
    const rows = within(await screen.findByRole('table')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Riverside Gym · Level 1');
    expect(rows[0]).toHaveTextContent('LiDAR scan');
    expect(rows[0]).toHaveTextContent('2 to confirm');
    expect(rows[1]).toHaveTextContent('PDF');
    expect(rows[1]).toHaveTextContent('Outline open');
    expect(within(rows[1]).getByText('Taken')).toBeInTheDocument();
    expect(screen.getByText('11m 20s')).toBeInTheDocument();
  });
});

describe('plan editor', () => {
  async function openRiverside(fetch) {
    vi.stubGlobal('fetch', fetch);
    renderApp();
    await signIn();
    fireEvent.click(await screen.findByRole('button', { name: 'Open Riverside Gym, Level 1' }));
    await screen.findByRole('heading', { name: 'Riverside Gym · Level 1' });
  }

  it('opening claims the plan and shows what needs confirming', async () => {
    const fetch = fakeBackend();
    await openRiverside(fetch);
    expect(fetch.calls).toContain('POST /v1/review/versions/pv_rv1_1/start');
    expect(screen.getByRole('application', { name: /Plan editor. 4 walls, 1 openings/ })).toBeInTheDocument();
    const panel = screen.getByRole('region', { name: 'Needs confirmation' });
    expect(within(panel).getByText('East wall, low confidence')).toBeInTheDocument();
    expect(within(panel).getByText('Column or object?')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Validation' })).toHaveTextContent('Passed');
    // Approve shows its one blocker: the flags.
    expect(screen.getByRole('button', { name: /Approve/ })).toHaveTextContent('1');
  });

  it('flags block approval until cleared; edits autosave; approval records the hash', async () => {
    const fetch = fakeBackend();
    await openRiverside(fetch);

    fireEvent.click(screen.getByRole('button', { name: /^Approve/ }));
    let dialog = await screen.findByRole('dialog', { name: 'Approve version 1' });
    expect(within(dialog).getByRole('button', { name: /Approve and generate/ })).toBeDisabled();
    expect(within(dialog).getByText(/2 flagged elements need confirming/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back to editing' }));

    // Edit the block into a column, confirm the wall.
    const panel = screen.getByRole('region', { name: 'Needs confirmation' });
    const blockFlag = within(panel).getByText('Column or object?').closest('li');
    fireEvent.click(within(blockFlag).getByRole('button', { name: 'Edit' }));
    fireEvent.click(await screen.findByRole('button', { name: 'It is a column' }));
    fireEvent.click(within(screen.getByRole('region', { name: 'Needs confirmation' })).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('All 2 flags cleared')).toBeInTheDocument();

    // Autosave sends the edited plan with the revision it was loaded at.
    await waitFor(() => expect(fetch.calls).toContain('PUT /v1/review/versions/pv_rv1_1/plan'), { timeout: 4000 });
    const saved = fetch.bodies['PUT /v1/review/versions/pv_rv1_1/plan'];
    expect(saved.revision).toBe(0);
    expect(saved.plan.columns).toHaveLength(1);
    expect(saved.plan.flags.map((f) => f.resolution).sort()).toEqual(['confirmed', 'edited']);

    fireEvent.click(screen.getByRole('button', { name: /^Approve/ }));
    dialog = await screen.findByRole('dialog', { name: 'Approve version 1' });
    expect(within(dialog).getByText('All 2 flagged elements confirmed, edited or deleted')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /Approve and generate/ }));
    expect(await screen.findByText(/version 1 approved · hash cdcdcdcdcdcd/)).toBeInTheDocument();
    expect(fetch.versions.pv_rv1_1.status).toBe('ready');
  }, 15000);

  it('undo and redo step through edits', async () => {
    await openRiverside(fakeBackend());
    fireEvent.click(within(screen.getByRole('region', { name: 'Needs confirmation' })).getByRole('button', { name: 'Confirm all remaining' }));
    expect(await screen.findByText('All 2 flags cleared')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(await screen.findByText('East wall, low confidence')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(await screen.findByText('All 2 flags cleared')).toBeInTheDocument();
  });

  it('rejects with a reason code and a note', async () => {
    const fetch = fakeBackend();
    await openRiverside(fetch);
    fireEvent.click(screen.getByRole('button', { name: /Reject/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Send back for recapture' });
    const send = within(dialog).getByRole('button', { name: 'Reject and notify owner' });
    expect(send).toBeDisabled();
    fireEvent.click(within(dialog).getByLabelText(/Wrong scale/));
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'The south wall reads 3 m short.' } });
    fireEvent.click(send);
    expect(await screen.findByText(/sent back for recapture: Wrong scale./)).toBeInTheDocument();
    expect(fetch.versions.pv_rv1_1).toMatchObject({ status: 'recapture', rejectionReason: 'Wrong scale' });
  });

  it('a plan someone else holds is read-only', async () => {
    vi.stubGlobal('fetch', fakeBackend());
    renderApp();
    await signIn();
    await screen.findByRole('table');
    cleanup();
    renderApp('/review/versions/pv_ng2_1');
    expect(await screen.findByText(/Tom Alder is reviewing this plan/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
  });

  it('an approved plan is read-only and can be revised into a new version', async () => {
    const fetch = fakeBackend();
    vi.stubGlobal('fetch', fetch);
    renderApp();
    await signIn();
    await screen.findByRole('table');
    cleanup();
    renderApp('/review/versions/pv_eb0_1');
    expect(await screen.findByText(/Approved by Maya Restrepo/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revise' }));
    expect(await screen.findByText('v2 draft')).toBeInTheDocument();
    expect(fetch.calls).toContain('POST /v1/review/versions/pv_eb0_1/revise');
  });
});
