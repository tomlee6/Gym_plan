"""
Sample ARKit frames uploads (tasks L-04, L-01), made up: what the app will
send for a machine once it records its walk-rounds with ARKit (I-05), in
the format in docs/3d-contract.md ("ARKit frames upload"). Until real ones
exist, these are the input the measured route is built and tested against.

    python sample_arkit.py --out sample-frames.zip [--scene treadmill] [--frames 72]

Every scene is in ARKit's world (metres, y up), on a tiled floor, its
machine standing 30 degrees round from the world's axes at (1.2, -0.8).
The phone walks round it at chest height, keeping it in the middle of the
frame, held landscape; where a wall or a neighbour is in the way, only the
open sides are walked. Each frame has a photo, LiDAR depth (z-distance along
the view, in millimetres) and confidence, and a few lose tracking.

The scenes:
- `treadmill`: a black rubber deck 0.8 x 1.9 m, two grey posts and a blue
  console, 1.45 m tall in all, a bench beside it and a wall well behind
  (the measured route's own sample, L-04).
- The five of the route test (L-01): `chrome` (a chrome squat rack),
  `black` (the treadmill, all black rubber), `wall` (the treadmill 15 cm
  from a wall, walked round its open side only), `row` (the treadmill
  between two others, walked in front and behind) and `large` (a cable
  crossover 2.6 m wide and 2.3 m tall).

How the sensor behaves on each surface is an assumption, to be checked
against real recordings: matte surfaces read well; black rubber reads
noisily, with gaps; chrome mostly not at all, and some of what it gives
back is a reflection, confidently wrong.
"""
from __future__ import annotations

import argparse
import json
import math
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

CENTRE = (1.2, -0.8)  # the machine's middle on the floor (x, z)
YAW_DEG = 30.0  # how far round from the world's axes it stands
IMAGE = (320, 240)  # photo size (the app's are larger; the ratio is ARKit's 4:3)
DEPTH = (256, 192)  # ARKit sceneDepth
FOCAL = 250.0  # pixels of the photo
MAX_RANGE_M = 5.0
WALK_RADIUS_M = 2.2

MATTE, BLACK, CHROME = 1, 2, 3
# Per surface: relative depth noise, share with no reading, share read with medium confidence, share reflected.
SENSOR = {
    0: (0.004, 0.02, 0.0, 0.0),  # floor and walls
    MATTE: (0.004, 0.02, 0.0, 0.0),
    BLACK: (0.015, 0.30, 0.15, 0.0),
    CHROME: (0.010, 0.50, 0.0, 0.25),
}


@dataclass
class Part:
    """A box of the machine (or of something round it), in the machine's frame: x across, z along, y up."""

    lo: tuple
    hi: tuple
    colour: tuple  # BGR
    surface: int = MATTE
    # Level stripes this wide (m), every other one darker: detail finer than the voxels (N-04).
    stripes: float = 0.0


@dataclass
class Scene:
    name: str
    parts: list  # the machine
    size: dict  # its true width (x), depth (z) and height
    others: list = field(default_factory=list)  # round it, in its frame
    walls: list = field(default_factory=list)  # round it, in the world's frame
    walk_radius: float = WALK_RADIUS_M
    # Stretches of the walk, as angles round the machine from its +x towards +z, in degrees.
    arcs: list = field(default_factory=lambda: [(0.0, 360.0)])
    look_height: float = 0.6


GREY, BLUE, RUBBER = (160, 155, 150), (170, 90, 30), (38, 40, 42)
# The darker stripes' share of their part's colour, and the stripes' width on the treadmill's console.
STRIPE_SHADE = 0.45
STRIPES_M = 0.01


def treadmill(surface_all: int | None = None, dx: float = 0.0) -> list:
    """The treadmill, its middle `dx` along x; every part black rubber when `surface_all` says so."""
    parts = [
        Part((-0.40, 0.00, -0.95), (0.40, 0.25, 0.95), RUBBER, BLACK),  # deck
        Part((-0.38, 0.25, 0.70), (-0.32, 1.25, 0.76), GREY),  # left post
        Part((0.32, 0.25, 0.70), (0.38, 1.25, 0.76), GREY),  # right post
        Part((-0.40, 1.20, 0.62), (0.40, 1.45, 0.95), BLUE, stripes=STRIPES_M),  # console, with a striped label
    ]
    out = []
    for p in parts:
        colour, surface = (RUBBER, BLACK) if surface_all == BLACK else (p.colour, p.surface)
        out.append(Part((p.lo[0] + dx, *p.lo[1:]), (p.hi[0] + dx, *p.hi[1:]), colour, surface, p.stripes))
    return out


TREADMILL_SIZE = {"w": 0.8, "d": 1.9, "h": 1.45}
CHROMED = (210, 210, 215)

