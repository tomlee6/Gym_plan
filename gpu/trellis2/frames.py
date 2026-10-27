"""
Frame picking (task L-02): the frames a machine's model is made from, out
of the surveyor's walk round the machine.

    python frames.py --video 360.mov --out picked/ [--arkit frames.zip] [--steps 96]

Two sources:
- The 360 video, always there. Where each frame was taken round the orbit
  is estimated from the camera's own sideways movement (how far the view
  slides from one frame to the next), so a pause or a change of pace does
  not bunch the picks. A quarter of the weight stays on time, so a stretch
  where the movement cannot be measured still moves on.
- The ARKit frames (I-05), when the app sends them. Each frame's camera
  position is known, so its place round the orbit is its bearing from the
  point every camera looked at. They are used instead of the video: they
  are the same walk, with positions.

Frames that are too dark, too bright, flat (nothing in view) or blurred
(less than a third as sharp as the walk's typical frame) are left out; for
ARKit, so are frames taken while tracking was limited. The orbit is split
into equal steps and each step gives its sharpest frame, so the picks are
spread all the way round (the measured route, L-04, uses them all).

The candidates for the single image TRELLIS.2 takes (L-05) are the
sharpest frame of each sixth of the orbit, sharpest first. The cut-out step
(L-03) chooses among them by how cleanly the machine comes out.

Writes the picked frames under `<out>/frames/` (JPEG, at most 2048 px on the
long side; ARKit images are copied as they are) and `<out>/frames.json`.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import zipfile
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

import cv2
import numpy as np

# Frames are judged at this size, so every video is judged alike.
SCORE_SIDE = 512
# Movement is measured on frames this wide.
MOTION_SIDE = 256
# Frames looked at per second of video: plenty for a walk of a minute or so.
SAMPLE_FPS = 6.0
# Steps round the orbit, so frames picked (the plan's 60 to 150).
STEPS = 96
CANDIDATES = 6
# Mean grey level (0-255) outside which a frame is too dark or too bright,
# and the spread below which it shows nothing.
DARK, BRIGHT, FLAT = 20, 235, 12
# A frame less sharp than this share of the walk's median is blurred.
BLURRY = 0.35
# The share of a step's weight given to movement; the rest is time.
MOTION_WEIGHT = 0.75
# Below this match strength, a frame-to-frame slide is not trusted.
MIN_RESPONSE = 0.05
MIN_SECONDS = 3.0
MIN_USABLE = 4
SAVE_SIDE = 2048
JPEG_QUALITY = 92

ARKIT_FORMAT = "flexgym-arkit-frames"
# Guards on an uploaded archive.
MAX_ARKIT_FRAMES = 5000
MAX_ARKIT_IMAGE_BYTES = 20 * 1024 * 1024


class FramesError(ValueError):
    """The video or frames cannot be used: picking again will not help."""


@dataclass
class Frame:
    index: int  # place in the video, or in the ARKit list
    time_s: float
    sharpness: float = 0.0
    brightness: float = 0.0
    contrast: float = 0.0
    place: float = 0.0  # round the orbit, from 0 (the start) to 1
    rejected: str | None = None
    image: str | None = None  # ARKit: the image's name in the archive
    camera: dict = field(default_factory=dict)  # ARKit: transform, intrinsics, depth, upright turns
    file: str | None = None  # where it was written, under the output folder


def resize_long(image, side: int):
    h, w = image.shape[:2]
    scale = side / max(h, w)
    if scale >= 1:
        return image
    return cv2.resize(image, (max(1, round(w * scale)), max(1, round(h * scale))), interpolation=cv2.INTER_AREA)


def score(image) -> tuple[float, float, float]:
    """Sharpness (variance of the Laplacian at scoring size), brightness and contrast of a BGR image."""
    gray = cv2.cvtColor(resize_long(image, SCORE_SIDE), cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_32F, ksize=3).var()), float(gray.mean()), float(gray.std())


def judge(frames: list[Frame]) -> None:
    """Marks the frames that cannot be used, and why."""
    for f in frames:
        if f.rejected:
            continue
        if f.brightness < DARK:
            f.rejected = "dark"
        elif f.brightness > BRIGHT:
            f.rejected = "bright"
        elif f.contrast < FLAT:
            f.rejected = "flat"
    sharp = [f.sharpness for f in frames if not f.rejected]
    if sharp:
        floor = BLURRY * float(np.median(sharp))
        for f in frames:
            if not f.rejected and f.sharpness < floor:
                f.rejected = "blurry"


def pick(frames: list[Frame], steps: int = STEPS) -> tuple[list[Frame], int]:
    """The sharpest usable frame of each step round the orbit, in orbit order."""
    usable = [f for f in frames if not f.rejected]
    if len(usable) < MIN_USABLE:
        counts = rejected_counts(frames)
        why = ", ".join(f"{n} {k}" for k, n in counts.items() if n) or "none"
        raise FramesError(f"Only {len(usable)} usable frames (left out: {why}). Record the walk again in good light, moving slowly.")
    # At least two frames to choose from in each step.
    steps = max(1, min(steps, len(usable) // 2))
    best: dict[int, Frame] = {}
    for f in usable:
        k = min(steps - 1, int(f.place * steps))
        if k not in best or f.sharpness > best[k].sharpness:
            best[k] = f
    return [best[k] for k in sorted(best)], steps


def candidates(chosen: list[Frame], count: int = CANDIDATES) -> list[Frame]:
    """The sharpest frame of each of `count` equal arcs, sharpest first."""
    arcs: dict[int, Frame] = {}
    for f in chosen:
        a = min(count - 1, int(f.place * count))
        if a not in arcs or f.sharpness > arcs[a].sharpness:
            arcs[a] = f
    return sorted(arcs.values(), key=lambda f: -f.sharpness)


def largest_gap_deg(chosen: list[Frame]) -> float:
    """The widest stretch of the orbit with no picked frame, in degrees."""
    places = sorted(f.place for f in chosen)
    if not places:
        return 360.0
    gaps = [b - a for a, b in zip(places, places[1:])] + [1 - places[-1] + places[0]]
    return round(360 * max(gaps), 1)


def rejected_counts(frames: list[Frame]) -> dict[str, int]:
    counts = {k: 0 for k in ("dark", "bright", "flat", "blurry", "tracking")}
    for f in frames:
        if f.rejected:
            counts[f.rejected] += 1
    return counts


# --------------------------------------------------------------------------
# The video.


def open_video(path: Path):
    cap = cv2.VideoCapture(str(path), cv2.CAP_FFMPEG)
    if not cap.isOpened():
        raise FramesError("The 360 video cannot be read: it is not a video this worker can decode.")
    # Upright, as the phone showed it (iPhone videos are stored sideways with a rotation).
    cap.set(cv2.CAP_PROP_ORIENTATION_AUTO, 1)
    return cap


def scan_video(path: Path, sample_fps: float = SAMPLE_FPS) -> tuple[list[Frame], list[tuple[float, float]], dict]:
    """
    Reads the video once: each sampled frame's scores, and how far the view
    slid sideways between samples (pixels at MOTION_SIDE, match strength).
    """
    cap = open_video(path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    if not fps or not math.isfinite(fps) or fps <= 0:
        fps = 30.0
    every = max(1, round(fps / sample_fps))
    frames: list[Frame] = []
    slides: list[tuple[float, float]] = []
    previous = window = None
    size = None
    index = -1
    try:
        while cap.grab():
            index += 1
            if index % every:
                continue
            ok, image = cap.retrieve()
            if not ok or image is None:
                continue
            size = image.shape[1], image.shape[0]
            sharpness, brightness, contrast = score(image)
            gray = cv2.cvtColor(resize_long(image, SCORE_SIDE), cv2.COLOR_BGR2GRAY)
            small = cv2.resize(gray, (MOTION_SIDE, max(1, round(MOTION_SIDE * gray.shape[0] / gray.shape[1]))), interpolation=cv2.INTER_AREA)
            small = small.astype(np.float32)
            if previous is not None and previous.shape == small.shape:
                if window is None:
                    window = cv2.createHanningWindow((small.shape[1], small.shape[0]), cv2.CV_32F)
                (dx, _dy), response = cv2.phaseCorrelate(previous, small, window)
                slides.append((float(dx), float(response)))
            elif previous is not None:
                slides.append((0.0, 0.0))
            previous = small
            frames.append(Frame(index=index, time_s=index / fps, sharpness=sharpness, brightness=brightness, contrast=contrast))
    finally:
        cap.release()
    if size is None:
        raise FramesError("The 360 video has no frames that can be read.")
    info = {"width": size[0], "height": size[1], "fps": round(fps, 3), "framesRead": index + 1, "durationS": round((index + 1) / fps, 2), "looked": len(frames)}
    return frames, slides, info


def video_places(frames: list[Frame], slides: list[tuple[float, float]]) -> None:
    """
    Sets each frame's place round the orbit: mostly from how far the view
    slid sideways since the start, partly from time.
    """
    if len(frames) < 2:
        for f in frames:
            f.place = 0.0
        return
    times = np.array([f.time_s for f in frames])
    dt = np.diff(times)
    by_time = dt / dt.sum() if dt.sum() > 0 else np.full(len(dt), 1 / len(dt))

    dx = np.array([s[0] for s in slides])
    trusted = np.array([s[1] >= MIN_RESPONSE for s in slides])
    by_motion = by_time
    if trusted.sum() >= max(2, 0.2 * len(slides)):
        # The way the view mostly slides is forward; sliding back is not progress.
        direction = 1.0 if dx[trusted].sum() >= 0 else -1.0
        moved = np.clip(dx * direction, 0, None)
        moved[~trusted] = np.median(moved[trusted])
        if moved.sum() > 1e-6:
            by_motion = moved / moved.sum()
    step = MOTION_WEIGHT * by_motion + (1 - MOTION_WEIGHT) * by_time
    place = np.concatenate([[0.0], np.cumsum(step)])
    place /= place[-1]
    for f, p in zip(frames, place):
        f.place = float(min(p, 1.0))


def save_video_frames(path: Path, chosen: list[Frame], out: Path, side: int = SAVE_SIDE) -> None:
    """Reads the video again and writes the chosen frames, at full quality."""
    wanted = {f.index: f for f in chosen}
    (out / "frames").mkdir(parents=True, exist_ok=True)
    cap = open_video(path)
    index = -1
    last = max(wanted)
    try:
        while index < last and cap.grab():
            index += 1
            f = wanted.get(index)
            if f is None:
                continue
            ok, image = cap.retrieve()
            if not ok or image is None:
                break
            f.file = f"frames/{index:06d}.jpg"
            if not cv2.imwrite(str(out / f.file), resize_long(image, side), [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY]):
                raise OSError(f"Could not write {out / f.file}")
    finally:
        cap.release()
    missing = [f.index for f in chosen if f.file is None]
    if missing:
        # The same video read the same way; not the input's fault.
        raise RuntimeError(f"The video gave fewer frames the second time it was read (missing {missing[:5]}).")


# --------------------------------------------------------------------------
# The ARKit frames (format: docs/3d-contract.md, "Machine capture frames").


class Archive:
    """The frames upload: a zip, or the folder it was unpacked into."""

    def __init__(self, source: Path):
        self.source = source
        self.zip = zipfile.ZipFile(source) if source.is_file() else None

    def read(self, name: str) -> bytes:
        parts = PurePosixPath(name).parts
        if not name or name.startswith("/") or ".." in parts or "\\" in name:
            raise FramesError(f"The frames list names a file outside the upload: {name!r}")
        if self.zip:
            try:
                info = self.zip.getinfo(name)
            except KeyError:
                raise FramesError(f"The frames upload has no {name}.") from None
            if info.file_size > MAX_ARKIT_IMAGE_BYTES:
                raise FramesError(f"{name} in the frames upload is too large.")
            return self.zip.read(info)
        path = self.source / name
        if not path.is_file():
            raise FramesError(f"The frames upload has no {name}.")
        if path.stat().st_size > MAX_ARKIT_IMAGE_BYTES:
            raise FramesError(f"{name} in the frames upload is too large.")
        return path.read_bytes()

    def close(self):
        if self.zip:
            self.zip.close()


def camera_matrix(transform) -> np.ndarray:
    """ARKit's camera-to-world transform, given column by column, as a 4x4 matrix."""
    m = np.asarray(transform, dtype=float)
    if m.shape != (16,) or not np.all(np.isfinite(m)):
        raise FramesError("A frame's transform is not 16 numbers.")
    return m.reshape(4, 4, order="F")


