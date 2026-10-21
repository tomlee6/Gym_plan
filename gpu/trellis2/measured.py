"""
Measured reconstruction (task L-04): a machine's model built from what the
phone measured on the walk round it, the ARKit frames (each a photo with
its camera position and LiDAR depth; format in docs/3d-contract.md, "ARKit
frames upload"). Its shape and size are real; what the walk never saw is
missing, not invented (the other route, TRELLIS.2, invents it).

    python measured.py --frames frames.zip --out made/ [--box 0.8,1.9,1.45]

1. The frames: those tracked normally that carry depth, up to 150 spread
   over the walk. Depth the sensor was unsure of is left out.
2. Where the machine is: the point every camera looked at (frames.py's
   orbit centre), standing on the floor (the lowest broad level in the
   depth round it). What is rebuilt is a cylinder round that point, as wide
   as the scanned footprint's diagonal and a third more, from the floor to
   a quarter above the scanned height (2.5 m across and high without a
   scan).
3. Depth fusion (TSDF): a grid of voxels, each the signed distance to the
   nearest surface as the frames that saw it agree, and the colour the
   photos show there.
4. The floor is cut away. What reaches the cylinder's edge or top is
   something else (a wall, a neighbour) and goes; of the rest, every piece
   lying mostly over the footprint is kept, and specks of noise are not.
5. The surface: a vertex in each cell of voxels the surface passes through,
   joined into triangles across every crossing (surface nets), coloured
   from the grid.
6. Lined up: turned about the vertical so the footprint's smallest
   rectangle lies along X and Z, centred on it, standing on y = 0. Which
   end is the front is the reviewer's to settle (L-08); the size is kept,
   being measured.
7. A photo texture (N-04, bake.py): the surface laid out flat, each texel
   coloured from the photos that see it best, so its detail is the
   photos', not the voxels'.

Writes `model.glb` (metres, a photo texture) and `measured.json`.
"""
from __future__ import annotations

import argparse
import json
import math
import struct
import sys
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np
from scipy import ndimage
from scipy.spatial import ConvexHull

from frames import ARKIT_FORMAT, MAX_ARKIT_FRAMES, Archive, FramesError, camera_matrix, orbit_centre

MAX_FRAMES = 150
MIN_FRAMES = 12
# Voxels this size, for a machine of any size (N-02: a large machine's grew to 2 cm and it came
# back 10 % too deep), within a cap on memory (about 0.7 GB at the cap).
VOXEL_M = 0.015
MAX_VOXELS = 12_000_000
# The distance either side of a surface that a frame says anything about, in voxels.
TRUNCATION = 3
# ARKit's depth confidence: 0 low, 1 medium, 2 high. Low is left out.
CONFIDENT = 1
REACH = 1.33
HEADROOM = 1.25
UNSIZED_RADIUS_M, UNSIZED_HEIGHT_M = 1.25, 2.5
MAX_WEIGHT = 64
# How far above the floor it is cut, at least.
FLOOR_CLEAR_M = 0.015
# Fewer triangles than this is not a machine.
MIN_TRIANGLES = 200
# A piece is part of the machine if this share of it lies over the footprint, and it is not a speck.
MOSTLY = 0.5
MIN_PIECE_VOXELS = 30
# The photo texture's size in texels a side (N-04): the nearest level of detail's (LEVELS_OF_DETAIL in
# shared/build3d/budget.js), as L-06 would cut a larger one down to it. 0 leaves the model coloured per vertex.
TEXTURE = 1024
JPEG_QUALITY = 92


class MeasureError(ValueError):
    """The frames cannot make a model: measuring again will not help."""


@dataclass
class View:
    matrix: np.ndarray  # camera to world
    depth: np.ndarray  # metres along the view, 0 where there is none
    image: np.ndarray  # BGR
    fx: float
    fy: float
    cx: float
    cy: float


# --------------------------------------------------------------------------
# The frames.


