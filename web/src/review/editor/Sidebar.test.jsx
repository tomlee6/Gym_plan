/**
 * CHANGE 5: what the reviewer actually sees and can change — measurements
 * on the selected element, naming a machine, and the 360 video.
 *
 * Renders the real panel rather than calling the operations directly, so a
 * field that is wired to nothing fails here.
 */
import { approvalBlockers, emptyPlan, upgradePlan } from '@shared/plan/index.js';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
      placing={over.placing ?? null}
      onPlace={over.onPlace}
      keyframes={over.keyframes ?? null}
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
    expect(within(swing).getByRole('option', { name: 'Not recorded' })).toBeInTheDocument();

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

/* Format 3 (H-01..H-03): the fields the new plan format adds. */

const blur = (field, value) => {
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
};

describe('spaces', () => {
  // upgradePlan turns the closed outline into one "Gym floor" space.
  const withSpace = () => {
    const p = plan();
    return { p, space: p.spaces[0] };
  };

  it('edits a space’s name, kind, floor finish and ceiling', () => {
    const { p, space } = withSpace();
    const { change } = show({ plan: p, selection: space.id });
    expect(screen.getByRole('region', { name: 'Selected Space' })).toBeInTheDocument();
    expect(screen.getByLabelText('Space name')).toHaveValue('Gym floor');

    fireEvent.change(screen.getByLabelText('Space kind'), { target: { value: 'studio' } });
    expect(change.mock.calls.at(-1)[0].spaces[0].kind).toBe('studio');
    fireEvent.change(screen.getByLabelText('Floor finish'), { target: { value: 'timber' } });
    expect(change.mock.calls.at(-1)[0].spaces[0].floorFinish).toBe('timber');
    blur(screen.getByLabelText('Space ceiling height'), '4.2');
    expect(change.mock.calls.at(-1)[0].spaces[0].ceilingHeightM).toBe(4.2);
    blur(screen.getByLabelText('Space name'), 'Free weights');
    expect(change.mock.calls.at(-1)[0].spaces[0].name).toBe('Free weights');
    expect(screen.getByText(/Use the ceiling zone tool/)).toBeInTheDocument();
  });

  it('edits a ceiling zone’s height inside its space', () => {
    const { p, space } = withSpace();
    space.ceilingZones = [{ id: 'cz1', points: [[1, 1], [2, 1], [2, 2]], heightM: 3.5 }];
    const { change } = show({ plan: p, selection: 'cz1' });
    expect(screen.getByRole('region', { name: 'Selected Ceiling zone' })).toBeInTheDocument();
    blur(screen.getByLabelText('Zone ceiling height'), '4');
    expect(change.mock.calls[0][0].spaces[0].ceilingZones[0].heightM).toBe(4);
  });
});

describe('walls, format 3', () => {
  it('sets a wall’s kind and curve', () => {
    const { change } = show({ selection: 'n' });
    fireEvent.change(screen.getByLabelText('Wall kind'), { target: { value: 'glass' } });
    expect(change.mock.calls.at(-1)[0].walls[0].kind).toBe('glass');
    blur(screen.getByLabelText('Wall curve'), '0.8');
    expect(change.mock.calls.at(-1)[0].walls[0].curveM).toBe(0.8);
  });

  it('adds a mirror span and edits where it stops', () => {
    const { change } = show({ selection: 'n' });
    fireEvent.click(screen.getByRole('button', { name: 'Add mirror span' }));
    const added = change.mock.calls.at(-1)[0].walls[0];
    expect(added.mirror).toBe(true);
    expect(added.mirrors[0]).toMatchObject({ fromM: 0, toM: 10, bottomM: 0 });

    cleanup();
    const p = plan();
    p.walls[0].mirrors = [{ id: 'm1', fromM: 0, toM: 10, bottomM: 0, topM: 2.4 }];
    p.walls[0].mirror = true;
    const second = show({ plan: p, selection: 'n' });
    blur(screen.getByLabelText('Mirror 1 to'), '4');
    expect(second.change.mock.calls[0][0].walls[0].mirrors[0].toM).toBe(4);
    fireEvent.click(screen.getByRole('button', { name: 'Remove mirror 1' }));
    expect(second.change.mock.calls.at(-1)[0].walls[0]).toMatchObject({ mirror: false, mirrors: [] });
  });
});

describe('openings, format 3', () => {
  it('a kind sets the old type with it', () => {
    const { change } = show({ selection: 'd' });
    expect(screen.getByLabelText('Opening kind')).toHaveValue('single_door');
    fireEvent.change(screen.getByLabelText('Opening kind'), { target: { value: 'fixed_glazing' } });
    expect(change.mock.calls[0][0].openings[0]).toMatchObject({ kind: 'fixed_glazing', type: 'window' });
  });

  it('records leaves, hinge side and the space a door swings into', () => {
    const p = plan();
    const { change } = show({ plan: p, selection: 'd' });
    fireEvent.change(screen.getByLabelText('Leaves'), { target: { value: '2' } });
    expect(change.mock.calls.at(-1)[0].openings[0].leaves).toBe(2);
    fireEvent.change(screen.getByLabelText('Hinge side'), { target: { value: 'right' } });
    expect(change.mock.calls.at(-1)[0].openings[0].hinge).toBe('right');
    const into = screen.getByLabelText('Swings into');
    expect(within(into).getByRole('option', { name: 'Gym floor' })).toBeInTheDocument();
    fireEvent.change(into, { target: { value: p.spaces[0].id } });
    expect(change.mock.calls.at(-1)[0].openings[0].swingInto).toBe(p.spaces[0].id);
  });
});