def upright_turns(m: np.ndarray) -> int:
    """
    Quarter turns clockwise that stand the camera image upright. ARKit keeps
    the image in the sensor's landscape orientation whichever way the phone
    was held; the world's up, seen from the camera, says which way that was.
    """
    up = m[:3, :3].T @ np.array([0.0, 1.0, 0.0])  # world up in camera axes (x right, y up, z back)
    # In the image (x right, y down), "up" points at (up.x, -up.y). Upright means it points at (0, -1).
    x, y = up[0], -up[1]
    if abs(y) >= abs(x):
        return 0 if y < 0 else 2
    return 1 if x < 0 else 3


def orbit_centre(positions: np.ndarray, forwards: np.ndarray) -> np.ndarray:
    """
    The point on the ground plane nearest every camera's line of sight (the
    machine, as the walk kept it in view), or the cameras' centre when the
    lines say nothing (all parallel).
    """
    a = np.zeros((2, 2))
    b = np.zeros(2)
    for p, d in zip(positions[:, [0, 2]], forwards[:, [0, 2]]):
        n = np.linalg.norm(d)
        if n < 1e-6:
            continue
        d = d / n
        proj = np.eye(2) - np.outer(d, d)
        a += proj
        b += proj @ p
    middle = positions[:, [0, 2]].mean(axis=0)
    if np.linalg.cond(a) > 1e6:
        return middle
    centre = np.linalg.solve(a, b)
    # Lines that meet far beyond the walk mean little: keep to the walk's own middle.
    reach = np.max(np.linalg.norm(positions[:, [0, 2]] - middle, axis=1))
    return centre if np.linalg.norm(centre - middle) <= max(reach, 0.5) else middle