def _decode(data: bytes, flags, what: str):
    image = cv2.imdecode(np.frombuffer(data, np.uint8), flags)
    if image is None:
        raise MeasureError(f"{what} in the frames upload is not an image.")
    return image


def read_views(source: Path, max_frames: int = MAX_FRAMES) -> tuple[list[View], dict]:
    """The frames worth fusing, spread over the walk, and how many were left out and why."""
    archive = Archive(source)
    try:
        try:
            manifest = json.loads(archive.read("frames.json"))
        except (ValueError, UnicodeDecodeError) as e:
            raise MeasureError(f"frames.json in the frames upload is not JSON: {e}") from None
        if not isinstance(manifest, dict) or manifest.get("format") != ARKIT_FORMAT or manifest.get("version") != 1:
            raise MeasureError(f"The frames upload is not {ARKIT_FORMAT} version 1.")
        entries = manifest.get("frames")
        if not isinstance(entries, list) or not entries or len(entries) > MAX_ARKIT_FRAMES:
            raise MeasureError(f"The frames upload should list 1 to {MAX_ARKIT_FRAMES} frames.")
        left_out = {"tracking": 0, "noDepth": 0}
        usable = []
        for e in entries:
            if not isinstance(e, dict) or e.get("tracking", "normal") != "normal":
                left_out["tracking"] += 1
            elif not e.get("depth") or not e.get("intrinsics"):
                left_out["noDepth"] += 1
            else:
                usable.append(e)
        if len(usable) < MIN_FRAMES:
            raise MeasureError(
                f"Only {len(usable)} frames have depth and normal tracking (at least {MIN_FRAMES} are needed). "
                "Record the walk again, slowly, with the whole machine in view."
            )
        picks = np.unique(np.linspace(0, len(usable) - 1, min(max_frames, len(usable))).round().astype(int))
        views = []
        for e in (usable[i] for i in picks):
            try:
                matrix = camera_matrix(e["transform"])
                fx, fy, cx, cy = (float(v) for v in e["intrinsics"])
            except (KeyError, TypeError, ValueError) as err:
                raise MeasureError(f"A frame in frames.json is not as described ({err!r}).") from None
            image = _decode(archive.read(str(e["image"])), cv2.IMREAD_COLOR, e["image"])
            raw = _decode(archive.read(str(e["depth"])), cv2.IMREAD_UNCHANGED, e["depth"])
            if raw.ndim != 2 or raw.dtype != np.uint16:
                raise MeasureError(f"{e['depth']} is not a 16-bit depth map in millimetres.")
            depth = raw.astype(np.float32) / 1000
            if e.get("confidence"):
                confidence = _decode(archive.read(str(e["confidence"])), cv2.IMREAD_UNCHANGED, e["confidence"])
                if confidence.shape != depth.shape:
                    raise MeasureError(f"{e['confidence']} is not the size of its depth map.")
                depth[confidence < CONFIDENT] = 0
            views.append(View(matrix, depth, image, fx, fy, cx, cy))
        return views, left_out
    finally:
        archive.close()


def depth_intrinsics(view: View) -> tuple[float, float, float, float]:
    """The camera's intrinsics in pixels of its depth map (the same view as the photo, smaller)."""
    sx = view.depth.shape[1] / view.image.shape[1]
    sy = view.depth.shape[0] / view.image.shape[0]
    return view.fx * sx, view.fy * sy, (view.cx + 0.5) * sx - 0.5, (view.cy + 0.5) * sy - 0.5


def backproject(view: View, step: int = 4) -> np.ndarray:
    """Every `step`th depth reading of a frame, as points in the world."""
    fx, fy, cx, cy = depth_intrinsics(view)
    v, u = np.mgrid[0 : view.depth.shape[0] : step, 0 : view.depth.shape[1] : step]
    z = view.depth[v, u]
    keep = z > 0
    u, v, z = u[keep], v[keep], z[keep]
    # Camera axes: x right, y up, looking down -z; the image's v runs down.
    cam = np.stack([(u - cx) * z / fx, -(v - cy) * z / fy, -z], axis=1)
    return cam @ view.matrix[:3, :3].T + view.matrix[:3, 3]