SCENES = {
    "treadmill": Scene(
        "treadmill",
        treadmill(),
        TREADMILL_SIZE,
        others=[Part((1.00, 0.0, -0.25), (1.40, 0.45, 0.25), (60, 120, 60))],  # a bench, 0.6 m clear
        walls=[Part((-3.0, 0.0, 2.2), (5.0, 3.0, 2.4), (200, 205, 210))],
    ),
    "chrome": Scene(
        "chrome",
        [
            Part((-0.60, 0.00, -0.50), (0.60, 0.05, 0.50), (90, 90, 95)),  # base plate
            *[
                Part((x - 0.035, 0.05, z - 0.035), (x + 0.035, 2.10, z + 0.035), CHROMED, CHROME)
                for x in (-0.55, 0.55)
                for z in (-0.45, 0.45)
            ],
            Part((-0.585, 2.03, -0.485), (0.585, 2.10, -0.415), CHROMED, CHROME),  # top bars
            Part((-0.585, 2.03, 0.415), (0.585, 2.10, 0.485), CHROMED, CHROME),
            Part((-0.60, 1.38, -0.02), (0.60, 1.42, 0.02), CHROMED, CHROME),  # the bar
        ],
        {"w": 1.2, "d": 1.0, "h": 2.1},
        walk_radius=2.4,
        look_height=0.9,
    ),
    "black": Scene("black", treadmill(BLACK), TREADMILL_SIZE),
    "wall": Scene(
        "wall",
        treadmill(),
        TREADMILL_SIZE,
        others=[Part((-0.80, 0.0, -3.0), (-0.55, 3.0, 3.0), (200, 205, 210))],  # 15 cm off its left side
        arcs=[(-100.0, 100.0)],
    ),
    "row": Scene(
        "row",
        treadmill(),
        TREADMILL_SIZE,
        others=[*treadmill(dx=-1.25), *treadmill(dx=1.25)],  # 45 cm either side
        arcs=[(30.0, 150.0), (210.0, 330.0)],
    ),
    "large": Scene(
        "large",
        [
            Part((-1.30, 0.00, -0.30), (-0.80, 2.30, 0.30), (70, 72, 75)),  # towers
            Part((0.80, 0.00, -0.30), (1.30, 2.30, 0.30), (70, 72, 75)),
            Part((-0.80, 2.18, -0.05), (0.80, 2.28, 0.05), (150, 150, 155)),  # top beam
            Part((-0.80, 0.00, -0.06), (0.80, 0.08, 0.06), (150, 150, 155)),  # floor rail
        ],
        {"w": 2.6, "d": 0.6, "h": 2.3},
        walk_radius=3.0,
        look_height=1.0,
    ),
}
ROUTE_TEST = ["chrome", "black", "wall", "row", "large"]
# The treadmill sample's own, for those that use it directly.
SIZE = TREADMILL_SIZE


def _rotation(yaw_deg: float) -> np.ndarray:
    """Machine frame to world: a turn about +y (right-handed)."""
    a = math.radians(yaw_deg)
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


ROTATION = _rotation(YAW_DEG)
ORIGIN = np.array([CENTRE[0], 0.0, CENTRE[1]])


def to_world(local) -> np.ndarray:
    """Points in the machine's frame, in the world's."""
    return np.asarray(local, float) @ ROTATION.T + ORIGIN


def camera(position, target) -> np.ndarray:
    """ARKit's camera-to-world transform for a phone at `position` looking at `target`, held landscape."""
    p, t = np.asarray(position, float), np.asarray(target, float)
    forward = (t - p) / np.linalg.norm(t - p)
    right = np.cross(forward, [0, 1, 0])
    right /= np.linalg.norm(right)
    up = np.cross(right, forward)
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = right, up, -forward, p
    return m


def _boxes(scene: Scene, machine: bool = True) -> list:
    """Every box in the world: (rotation to its frame, origin, min, max, colour, surface, stripes)."""
    out = []
    if machine:
        out += [(ROTATION, ORIGIN, np.array(p.lo), np.array(p.hi), p.colour, p.surface, p.stripes) for p in scene.parts]
    out += [(ROTATION, ORIGIN, np.array(p.lo), np.array(p.hi), p.colour, p.surface, p.stripes) for p in scene.others]
    out += [(np.eye(3), np.zeros(3), np.array(p.lo), np.array(p.hi), p.colour, 0, 0.0) for p in scene.walls]
    return out


