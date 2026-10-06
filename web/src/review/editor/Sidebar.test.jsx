/**
 * CHANGE 5: what the reviewer actually sees and can change — measurements
 * on the selected element, naming a machine, and the 360 video.
 *
 * Renders the real panel rather than calling the operations directly, so a
 * field that is wired to nothing fails here.
 */
import { approvalBlockers, emptyPlan, upgradePlan } from '@shared/plan/index.js';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import Sidebar from './Sidebar.jsx';

afterEach(cleanup);

const wall = (id, a, b) => ({ id, a, b, confidence: 0.95, mirror: false });

function plan() {
  const p = upgradePlan(
    emptyPlan({
      walls: [
        wall('n', [0, 0], [10, 0]),
        wall('e', [10, 0], [10, 6]),
        wall('s', [10, 6], [0, 6]),
        wall('w', [0, 6], [0, 0]),
      ],
      openings: [
        { id: 'd', wallId: 'n', type: 'door', offset: 1, width: 0.9, confidence: 0.9 },
        { id: 'win', wallId: 's', type: 'window', offset: 2, width: 1.8, confidence: 0.9 },
      ],
      objects: [{ id: 'b', x: 5, y: 3, w: 1, d: 2, angle: 0, heightM: 1.5, confidence: 0.9 }],
    }),
  );
  // As a scan leaves it: a measured height, no measured thickness.
  p.walls.forEach((w) => {
    w.heightM = 3.1;
    w.thicknessM = null;
    w.source = 'roomplan';
  });
  p.openings[0].heightM = 2.04;
  p.openings[1].heightM = 1.5;
  p.openings[1].sillHeightM = 0.9;
  return p;
}

const version = (over = {}) => ({ files: [], equipment: [], history: [], ...over });

function show(over = {}) {
  const change = vi.fn();
  const current = over.plan ?? plan();
  render(
    <Sidebar
      v={over.v ?? version()}
      plan={current}
      issues={[]}
      readOnly={over.readOnly ?? false}
      selection={over.selection ?? null}
      onSelect={() => {}}
      onFocus={() => {}}
      history={{ change }}
    />,
  );
  return { change, plan: current };
}

describe('wall measurements', () => {
  it('shows the length, bearing and measured height', () => {
    show({ selection: 'n' });
    expect(screen.getByLabelText('Wall length')).toHaveValue(10);
    expect(screen.getByText('0.0°')).toBeInTheDocument();
    expect(screen.getByLabelText('Wall height')).toHaveValue(3.1);
  });

  it('leaves a thickness that was never measured blank, not nought', () => {
    show({ selection: 'n' });
    // A corner at [0, 0] is a real nought; an unmeasured thickness is not.
    expect(screen.getByLabelText('Wall thickness')).toHaveValue(null);
    expect(screen.getByLabelText('Wall thickness').value).toBe('');
  });

  it('moves the wall when a measured length is typed in', () => {
    const { change } = show({ selection: 'n' });
    const field = screen.getByLabelText('Wall length');
    fireEvent.change(field, { target: { value: '8.5' } });
    fireEvent.blur(field);

    expect(change).toHaveBeenCalledTimes(1);
    const next = change.mock.calls[0][0];
    const n = next.walls.find((w) => w.id === 'n');
    expect(n.a).toEqual([0, 0]);
    expect(n.b[0]).toBeCloseTo(8.5);
  });

  it('records a thickness the reviewer measured on site', () => {
    const { change } = show({ selection: 'n' });
    const field = screen.getByLabelText('Wall thickness');
    fireEvent.change(field, { target: { value: '0.2' } });
    fireEvent.blur(field);
    expect(change.mock.calls[0][0].walls.find((w) => w.id === 'n').thicknessM).toBe(0.2);
  });

  it('shows measurements but no inputs once the plan is read-only', () => {
    show({ selection: 'n', readOnly: true });
    expect(screen.queryByLabelText('Wall length')).not.toBeInTheDocument();
    expect(screen.getByText('Not measured')).toBeInTheDocument();
  });
});

describe('door and window measurements', () => {
  it('offers a swing for a door, which the scan never recorded', () => {
    const { change } = show({ selection: 'd' });
    const swing = screen.getByLabelText('Swing');
    expect(swing).toHaveValue('');
    expect(screen.getByRole('option', { name: 'Not recorded' })).toBeInTheDocument();

    fireEvent.change(swing, { target: { value: 'outward' } });
    expect(change.mock.calls[0][0].openings.find((o) => o.id === 'd').swing).toBe('outward');
  });

  it('shows a sill for a window and not for a door', () => {
    show({ selection: 'win' });
    expect(screen.getByLabelText('Sill height')).toHaveValue(0.9);
    cleanup();
    show({ selection: 'd' });
    expect(screen.queryByLabelText('Sill height')).not.toBeInTheDocument();
  });

  it('corrects a window’s sill', () => {
    const { change } = show({ selection: 'win' });
    const field = screen.getByLabelText('Sill height');
    fireEvent.change(field, { target: { value: '1.1' } });
    fireEvent.blur(field);
    expect(change.mock.calls[0][0].openings.find((o) => o.id === 'win').sillHeightM).toBe(1.1);
  });
});