# --------------------------------------------------------------------------
# Where the machine is.


def find_floor(points: np.ndarray) -> float:
    """The floor's height: the lowest level that a good share of the points round the machine lie on."""
    y = points[:, 1]
    lo = np.percentile(y, 0.5)
    bins = np.arange(lo - 0.02, lo + 1.5, 0.01)
    counts, edges = np.histogram(y, bins=bins)
    if not counts.any():
        raise MeasureError("The depth shows no floor round the machine.")
    broad = np.nonzero(counts >= 0.3 * counts.max())[0][0]
    # The middle of that level, from the points in it and either side.
    band = (y >= edges[max(0, broad - 1)]) & (y < edges[min(len(edges) - 1, broad + 2)])
    return float(np.median(y[band]))


def locate(views: list[View], box: dict | None) -> dict:
    positions = np.array([v.matrix[:3, 3] for v in views])
    forwards = np.array([-v.matrix[:3, 2] for v in views])
    centre = orbit_centre(positions, forwards)
    if box:
        radius = REACH * 0.5 * math.hypot(box["w"], box["d"])
        height = HEADROOM * box["h"]
    else:
        radius, height = UNSIZED_RADIUS_M, UNSIZED_HEIGHT_M
    points = np.concatenate([backproject(v) for v in views[:: max(1, len(views) // 24)]])
    near = points[np.hypot(points[:, 0] - centre[0], points[:, 2] - centre[1]) < 1.5 * radius]
    if len(near) < 100:
        raise MeasureError("The depth shows almost nothing round the middle of the walk.")
    return {"centre": centre, "radius": radius, "floor": find_floor(near), "height": height}


# --------------------------------------------------------------------------
# Depth fusion.


@dataclass
class Grid:
    origin: np.ndarray  # world position of voxel (0, 0, 0)
    voxel: float
    shape: tuple[int, int, int]  # x, y, z
    tsdf: np.ndarray  # signed distance over the truncation, -1 (inside) to 1
    weight: np.ndarray  # frames that saw the voxel (0: never seen)
    colour: np.ndarray  # BGR, averaged
    cweight: np.ndarray


def voxel_size(extent, max_voxels: int = MAX_VOXELS) -> float:
    """VOXEL_M, or larger when a volume this big would need more than max_voxels of them."""
    return max(VOXEL_M, float(np.prod(extent) / max_voxels) ** (1 / 3))


def fuse(views: list[View], where: dict, max_voxels: int = MAX_VOXELS) -> Grid:
    cx, cz = where["centre"]
    r, floor, height = where["radius"], where["floor"], where["height"]
    lo = np.array([cx - r, floor - 0.05, cz - r])
    hi = np.array([cx + r, floor + height, cz + r])
    voxel = voxel_size(hi - lo, max_voxels)
    shape = tuple(int(n) for n in np.ceil((hi - lo) / voxel))
    total = int(np.prod(shape))
    tsdf = np.ones(total, np.float32)
    weight = np.zeros(total, np.float32)
    colour = np.zeros((total, 3), np.float32)
    cweight = np.zeros(total, np.float32)

    # Only the voxels inside the cylinder are fused.
    ii, jj, kk = np.meshgrid(*(np.arange(n, dtype=np.int32) for n in shape), indexing="ij")
    centres = np.stack([ii.ravel(), jj.ravel(), kk.ravel()], axis=1).astype(np.float32) * voxel + lo.astype(np.float32) + voxel / 2
    del ii, jj, kk
    inside = np.nonzero(np.hypot(centres[:, 0] - cx, centres[:, 2] - cz) <= r)[0]
    pts = centres[inside]
    del centres
    trunc = TRUNCATION * voxel

    for view in views:
        fx, fy, dcx, dcy = depth_intrinsics(view)
        rot = view.matrix[:3, :3].astype(np.float32)
        cam = (pts - view.matrix[:3, 3].astype(np.float32)) @ rot
        z = -cam[:, 2]
        ahead = np.nonzero(z > 0.05)[0]
        zc = z[ahead]
        u = np.rint(fx * cam[ahead, 0] / zc + dcx).astype(np.int32)
        v = np.rint(-fy * cam[ahead, 1] / zc + dcy).astype(np.int32)
        h, w = view.depth.shape
        seen = (u >= 0) & (u < w) & (v >= 0) & (v < h)
        ahead, zc, u, v = ahead[seen], zc[seen], u[seen], v[seen]
        d = view.depth[v, u]
        sdf = d - zc
        ok = (d > 0) & (sdf > -trunc)
        idx = inside[ahead[ok]]
        s = np.minimum(1.0, sdf[ok] / trunc)
        wt = weight[idx]
        tsdf[idx] = (tsdf[idx] * wt + s) / (wt + 1)
        weight[idx] = np.minimum(wt + 1, MAX_WEIGHT)

        # Colour, for voxels by the surface: where they fall in the photo.
        near = ok & (np.abs(sdf) < trunc)
        sel = ahead[near]
        zs = zc[near]
        iu = np.rint(view.fx * cam[sel, 0] / zs + view.cx).astype(np.int32)
        iv = np.rint(-view.fy * cam[sel, 1] / zs + view.cy).astype(np.int32)
        ih, iw = view.image.shape[:2]
        inside_photo = (iu >= 0) & (iu < iw) & (iv >= 0) & (iv < ih)
        cidx = inside[sel[inside_photo]]
        cw = cweight[cidx][:, None]
        colour[cidx] = (colour[cidx] * cw + view.image[iv[inside_photo], iu[inside_photo]]) / (cw + 1)
        cweight[cidx] = np.minimum(cw[:, 0] + 1, MAX_WEIGHT)

    return Grid(lo, voxel, shape, tsdf.reshape(shape), weight.reshape(shape), colour.reshape(*shape, 3), cweight.reshape(shape))


def keep_machine(grid: Grid, where: dict) -> dict:
    """
    Cuts the floor away and keeps the machine; returns how many solid pieces
    there were and how many were kept.

    The volume is sized to hold the machine with room to spare, so a piece
    that reaches its edge or its top is something else: a wall, a
    neighbour. Of the rest, every piece lying mostly over the footprint is
    the machine (a black one, which the sensor reads in patches, can come
    in several), and specks of noise are not.
    """
    floor_index = int(math.ceil((where["floor"] + max(FLOOR_CLEAR_M, grid.voxel) - grid.origin[1]) / grid.voxel))
    # Below the cut: seen, and empty, so the machine's underside closes there and the floor is gone.
    grid.tsdf[:, :floor_index, :] = 1.0
    grid.weight[:, :floor_index, :] = np.maximum(grid.weight[:, :floor_index, :], 1)
    solid = (grid.weight > 0) & (grid.tsdf < 0)
    labels, count = ndimage.label(solid)
    if not count:
        raise MeasureError("Nothing solid stands in the middle of the walk.")
    ids = np.arange(1, count + 1)

    cx, cz = where["centre"]
    xs = grid.origin[0] + (np.arange(grid.shape[0]) + 0.5) * grid.voxel
    zs = grid.origin[2] + (np.arange(grid.shape[2]) + 0.5) * grid.voxel
    across = np.hypot(xs[:, None] - cx, zs[None, :] - cz)
    footprint = (across <= where["radius"] / REACH)[:, None, :]
    edge = np.broadcast_to((across >= where["radius"] - 1.5 * grid.voxel)[:, None, :], solid.shape).copy()
    edge[:, -2:, :] = True

    sizes = ndimage.sum(solid, labels, index=ids)
    over = ndimage.sum(np.broadcast_to(footprint, solid.shape), labels, index=ids)
    reaches_edge = ndimage.maximum(edge, labels, index=ids) > 0
    inside = ~reaches_edge
    machine = inside & (over >= MOSTLY * sizes) & (sizes >= MIN_PIECE_VOXELS)
    if not machine.any():
        # Nothing inside on its own: the piece most over the footprint, whatever it reaches.
        candidates = inside if (inside & (over > 0)).any() else np.ones(count, bool)
        score = np.where(candidates, over, -1)
        if score.max() <= 0:
            raise MeasureError("Nothing solid stands in the middle of the walk.")
        machine = np.zeros(count, bool)
        machine[int(np.argmax(score))] = True
    keep = np.zeros(count + 1, bool)
    keep[1:] = machine
    grid.tsdf[solid & ~keep[labels]] = 1.0
    return {"pieces": int(count), "kept": int(machine.sum()), "voxels": int(sizes[machine].sum())}


# --------------------------------------------------------------------------
# The surface.

CORNERS = np.array([[i, j, k] for i in (0, 1) for j in (0, 1) for k in (0, 1)])
EDGES = [(a, b) for a in range(8) for b in range(a + 1, 8) if np.abs(CORNERS[a] - CORNERS[b]).sum() == 1]
# For a crossing along each axis, the two others in order (so b x c = the axis), and the four cells round it.
FACE_AXES = {0: (1, 2), 1: (2, 0), 2: (0, 1)}
AROUND = [(-1, -1), (0, -1), (0, 0), (-1, 0)]


def surface(grid: Grid) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Surface nets: vertices (world), triangles, and each vertex's BGR colour."""
    f, seen = grid.tsdf, grid.weight > 0
    nx, ny, nz = f.shape
    corner = lambda a: (slice(CORNERS[a][0], nx - 1 + CORNERS[a][0]), slice(CORNERS[a][1], ny - 1 + CORNERS[a][1]), slice(CORNERS[a][2], nz - 1 + CORNERS[a][2]))  # noqa: E731
    all_seen = np.logical_and.reduce([seen[corner(a)] for a in range(8)])
    negative = [f[corner(a)] < 0 for a in range(8)]
    some = np.logical_or.reduce(negative)
    every = np.logical_and.reduce(negative)
    active = all_seen & some & ~every
    del negative, some, every, all_seen
    cells = np.argwhere(active)
    if not len(cells):
        raise MeasureError("Nothing solid stands in the middle of the walk.")
    index = np.full(active.shape, -1, np.int64)
    index[tuple(cells.T)] = np.arange(len(cells))

    # Each vertex: the mean of where the surface crosses its cell's edges.
    values = np.stack([f[tuple((cells + CORNERS[a]).T)] for a in range(8)], axis=1)
    total = np.zeros((len(cells), 3))
    crossings = np.zeros(len(cells))
    for a, b in EDGES:
        va, vb = values[:, a], values[:, b]
        cross = (va < 0) != (vb < 0)
        t = np.where(cross, va / np.where(cross, va - vb, 1), 0)
        total += np.where(cross[:, None], CORNERS[a] + t[:, None] * (CORNERS[b] - CORNERS[a]), 0)
        crossings += cross
    local = total / crossings[:, None]
    vertices = grid.origin + (cells + local + 0.5) * grid.voxel

    # Colour: the corners' colours, by how many photos saw each.
    cw = np.stack([grid.cweight[tuple((cells + CORNERS[a]).T)] for a in range(8)], axis=1)
    cc = np.stack([grid.colour[tuple((cells + CORNERS[a]).T)] for a in range(8)], axis=1)
    colours = (cc * cw[:, :, None]).sum(1) / np.maximum(cw.sum(1), 1e-6)[:, None]

    # Faces: a quad round each crossing between two seen voxels, facing out of the solid.
    triangles = []
    for axis, (b, c) in FACE_AXES.items():
        lo = [slice(0, n) for n in f.shape]
        hi = [slice(0, n) for n in f.shape]
        lo[axis] = slice(0, f.shape[axis] - 1)
        hi[axis] = slice(1, f.shape[axis])
        fa, fb = f[tuple(lo)], f[tuple(hi)]
        both = seen[tuple(lo)] & seen[tuple(hi)]
        flip = both & ((fa < 0) != (fb < 0))
        edges = np.argwhere(flip)
        # The four cells round the edge must exist: not on the grid's border.
        ok = (edges[:, b] >= 1) & (edges[:, c] >= 1) & (edges[:, b] <= f.shape[b] - 1) & (edges[:, c] <= f.shape[c] - 1)
        ok &= (edges[:, b] - 1 < index.shape[b]) & (edges[:, c] - 1 < index.shape[c])
        edges = edges[ok]
        if not len(edges):
            continue
        quad = []
        for db, dc in AROUND:
            cell = edges.copy()
            cell[:, b] += db
            cell[:, c] += dc
            valid = (cell[:, b] < index.shape[b]) & (cell[:, c] < index.shape[c]) & (cell[:, axis] < index.shape[axis])
            ids = np.full(len(cell), -1)
            ids[valid] = index[tuple(cell[valid].T)]
            quad.append(ids)
        quad = np.stack(quad, axis=1)
        whole = (quad >= 0).all(1)
        quad = quad[whole]
        # Solid at the low end: the face looks along +axis, as b, c are ordered; else the other way.
        outward = f[tuple(edges[whole].T)] < 0
        quad[~outward] = quad[~outward][:, ::-1]
        triangles.append(np.concatenate([quad[:, [0, 1, 2]], quad[:, [0, 2, 3]]]))
    if not triangles:
        raise MeasureError("Nothing solid stands in the middle of the walk.")
    return vertices, np.concatenate(triangles).astype(np.uint32), colours


def vertex_normals(vertices: np.ndarray, triangles: np.ndarray) -> np.ndarray:
    a, b, c = (vertices[triangles[:, i]] for i in range(3))
    face = np.cross(b - a, c - a)
    normals = np.zeros_like(vertices)
    for i in range(3):
        np.add.at(normals, triangles[:, i], face)
    length = np.linalg.norm(normals, axis=1, keepdims=True)
    return np.where(length > 0, normals / np.maximum(length, 1e-12), [0, 1, 0])


def line_up(vertices: np.ndarray, floor: float) -> tuple[np.ndarray, float]:
    """
    Turns the model about the vertical so the smallest rectangle round its
    footprint lies along X and Z, centres it on that rectangle, and stands
    it at the floor's height on y = 0. Returns the vertices and the turn.
    """
    xz = vertices[:, [0, 2]]
    hull = xz[ConvexHull(xz).vertices]
    best = None
    for p, q in zip(hull, np.roll(hull, -1, axis=0)):
        theta = math.atan2(q[1] - p[1], q[0] - p[0])
        c, s = math.cos(theta), math.sin(theta)
        # A right-handed turn about +y by theta: (x, z) -> (c x + s z, -s x + c z).
        turned = np.stack([c * hull[:, 0] + s * hull[:, 1], -s * hull[:, 0] + c * hull[:, 1]], axis=1)
        area = np.prod(turned.max(0) - turned.min(0))
        if best is None or area < best[0]:
            best = (area, theta)
    theta = best[1]
    c, s = math.cos(theta), math.sin(theta)
    x = c * vertices[:, 0] + s * vertices[:, 2]
    z = -s * vertices[:, 0] + c * vertices[:, 2]
    out = np.stack([x, vertices[:, 1] - floor, z], axis=1)
    middle = (out.max(0) + out.min(0)) / 2
    out[:, 0] -= middle[0]
    out[:, 2] -= middle[2]
    return out, math.degrees(theta)


# --------------------------------------------------------------------------
# The file.


def linear(srgb: np.ndarray) -> np.ndarray:
    """sRGB (0-1, as photos are) to linear light (0-1), which is what glTF's vertex colours are."""
    return np.where(srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4)


def write_glb(
    positions: np.ndarray,
    normals: np.ndarray,
    colours: np.ndarray | None,
    triangles: np.ndarray,
    *,
    uvs: np.ndarray | None = None,
    image: bytes | None = None,
) -> bytes:
    """
    A GLB of one mesh. With `uvs` and `image` (a JPEG), textured (N-04).
    Otherwise coloured per vertex: `colours` are the photos' RGB (0-255),
    stored in linear light, 16 bits a channel so dark ones (black rubber)
    keep their detail.
    """
    n = len(positions)
    accessors = [
        {"componentType": 5126, "count": n, "type": "VEC3", "min": positions.min(0).tolist(), "max": positions.max(0).tolist()},
        {"componentType": 5126, "count": n, "type": "VEC3"},
    ]
    data = [(positions.astype("<f4").tobytes(), 34962), (normals.astype("<f4").tobytes(), 34962)]
    attributes = {"POSITION": 0, "NORMAL": 1}
    material = {"name": "measured", "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0.0, "roughnessFactor": 0.85}}
    if uvs is not None:
        attributes["TEXCOORD_0"] = len(accessors)
        accessors.append({"componentType": 5126, "count": n, "type": "VEC2"})
        data.append((uvs.astype("<f4").tobytes(), 34962))
        material["pbrMetallicRoughness"]["baseColorTexture"] = {"index": 0}
    else:
        rgb = linear(np.clip(colours[:, :3], 0, 255) / 255)
        rgba = np.concatenate([rgb, np.ones((len(rgb), 1))], axis=1)
        attributes["COLOR_0"] = len(accessors)
        accessors.append({"componentType": 5123, "normalized": True, "count": n, "type": "VEC4"})
        data.append((np.round(rgba * 65535).astype("<u2").tobytes(), 34962))
    indices = len(accessors)
    accessors.append({"componentType": 5125, "count": int(triangles.size), "type": "SCALAR"})
    data.append((triangles.astype("<u4").tobytes(), 34963))
    for i, accessor in enumerate(accessors):
        accessor["bufferView"] = i
    if uvs is not None:
        data.append((image, None))

    parts, views, offset = [], [], 0
    for chunk, target in data:
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(chunk), **({"target": target} if target else {})})
        parts.append(chunk + b"\0" * (-len(chunk) % 4))
        offset += len(parts[-1])
    binary = b"".join(parts)
    gltf = {
        "asset": {"version": "2.0", "generator": "flexgym measured reconstruction (L-04)"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"name": "model", "mesh": 0}],
        "meshes": [{"name": "model", "primitives": [{"attributes": attributes, "indices": indices, "material": 0, "mode": 4}]}],
        "materials": [material],
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": len(binary)}],
    }
    if uvs is not None:
        gltf["images"] = [{"bufferView": len(views) - 1, "mimeType": "image/jpeg"}]
        # Clamped: a chart's edge must not wrap round to the far side of the texture.
        gltf["samplers"] = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}]
        gltf["textures"] = [{"source": 0, "sampler": 0}]
    body = json.dumps(gltf, separators=(",", ":")).encode()
    body += b" " * (-len(body) % 4)
    chunks = struct.pack("<I4s", len(body), b"JSON") + body + struct.pack("<I4s", len(binary), b"BIN\0") + binary
    return struct.pack("<4sII", b"glTF", 2, 12 + len(chunks)) + chunks


