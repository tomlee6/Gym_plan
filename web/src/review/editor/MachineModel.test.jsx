/**
 * L-08: a machine's 3D model reviewed in the editor beside its 360 video,
 * and "same as". The API is stood in for; the WebGL preview too (jsdom has
 * no WebGL), so what is checked is which model it is given.
 */
import { emptyPlan, upgradePlan } from '@shared/plan/index.js';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reviewApi } from '../../lib/client.js';
import { MachineModelDialog, MachineModelPanel, POLL_MS } from './MachineModel.jsx';
import { frontInModel, modelSource, recordedMachine, sameAsChoices, setSameAs } from './machineModels.js';

vi.mock('../../lib/client.js', () => ({
  reviewApi: {
    machineModels: vi.fn(),
    buildModel: vi.fn(),
    approveModel: vi.fn(),
    rejectModel: vi.fn(),
    turnModel: vi.fn(),
  },
}));
vi.mock('./ModelPreview.jsx', () => ({
  default: ({ url, box, front, label }) => (
    <div data-testid="preview" data-url={url} data-box={JSON.stringify(box)} data-front={JSON.stringify(front)}>
      {label}
    </div>
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

const machine = (id, equipmentId, name, extra = {}) => ({
  id,
  x: 2,
  y: 2,
  w: 1,
  d: 2,
  angle: 0,
  heightM: 1.5,
  confidence: 0.9,
  equipment: { equipmentId, type: 'treadmill', name },
  ...extra,
});

function plan(objects) {
  return upgradePlan(emptyPlan({ walls: [], openings: [], objects }));
}

const TREADMILL = {
  machineId: 'm-1',
  equipmentId: 'EQ-001',
  name: 'Treadmill 1',
  widthM: 0.85,
  depthM: 2.1,
  heightM: 1.5,
  modelStatus: 'awaiting_review',
  video: { status: 'ready', url: 'https://cdn.example/360.mp4', thumbnailUrl: null },
};

const model = (over = {}) => ({
  modelId: 'model-2',
  machineId: 'm-1',
  status: 'awaiting_review',
  seed: 2,
  turnDeg: 90,
  sizeM: { w: 0.95, d: 2.03, h: 1.4 },
  scaleErrorPct: 11.3,
  triangleCount: 50000,
  flags: [{ code: 'front_guessed', message: 'Check which way its front faces, and turn it if that is wrong.' }],
  url: 'https://cdn.example/model-2.glb',
  createdAt: '2026-10-13T09:00:00Z',
  reviewNote: null,
  ...over,
});

const listing = (models, over = {}) => ({ machineId: 'm-1', canBuild: true, videoStatus: 'ready', modelStatus: models[0]?.status ?? 'none', models, ...over });

describe('the 3D model panel', () => {
  it('shows the machine’s model status and opens the review', async () => {
    const p = plan([machine('a', 'EQ-001', 'Treadmill 1')]);
    reviewApi.machineModels.mockResolvedValue(listing([model()]));
    render(<MachineModelPanel plan={p} object={p.objects[0]} v={{ equipment: [TREADMILL] }} readOnly={false} history={{ change: vi.fn() }} />);
    expect(screen.getByText('Awaiting review')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review 3D model' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(reviewApi.machineModels).toHaveBeenCalledWith('m-1');
  });

  it('shows the review where the plan says the machine faces', async () => {
    // Footprint turned a quarter; facing a quarter further: its front is along the depth, +Z in the model.
    const p = plan([machine('a', 'EQ-001', 'Treadmill 1', { angle: Math.PI / 2, facingDeg: 180 })]);
    reviewApi.machineModels.mockResolvedValue(listing([model()]));
    render(<MachineModelPanel plan={p} object={p.objects[0]} v={{ equipment: [TREADMILL] }} readOnly={false} history={{ change: vi.fn() }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review 3D model' }));
    expect(JSON.parse((await screen.findByTestId('preview')).dataset.front)).toEqual([0, 1]);
  });

  it('marks a machine the same as another, which then supplies its model', () => {
    const p = plan([machine('a', 'EQ-001', 'Treadmill 1'), machine('b', 'EQ-002', 'Treadmill 2'), machine('c', 'EQ-003', 'Copy', { sameAs: 'a' })]);
    const change = vi.fn();
    render(<MachineModelPanel plan={p} object={p.objects[1]} v={{ equipment: [TREADMILL] }} readOnly={false} history={{ change }} />);
    const select = screen.getByRole('combobox');
    // A copy is not offered: everything points straight at the machine whose model is used.
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['None: its own model', 'EQ-001 · Treadmill 1']);
    fireEvent.change(select, { target: { value: 'a' } });
    expect(change.mock.calls[0][0].objects.find((o) => o.id === 'b').sameAs).toBe('a');

    cleanup();
    const copy = change.mock.calls[0][0];
    render(<MachineModelPanel plan={copy} object={copy.objects[1]} v={{ equipment: [TREADMILL] }} readOnly={false} history={{ change }} />);
    expect(screen.getByText(/Uses the model of/).textContent).toContain('EQ-001');
    expect(screen.queryByRole('button', { name: 'Review 3D model' })).toBeNull();
  });

  it('says why a machine named on the plan alone has no model of its own', () => {
    const p = plan([machine('a', 'EQ-009', 'Bench')]);
    render(<MachineModelPanel plan={p} object={p.objects[0]} v={{ equipment: [] }} readOnly history={{ change: vi.fn() }} />);
    expect(screen.getByText(/No machine was recorded for this on the phone/)).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText('None: its own model')).toBeTruthy();
  });
});

describe('the model review', () => {
  beforeEach(() => {
    reviewApi.machineModels.mockResolvedValue(
      listing([model(), model({ modelId: 'model-1', seed: 1, status: 'rejected', url: 'https://cdn.example/model-1.glb', reviewNote: 'Seat missing', flags: [] })]),
    );
  });

  async function open() {
    render(<MachineModelDialog machine={TREADMILL} onClose={vi.fn()} />);
    return screen.findByTestId('preview');
  }

  it('shows the model beside the video, with what to check', async () => {
    const preview = await open();
    expect(preview.dataset.url).toBe('https://cdn.example/model-2.glb');
    expect(JSON.parse(preview.dataset.box)).toEqual({ w: 0.85, d: 2.1, h: 1.5 });
    expect(document.querySelector('video').getAttribute('src')).toBe('https://cdn.example/360.mp4');
    expect(screen.getByText(/Check which way its front faces/)).toBeTruthy();
    expect(screen.getByText('11.3 %')).toBeTruthy();
    expect(screen.getByText(/scan 2.10 m/)).toBeTruthy();
    // Every model made for it, to look at in turn.
    fireEvent.click(screen.getByRole('button', { name: /Rejected/ }));
    expect(screen.getByTestId('preview').dataset.url).toBe('https://cdn.example/model-1.glb');
    expect(screen.getByText('Seat missing')).toBeTruthy();
  });

  it('approves the model', async () => {
    await open();
    reviewApi.approveModel.mockResolvedValue({ modelId: 'model-2', ...listing([model({ status: 'approved', flags: [] })]) });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(reviewApi.approveModel).toHaveBeenCalledWith('model-2'));
    expect(await screen.findAllByText('Approved')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('rejects only with a reason', async () => {
    await open();
    reviewApi.rejectModel.mockResolvedValue({ modelId: 'model-2', ...listing([model({ status: 'rejected' })]) });
    fireEvent.click(screen.getByRole('button', { name: 'Reject…' }));
    const reject = screen.getByRole('button', { name: 'Reject' });
    expect(reject.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Why is it rejected?'), { target: { value: ' The wrong machine ' } });
    fireEvent.click(reject);
    await waitFor(() => expect(reviewApi.rejectModel).toHaveBeenCalledWith('model-2', 'The wrong machine'));
  });

  it('turns the model a quarter or half turn from where it is', async () => {
    await open();
    reviewApi.turnModel.mockResolvedValue({ modelId: 'model-2', ...listing([model({ status: 'building', url: null })]) });
    fireEvent.click(screen.getByRole('button', { name: '↺ 90°' }));
    await waitFor(() => expect(reviewApi.turnModel).toHaveBeenLastCalledWith('model-2', 180));
    expect(await screen.findByText(/Building… this takes a few minutes/)).toBeTruthy();
  });

  it('turns clockwise and round, wrapping past 0', async () => {
    reviewApi.machineModels.mockResolvedValue(listing([model({ turnDeg: 0 })]));
    await open();
    reviewApi.turnModel.mockResolvedValue({ modelId: 'model-2', ...listing([model({ turnDeg: 270 })]) });
    fireEvent.click(screen.getByRole('button', { name: '↻ 90°' }));
    await waitFor(() => expect(reviewApi.turnModel).toHaveBeenLastCalledWith('model-2', 270));
    fireEvent.click(await screen.findByRole('button', { name: '180°' }));
    await waitFor(() => expect(reviewApi.turnModel).toHaveBeenLastCalledWith('model-2', 90));
  });

  it('builds another, and checks on a build until it is done', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open();
    reviewApi.buildModel.mockResolvedValue({ modelId: 'model-3', ...listing([model({ modelId: 'model-3', seed: 3, status: 'queued', url: null }), model()]) });
    fireEvent.click(screen.getByRole('button', { name: 'Build another' }));
    await waitFor(() => expect(reviewApi.buildModel).toHaveBeenCalledWith('m-1'));
    expect(await screen.findByText(/Queued… this takes a few minutes/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Build another' })).toBeNull();

    reviewApi.machineModels.mockResolvedValue(listing([model({ modelId: 'model-3', seed: 3 }), model()]));
    const calls = reviewApi.machineModels.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS + 10);
    });
    expect(reviewApi.machineModels.mock.calls.length).toBe(calls + 1);
    expect((await screen.findByTestId('preview')).dataset.url).toBe('https://cdn.example/model-2.glb');
  });

  it('offers a model rebuilt from the depth scan when the app sent one, once', async () => {
    reviewApi.machineModels.mockResolvedValue(listing([model({ route: 'generated' })], { canMeasure: true }));
    await open();
    expect(screen.getByText(/TRELLIS.2 · try 2/)).toBeTruthy();
    reviewApi.buildModel.mockResolvedValue({
      modelId: 'model-m',
      ...listing([model({ modelId: 'model-m', route: 'measured', seed: 1, status: 'queued', url: null }), model({ route: 'generated' })], { canMeasure: true }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Build from the depth scan' }));
    await waitFor(() => expect(reviewApi.buildModel).toHaveBeenCalledWith('m-1', 'measured'));
    expect(await screen.findAllByText(/Measured ·/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Build from the depth scan' })).toBeNull();
  });

  it('does not offer the depth scan without one', async () => {
    await open();
    expect(screen.queryByRole('button', { name: 'Build from the depth scan' })).toBeNull();
  });

  it('says what went wrong', async () => {
    await open();
    reviewApi.approveModel.mockRejectedValue(new Error('This model is building: only a built model can be approved.'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect((await screen.findByRole('alert')).textContent).toContain('only a built model');
  });
});

describe('which way the front faces, in the model', () => {
  it('is the facing, measured from the footprint’s width', () => {
    expect(frontInModel({ angle: 0, facingDeg: null })).toEqual([1, 0]);
    expect(frontInModel({ angle: 0 })).toEqual([1, 0]);
    expect(frontInModel({ angle: 0, facingDeg: 90 })).toEqual([0, 1]);
    expect(frontInModel({ angle: Math.PI / 2, facingDeg: 90 })).toEqual([1, 0]);
    expect(frontInModel({ angle: Math.PI / 2, facingDeg: 0 })).toEqual([0, -1]);
    expect(frontInModel({ angle: Math.PI, facingDeg: 0 })).toEqual([-1, 0]);
  });
});

describe('same as', () => {
  const p = plan([machine('a', 'EQ-001', 'A'), machine('b', 'EQ-002', 'B', { sameAs: 'a' }), machine('c', 'EQ-003', 'C'), machine('d', 'EQ-004', 'D', { sameAs: 'c' })]);

  it('always points straight at the machine whose model is used', () => {
    // C the same as B (a copy of A): C, and D with it, use A's.
    const next = setSameAs(p, 'c', 'b');
    expect(next.objects.find((o) => o.id === 'c').sameAs).toBe('a');
    expect(next.objects.find((o) => o.id === 'd').sameAs).toBe('a');
    expect(setSameAs(p, 'b', null).objects.find((o) => o.id === 'b').sameAs).toBeNull();
    // Never itself, and never round in a circle.
    expect(setSameAs(p, 'a', 'b')).toBe(p);
    expect(setSameAs(p, 'a', 'missing')).toBe(p);
  });

  it('finds the machine that supplies the model, and the one the surveyor recorded', () => {
    expect(modelSource(p, p.objects[1]).id).toBe('a');
    expect(modelSource(p, p.objects[0]).id).toBe('a');
    expect(recordedMachine({ equipment: [{ equipmentId: 'EQ-003', machineId: 'm-3' }] }, p.objects[2]).machineId).toBe('m-3');
    expect(recordedMachine({ equipment: [] }, p.objects[2])).toBeNull();
    expect(sameAsChoices(p, p.objects[0]).map((o) => o.id)).toEqual(['c']);
  });
});
