import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as client from '../lib/client.js';
import ObjectsPage from './ObjectsPage.jsx';

const OBJECTS = [
  {
    objectId: 'obj_1',
    name: 'Leg press',
    status: 'ready',
    facility: { id: 'fac_ng', name: 'Northgate Fitness' },
    bytes: 9 * 1024 * 1024,
    photoCount: 84,
    scannedBy: 'Lee Tan',
    scannedAt: '2026-10-31T11:20:00Z',
    createdAt: '2026-10-31T11:25:00Z',
  },
  {
    objectId: 'obj_2',
    name: 'Rower',
    status: 'ready',
    facility: null,
    bytes: 4 * 1024 * 1024,
    photoCount: null,
    scannedBy: null,
    scannedAt: null,
    createdAt: '2026-10-30T09:00:00Z',
  },
];

const page = () =>
  render(
    <MemoryRouter>
      <ObjectsPage />
    </MemoryRouter>,
  );

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('3D objects page', () => {
  it('lists each object with where, when and how it was scanned', async () => {
    vi.spyOn(client.objectsApi, 'list').mockResolvedValue({ objects: OBJECTS });
    page();

    expect(await screen.findByRole('heading', { name: 'Leg press' })).toBeInTheDocument();
    const leg = screen.getByRole('heading', { name: 'Leg press' }).closest('li');
    expect(within(leg).getByText(/Northgate Fitness/)).toBeInTheDocument();
    expect(within(leg).getByText(/84 photos/)).toBeInTheDocument();
    expect(within(leg).getByText(/Scanned by Lee Tan/)).toBeInTheDocument();

    const rower = screen.getByRole('heading', { name: 'Rower' }).closest('li');
    expect(within(rower).getByText(/No gym given/)).toBeInTheDocument();
  });

  it('says how to make one when there are none', async () => {
    vi.spyOn(client.objectsApi, 'list').mockResolvedValue({ objects: [] });
    page();
    expect(await screen.findByText('No 3D objects yet')).toBeInTheDocument();
  });

  it('fetches a fresh signed link to download', async () => {
    vi.spyOn(client.objectsApi, 'list').mockResolvedValue({ objects: OBJECTS });
    const get = vi
      .spyOn(client.objectsApi, 'get')
      .mockResolvedValue({ ...OBJECTS[0], downloadUrl: 'https://files.test/obj_1.usdz?sig=x' });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      expect(this.href).toBe('https://files.test/obj_1.usdz?sig=x');
      expect(this.download).toBe('Leg press.usdz');
    });
    page();

    const leg = (await screen.findByRole('heading', { name: 'Leg press' })).closest('li');
    fireEvent.click(within(leg).getByRole('button', { name: /Download USDZ/ }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(get).toHaveBeenCalledWith('obj_1');
  });

  it('removes one after asking', async () => {
    const list = vi
      .spyOn(client.objectsApi, 'list')
      .mockResolvedValueOnce({ objects: OBJECTS })
      .mockResolvedValue({ objects: [OBJECTS[1]] });
    const remove = vi.spyOn(client.objectsApi, 'remove').mockResolvedValue({});
    page();

    fireEvent.click(await screen.findByRole('button', { name: 'Remove, Leg press' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Remove Leg press?')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith('obj_1'));
    expect(await screen.findByText('Leg press was removed.')).toBeInTheDocument();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('heading', { name: 'Leg press' })).not.toBeInTheDocument();
  });
});
