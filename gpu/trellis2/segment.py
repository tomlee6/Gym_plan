"""
The cut-out (task L-03): the machine alone on a transparent background,
from the best of the candidate frames picked by frames.py (L-02). This is
the single image TRELLIS.2 is given (L-05), and what the reviewer sees
beside the model.

    python segment.py --frames picked/ --out cut/ --weights /weights [--box 2.0,0.9,1.5]

For each candidate, sharpest first:
1. Stand it upright (an ARKit image is stored the way the sensor lies).
2. Separate the foreground with BiRefNet (MIT), the copy the TRELLIS.2
   pipeline already holds, so no second model is loaded.
3. Keep the machine: the foreground piece nearest the middle of the frame
   (the surveyor keeps the machine in the middle), with the pieces that
   touch it, so a neighbouring machine or a mirror's reflection is dropped.
   With ARKit frames, everything outside the columns the machine can fill
   (its scanned footprint, standing at the middle of the orbit) goes too.
4. Judge it: a machine cut off by the frame's edge, a person in front of
   it, a shape far from what the scanned box allows (a neighbour still
   attached, or half the machine missing), or a matte BiRefNet is unsure of,
   each count against the frame.

The best frame is cut out: cropped round the machine with a margin, at
most 1024 px on the long side (as TRELLIS.2 takes it), with BiRefNet's soft
edge. Writes `cutout.png` and `cutout.json` (every candidate's scores and
what counted against it). When no candidate shows the whole machine on its
own, the build fails with the reason, rather than modelling a fragment.

People are found with OpenCV's built-in pedestrian detector, which needs no
model weights; it misses people seen only in part, and the reviewer still
checks the cut-out.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from cutout import CutoutError, check_cutout

# BiRefNet sees 1024 x 1024; TRELLIS.2 takes at most 1024 on the long side.
WORK_SIDE = 1024
OUT_SIDE = 1024
SOLID = 0.5
# A piece smaller than this share of the frame is noise.
MIN_PIECE = 0.002
# Pieces within this share of the frame's long side of the machine belong to it.
JOIN = 0.02
# The machine's share of the frame: below, too far away; above, too close to have all of it.
MIN_AREA, MAX_AREA = 0.02, 0.85
EDGE_PX = 2
MARGIN = 0.08
# People within this share of the machine's size of it count against the frame.
ZONE = 0.25
# How far the footprint's sideways reach is stretched for the columns it may fill.
REACH = 1.15
# How high a phone is held above the floor while walking round, in metres.
HOLD_HEIGHT = 1.4


@dataclass
class Judgement:
    file: str
    score: float = 0.0
    area: float = 0.0
    edges: list[str] = field(default_factory=list)
    people: float = 0.0
    shape: float = 1.0
    confidence: float = 0.0
    sharpness: float = 0.0
    problems: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "file": self.file,
            "score": round(self.score, 4),
            "areaShare": round(self.area, 4),
            "touchesEdges": self.edges,
            "peopleOverlap": round(self.people, 3),
            "shapeFit": round(self.shape, 3),
            "confidence": round(self.confidence, 3),
            "sharpness": round(self.sharpness, 2),
            "problems": self.problems,
        }


class BiRefNetSegmenter:
    """BiRefNet as the TRELLIS.2 pipeline loads it (`pipeline.rembg_model`), plus OpenCV's people detector."""

    def __init__(self, rembg):
        self.rembg = rembg
        self.hog = cv2.HOGDescriptor()
        self.hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())

    def foreground(self, rgb: np.ndarray) -> np.ndarray:
        self.rembg.cuda()
        try:
            out = self.rembg(Image.fromarray(rgb))
        finally:
            self.rembg.cpu()
        return np.asarray(out)[:, :, 3].astype(np.float32) / 255

    def people(self, rgb: np.ndarray) -> list[tuple[int, int, int, int]]:
        return find_people(self.hog, rgb)


def find_people(hog, rgb: np.ndarray) -> list[tuple[int, int, int, int]]:
    """Boxes `(x0, y0, x1, y1)` round the people OpenCV's pedestrian detector finds."""
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    rects, weights = hog.detectMultiScale(gray, winStride=(8, 8), padding=(8, 8), scale=1.05)
    found = []
    for (x, y, w, h), weight in zip(rects, np.ravel(weights) if len(rects) else []):
        if weight > 0.5:
            found.append((int(x), int(y), int(x + w), int(y + h)))
    return found