def render(m: np.ndarray, size, focal: float, boxes):
    """Ray-casts the scene from a camera: z-depth (m, 0 where nothing), a BGR photo, and each pixel's surface."""
    w, h = size
    # Pixel centres at whole numbers, the principal point in the middle: as ARKit's intrinsics are.
    u, v = np.meshgrid(np.arange(w, dtype=float), np.arange(h, dtype=float))
    dirs_cam = np.stack([(u - (w - 1) / 2) / focal, -(v - (h - 1) / 2) / focal, -np.ones_like(u)], axis=-1).reshape(-1, 3)
    dirs = dirs_cam @ m[:3, :3].T
    origin = m[:3, 3]
    best = np.full(len(dirs), np.inf)
    colour = np.zeros((len(dirs), 3))
    shade = np.ones(len(dirs))
    surface = np.zeros(len(dirs), np.uint8)
    light = np.array([0.3, 0.8, 0.5]) / np.linalg.norm([0.3, 0.8, 0.5])
    rows = np.arange(len(dirs))

    for r, o, lo, hi, col, kind, stripes in boxes:
        # Into the box's frame, then the slab test.
        ol = (origin - o) @ r
        dl = dirs @ r
        with np.errstate(divide="ignore", invalid="ignore"):
            t1 = (lo - ol) / dl
            t2 = (hi - ol) / dl
        near = np.minimum(t1, t2)
        tmin = np.nanmax(near, axis=1)
        tmax = np.nanmin(np.maximum(t1, t2), axis=1)
        hit = (tmax >= tmin) & (tmin > 0.01) & (tmin < best)
        if not hit.any():
            continue
        best[hit] = tmin[hit]
        colour[hit] = col
        if stripes:
            # Where on the box it hit, in the box's frame: every other level band is darker.
            y = ol[1] + tmin * dl[:, 1]
            dark = hit & (np.floor(y / stripes) % 2 == 1)
            colour[dark] = np.asarray(col) * STRIPE_SHADE
        surface[hit] = kind
        axis = np.nanargmax(near, axis=1)
        normal_l = np.zeros_like(dl)
        normal_l[rows, axis] = -np.sign(dl[rows, axis])
        shade[hit] = 0.45 + 0.55 * np.clip((normal_l @ r.T)[hit] @ light, 0, 1)

    # The floor: grey tiles half a metre square.
    with np.errstate(divide="ignore", invalid="ignore"):
        tf = -origin[1] / dirs[:, 1]
    floor = (dirs[:, 1] < 0) & (tf > 0) & (tf < best)
    best[floor] = tf[floor]
    fx = origin[0] + tf * dirs[:, 0]
    fz = origin[2] + tf * dirs[:, 2]
    tile = ((np.floor(fx * 2) + np.floor(fz * 2)) % 2)[floor]
    colour[floor] = np.where(tile[:, None] > 0, [120, 122, 125], [95, 97, 100])
    shade[floor] = 1.0
    surface[floor] = 0

    found = np.isfinite(best)
    zdepth = np.where(found, best * -dirs_cam[:, 2], 0.0).reshape(h, w)
    # LiDAR sees about 5 m: beyond that, no reading.
    zdepth[zdepth > MAX_RANGE_M] = 0.0
    image = (colour * shade[:, None]).clip(0, 255).astype(np.uint8).reshape(h, w, 3)
    return zdepth, image, surface.reshape(h, w)


def sense(depth: np.ndarray, surface: np.ndarray, rng) -> tuple[np.ndarray, np.ndarray]:
    """What the LiDAR reports for true depth: noise, gaps and reflections by surface, and its confidence."""
    noisy = depth.copy()
    confidence = np.where(depth > 0, 2, 0).astype(np.uint8)
    for kind, (noise, missing, medium, reflected) in SENSOR.items():
        on = surface == kind
        noisy[on] *= 1 + rng.normal(0, noise, on.sum())
        roll = rng.random(depth.shape)
        gone = on & (roll < missing)
        unsure = on & (roll >= missing) & (roll < missing + medium)
        mirror = on & (roll >= missing + medium) & (roll < missing + medium + reflected)
        confidence[gone] = 0
        noisy[gone] = rng.uniform(0.2, 6.0, gone.sum())
        confidence[unsure] = 1
        # A reflection: what is beyond it, read as if it were there, with medium confidence.
        noisy[mirror] += rng.uniform(0.3, 1.5, mirror.sum())
        confidence[mirror & (depth > 0)] = 1
    confidence[(depth > 4.0) & (confidence == 2)] = 1
    noisy[depth == 0] = 0
    return noisy, confidence


def walk(scene: Scene, frames: int) -> list:
    """The phone's positions, spread over the walk's stretches by their length, in the world."""
    lengths = np.array([b - a for a, b in scene.arcs])
    out = []
    for i in range(frames):
        along = (i + 0.5) / frames * lengths.sum()
        k = int(np.searchsorted(np.cumsum(lengths), along, side="right"))
        k = min(k, len(lengths) - 1)
        angle = math.radians(scene.arcs[k][0] + along - (np.cumsum(lengths)[k] - lengths[k]))
        height = 1.4 + 0.15 * math.sin(3 * angle)
        local = (scene.walk_radius * math.cos(angle), height, scene.walk_radius * math.sin(angle))
        out.append(to_world(local))
    return out


