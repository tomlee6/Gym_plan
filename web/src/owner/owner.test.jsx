import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as client from '../lib/client.js';
import PlanPage from './PlanPage.jsx';
import PlansPage from './PlansPage.jsx';
import UploadPage from './UploadPage.jsx';

// jsdom cannot decode images; the page only needs the size.
vi.mock('./upload.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadImageSize: vi.fn(async () => ({ width: 1000, height: 800, url: 'blob:drawing' })),
}));

const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();

const PLANS = [
  { id: 'plan_ng1', facilityId: 'fac_ng', site: 'Northgate Fitness', level: 1, status: 'ready', version: 2, inputType: 'lidar', reviewedAt: hoursAgo(48), reviewerName: 'Maya Restrepo', walkthroughVersion: 2 },
  { id: 'plan_ng2', facilityId: 'fac_ng', site: 'Northgate Fitness', level: 2, status: 'in_review', version: 1, inputType: 'lidar', reviewStartedAt: hoursAgo(1), reviewerName: 'Maya Restrepo', walkthroughVersion: null },
  { id: 'plan_ng3', facilityId: 'fac_ng', site: 'Northgate Fitness', level: 3, status: 'uploading', version: 1, inputType: 'lidar', walkthroughVersion: null },
  { id: 'plan_rv0', facilityId: 'fac_rv', site: 'Riverside Gym', level: 0, status: 'recapture', version: 1, inputType: 'lidar', reviewedAt: hoursAgo(200), reviewerName: 'Maya Restrepo', rejectionReason: 'Incomplete coverage', walkthroughVersion: null },
  { id: 'plan_rv1', facilityId: 'fac_rv', site: 'Riverside Gym', level: 1, status: 'processing', version: 1, inputType: 'pdf', submittedAt: hoursAgo(0.1), walkthroughVersion: null },
];

/** An in-memory backend for the owner pages. `calls` lists "METHOD path". */
function fakeBackend() {
  const calls = [];
  const bodies = {};
  const headers = {};
  let share = null;
  const json = (status, body) => Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body) });

  const fetch = vi.fn((url, init = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    calls.push(`${method} ${path}`);
    bodies[`${method} ${path}`] = init.body;
    headers[`${method} ${path}`] = init.headers;

    if (url.startsWith('https://storage.test/')) return json(200, {});
    if (path === '/v1/auth/login') return json(200, { accessToken: 'a', refreshToken: 'r', user: { role: 'owner' } });
    if (path === '/v1/me') return json(200, { name: 'Sam Okafor', role: 'owner', plansUsed: 6, planQuota: 10 });
    if (path === '/v1/facilities') {
      return json(200, {
        facilities: [
          { id: 'fac_eb', name: 'Eastbrook Athletic Club' },
          { id: 'fac_ng', name: 'Northgate Fitness' },
          { id: 'fac_rv', name: 'Riverside Gym' },
        ],
        defaultFacilityId: 'fac_ng',
      });
    }
    if (path === '/v1/plans') return json(200, { plans: PLANS });
    if (path === '/v1/plans/plan_rv0') {
      return json(200, { ...PLANS[3], review: { reviewer: { name: 'Maya Restrepo' }, note: 'Rewalk the north-east corner.' }, history: [] });
    }
    if (path === '/v1/plans/plan_ng1') {
      return json(200, {
        ...PLANS[0],
        areaM2: 384,
        coverage: 0.97,
        review: { reviewer: { name: 'Maya Restrepo', initials: 'MR' }, seconds: 680, note: null },
        shareLink: share,
        history: [
          { id: 'pv2', version: 2, status: 'ready', origin: 'capture', inputType: 'lidar', submittedBy: 'Sam Okafor', submittedAt: hoursAgo(72), reviewerName: 'Maya Restrepo', reviewedAt: hoursAgo(48), contentHash: 'a'.repeat(64) },
          { id: 'pv1', version: 1, status: 'superseded', origin: 'capture', inputType: 'lidar', submittedBy: 'Sam Okafor', submittedAt: hoursAgo(900), reviewerName: 'Maya Restrepo', reviewedAt: hoursAgo(880), contentHash: 'b'.repeat(64) },
        ],
      });
    }
    if (path === '/v1/plans/plan_ng1/share-links' && method === 'POST') {
      share = { url: 'http://localhost:3000/s/tok123', expiresAt: null };
      return json(201, share);
    }
    if (path === '/v1/plans/plan_ng1/share-links' && method === 'DELETE') {
      share = null;
      return json(204);
    }
    if (path === '/v1/captures/drawings') return json(201, { captureId: 'cap_1' });
    if (path === '/v1/captures/cap_1/uploads') {
      const req = JSON.parse(init.body);
      return json(200, {
        files: req.files.map((f, i) => ({ name: f.name, fileId: `file_${i}`, parts: [{ number: 1, url: `https://storage.test/${f.name}/1` }] })),
      });
    }
    if (path === '/v1/captures/cap_1/complete') return json(200, { status: 'received' });
    return json(404, { message: 'Not found.' });
  });
  Object.assign(fetch, { calls, bodies, headers });
  return fetch;
}

