/**
 * The scan check on the review screen: the scanned room in 3D on the left,
 * the video the phone recorded during the same LiDAR scan on the right, side
 * by side, so the reviewer can watch the real room and turn the scan
 * together and judge whether the walls, openings, sizes and objects match.
 *
 * Both are the capture's own files, from the review API with signed links:
 * the 3D is `scan.usdz` (kind `model`) or, for a 3D Space scan, the mesh
 * (kind `mesh`); the video is `room-video.mp4` (kind `room_video`). A scan
 * from an app build that recorded no video says so instead of a player.
 *
 * Open by default when there is a room video to compare; it can be folded
 * away to give the plan editor the whole height.
 */
import { lazy, Suspense, useState } from 'react';

const ScanModelViewer = lazy(() => import('./ScanModelViewer.jsx'));

/** The files the scan check shows, from a version's `files`. */
export function scanCheckFiles(files = []) {
  const withUrl = (kind) => files.find((f) => f.kind === kind && f.url) ?? null;
  return {
    model: withUrl('model') ?? withUrl('mesh'),
    video: withUrl('room_video'),
  };
}

export default function ScanCheck({ files }) {
  const { model, video } = scanCheckFiles(files);
  const [open, setOpen] = useState(Boolean(video));
  if (!model && !video) return null;

  return (
    <section className={`sc-panel${open ? ' open' : ''}`} aria-labelledby="sc-title">
      <div className="sc-head">
        <h2 id="sc-title" className="sc-title">
          Scan check
        </h2>
        {video ? (
          <span className="small muted">Compare the 3D scan with the video of the room recorded while it was scanned.</span>
        ) : (
          // Said up front, so the reviewer need not open the panel to find out.
          <span className="sc-novideo small">
            No room video for this scan: it was made with an app version that did not record one.
            {model ? ' Show to see the 3D scan.' : ''}
          </span>
        )}
        <span className="spacer" />
        <button type="button" className="rv-button ghost small" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      {open && (
        <div className="sc-grid">
          <div className="sc-side">
            <h3 className="sc-label small">3D scan{model?.kind === 'mesh' ? ' (LiDAR mesh)' : ''}</h3>
            {model ? (
              <Suspense fallback={<div className="sc-model"><p className="sc-note muted small">Loading the 3D scan…</p></div>}>
                <ScanModelViewer file={model} label="The scanned room in 3D. Drag to turn, scroll to zoom, right-drag to pan." />
              </Suspense>
            ) : (
              <div className="sc-model">
                <p className="sc-note muted small">This capture has no 3D scan.</p>
              </div>
            )}
          </div>
          <div className="sc-side">
            <h3 className="sc-label small">Room video</h3>
            {video ? (
              // Native controls: play, pause, seek, fullscreen. No sound is recorded.
              <video className="sc-video" src={video.url} controls preload="metadata" playsInline muted aria-label="Video of the room, recorded during the LiDAR scan">
                <a href={video.url} download>
                  Download the room video
                </a>
              </video>
            ) : (
              <div className="sc-video sc-empty">
                <p className="sc-note muted small">No room video: this scan was made with an app version that did not record one.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