describe('columns and facing', () => {
  it('makes a column round and part height', () => {
    const p = plan();
    p.columns = [{ id: 'c', x: 2, y: 2, w: 0.4, d: 0.4, angle: 0, shape: 'rect', heightM: null }];
    const { change } = show({ plan: p, selection: 'c' });
    expect(screen.getByLabelText('Column height')).toHaveValue(null);
    fireEvent.change(screen.getByLabelText('Column shape'), { target: { value: 'round' } });
    expect(change.mock.calls.at(-1)[0].columns[0].shape).toBe('round');
    blur(screen.getByLabelText('Column height'), '2.2');
    expect(change.mock.calls.at(-1)[0].columns[0].heightM).toBe(2.2);
  });

  it('sets which way a machine faces', () => {
    const { change } = show({ selection: 'b' });
    blur(screen.getByLabelText('Facing'), '-90');
    expect(change.mock.calls[0][0].objects[0].facingDeg).toBe(270);
  });
});

describe('beams, level changes and voids', () => {
  it('shows the ramp angle only for a ramp', () => {
    const p = plan();
    p.levelChanges = [{ id: 'lc', kind: 'step', points: [[0, 0], [1, 0], [1, 1]], heightM: 0.15, rampAngleDeg: null }];
    show({ plan: p, selection: 'lc' });
    expect(screen.queryByLabelText('Ramp angle')).not.toBeInTheDocument();
    cleanup();
    p.levelChanges[0].kind = 'ramp';
    const { change } = show({ plan: p, selection: 'lc' });
    blur(screen.getByLabelText('Ramp angle'), '4.5');
    expect(change.mock.calls[0][0].levelChanges[0].rampAngleDeg).toBe(4.5);
  });

  it('edits a beam’s underside and a void’s kind', () => {
    const p = plan();
    p.beams = [{ id: 'bm', kind: 'beam', points: [[0, 2], [10, 2], [10, 2.3]], bottomM: null }];
    p.voids = [{ id: 'vd', kind: 'void', points: [[8, 0], [10, 0], [10, 2]], railHeightM: null }];
    const first = show({ plan: p, selection: 'bm' });
    blur(screen.getByLabelText('Underside height'), '2.7');
    expect(first.change.mock.calls[0][0].beams[0].bottomM).toBe(2.7);
    cleanup();
    const second = show({ plan: p, selection: 'vd' });
    fireEvent.change(screen.getByLabelText('Void kind'), { target: { value: 'stair' } });
    expect(second.change.mock.calls[0][0].voids[0].kind).toBe('stair');
  });
});

describe('unplaced machines (H-02)', () => {
  const equipment = [
    { equipmentId: 'EQ-004', type: 'rower', name: 'Rower 2', placed: false, video: { status: 'ready', url: 'x' } },
    { equipmentId: 'EQ-001', type: 'treadmill', name: 'Treadmill 1', placed: true },
  ];

  it('lists the machines without a position and starts placing one', () => {
    const onPlace = vi.fn();
    show({ v: version({ equipment }), onPlace });
    const panel = screen.getByRole('region', { name: 'Unplaced machines' });
    expect(within(panel).getByText('Rower 2')).toBeInTheDocument();
    expect(within(panel).queryByText('Treadmill 1')).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'Place Rower 2 on the plan' }));
    expect(onPlace).toHaveBeenCalledWith(equipment[0]);
  });

  it('shows which one is being placed, and nothing once all are on the plan', () => {
    show({ v: version({ equipment }), placing: equipment[0] });
    expect(screen.getByRole('button', { name: 'Place Rower 2 on the plan' })).toHaveAttribute('aria-pressed', 'true');
    cleanup();
    const p = plan();
    p.objects[0].equipment = { equipmentId: 'EQ-004', type: 'rower', name: 'Rower 2' };
    show({ plan: p, v: version({ equipment }) });
    expect(screen.queryByRole('region', { name: 'Unplaced machines' })).toBeNull();
  });
});

describe('scan keyframes (H-03)', () => {
  // A camera 2 m from the machine at (5, 3), looking straight at it (down -z).
  const facing = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 1.4, 5, 1];

  it('shows the frames that see the selected machine', () => {
    show({
      selection: 'b',
      keyframes: {
        frames: [{ id: 'k1', t: 1, file: 'k1.jpg', transform: facing }],
        files: [{ id: 'f', name: 'keyframes/k1.jpg', kind: 'keyframes', url: 'https://s/k1.jpg?sig' }],
      },
    });
    const panel = screen.getByRole('region', { name: 'Scan photos of this machine' });
    expect(within(panel).getByRole('img')).toHaveAttribute('src', 'https://s/k1.jpg?sig');
    expect(within(panel).getByText('2.0 m')).toBeInTheDocument();
  });

  it('is absent when the capture kept no keyframes', () => {
    show({ selection: 'b' });
    expect(screen.queryByRole('region', { name: 'Scan photos of this machine' })).toBeNull();
  });
});
