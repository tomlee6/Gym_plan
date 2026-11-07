import { EQUIPMENT_LIBRARY } from '@shared/plan/index.js';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { adminApi } from '../lib/client.js';
import { useLibrary } from '../review/editor/useLibrary.js';
import LibraryPage, { machineFormProblems } from './LibraryPage.jsx';
import { keyFrom, parseCsv, readCatalogue } from './libraryImport.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const row = (over = {}) => ({
  id: '01930000-0000-7000-8000-000000000001',
  key: 'treadmill',
  name: 'Treadmill',
  category: 'Cardio',
  type: 'treadmill',
  widthM: 0.9,
  depthM: 2.1,
  heightM: 1.6,
  clearance: { aroundM: 0.6, behindM: 2 },
  modelCode: null,
  description: null,
  manufacturer: null,
  source: 'platform',
  status: 'active',
  sortOrder: 0,
  ...over,
});

describe('reading a catalogue file', () => {
  it('reads CSV with quotes, commas and a maker’s own column names', () => {
    expect(parseCsv('a,"b, c","say ""hi"""\r\n1,2,3\n')).toEqual([
      ['a', 'b, c', 'say "hi"'],
      ['1', '2', '3'],
    ]);
    const { rows, problems } = readCatalogue(
      'Model Name,Category,Equipment Type,Width (m),Depth,Height,Run-off,Part Number,Colour\n' +
        '"Acme T5 Treadmill",Cardio,treadmill,"0,95",2.2,1.6,2,T5-BLK,Black\n',
      'acme.csv',
    );
    expect(problems).toEqual([]);
    expect(rows).toEqual([
      { key: 'acme-t5-treadmill', name: 'Acme T5 Treadmill', category: 'Cardio', type: 'treadmill', widthM: 0.95, depthM: 2.2, heightM: 1.6, clearanceBehindM: 2, modelCode: 'T5-BLK' },
    ]);
  });

  it('reads JSON, as a list or as { rows }', () => {
    const one = { key: 'r3', name: 'R3', category: 'Cardio', type: 'rowingMachine', widthM: 0.6, depthM: 2.4, heightM: 1 };
    expect(readCatalogue(JSON.stringify([one])).rows).toEqual([one]);
    expect(readCatalogue(JSON.stringify({ rows: [one] }), 'x.json').rows).toEqual([one]);
  });

  it('says what is wrong with a file before it is sent', () => {
    expect(readCatalogue('').problems).toEqual(['The file is empty.']);
    expect(readCatalogue('{nope').problems).toEqual(['The file is not valid JSON.']);
    expect(readCatalogue('colour\nred').problems[0]).toMatch(/name column/);
    const bad = readCatalogue('name,category,type,width,depth,height\nBike,Cardio,exerciseBike,wide,1,1\nBike,Cardio,exerciseBike,0,1,1\n');
    expect(bad.problems).toEqual(
      expect.arrayContaining([
        'line 2: widthM “wide” is not a number',
        'line 2: no widthM',
        'line 3: widthM must be more than 0',
        'The key “bike” is used more than once.',
      ]),
    );
    expect(keyFrom('  Acme / T5  Treadmill! ')).toBe('acme-t5-treadmill');
  });
});

describe('the editor’s library', () => {
  it('uses the database’s machines, keyed by row so makers can share keys', async () => {
    const load = vi.fn().mockResolvedValue({ items: [row(), row({ id: '01930000-0000-7000-8000-0000000000aa', manufacturer: { id: 'm1', name: 'Acme' } })] });
    const { result } = renderHook(() => useLibrary(load));
    expect(result.current.items).toBe(EQUIPMENT_LIBRARY);
    await waitFor(() => expect(result.current.live).toBe(true));
    expect(result.current.items.map((i) => [i.key, i.libraryKey])).toEqual([
      ['01930000-0000-7000-8000-000000000001', 'treadmill'],
      ['01930000-0000-7000-8000-0000000000aa', 'treadmill'],
    ]);
  });

  it('falls back to the built-in list when the library cannot be loaded', async () => {
    const load = vi.fn().mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useLibrary(load));
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.items).toBe(EQUIPMENT_LIBRARY);
    expect(result.current.live).toBe(false);
  });
});

describe('the admin library page', () => {
  function backend(items = [row(), row({ id: '01930000-0000-7000-8000-000000000002', key: 'rower', name: 'Rowing machine', type: 'rowingMachine', clearance: { aroundM: 0.6, behindM: 0.6 } })]) {
    const state = { items, manufacturers: [{ id: 'm1', name: 'Acme Fitness', slug: 'acme-fitness', website: null, status: 'active', machines: 0 }] };
    vi.spyOn(adminApi, 'library').mockImplementation(async () => ({ items: state.items }));
    vi.spyOn(adminApi, 'manufacturers').mockImplementation(async () => ({ manufacturers: state.manufacturers }));
    const update = vi.spyOn(adminApi, 'updateLibraryItem').mockImplementation(async (id, body) => {
      state.items = state.items.map((i) => (i.id === id ? { ...i, ...body } : i));
      return {};
    });
    const add = vi.spyOn(adminApi, 'addLibraryItem').mockResolvedValue({});
    return { state, update, add };
  }

  it('lists machines and archives one', async () => {
    const { update } = backend();
    render(<LibraryPage />);
    const table = await screen.findByRole('table', { name: 'Library machines' });
    expect(within(table).getByText('Treadmill')).toBeInTheDocument();
    expect(within(table).getByText(/0\.60 round, 2\.00 behind/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Archive Rowing machine' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('01930000-0000-7000-8000-000000000002', { status: 'archived' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Rowing machine is archived');
    // Archived rows are hidden until asked for.
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Library machines' })).queryByText('Rowing machine')).toBeNull());
    fireEvent.click(screen.getByLabelText('Show archived'));
    expect(within(screen.getByRole('table', { name: 'Library machines' })).getByText('Rowing machine')).toBeInTheDocument();
  });

  it('adds a machine, checking the form first', async () => {
    const { add } = backend();
    render(<LibraryPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add machine' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save machine' }));
    expect(add).not.toHaveBeenCalled();
    expect(within(dialog).getByText('Give the machine a name.')).toBeInTheDocument();

    const type = (label, value) => fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });
    type('Name', 'Acme T5');
    type('Key', 't5');
    type('Equipment type', 'treadmill');
    type('Width (m)', '0.95');
    type('Depth (m)', '2.2');
    type('Height (m)', '1.6');
    type('Clearance behind (m)', '2');
    fireEvent.change(within(dialog).getByLabelText('Manufacturer'), { target: { value: 'm1' } });
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Save machine' })));
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ key: 't5', name: 'Acme T5', widthM: 0.95, clearanceAroundM: 0.6, clearanceBehindM: 2, manufacturerId: 'm1' }),
    );
  });

  it('checks every field of a machine', () => {
    const p = machineFormProblems({ key: 'Bad Key', name: '', category: '', type: 'x/y', widthM: '0', depthM: '31', heightM: 'tall', clearanceAroundM: '', clearanceBehindM: '-1' });
    expect(Object.keys(p).sort()).toEqual(['category', 'clearanceAroundM', 'clearanceBehindM', 'depthM', 'heightM', 'key', 'name', 'type', 'widthM']);
  });
});