@dataclass
class Rebuilt:
    """The machine as rebuilt, still in ARKit's world (before it is lined up)."""

    vertices: np.ndarray
    triangles: np.ndarray
    bgr: np.ndarray
    where: dict
    voxel: float
    pieces: int
    kept: int
    frames: int
    left_out: dict
    # The frames it was built from, for the photo texture.
    views: list = field(default_factory=list, repr=False)


def rebuild(frames: Path, box: dict | None = None, *, max_frames: int = MAX_FRAMES, max_voxels: int = MAX_VOXELS) -> Rebuilt:
    """Steps 1 to 5: the machine's surface from an ARKit frames upload, where it stands in the world."""
    try:
        views, left_out = read_views(frames, max_frames)
    except FramesError as e:
        raise MeasureError(str(e)) from None
    where = locate(views, box)
    grid = fuse(views, where, max_voxels)
    kept = keep_machine(grid, where)
    vertices, triangles, bgr = surface(grid)
    if len(triangles) < MIN_TRIANGLES:
        raise MeasureError(f"What stands in the middle is too small to be the machine ({len(triangles)} triangles).")
    return Rebuilt(vertices, triangles, bgr, where, grid.voxel, kept["pieces"], kept["kept"], len(views), left_out, views)


def reconstruct(
    frames: Path,
    out: Path,
    box: dict | None = None,
    *,
    max_frames: int = MAX_FRAMES,
    max_voxels: int = MAX_VOXELS,
    texture_size: int | None = None,
) -> dict:
    """Builds the model from an ARKit frames upload; writes model.glb and measured.json; returns the report."""
    return finish(rebuild(frames, box, max_frames=max_frames, max_voxels=max_voxels), out, box, texture_size=texture_size)