def truth_points(scene: Scene, per_m2: float = 2500) -> np.ndarray:
    """
    Points on the machine's surfaces a walk could see, in the world: not the
    undersides on the floor, nor faces inside another of its parts.
    """
    rng = np.random.default_rng(0)
    points = []
    boxes = [(np.array(p.lo), np.array(p.hi)) for p in scene.parts]
    for lo, hi in boxes:
        for axis in range(3):
            for side in (lo[axis], hi[axis]):
                if axis == 1 and side <= 1e-6:
                    continue  # on the floor
                a, b = [i for i in range(3) if i != axis]
                area = (hi[a] - lo[a]) * (hi[b] - lo[b])
                n = max(4, int(area * per_m2))
                pts = np.empty((n, 3))
                pts[:, axis] = side
                pts[:, a] = rng.uniform(lo[a], hi[a], n)
                pts[:, b] = rng.uniform(lo[b], hi[b], n)
                points.append(pts)
    pts = np.concatenate(points)
    inside_another = np.zeros(len(pts), bool)
    for lo, hi in boxes:
        inside_another |= np.all((pts > lo + 1e-4) & (pts < hi - 1e-4), axis=1)
    return to_world(pts[~inside_another])


def make_sample(
    path: Path,
    frames: int = 72,
    neighbour: bool = True,
    wall: bool = True,
    machine: bool = True,
    seed: int = 7,
    image_size: tuple[int, int] = IMAGE,
    depth_size: tuple[int, int] = DEPTH,
    scene: str = "treadmill",
) -> dict:
    """
    Writes a sample upload to `path` (a .zip, or a folder); returns what is
    true of the scene. Smaller `image_size` and `depth_size` (4:3) make a
    quicker one, for tests. `neighbour` and `wall` leave the treadmill's
    bench and wall out; `machine` the machine itself.
    """
    base = SCENES[scene]
    chosen = Scene(
        base.name,
        base.parts,
        base.size,
        others=base.others if neighbour else [],
        walls=base.walls if wall else [],
        walk_radius=base.walk_radius,
        arcs=base.arcs,
        look_height=base.look_height,
    )
    rng = np.random.default_rng(seed)
    boxes = _boxes(chosen, machine)
    target = to_world((0.0, chosen.look_height, 0.0))
    entries, files = [], {}
    focal = FOCAL * image_size[0] / IMAGE[0]
    sx = depth_size[0] / image_size[0]
    for i, position in enumerate(walk(chosen, frames)):
        m = camera(position, target)
        depth, _, surface = render(m, depth_size, focal * sx, boxes)
        _, image, _ = render(m, image_size, focal, boxes)
        noisy, confidence = sense(depth, surface, rng)
        name = f"{i:06d}"
        files[f"images/{name}.jpg"] = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 90])[1].tobytes()
        files[f"depth/{name}.png"] = cv2.imencode(".png", np.round(noisy * 1000).clip(0, 65535).astype(np.uint16))[1].tobytes()
        files[f"confidence/{name}.png"] = cv2.imencode(".png", confidence)[1].tobytes()
        entries.append({
            "image": f"images/{name}.jpg",
            "timeS": round(i / 5, 3),
            "transform": [float(v) for v in m.reshape(16, order="F")],
            "intrinsics": [focal, focal, (image_size[0] - 1) / 2, (image_size[1] - 1) / 2],
            "tracking": "limited" if i % 25 == 24 else "normal",
            "depth": f"depth/{name}.png",
            "confidence": f"confidence/{name}.png",
        })
    manifest = {"format": "flexgym-arkit-frames", "version": 1, "device": "sample", "frames": entries}
    path = Path(path)
    if path.suffix == ".zip":
        with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED) as z:
            z.writestr("frames.json", json.dumps(manifest))
            for name, data in files.items():
                z.writestr(name, data)
    else:
        for name, data in {"frames.json": json.dumps(manifest).encode(), **files}.items():
            (path / name).parent.mkdir(parents=True, exist_ok=True)
            (path / name).write_bytes(data)
    return {"scene": scene, "centre": CENTRE, "yawDeg": YAW_DEG, "size": chosen.size, "frames": frames}


def main() -> None:
    parser = argparse.ArgumentParser(description="Write a made-up ARKit frames upload of a machine (L-04, L-01).")
    parser.add_argument("--out", type=Path, required=True, help="a .zip, or a folder")
    parser.add_argument("--scene", choices=sorted(SCENES), default="treadmill")
    parser.add_argument("--frames", type=int, default=72)
    args = parser.parse_args()
    print(json.dumps(make_sample(args.out, args.frames, scene=args.scene)))


if __name__ == "__main__":
    main()