function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.pathname}</div>;
}

async function renderAt(path) {
  await client.signIn('sam.okafor@northgatefitness.com', 'flex1234');
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/plans" element={<PlansPage />} />
        <Route path="/plans/:planId" element={<PlanPage />} />
        <Route path="/upload" element={<UploadPage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => client.resetForTests());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('status page', () => {
  it('lists every gym and level in the PRD’s words', async () => {
    vi.stubGlobal('fetch', fakeBackend());
    await renderAt('/plans');

    const northgate = await screen.findByRole('region', { name: 'Northgate Fitness' });
    const rows = within(northgate).getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('.ow-pill').textContent)).toEqual(['Ready', 'In review', 'Received']);
    expect(rows[0]).toHaveTextContent('version 2');
    expect(within(rows[0]).getByRole('link', { name: /open walkthrough/i })).toHaveAttribute(
      'href',
      '/plans/plan_ng1/walkthrough',
    );
    expect(rows[1]).toHaveTextContent('With Maya Restrepo since');
    expect(rows[2]).toHaveTextContent('Uploading from the app');

    const riverside = screen.getByRole('region', { name: 'Riverside Gym' });
    expect(riverside).toHaveTextContent('Needs recapture');
    expect(riverside).toHaveTextContent('Incomplete coverage');
    expect(await within(riverside).findByText('Rewalk the north-east corner.')).toBeInTheDocument();
    expect(riverside).toHaveTextContent('Processing complete, awaiting review');
    expect(riverside).toHaveTextContent('PDF');

    expect(screen.getByRole('region', { name: 'Eastbrook Athletic Club' })).toHaveTextContent('No levels yet');
    expect(screen.getByText('6 of 10 this month')).toBeInTheDocument();
  });
});

