import { EQUIPMENT_LIBRARY, emptyPlan, libraryItem, libraryPlacement, nextLibraryId, searchLibrary } from '@shared/plan/index.js';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import EquipmentLibrary, { LIBRARY_DRAG_TYPE } from './EquipmentLibrary.jsx';
import { placeEquipment } from './ops.js';

describe('the equipment library', () => {
  it('has unique keys and sensible sizes', () => {
    const keys = EQUIPMENT_LIBRARY.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const i of EQUIPMENT_LIBRARY) {
      expect(i.widthM).toBeGreaterThan(0);
      expect(i.depthM).toBeGreaterThan(0);
      expect(i.heightM).toBeGreaterThan(0);
      expect(i.widthM).toBeLessThanOrEqual(30);
      expect(i.clearance.aroundM).toBeGreaterThanOrEqual(0);
    }
    // A treadmill needs its run-off behind it.
    expect(libraryItem('treadmill').clearance.behindM).toBe(2);
  });

  it('searches by every word typed', () => {
    expect(searchLibrary('').length).toBe(EQUIPMENT_LIBRARY.length);
    expect(searchLibrary('rack').map((i) => i.key)).toEqual(expect.arrayContaining(['power-rack', 'half-rack', 'dumbbell-rack']));
    expect(searchLibrary('recumbent bike').map((i) => i.key)).toEqual(['recumbent-bike']);
    expect(searchLibrary('hovercraft')).toEqual([]);
  });

  it('gives a placed machine a reference no recorded machine has', () => {
    const plan = emptyPlan({ objects: [{ id: 'b1', equipment: { equipmentId: 'LIB-001' } }] });
    expect(nextLibraryId(plan, [{ equipmentId: 'LIB-002' }])).toBe('LIB-003');
  });

  it('places a library machine at its typical size', () => {
    const plan = emptyPlan();
    const item = libraryPlacement(libraryItem('leg-press'), plan);
    const { plan: next, id } = placeEquipment(plan, item, [3, 4]);
    const placed = next.objects.find((o) => o.id === id);
    expect(placed).toMatchObject({ x: 3, y: 4, w: 1.6, d: 2.3, heightM: 1.5, source: 'reviewer' });
    expect(placed.equipment).toEqual({ equipmentId: 'LIB-001', type: 'legPress', name: 'Leg press' });
  });

  it('lists machines to place or drag, and hides itself when read only', () => {
    const onPlace = vi.fn();
    const { rerender } = render(<EquipmentLibrary readOnly={false} onPlace={onPlace} />);
    fireEvent.click(screen.getByRole('button', { name: /Equipment library/ }));
    fireEvent.change(screen.getByLabelText('Search equipment'), { target: { value: 'rower' } });
    fireEvent.click(screen.getByRole('button', { name: 'Place a Rowing machine on the plan' }));
    expect(onPlace).toHaveBeenCalledWith(expect.objectContaining({ key: 'rower' }));

    const setData = vi.fn();
    fireEvent.dragStart(screen.getByText('Rowing machine').closest('li'), { dataTransfer: { setData, effectAllowed: '' } });
    expect(setData).toHaveBeenCalledWith(LIBRARY_DRAG_TYPE, 'rower');

    rerender(<EquipmentLibrary readOnly onPlace={onPlace} />);
    expect(screen.queryByRole('region', { name: 'Equipment library' })).toBeNull();
  });
});