def scan_arkit(source: Path) -> tuple[list[Frame], Archive, dict]:
    archive = Archive(source)
    try:
        frames, info = read_arkit(archive)
    except BaseException:
        archive.close()
        raise
    return frames, archive, info


def read_arkit(archive: Archive) -> tuple[list[Frame], dict]:
    try:
        manifest = json.loads(archive.read("frames.json"))
    except (ValueError, UnicodeDecodeError) as err:
        raise FramesError(f"frames.json in the frames upload is not JSON: {err}") from None
    if not isinstance(manifest, dict) or manifest.get("format") != ARKIT_FORMAT or manifest.get("version") != 1:
        raise FramesError(f"The frames upload is not {ARKIT_FORMAT} version 1.")
    entries = manifest.get("frames")
    if not isinstance(entries, list) or not entries or len(entries) > MAX_ARKIT_FRAMES:
        raise FramesError(f"The frames upload should list 1 to {MAX_ARKIT_FRAMES} frames.")

    frames: list[Frame] = []
    size = None
    for i, e in enumerate(entries):
        try:
            m = camera_matrix(e["transform"])
            name = str(e["image"])
            time_s = float(e.get("timeS", i))
        except (KeyError, TypeError, ValueError) as err:
            raise FramesError(f"Frame {i} in frames.json is not as described ({err!r}).") from None
        image = cv2.imdecode(np.frombuffer(archive.read(name), np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise FramesError(f"{name} in the frames upload is not an image.")
        size = size or (image.shape[1], image.shape[0])
        sharpness, brightness, contrast = score(image)
        f = Frame(index=i, time_s=time_s, sharpness=sharpness, brightness=brightness, contrast=contrast, image=name)
        f.camera = {
            "transform": [float(v) for v in m.reshape(16, order="F")],
            "intrinsics": e.get("intrinsics"),
            "depth": e.get("depth"),
            "confidence": e.get("confidence"),
            "uprightTurns": upright_turns(m),
        }
        if e.get("tracking", "normal") != "normal":
            f.rejected = "tracking"
        frames.append(f)

    matrices = [camera_matrix(f.camera["transform"]) for f in frames]
    tracked = [m for m, f in zip(matrices, frames) if f.rejected != "tracking"] or matrices
    positions = np.array([m[:3, 3] for m in tracked])
    forwards = np.array([-m[:3, 2] for m in tracked])  # the camera looks down its -z axis
    centre = orbit_centre(positions, forwards)
    bearings = [math.atan2(m[2, 3] - centre[1], m[0, 3] - centre[0]) for m in matrices]
    start = bearings[0]
    for f, b in zip(frames, bearings):
        f.place = ((b - start) % (2 * math.pi)) / (2 * math.pi)
    info = {
        "width": size[0],
        "height": size[1],
        "frames": len(frames),
        "durationS": round(max(f.time_s for f in frames) - min(f.time_s for f in frames), 2),
        "orbitCentre": [round(float(centre[0]), 3), round(float(centre[1]), 3)],
        "device": manifest.get("device"),
    }
    return frames, info


def save_arkit_frames(archive: Archive, chosen: list[Frame], out: Path) -> None:
    """Copies the chosen images as they are: re-encoding would only lose detail."""
    (out / "frames").mkdir(parents=True, exist_ok=True)
    for f in chosen:
        f.file = f"frames/{f.index:06d}{PurePosixPath(f.image).suffix.lower() or '.jpg'}"
        (out / f.file).write_bytes(archive.read(f.image))


# --------------------------------------------------------------------------


def pick_frames(video: Path, out: Path, arkit: Path | None = None, steps: int = STEPS) -> dict:
    """Picks and writes the frames; returns what is written to frames.json."""
    out.mkdir(parents=True, exist_ok=True)
    if arkit is not None:
        frames, archive, info = scan_arkit(arkit)
        try:
            judge(frames)
            chosen, steps = pick(frames, steps)
            save_arkit_frames(archive, chosen, out)
        finally:
            archive.close()
        source = "arkit"
    else:
        frames, slides, info = scan_video(video)
        if info["durationS"] < MIN_SECONDS:
            raise FramesError(f"The 360 video is {info['durationS']} s long: walk all the way round the machine.")
        video_places(frames, slides)
        judge(frames)
        chosen, steps = pick(frames, steps)
        save_video_frames(video, chosen, out)
        source = "video"

    usable = [f.sharpness for f in frames if not f.rejected]
    report = {
        "source": source,
        "input": info,
        "steps": steps,
        "coverage": round(len(chosen) / steps, 3),
        "largestGapDeg": largest_gap_deg(chosen),
        "sharpnessMedian": round(float(np.median(usable)), 2) if usable else None,
        "rejected": rejected_counts(frames),
        "frames": [
            {
                "file": f.file,
                "index": f.index,
                "timeS": round(f.time_s, 3),
                "place": round(f.place, 4),
                "sharpness": round(f.sharpness, 2),
                "brightness": round(f.brightness, 1),
                "camera": f.camera or {"uprightTurns": 0},
            }
            for f in chosen
        ],
        "candidates": [f.file for f in candidates(chosen)],
    }
    (out / "frames.json").write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Pick the frames a machine model is made from (L-02).")
    parser.add_argument("--video", type=Path, required=True, help="the 360 video")
    parser.add_argument("--arkit", type=Path, help="the ARKit frames upload (zip or folder), when there is one")
    parser.add_argument("--out", type=Path, required=True, help="folder to write frames/ and frames.json into")
    parser.add_argument("--steps", type=int, default=STEPS, help=f"steps round the orbit (default {STEPS})")
    args = parser.parse_args()
    try:
        report = pick_frames(args.video, args.out, arkit=args.arkit, steps=args.steps)
    except FramesError as err:
        sys.exit(f"Cannot use this walk-around: {err}")
    print(json.dumps({k: report[k] for k in ("source", "steps", "coverage", "largestGapDeg", "rejected", "candidates")}, indent=1))


if __name__ == "__main__":
    main()
