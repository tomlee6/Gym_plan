import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import App from '../App.jsx';
import { plansApi, reviewApi } from '../lib/client.js';
import ReviewWalkthroughPage from '../review/ReviewWalkthroughPage.jsx';
import WalkthroughPage from './WalkthroughPage.jsx';

// The viewer itself needs WebGL; here it only shows what it was given.
vi.mock('./Walkthrough.jsx', () => ({
  default: ({ modelUrl, machineModels, site, meta }) => (
    <div data-testid="viewer" data-site={site} data-meta={meta} data-machines={JSON.stringify(machineModels)}>
      {modelUrl ?? 'no model'}
    </div>
  ),
}));
vi.mock('../lib/client.js', () => ({ plansApi: { model: vi.fn(), share: vi.fn() }, reviewApi: { version: vi.fn() } }));

const PLAN = { format: 'gymplan/3', ceilingHeightM: 3, walls: [], openings: [], columns: [], objects: [], zones: [], tags: [], flags: [] };
const URL_SIGNED = 'https://d111111abcdef8.cloudfront.net/models/accounts/a/levels/h/build3d-1.glb?Expires=1792000000&Signature=s&Key-Pair-Id=K';
const stored = { generatorVersion: 'build3d-1', stored: true, bytes: 66052, url: URL_SIGNED, urlExpiresAt: '2026-10-12T10:15:00.000Z' };
const notStored = { generatorVersion: 'browser-0', stored: false, bytes: null, url: null, urlExpiresAt: null };
// J-06: the machines' approved models go to the viewer with the level.
const MACHINES = { 'EQ-001': { modelId: 'model-1', sizeM: { w: 0.9, d: 2, h: 1.4 }, lods: [{ url: 'https://cdn.example/m.glb', triangles: 50000 }] } };
const machinesOf = (viewer) => JSON.parse(viewer.dataset.machines);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the generated model reaches the viewer (K-01, K-05)', () => {
  it('on a share link, the same signed model the owner sees', async () => {
    const share = { site: 'Northgate Fitness', level: 1, version: 2, areaM2: 384, approvedAt: null, expiresAt: null, plan: PLAN, generatedModel: stored, machineModels: MACHINES };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(share) }));
    render(<App pathname="/s/9zMArQAJn9AnPnv9IlcEJx3f" />);
    const viewer = await screen.findByTestId('viewer');
    expect(viewer).toHaveTextContent(URL_SIGNED);
    expect(machinesOf(viewer)).toEqual(MACHINES);
  });

  it('on a share link with no stored model, none, so the viewer draws the plan', async () => {
    const share = { site: 'Northgate Fitness', level: 1, version: 2, areaM2: 384, approvedAt: null, expiresAt: null, plan: PLAN, generatedModel: notStored };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(share) }));
    render(<App pathname="/s/9zMArQAJn9AnPnv9IlcEJx3f" />);
    expect(await screen.findByTestId('viewer')).toHaveTextContent('no model');
  });

  it('on the owner’s walkthrough page', async () => {
    plansApi.model.mockResolvedValue({
      planId: 'plan_ng1',
      site: 'Northgate Fitness',
      level: 1,
      version: 2,
      approvedAt: null,
      areaM2: 60,
      plan: PLAN,
      generatedModel: stored,
      machineModels: MACHINES,
      levels: [{ planId: 'plan_ng1', level: 1 }],
    });
    render(
      <MemoryRouter initialEntries={['/plans/plan_ng1/walkthrough']}>
        <Routes>
          <Route path="/plans/:planId/walkthrough" element={<WalkthroughPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const viewer = await screen.findByTestId('viewer');
    expect(viewer).toHaveTextContent(URL_SIGNED);
    expect(machinesOf(viewer)).toEqual(MACHINES);
  });

  it('for a reviewer checking a version in 3D (K-06)', async () => {
    reviewApi.version.mockResolvedValue({ id: 'v1', version: 3, facility: 'Northgate Fitness', level: 1, plan: PLAN, generatedModel: stored, machineModels: MACHINES });
    render(
      <MemoryRouter initialEntries={['/review/versions/v1/walkthrough']}>
        <Routes>
          <Route path="/review/versions/:id/walkthrough" element={<ReviewWalkthroughPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const viewer = await screen.findByTestId('viewer');
    expect(viewer).toHaveTextContent(URL_SIGNED);
    expect(viewer.dataset.meta).toBe('Review · version 3 · Level 1 · generated model build3d-1');
    expect(machinesOf(viewer)).toEqual(MACHINES);
  });

  it('says when a reviewer’s version has no generated model yet', async () => {
    reviewApi.version.mockResolvedValue({
      id: 'v2',
      version: 4,
      facility: 'Northgate Fitness',
      level: 1,
      plan: PLAN,
      generatedModel: { status: 'failed', generatorVersion: 'build3d-1', stored: false, url: null, failureReason: 'The walls do not close. [open_outline]' },
    });
    render(
      <MemoryRouter initialEntries={['/review/versions/v2/walkthrough']}>
        <Routes>
          <Route path="/review/versions/:id/walkthrough" element={<ReviewWalkthroughPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const viewer = await screen.findByTestId('viewer');
    expect(viewer).toHaveTextContent('no model');
    expect(viewer.dataset.meta).toMatch(/3D build failed: drawn from the plan/);
  });
});
