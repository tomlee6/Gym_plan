import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { tokenFromPath } from './api.js';
import App from './App.jsx';

const wall = (id, a, b) => ({ id, a, b, confidence: 1, mirror: false });

const PLAN = {
  format: 'gymplan/1',
  scale: { source: 'scan' },
  underlay: null,
  ceilingHeightM: 3.18,
  walls: [wall('n', [0, 0], [24, 0]), wall('e', [24, 0], [24, 16]), wall('s', [24, 16], [0, 16]), wall('w', [0, 16], [0, 0])],
  openings: [{ id: 'd', wallId: 'n', type: 'door', offset: 2, width: 1.8, confidence: 1 }],
  columns: [],
  objects: [],
  zones: [],
  tags: [],
  flags: [],
};

const SHARE = {
  site: 'Northgate Fitness',
  organisation: 'Northgate Group',
  level: 1,
  version: 2,
  areaM2: 384,
  approvedAt: '2026-09-22T13:33:47.367Z',
  expiresAt: null,
  plan: PLAN,
};

function respond(status, body) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('share viewer', () => {
  it('opens the approved walkthrough with its details and the disclaimer', async () => {
    const fetch = respond(200, SHARE);
    vi.stubGlobal('fetch', fetch);
    render(<App pathname="/s/9zMArQAJn9AnPnv9IlcEJx3f" />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading walkthrough');
    // jsdom has no WebGL, so the viewer shows the plan from above instead.
    expect(await screen.findByRole('img', { name: 'Plan of Northgate Fitness · Level 1' })).toBeInTheDocument();
    expect(screen.getByText(/cannot show 3D/)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith('/v1/share/9zMArQAJn9AnPnv9IlcEJx3f', expect.anything());

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Northgate Fitness');
    expect(screen.getByText(/View only · version 2 · approved 22 Sep 2026 · 384 m²/)).toBeInTheDocument();
    expect(screen.getByText(/Indicative only/)).toBeInTheDocument();
    // View only: no share or close buttons for someone holding a link.
    expect(screen.queryByRole('button', { name: /share link/i })).toBeNull();
  });

  it('says the walkthrough is coming when the approved version has no plan yet', async () => {
    vi.stubGlobal('fetch', respond(200, { ...SHARE, plan: null, level: 0 }));
    render(<App pathname="/s/9zMArQAJn9AnPnv9IlcEJx3f" />);
    expect(await screen.findByText('The 3D walkthrough is on its way')).toBeInTheDocument();
    expect(screen.getAllByText('Ground').length).toBeGreaterThan(0);
  });

  it('explains an expired, revoked or unknown link', async () => {
    vi.stubGlobal('fetch', respond(404, { message: 'This link is no longer available.' }));
    render(<App pathname="/s/expiredtoken123" />);
    expect(await screen.findByText('This link is no longer available')).toBeInTheDocument();
    expect(screen.getByText(/revoked/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });

  it('offers a retry when the server cannot be reached', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(SHARE) });
    vi.stubGlobal('fetch', fetch);
    render(<App pathname="/s/9zMArQAJn9AnPnv9IlcEJx3f" />);

    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));
    expect(await screen.findByRole('img', { name: /Plan of Northgate Fitness/ })).toBeInTheDocument();
  });

  it('does not call the API for a path that is not a share link', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    render(<App pathname="/" />);
    expect(screen.getByText('This link is no longer available')).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('tokenFromPath', () => {
  it('accepts only /s/<token>', () => {
    expect(tokenFromPath('/s/abc_DEF-123456')).toBe('abc_DEF-123456');
    expect(tokenFromPath('/s/abc_DEF-123456/')).toBe('abc_DEF-123456');
    expect(tokenFromPath('/s/short')).toBeNull();
    expect(tokenFromPath('/s/../../etc')).toBeNull();
    expect(tokenFromPath('/plans/1')).toBeNull();
  });
});