def resize_long(image, side: int):
    h, w = image.shape[:2]
    scale = side / max(h, w)
    if scale >= 1:
        return image
    return cv2.resize(image, (max(1, round(w * scale)), max(1, round(h * scale))), interpolation=cv2.INTER_AREA)


TURNS = {1: cv2.ROTATE_90_CLOCKWISE, 2: cv2.ROTATE_180, 3: cv2.ROTATE_90_COUNTERCLOCKWISE}


def upright(image, turns: int):
    return cv2.rotate(image, TURNS[turns % 4]) if turns % 4 else image


def machine_piece(alpha: np.ndarray, allowed: np.ndarray | None = None) -> np.ndarray | None:
    """
    The machine's mask: the solid piece nearest the middle of the frame and
    the pieces touching it. None when there is nothing solid enough.
    """
    h, w = alpha.shape
    solid = (alpha > SOLID).astype(np.uint8)
    if allowed is not None:
        solid &= allowed.astype(np.uint8)
    count, labels, stats, centroids = cv2.connectedComponentsWithStats(solid, connectivity=8)
    pieces = [i for i in range(1, count) if stats[i, cv2.CC_STAT_AREA] >= MIN_PIECE * h * w]
    if not pieces:
        return None
    middle = np.array([w / 2, h / 2])

    def distance(i):
        # Zero for a piece over the middle; otherwise how far its nearest pixel is.
        if labels[int(middle[1]), int(middle[0])] == i:
            return 0.0
        ys, xs = np.nonzero(labels == i)
        return float(np.min(np.hypot(xs - middle[0], ys - middle[1])))

    main = min(pieces, key=lambda i: (distance(i), -stats[i, cv2.CC_STAT_AREA]))
    mask = labels == main
    # Pieces close enough to the machine to be part of it (a bar, a cable, a seat seen through a gap).
    reach = max(1, round(JOIN * max(h, w)))
    near = cv2.dilate(mask.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * reach + 1, 2 * reach + 1)))
    for i in pieces:
        if i != main and np.any(near[labels == i]):
            mask |= labels == i
    return mask


def bounds(mask: np.ndarray) -> tuple[int, int, int, int]:
    ys, xs = np.nonzero(mask)
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def touching(mask: np.ndarray) -> list[str]:
    """The frame's edges the machine runs into: it is cut off there."""
    h, w = mask.shape
    x0, y0, x1, y1 = bounds(mask)
    edges = []
    if y0 <= EDGE_PX:
        edges.append("top")
    if y1 >= h - EDGE_PX:
        edges.append("bottom")
    if x0 <= EDGE_PX:
        edges.append("left")
    if x1 >= w - EDGE_PX:
        edges.append("right")
    return edges


def shape_fit(mask: np.ndarray, box: dict | None) -> float:
    """
    1 when the outline's height over width is one the scanned box can show
    from somewhere round it; less the further outside that it is.
    """
    if not box or not all(box.get(k) for k in ("w", "d", "h")):
        return 1.0
    x0, y0, x1, y1 = bounds(mask)
    ratio = (y1 - y0) / max(1, x1 - x0)
    w, d, h = float(box["w"]), float(box["d"]), float(box["h"])
    # Widest from a corner, narrowest end on; perspective and the camera's height give a margin.
    low = 0.6 * h / math.hypot(w, d)
    high = 1.6 * h / min(w, d)
    if low <= ratio <= high:
        return 1.0
    off = low / ratio if ratio < low else ratio / high
    return float(max(0.0, 1.0 - 0.5 * (off - 1.0)))