describe('naming a machine', () => {
  it('says an object is not identified, because RoomPlan cannot name one', () => {
    show({ selection: 'b' });
    expect(screen.getByText(/RoomPlan cannot name a gym machine/)).toBeInTheDocument();
  });

  it('names it, and the name reaches the plan', () => {
    const { change } = show({ selection: 'b' });
    fireEvent.click(screen.getByRole('button', { name: 'Name this machine' }));

    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'treadmill' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Treadmill 1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const object = change.mock.calls[0][0].objects.find((o) => o.id === 'b');
    expect(object.equipment).toEqual({ equipmentId: 'EQ-001', type: 'treadmill', name: 'Treadmill 1' });
  });

  it('accepts a machine type the catalogue has never heard of', () => {
    const { change } = show({ selection: 'b' });
    fireEvent.click(screen.getByRole('button', { name: 'Name this machine' }));
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'plateLoadedHipThrust' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(change.mock.calls[0][0].objects[0].equipment.type).toBe('plateLoadedHipThrust');
  });

  it('turns a machine to a bearing', () => {
    const { change } = show({ selection: 'b' });
    const field = screen.getByLabelText('Rotation');
    fireEvent.change(field, { target: { value: '90' } });
    fireEvent.blur(field);
    expect(change.mock.calls[0][0].objects[0].angle).toBeCloseTo(Math.PI / 2);
  });

  it('shows the clearances once a machine is named', () => {
    const named = plan();
    named.objects[0].equipment = { equipmentId: 'EQ-001', type: 'treadmill', name: 'Treadmill 1' };
    show({ plan: named, selection: 'b' });
    expect(screen.getByText('To nearest wall')).toBeInTheDocument();
    expect(screen.getByText('2.00 m')).toBeInTheDocument();
  });
});

describe('the 360 video', () => {
  const named = () => {
    const p = plan();
    p.objects[0].equipment = { equipmentId: 'EQ-001', type: 'treadmill', name: 'Treadmill 1' };
    return p;
  };

  it('plays the video recorded for this machine', () => {
    show({
      plan: named(),
      selection: 'b',
      v: version({
        equipment: [
          {
            equipmentId: 'EQ-001',
            video: { videoId: 'vid_1', status: 'ready', url: 'https://example.test/360.mp4', thumbnailUrl: null, durationSeconds: 24 },
          },
        ],
      }),
    });
    const video = document.querySelector('video');
    expect(video).toBeTruthy();
    expect(video.getAttribute('src')).toBe('https://example.test/360.mp4');
    expect(screen.getByText(/360° walkaround · 24 s/)).toBeInTheDocument();
  });

  it('says so when a machine has no video', () => {
    show({ plan: named(), selection: 'b', v: version() });
    expect(screen.getByText(/No 360° video was recorded/)).toBeInTheDocument();
    expect(document.querySelector('video')).toBeNull();
  });

  it('does not offer a player while the upload is still going', () => {
    show({
      plan: named(),
      selection: 'b',
      v: version({ equipment: [{ equipmentId: 'EQ-001', video: { videoId: 'v', status: 'uploading', url: null } }] }),
    });
    expect(document.querySelector('video')).toBeNull();
    expect(screen.getByText(/360° video uploading/)).toBeInTheDocument();
  });
});

describe('flagging a machine that looks wrong', () => {
  const named = () => {
    const p = plan();
    p.objects[0].equipment = { equipmentId: 'EQ-001', type: 'treadmill', name: 'Treadmill 1' };
    return p;
  };

  it('raises a flag, which blocks approval until it is settled', () => {
    const { change } = show({ plan: named(), selection: 'b' });
    fireEvent.click(screen.getByRole('button', { name: 'Flag as wrong' }));

    const next = change.mock.calls[0][0];
    const flag = next.flags.find((f) => f.elementId === 'b');
    expect(flag.status).toBe('open');
    expect(flag.title).toBe('Treadmill 1 looks wrong');
    expect(approvalBlockers(next).some((b) => /flagged element/.test(b))).toBe(true);
  });

  it('will not raise the same flag twice', () => {
    const already = named();
    already.flags = [
      { id: 'f', kind: 'equipment_wrong', elementId: 'b', title: 'Treadmill 1 looks wrong', detail: '', status: 'open' },
    ];
    show({ plan: already, selection: 'b' });
    expect(screen.getByRole('button', { name: 'Flagged' })).toBeDisabled();
  });
});
