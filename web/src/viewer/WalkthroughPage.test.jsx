import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { plansApi } from '../lib/client.js';
import WalkthroughPage from './WalkthroughPage.jsx';

vi.mock('../lib/client.js', () => ({
  plansApi: { model: vi.fn(), share: vi.fn() },
}));

const wall = (id, a, b) => ({ id, a, b, confidence: 1, mirror: false });
const PLAN = {
  format: 'gymplan/1',
  scale: { source: 'scan' },
  underlay: null,
  ceilingHeightM: 3,
  walls: [wall('n', [0, 0], [10, 0]), wall('e', [10, 0], [10, 6]), wall('s', [10, 6], [0, 6]), wall('w', [0, 6], [0, 0])],
  openings: [],
  columns: [],
  objects: [],
  zones: [],
  tags: [],
  flags: [],
};

const model = (planId, level) => ({
  planId,
  site: 'Northgate Fitness',
  organisation: 'Northgate Group',
  level,
  version: 2,
  approvedAt: '2026-09-22T13:33:47.367Z',
  contentHash: 'a'.repeat(64),
  areaM2: 60,
  plan: PLAN,
  levels: [
    { planId: 'plan_ng1', level: 1 },
    { planId: 'plan_ng2', level: 2 },
  ],
});

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/plans/:planId/walkthrough" element={<WalkthroughPage />} />
        <Route path="/plans/:planId" element={<p>Plan page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('owner walkthrough page', () => {
  it('shows the newest approved version, and switches level', async () => {
    plansApi.model.mockImplementation(async (id) => model(id, id === 'plan_ng1' ? 1 : 2));
    renderAt('/plans/plan_ng1/walkthrough');

    expect(await screen.findByRole('img', { name: 'Plan of Northgate Fitness · Level 1' })).toBeInTheDocument();
    expect(screen.getByText(/Level 1 · version 2 · approved 22 Sep 2026 · 60 m²/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Level 1' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Level 2' }));
    expect(await screen.findByRole('img', { name: 'Plan of Northgate Fitness · Level 2' })).toBeInTheDocument();
    expect(plansApi.model).toHaveBeenLastCalledWith('plan_ng2');
  });

  it('creates and copies a share link', async () => {
    plansApi.model.mockResolvedValue(model('plan_ng1', 1));
    plansApi.share.mockResolvedValue({ url: 'http://localhost:3000/s/abcdefghijklmnop' });
    const writeText = vi.fn().mockRejectedValue(new Error('no clipboard'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderAt('/plans/plan_ng1/walkthrough');

    fireEvent.click(await screen.findByRole('button', { name: 'Share link' }));
    // Without clipboard access the link is shown to copy by hand.
    expect(await screen.findByRole('link', { name: 'http://localhost:3000/s/abcdefghijklmnop' })).toBeInTheDocument();
    expect(plansApi.share).toHaveBeenCalledWith('plan_ng1');
  });

  it('says so when there is no approved walkthrough yet, and goes back', async () => {
    plansApi.model.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }));
    renderAt('/plans/plan_ng2/walkthrough');
    expect(await screen.findByRole('heading', { name: 'No approved walkthrough yet' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the plan' }));
    expect(await screen.findByText('Plan page')).toBeInTheDocument();
  });

  it('offers a retry on other errors', async () => {
    plansApi.model
      .mockRejectedValueOnce(Object.assign(new Error('The server returned an error (500).'), { status: 500 }))
      .mockResolvedValue(model('plan_ng1', 1));
    renderAt('/plans/plan_ng1/walkthrough');
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('img', { name: /Plan of Northgate Fitness/ })).toBeInTheDocument();
  });
});