def overlap(people: list[tuple[int, int, int, int]], mask: np.ndarray) -> float:
    """
    The share of the space round the machine (its outline box, a quarter
    bigger each way) that people cover. A person in front can split the
    machine in two, leaving only one side of them in the mask, so the space
    round it is what counts.
    """
    if not people:
        return 0.0
    h, w = mask.shape
    x0, y0, x1, y1 = bounds(mask)
    grow = round(ZONE * max(x1 - x0, y1 - y0))
    x0, y0, x1, y1 = max(0, x0 - grow), max(0, y0 - grow), min(w, x1 + grow), min(h, y1 + grow)
    covered = np.zeros((y1 - y0, x1 - x0), bool)
    for px0, py0, px1, py1 in people:
        a, b = max(px0, x0), max(py0, y0)
        c, d = min(px1, x1), min(py1, y1)
        if a < c and b < d:
            covered[b - y0 : d - y0, a - x0 : c - x0] = True
    return float(covered.mean())


def footprint_columns(camera: dict, centre, box: dict | None, size: tuple[int, int]) -> np.ndarray | None:
    """
    For an ARKit frame (sensor orientation): the image columns the machine
    can fill, from its footprint standing at the middle of the orbit. None
    when the frame has no camera or the machine no size.
    """
    if not box or not centre or not camera.get("transform") or not camera.get("intrinsics"):
        return None
    if not (box.get("w") and box.get("d")):
        return None
    m = np.asarray(camera["transform"], float).reshape(4, 4, order="F")
    fx, _fy, cx, _cy = (float(v) for v in camera["intrinsics"])
    world_to_camera = np.linalg.inv(m)
    radius = REACH * 0.5 * math.hypot(float(box["w"]), float(box["d"]))
    # ARKit's world has no floor of its own: take it as a phone held at chest height, give or take.
    floor = m[1, 3] - HOLD_HEIGHT
    heights = np.linspace(floor - 0.3, floor + float(box.get("h") or 2.0) + 0.3, 5)
    us = []
    for a in np.linspace(0, 2 * math.pi, 48, endpoint=False):
        for y in heights:
            p = np.array([centre[0] + radius * math.cos(a), y, centre[1] + radius * math.sin(a), 1.0])
            x, _y, z, _ = world_to_camera @ p
            if z < -0.05:  # in front: the camera looks down -z
                us.append(fx * (x / -z) + cx)
    w, h = size
    if not us:
        return None
    lo, hi = max(0, int(math.floor(min(us)))), min(w, int(math.ceil(max(us))))
    allowed = np.zeros((h, w), np.uint8)
    if lo < hi:
        allowed[:, lo:hi] = 1
    return allowed


def judge(j: Judgement, mask: np.ndarray | None, alpha: np.ndarray, people, box, best_sharpness: float) -> None:
    """Scores one candidate: 0 when it cannot be used, otherwise higher is better."""
    if mask is None:
        j.problems.append("nothing stands out from the background")
        return
    j.area = float(mask.mean())
    j.edges = touching(mask)
    j.people = overlap(people, mask)
    j.shape = shape_fit(mask, box)
    j.confidence = float(alpha[mask].mean())
    if j.area < MIN_AREA:
        j.problems.append(f"the machine fills only {j.area:.1%} of the frame")
    if j.area > MAX_AREA:
        j.problems.append(f"the machine fills {j.area:.0%} of the frame: too close to show all of it")
    if len(j.edges) >= 2:
        j.problems.append(f"cut off at the {' and '.join(j.edges)}")
    if j.problems:
        return
    if j.edges:
        j.problems.append(f"touches the {j.edges[0]} edge")
    if j.people > 0.05:
        j.problems.append(f"a person covers {j.people:.0%} of it")
    if j.shape < 1:
        j.problems.append("its outline does not match the scanned size")
    j.score = (
        (0.5 + 0.5 * j.sharpness / max(best_sharpness, 1e-6))
        * (0.4 if j.edges else 1.0)
        * (1.0 - min(1.0, 2 * j.people))
        * j.shape
        * j.confidence
    )


