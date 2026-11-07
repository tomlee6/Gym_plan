import { emptyPlan } from '@shared/plan/index.js';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { libraryApi, plansApi } from '../lib/client.js';
import CorrectionPage from './CorrectionPage.jsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const wall = (id, a, b) => ({ id, a, b, confidence: 1, mirror: false });
const approved = emptyPlan({
  walls: [wall('n', [0, 0], [10, 0]), wall('e', [10, 0], [10, 6]), wall('s', [10, 6], [0, 6]), wall('w', [0, 6], [0, 0])],
  spaces: [{ id: 's1', name: 'Gym floor', kind: 'gym_floor', points: [[0, 0], [10, 0], [10, 6], [0, 6]] }],
});

function open() {
  vi.spyOn(plansApi, 'get').mockResolvedValue({ id: 'plan_1', facility: 'Northgate Fitness', level: 1, status: 'ready', version: 2 });
  vi.spyOn(plansApi, 'model').mockResolvedValue({ planId: 'plan_1', versionId: 'ver_2', version: 2, plan: approved });
  vi.spyOn(libraryApi, 'list').mockRejectedValue(new Error('offline'));
  const correct = vi.spyOn(plansApi, 'correct').mockResolvedValue({ id: 'ver_3', version: 3 });
  render(
    <MemoryRouter initialEntries={['/plans/plan_1/correct']}>
      <Routes>
        <Route path="/plans/:planId/correct" element={<CorrectionPage />} />
      </Routes>
    </MemoryRouter>,
  );
  return { correct };
}

describe('correcting a plan from site', () => {
  it('opens the approved version, and sends nothing until something is changed', async () => {
    open();
    expect(await screen.findByRole('heading', { name: /Correct/ })).toBeInTheDocument();
    expect(screen.getByText('From approved version 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send correction' })).toBeDisabled();
  });

  it('sends the corrected plan with a note, based on the approved version', async () => {
    const { correct } = open();
    await screen.findByRole('heading', { name: /Correct/ });

    // Rename the room: a change to send.
    fireEvent.click(screen.getByRole('tab', { name: 'Review' }));
    const svg = document.querySelector('svg.ed-svg');
    fireEvent.doubleClick(svg.querySelector('[data-hit="space:s1"]'));
    const name = await screen.findByLabelText('Room name');
    fireEvent.change(name, { target: { value: 'Free weights' } });
    fireEvent.blur(name);

    fireEvent.click(screen.getByRole('button', { name: 'Send correction' }));
    const dialog = screen.getByRole('dialog');
    const send = within(dialog).getByRole('button', { name: 'Send correction' });
    expect(send).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('What was wrong?'), { target: { value: 'The room is the free weights area.' } });
    fireEvent.click(send);

    expect(await screen.findByRole('heading', { name: 'Correction sent' })).toBeInTheDocument();
    const [planId, body] = correct.mock.calls[0];
    expect(planId).toBe('plan_1');
    expect(body.basedOnVersionId).toBe('ver_2');
    expect(body.note).toBe('The room is the free weights area.');
    expect(body.plan.spaces[0].name).toBe('Free weights');
  });
});
