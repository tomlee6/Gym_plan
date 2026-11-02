import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import ScanCheck, { scanCheckFiles } from './ScanCheck.jsx';

const MODEL = { id: 'f1', name: 'scan.usdz', kind: 'model', contentType: 'model/vnd.usdz+zip', url: 'https://s3.test/scan.usdz?sig=1' };
const MESH = { id: 'f2', name: 'scan.obj', kind: 'mesh', contentType: 'model/obj', url: 'https://s3.test/scan.obj?sig=1' };
const VIDEO = { id: 'f3', name: 'room-video.mp4', kind: 'room_video', contentType: 'video/mp4', url: 'https://s3.test/room-video.mp4?sig=1' };
const PHOTO = { id: 'f4', name: 'photo-1.jpg', kind: 'photo', contentType: 'image/jpeg', url: 'https://s3.test/photo-1.jpg?sig=1' };
// A machine's 360 walkaround is not the room video.
const WALKAROUND = { id: 'f5', name: 'equipment/eq1/360.mov', kind: 'video', contentType: 'video/quicktime', url: 'https://s3.test/360.mov?sig=1', equipmentId: 'eq1' };

afterEach(cleanup);

describe('scanCheckFiles', () => {
  it('takes the RoomPlan model, else the 3D Space mesh, and the room video', () => {
    expect(scanCheckFiles([PHOTO, MODEL, MESH, VIDEO])).toEqual({ model: MODEL, video: VIDEO });
    expect(scanCheckFiles([MESH])).toEqual({ model: MESH, video: null });
    expect(scanCheckFiles([PHOTO, WALKAROUND])).toEqual({ model: null, video: null });
  });

  it('skips a file with no link yet', () => {
    expect(scanCheckFiles([{ ...VIDEO, url: null }]).video).toBeNull();
  });
});

describe('ScanCheck', () => {
  it('shows the 3D scan and the room video side by side', async () => {
    render(<ScanCheck files={[MODEL, VIDEO, PHOTO]} />);
    expect(screen.getByRole('heading', { name: 'Scan check' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '3D scan' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Room video' })).toBeInTheDocument();

    const video = screen.getByLabelText(/Video of the room/);
    expect(video.tagName).toBe('VIDEO');
    expect(video).toHaveAttribute('src', VIDEO.url);
    // Native controls: play, pause, seek, fullscreen.
    expect(video).toHaveAttribute('controls');

    // The 3D viewer is loaded on demand; jsdom has no WebGL, so it says so.
    expect(await screen.findByText(/cannot show 3D/)).toBeInTheDocument();
  });

  it('folds away and opens again', () => {
    render(<ScanCheck files={[MODEL, VIDEO]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByLabelText(/Video of the room/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.getByLabelText(/Video of the room/)).toBeInTheDocument();
  });

  it('a scan from an older app: closed at first, and says there is no video', () => {
    render(<ScanCheck files={[MODEL, PHOTO]} />);
    expect(screen.queryByText(/No room video/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.getByText(/No room video/)).toBeInTheDocument();
  });

  it('a 3D Space scan shows its mesh', () => {
    render(<ScanCheck files={[MESH, VIDEO]} />);
    expect(screen.getByRole('heading', { name: '3D scan (LiDAR mesh)' })).toBeInTheDocument();
  });

  it('a drawing upload shows nothing', () => {
    const { container } = render(<ScanCheck files={[{ id: 'd', name: 'plan.pdf', kind: 'source', url: 'https://s3.test/plan.pdf' }]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