def cut(rgb: np.ndarray, alpha: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """The RGBA cut-out: cropped round the machine with a margin, soft-edged, at most OUT_SIDE."""
    h, w = mask.shape
    keep = cv2.dilate(mask.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)
    a = np.where(keep, alpha, 0.0)
    x0, y0, x1, y1 = bounds(mask)
    pad = round(MARGIN * max(x1 - x0, y1 - y0))
    x0, y0, x1, y1 = max(0, x0 - pad), max(0, y0 - pad), min(w, x1 + pad), min(h, y1 + pad)
    rgba = np.dstack([rgb[y0:y1, x0:x1], np.round(a[y0:y1, x0:x1] * 255).astype(np.uint8)])
    return resize_long(rgba, OUT_SIDE)


def make_cutout(frames_dir: Path, out: Path, segmenter, box: dict | None = None) -> dict:
    """Cuts the machine out of the best candidate; returns what is written to cutout.json."""
    report = json.loads((frames_dir / "frames.json").read_text(encoding="utf-8"))
    by_file = {f["file"]: f for f in report["frames"]}
    names = report.get("candidates") or [f["file"] for f in report["frames"]]
    centre = report.get("input", {}).get("orbitCentre")
    best_sharpness = max((by_file[n]["sharpness"] for n in names), default=1.0)

    judged: list[tuple[Judgement, np.ndarray, np.ndarray, np.ndarray]] = []
    for name in names:
        frame = by_file[name]
        camera = frame.get("camera") or {}
        image = cv2.imread(str(frames_dir / name), cv2.IMREAD_COLOR)
        if image is None:
            raise FileNotFoundError(f"{frames_dir / name} is missing or not an image")
        allowed = footprint_columns(camera, centre, box, (image.shape[1], image.shape[0]))
        turns = int(camera.get("uprightTurns", 0))
        image = upright(image, turns)
        if allowed is not None:
            allowed = upright(allowed, turns)
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)

        small = resize_long(rgb, WORK_SIDE)
        alpha = segmenter.foreground(small)
        if alpha.shape != small.shape[:2]:
            alpha = cv2.resize(alpha, (small.shape[1], small.shape[0]), interpolation=cv2.INTER_LINEAR)
        if small.shape[:2] != rgb.shape[:2]:
            alpha = cv2.resize(alpha, (rgb.shape[1], rgb.shape[0]), interpolation=cv2.INTER_LINEAR)
        alpha = np.clip(alpha, 0, 1)
        mask = machine_piece(alpha, allowed)

        j = Judgement(file=name, sharpness=float(frame["sharpness"]))
        scale = rgb.shape[1] / small.shape[1]
        people = [tuple(round(v * scale) for v in p) for p in segmenter.people(small)]
        judge(j, mask, alpha, people, box, best_sharpness)
        judged.append((j, rgb, alpha, mask))

    out.mkdir(parents=True, exist_ok=True)
    usable = [x for x in judged if x[0].score > 0]
    summary = {"box": box, "candidates": [j.as_dict() for j, *_ in judged], "chosen": None}
    if not usable:
        (out / "cutout.json").write_text(json.dumps(summary, indent=1) + "\n", encoding="utf-8")
        reasons = "; ".join(f"{j.file}: {', '.join(j.problems)}" for j, *_ in judged)
        raise CutoutError(f"No frame shows the whole machine on its own ({reasons}). Record the walk again, keeping the machine in the middle and all of it in view.")

    j, rgb, alpha, mask = max(usable, key=lambda x: x[0].score)
    image = check_cutout(Image.fromarray(cut(rgb, alpha, mask), "RGBA"))
    image.save(out / "cutout.png", optimize=True)
    summary["chosen"] = j.file
    summary["size"] = list(image.size)
    (out / "cutout.json").write_text(json.dumps(summary, indent=1) + "\n", encoding="utf-8")
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="Cut the machine out of its best frame (L-03).")
    parser.add_argument("--frames", type=Path, required=True, help="frames.py's output folder")
    parser.add_argument("--out", type=Path, required=True, help="folder to write cutout.png and cutout.json into")
    parser.add_argument("--weights", default="/weights", help="the locked weights folder (BiRefNet under birefnet/)")
    parser.add_argument("--box", help="the scanned size in metres: width,depth,height")
    args = parser.parse_args()
    box = dict(zip("wdh", (float(v) for v in args.box.split(",")))) if args.box else None

    from trellis_model import Trellis2  # noqa: PLC0415

    segmenter = BiRefNetSegmenter(Trellis2(args.weights).pipeline.rembg_model)
    try:
        summary = make_cutout(args.frames, args.out, segmenter, box)
    except CutoutError as err:
        sys.exit(f"No cut-out: {err}")
    print(json.dumps({"chosen": summary["chosen"], "size": summary["size"]}))


if __name__ == "__main__":
    main()