describe('plan page', () => {
  it('shows history with who and when, and creates, copies and revokes a share link', async () => {
    const fetch = fakeBackend();
    vi.stubGlobal('fetch', fetch);
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await renderAt('/plans/plan_ng1');

    const history = await screen.findByRole('table');
    const rows = within(history).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('v2');
    expect(rows[0]).toHaveTextContent('by Maya Restrepo');
    expect(rows[1]).toHaveTextContent('Superseded');
    expect(rows[0]).toHaveTextContent('aaaaaaaa');

    fireEvent.click(screen.getByRole('button', { name: /create share link/i }));
    const url = await screen.findByLabelText('Share link');
    expect(url).toHaveValue('http://localhost:3000/s/tok123');
    fireEvent.click(screen.getByRole('button', { name: /copy link/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('http://localhost:3000/s/tok123'));

    fireEvent.click(screen.getByRole('button', { name: /revoke link/i }));
    const dialog = await screen.findByRole('dialog', { name: 'Revoke the share link?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke link' }));
    expect(await screen.findByRole('button', { name: /create share link/i })).toBeInTheDocument();
    expect(fetch.calls).toContain('DELETE /v1/plans/plan_ng1/share-links');
  });
});

describe('upload', () => {
  it('uploads a scaled PNG through the signed-URL contract', async () => {
    const fetch = fakeBackend();
    vi.stubGlobal('fetch', fetch);
    await renderAt('/upload');

    // The default gym is preselected.
    await waitFor(() => expect(screen.getByLabelText('Facility')).toHaveValue('fac_ng'));
    fireEvent.change(screen.getByLabelText(/^Level/), { target: { value: '4' } });

    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])], 'RG-102.png', {
      type: 'image/png',
    });
    fireEvent.change(document.querySelector('input[type=file]'), { target: { files: [png] } });
    expect(await screen.findByText('RG-102.png')).toBeInTheDocument();

    const next = screen.getByRole('button', { name: 'Continue' });
    await waitFor(() => expect(next).toBeEnabled());
    fireEvent.click(next);

    // Step 2: the line starts across the middle; nudge its end with the keyboard.
    const end = screen.getByRole('button', { name: /^End of the scale line/ });
    fireEvent.keyDown(end, { key: 'ArrowRight', shiftKey: true });
    expect(end).toHaveAccessibleName(/at 810, 400 pixels/);
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Length of the drawn line/), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // Step 3.
    expect(screen.getByText('20 m over 610 px')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /submit for review/i }));

    expect(await screen.findByText(/was submitted. It is now waiting for review/)).toBeInTheDocument();
    const body = JSON.parse(fetch.bodies['POST /v1/captures/drawings']);
    expect(body).toMatchObject({
      facilityId: 'fac_ng',
      level: 4,
      inputType: 'png',
      originalName: 'RG-102.png',
      imageWidth: 1000,
      imageHeight: 800,
      scale: { a: [200, 400], b: [810, 400], lengthM: 20 },
    });
    expect(fetch.headers['POST /v1/captures/drawings']['Idempotency-Key']).toBeTruthy();
    const opened = JSON.parse(fetch.bodies['POST /v1/captures/cap_1/uploads']);
    expect(opened.files).toEqual([{ name: 'source.png', kind: 'source', bytes: 11, contentType: 'image/png' }]);
    expect(fetch.calls).toContain('PUT /source.png/1');
    expect(fetch.calls.indexOf('POST /v1/captures/cap_1/complete')).toBeGreaterThan(fetch.calls.indexOf('PUT /source.png/1'));
  });

  it('refuses a file that is not what its name says, or is too big', async () => {
    vi.stubGlobal('fetch', fakeBackend());
    await renderAt('/upload');
    const input = await waitFor(() => document.querySelector('input[type=file]'));

    const fake = new File(['hello world'], 'plan.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [fake] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('not a readable PDF');

    const doc = new File(['x'], 'notes.docx');
    fireEvent.change(input, { target: { files: [doc] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a PDF, DWG, JPG or PNG file.');

    const big = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'big.pdf');
    Object.defineProperty(big, 'size', { value: 51 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [big] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('up to 50 MB');
  });

  it('lets a DWG skip the scale step', async () => {
    const fetch = fakeBackend();
    vi.stubGlobal('fetch', fetch);
    await renderAt('/upload');
    await waitFor(() => expect(screen.getByLabelText('Facility')).toHaveValue('fac_ng'));
    const dwg = new File([new Uint8Array([0x41, 0x43, 0x31, 0x30, 0x33, 0x32])], 'plan.dwg');
    fireEvent.change(document.querySelector('input[type=file]'), { target: { files: [dwg] } });
    const next = await screen.findByRole('button', { name: 'Continue' });
    await waitFor(() => expect(next).toBeEnabled());
    fireEvent.click(next);
    expect(screen.getByText(/A DWG with embedded units skips this step/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: /submit for review/i }));
    expect(await screen.findByText(/was submitted. It is now waiting for review/)).toBeInTheDocument();
    expect(JSON.parse(fetch.bodies['POST /v1/captures/drawings'])).toMatchObject({ inputType: 'dwg', scale: null });
  });
});
