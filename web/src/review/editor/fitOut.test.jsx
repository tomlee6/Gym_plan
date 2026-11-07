import { emptyPlan, libraryItem, libraryPlacement } from '@shared/plan/index.js';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { fitOutSchedule, scheduleCsv } from './fitOut.js';
import FitOutSchedule from './FitOutSchedule.jsx';
import { placeEquipment, updateElement } from './ops.js';

const wall = (id, a, b) => ({ id, a, b, confidence: 1, mirror: false });
const gym = () =>
  emptyPlan({
    walls: [wall('n', [0, 0], [12, 0]), wall('e', [12, 0], [12, 8]), wall('s', [12, 8], [0, 8]), wall('w', [0, 8], [0, 0])],
    spaces: [{ id: 's1', name: 'Gym floor', kind: 'gym_floor', points: [[0, 0], [12, 0], [12, 8], [0, 8]] }],
  });

/** Places a library machine; returns the plan and the new machine's id. */
function put(plan, key, x, y) {
  return placeEquipment(plan, libraryPlacement(libraryItem(key), plan), [x, y]);
}

describe('the fit-out schedule', () => {
  it('lists each machine with its size, room and what to order', () => {
    let { plan } = put(gym(), 'flat-bench', 4, 4);
    ({ plan } = put(plan, 'flat-bench', 7, 4));
    ({ plan } = put(plan, 'rower', 9, 4));
    const s = fitOutSchedule(plan);
    expect(s.lines).toHaveLength(3);
    expect(s.lines[0]).toMatchObject({ name: 'Flat bench', room: 'Gym floor', widthM: 0.6, depthM: 1.3 });
    expect(s.counts).toEqual([
      { name: 'Flat bench', count: 2 },
      { name: 'Rowing machine', count: 1 },
    ]);
    expect(s.problems).toBe(0);
  });

  it('warns of a machine too close to a wall or to another machine', () => {
    let { plan } = put(gym(), 'flat-bench', 0.5, 4); // 0.2 m from the west wall
    ({ plan } = put(plan, 'flat-bench', 1.4, 4)); // 0.3 m from the first
    const [a, b] = fitOutSchedule(plan).lines;
    expect(a.issues.join(' ')).toMatch(/0\.20 m from a wall; needs 0\.6 m/);
    expect(b.issues.join(' ')).toMatch(/0\.30 m from Flat bench; needs 0\.6 m/);
  });

  it('asks which way a treadmill faces, then checks its 2 m run-off', () => {
    // A treadmill 2.1 m long (along y), its back 0.5 m from the south wall.
    let { plan, id } = put(gym(), 'treadmill', 6, 6.45);
    expect(fitOutSchedule(plan).lines[0].issues.join(' ')).toMatch(/Set which way it faces/);

    // Facing north (-y): the wall is 0.5 m behind it, so the run-off is blocked.
    plan = updateElement(plan, id, { facingDeg: -90 });
    expect(fitOutSchedule(plan).lines[0]).toMatchObject({ behind: 'blocked' });

    // Facing south: the room is clear behind it.
    plan = updateElement(plan, id, { facingDeg: 90 });
    const line = fitOutSchedule(plan).lines[0];
    expect(line.behind).toBe('clear');
  });

  it('exports CSV that a spreadsheet reads safely', () => {
    let { plan, id } = put(gym(), 'rower', 6, 4);
    plan = updateElement(plan, id, { equipment: { ...plan.objects[0].equipment, name: '=HYPERLINK("x")' } });
    const csv = scheduleCsv(fitOutSchedule(plan));
    const [head, row] = csv.trim().split('\r\n');
    expect(head.startsWith('Ref,Machine,Type,Room')).toBe(true);
    // A name starting "=" is not run as a formula, and quotes are escaped.
    expect(row).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it('shows the schedule, selects a machine and offers the CSV', () => {
    let { plan, id } = put(gym(), 'rower', 6, 4);
    const onSelect = vi.fn();
    render(<FitOutSchedule plan={plan} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /Fit-out schedule/ }));
    expect(screen.getByRole('button', { name: 'Download CSV' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Select Rowing machine/ }));
    expect(onSelect).toHaveBeenCalledWith(id);
  });
});