def finish(made: Rebuilt, out: Path, box: dict | None = None, *, texture_size: int | None = None) -> dict:
    """
    Steps 6 and 7 and the files: the rebuilt machine lined up and textured,
    written to model.glb, its report to measured.json. `texture_size`
    defaults to TEXTURE; 0 colours it per vertex instead.
    """
    triangles, where = made.triangles, made.where
    placed, turn = line_up(made.vertices, where["floor"])
    texture_size = TEXTURE if texture_size is None else texture_size
    textured = skipped = None
    if texture_size and made.views:
        import bake  # it builds on this module

        try:
            textured = bake.texture(placed, made.vertices, triangles, made.bgr, made.views, made.voxel, size=texture_size)
        except bake.TextureError as e:
            skipped = f"No photo texture: {e}. Coloured per vertex."
    if textured:
        jpeg = cv2.imencode(".jpg", textured.image, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])[1].tobytes()
        glb = write_glb(textured.positions, textured.normals, None, textured.triangles, uvs=textured.uvs, image=jpeg)
    else:
        glb = write_glb(placed, vertex_normals(placed, triangles), made.bgr[:, ::-1], triangles)
    out.mkdir(parents=True, exist_ok=True)
    (out / "model.glb").write_bytes(glb)
    size = placed.max(0) - placed.min(0)
    report = {
        "framesUsed": made.frames,
        "leftOut": made.left_out,
        "voxelM": round(made.voxel, 4),
        "centre": [round(float(v), 3) for v in where["centre"]],
        "floorY": round(where["floor"], 3),
        "radiusM": round(where["radius"], 3),
        "pieces": made.pieces,
        "kept": made.kept,
        "sizeM": {"w": round(float(size[0]), 3), "d": round(float(size[2]), 3), "h": round(float(placed[:, 1].max()), 3)},
        "turnDeg": round(turn, 2),
        "vertices": int(len(textured.positions) if textured else len(placed)),
        "triangles": int(len(triangles)),
        "texture": textured.report if textured else ({"skipped": skipped} if skipped else None),
        "box": box,
    }
    (out / "measured.json").write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a machine's model from its ARKit frames (L-04).")
    parser.add_argument("--frames", type=Path, required=True, help="the ARKit frames upload (zip or folder)")
    parser.add_argument("--out", type=Path, required=True, help="folder for model.glb and measured.json")
    parser.add_argument("--box", help="the scanned size in metres: width,depth,height")
    args = parser.parse_args()
    box = dict(zip("wdh", (float(v) for v in args.box.split(",")))) if args.box else None
    try:
        report = reconstruct(args.frames, args.out, box)
    except MeasureError as err:
        sys.exit(f"No model: {err}")
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
