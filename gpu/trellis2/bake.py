"""
Photo texture for a measured model (task N-04). The measured surface
(measured.py) is coloured per vertex, so its detail stops at the voxel size
(1.5 cm); the photos it came from hold far more. This lays the surface out
flat in a texture and fills each texel from the photos that see it best.

1. Charts. Each triangle goes with the side of a box it faces most (+x, -x,
   +y, -y, +z, -z; the model is lined up with its footprint, so a machine's
   flat faces fall on one side each); a stray one joins the side its
   neighbours chose, and a fleck of a few triangles the chart beside it,
   when it faces that side too. Each connected stretch on
   one side is a chart, laid flat by looking at it from that side; one
   that fills less than half the rectangle round it (the side of a frame)
   is cut in two, and again. A vertex on a chart's edge is split, one copy
   for each chart.
2. The atlas. The charts, all at one scale, are packed on shelves into a
   square texture, tallest first, with a gap round each; and again with
   the charts taller than wide turned on their side, the closer packing
   kept. About 70 % of the texture is used.
3. The texels. Each covered texel's point on the surface (in ARKit's world,
   where the photos were taken) and its normal come from the triangle that
   covers it.
4. The photos. A photo counts for a texel when the point is in it, faces it
   (within 75 degrees), is not hidden behind another part of the model, and
   is not behind something else the depth saw in front of it (a person, a
   neighbour). Each counts by how squarely and how closely it sees the
   point, strongly towards the best. Their colours are averaged in linear
   light. A texel that no photo sees keeps the surface's own colour (the
   fusion's).
5. Round each chart, colour spreads a few texels outward, so the smaller
   versions of the texture (L-06's levels of detail) do not pull the gaps'
   colour into its edges.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import cv2
import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

from measured import depth_intrinsics, linear, vertex_normals

# Texels left between charts in a 1024 texture; in proportion for others, at least 2.
GAP = 4
# Photos used at most, spread over the walk.
BAKE_VIEWS = 60
# A photo seeing a point more side-on than this tells nothing useful about it.
FACING = math.cos(math.radians(75))
# How strongly a squarer view counts over a more side-on one (cos ** SHARP).
SHARP = 8
# A triangle joins its neighbours' side only if it faces that side at least this much (else it would smear).
JOIN = 0.35
# A chart of fewer triangles joins its neighbour, if it faces the neighbour's side at least this much.
MIN_CHART = 16
MERGE_FACING = 0.1
# A chart filling less than this share of the rectangle round it is cut in two, up to SPLITS times, down to MIN_SPLIT_M.
SPARSE = 0.5
SPLITS = 4
MIN_SPLIT_M = 0.2
# Width in pixels of the model's own depth image, used to tell what it hides of itself.
SELF_DEPTH_WIDTH = 160

# The sides, and for each how a chart on it lies flat: (axis, sign) across and down, as seen from outside.
SIDES = np.array([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]], float)
FLAT = [((2, -1), (1, -1)), ((2, 1), (1, -1)), ((0, 1), (2, 1)), ((0, 1), (2, -1)), ((0, 1), (1, -1)), ((0, -1), (1, -1))]


class TextureError(ValueError):
    """The model cannot be given a texture: it is coloured per vertex instead."""


@dataclass
class Textured:
    """The model, its vertices split along the charts' edges, with its texture."""

    positions: np.ndarray  # the lined-up model's
    normals: np.ndarray
    uvs: np.ndarray  # 0-1, v down (glTF's)
    triangles: np.ndarray
    image: np.ndarray  # BGR, sRGB
    report: dict


# --------------------------------------------------------------------------
# 1. Charts.


def face_normals(vertices: np.ndarray, triangles: np.ndarray) -> np.ndarray:
    a, b, c = (vertices[triangles[:, i]] for i in range(3))
    n = np.cross(b - a, c - a)
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)


def neighbours(triangles: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Pairs of triangles that share an edge."""
    edges = np.concatenate([triangles[:, [0, 1]], triangles[:, [1, 2]], triangles[:, [2, 0]]]).astype(np.int64)
    faces = np.tile(np.arange(len(triangles)), 3)
    edges.sort(axis=1)
    key = edges[:, 0] * (int(edges.max()) + 1) + edges[:, 1]
    order = np.argsort(key, kind="stable")
    key, faces = key[order], faces[order]
    same = key[1:] == key[:-1]
    return faces[:-1][same], faces[1:][same]


def sides(facing: np.ndarray, a: np.ndarray, b: np.ndarray, rounds: int = 2) -> np.ndarray:
    """Each triangle's side: the one it faces most, or, where two of its three neighbours chose another it faces well enough, theirs."""
    rows = np.arange(len(facing))
    side = facing.argmax(1)
    for _ in range(rounds):
        votes = np.zeros((len(side), len(SIDES)))
        np.add.at(votes, (a, side[b]), 1)
        np.add.at(votes, (b, side[a]), 1)
        votes[rows, side] += 1.5  # its own counts most: two neighbours of three outvote it
        best = votes.argmax(1)
        side = np.where(facing[rows, best] > JOIN, best, side)
    return side


def merge_small(chart: np.ndarray, side: np.ndarray, facing: np.ndarray, a: np.ndarray, b: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """
    A chart of fewer than MIN_CHART triangles (a fleck of noise, a sliver
    a cut left) joins the larger chart beside it that it shares most edges
    with, if every one of its triangles faces that chart's side.
    """
    rows = np.arange(len(chart))
    for _ in range(3):
        count = np.bincount(chart)
        small = count < MIN_CHART
        x, y = np.concatenate([a, b]), np.concatenate([b, a])
        border = small[chart[x]] & ~small[chart[y]]
        if not border.any():
            break
        k = len(count)
        pairs, shared = np.unique(chart[x[border]].astype(np.int64) * k + chart[y[border]], return_counts=True)
        mine, theirs = pairs // k, pairs % k
        # For each small chart, the neighbour it shares most edges with (on a tie, the larger).
        order = np.lexsort((-count[theirs], -shared, mine))
        first = np.ones(len(order), bool)
        first[1:] = mine[order][1:] != mine[order][:-1]
        target = np.full(k, -1)
        target[mine[order][first]] = theirs[order][first]
        chart_side = np.zeros(k, int)
        chart_side[chart] = side
        moving = target[chart] >= 0
        to_side = np.where(moving, chart_side[np.maximum(target[chart], 0)], side)
        fits = np.ones(k, bool)
        np.logical_and.at(fits, chart[moving], facing[rows[moving], to_side[moving]] > MERGE_FACING)
        move = moving & fits[chart]
        if not move.any():
            break
        side = np.where(move, to_side, side)
        chart = _components(np.where(move, target[chart], chart), a, b)
    return chart, side


def flatten(points: np.ndarray, side: np.ndarray) -> np.ndarray:
    """Points (..., 3) laid flat as seen from their side (broadcast against them): (..., 2), in metres."""
    ua, us, va, vs = (np.array(column)[side] for column in zip(*[(u[0], u[1], v[0], v[1]) for u, v in FLAT]))
    u = us * np.take_along_axis(points, ua[..., None], axis=-1)[..., 0]
    v = vs * np.take_along_axis(points, va[..., None], axis=-1)[..., 0]
    return np.stack([u, v], axis=-1)


def _components(label: np.ndarray, a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Connected stretches of triangles sharing a label."""
    joined = label[a] == label[b]
    n = len(label)
    graph = coo_matrix((np.ones(int(joined.sum())), (a[joined], b[joined])), shape=(n, n))
    return connected_components(graph, directed=False)[1]


def charts(vertices: np.ndarray, triangles: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """
    Each triangle's chart, and each chart's side. A chart that fills less
    than half the rectangle round it (a frame's side, an L, a U) is cut in
    two across its longer way, and again, so the packing does not carry
    its empty middle.
    """
    a, b = neighbours(triangles)
    facing = face_normals(vertices, triangles) @ SIDES.T
    side = sides(facing, a, b)
    chart, side = merge_small(_components(side, a, b), side, facing, a, b)
    corners = flatten(vertices[triangles], side[:, None])  # each triangle's corners, flat
    edge1, edge2 = corners[:, 1] - corners[:, 0], corners[:, 2] - corners[:, 0]
    area = 0.5 * np.abs(edge1[:, 0] * edge2[:, 1] - edge1[:, 1] * edge2[:, 0])
    middle = corners.mean(1)
    rows = np.arange(len(chart))
    for _ in range(SPLITS):
        count = int(chart.max()) + 1
        lo = np.full((count, 2), np.inf)
        hi = np.full((count, 2), -np.inf)
        np.minimum.at(lo, chart, corners.min(1))
        np.maximum.at(hi, chart, corners.max(1))
        extent = hi - lo
        sparse = (np.bincount(chart, area, count) < SPARSE * extent.prod(1)) & (extent.max(1) > MIN_SPLIT_M)
        if not sparse.any():
            break
        along = (extent[:, 1] > extent[:, 0]).astype(int)[chart]
        upper = middle[rows, along] > ((lo + hi) / 2)[chart, along]
        chart = _components(chart * 2 + (sparse[chart] & upper), a, b)
    chart, side = merge_small(chart, side, facing, a, b)
    chart_side = np.zeros(int(chart.max()) + 1, int)
    chart_side[chart] = side
    return chart, chart_side


# --------------------------------------------------------------------------
# 2. The atlas.


def _shelves(rects: np.ndarray, size: int, gap: int) -> np.ndarray | None:
    """
    Corners for rectangles (texels, tallest first) on shelves across the
    square: each goes on the first shelf with room left, else on a new one
    below. None if they do not fit.
    """
    corners = np.zeros((len(rects), 2), int)
    shelves = []  # [top, height, used width]
    bottom = gap
    for i, (w, h) in enumerate(np.ceil(rects).astype(int)):
        if w + 2 * gap > size:
            return None
        for shelf in shelves:
            if h <= shelf[1] and shelf[2] + w + gap <= size:
                break
        else:
            if bottom + h + gap > size:
                return None
            shelf = [bottom, h, gap]
            shelves.append(shelf)
            bottom += h + gap
        corners[i] = (shelf[2], shelf[0])
        shelf[2] += w + gap
    return corners


def gap_for(size: int) -> int:
    return max(2, round(GAP * size / 1024))


def pack(extents: np.ndarray, size: int, gap: int | None = None) -> tuple[float, np.ndarray]:
    """
    Places rectangles (width, height in metres) in a square of `size`
    texels, all at one scale, as large as fits: tallest first, on shelves.
    Returns the scale (texels a metre) and each one's corner (texels).
    """
    gap = gap_for(size) if gap is None else gap
    order = np.lexsort((np.arange(len(extents)), -extents[:, 1]))
    fits = lambda scale: _shelves(extents[order] * scale, size, gap)  # noqa: E731
    area = float(np.sum(extents[:, 0] * extents[:, 1]))
    hi = math.sqrt(size * size / max(area, 1e-9))  # all of it used: no more than this
    lo = 0.0
    if fits(1e-9) is None:
        raise TextureError(f"its {len(extents)} charts do not fit in a {size} texture")
    for _ in range(30):
        mid = (lo + hi) / 2
        if fits(mid) is None:
            hi = mid
        else:
            lo = mid
    placed = fits(lo)
    corners = np.empty_like(placed)
    corners[order] = placed
    return lo, corners


def lay_flat(vertices: np.ndarray, triangles: np.ndarray, size: int) -> dict:
    """Steps 1 and 2: the split vertices (by their source vertex), the triangles on them, their UVs in texels."""
    chart, chart_side = charts(vertices, triangles)
    count = len(chart_side)
    # One vertex for each vertex and chart it is in.
    key = triangles.ravel().astype(np.int64) * count + np.repeat(chart, 3)
    unique, inverse = np.unique(key, return_inverse=True)
    source = unique // count
    vchart = unique % count
    flat = flatten(vertices[source], chart_side[vchart])
    lo = np.full((count, 2), np.inf)
    hi = np.full((count, 2), -np.inf)
    np.minimum.at(lo, vchart, flat)
    np.maximum.at(hi, vchart, flat)
    # Packed as they are, and with each chart taller than wide turned on its side; the closer of the two.
    extents = hi - lo
    tall = extents[:, 1] > extents[:, 0]
    scale, corners = pack(extents, size)
    turned_scale, turned_corners = pack(np.where(tall[:, None], extents[:, ::-1], extents), size)
    local = flat - lo[vchart]
    if turned_scale > scale:
        scale, corners = turned_scale, turned_corners
        turn = tall[vchart]
        local[turn] = np.stack([local[turn, 1], extents[vchart[turn], 0] - local[turn, 0]], axis=1)
    texels = local * scale + corners[vchart]
    return {
        "source": source,
        "triangles": inverse.reshape(-1, 3).astype(np.uint32),
        "texels": texels,
        "charts": count,
        "scale": scale,
    }


# --------------------------------------------------------------------------
# 3. The texels.


def rasterise(texels: np.ndarray, triangles: np.ndarray, size: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """The covered texels (row, column) and, for each, its triangle and where in it (barycentric)."""
    cover = np.full((size, size), -1, np.int32)
    # OpenCV's pixel centres are at whole numbers, ours at halves; 4 bits of fraction.
    corners = np.round((texels[triangles] - 0.5) * 16).astype(np.int32)
    for t in range(len(triangles)):
        cv2.fillConvexPoly(cover, corners[t], t, lineType=cv2.LINE_8, shift=4)
    rows, cols = np.nonzero(cover >= 0)
    tri = cover[rows, cols]
    p = np.stack([cols + 0.5, rows + 0.5], axis=1)
    a, b, c = (texels[triangles[tri, i]] for i in range(3))
    v0, v1, v2 = b - a, c - a, p - a
    d00, d01, d11 = (v0 * v0).sum(1), (v0 * v1).sum(1), (v1 * v1).sum(1)
    d20, d21 = (v2 * v0).sum(1), (v2 * v1).sum(1)
    denom = d00 * d11 - d01 * d01
    ok = np.abs(denom) > 1e-12
    safe = np.where(ok, denom, 1)
    l1 = np.where(ok, (d11 * d20 - d01 * d21) / safe, 1 / 3)
    l2 = np.where(ok, (d00 * d21 - d01 * d20) / safe, 1 / 3)
    weights = np.clip(np.stack([1 - l1 - l2, l1, l2], axis=1), 0, None)
    weights /= np.maximum(weights.sum(1, keepdims=True), 1e-12)
    return np.stack([rows, cols], axis=1), tri, weights


# --------------------------------------------------------------------------
# 4. The photos.


def srgb(lin: np.ndarray) -> np.ndarray:
    lin = np.clip(lin, 0, 1)
    return np.where(lin <= 0.0031308, lin * 12.92, 1.055 * lin ** (1 / 2.4) - 0.055)


def _sample(image: np.ndarray, u: np.ndarray, v: np.ndarray, interpolation: int) -> np.ndarray:
    """The image at (u, v), pixel centres at whole numbers. OpenCV maps must be 2D and under 32767 a side."""
    n = len(u)
    width = 4096
    rows = max(1, -(-n // width))
    mx = np.zeros(rows * width, np.float32)
    my = np.zeros(rows * width, np.float32)
    mx[:n], my[:n] = u, v
    out = cv2.remap(image, mx.reshape(rows, width), my.reshape(rows, width), interpolation, borderMode=cv2.BORDER_REPLICATE)
    return out.reshape(rows * width, -1)[:n]


def _camera(view, points: np.ndarray):
    """Points in a view's camera: x right, y up, looking down -z. Returns (camera points, depth along the view)."""
    cam = (points - view.matrix[:3, 3]) @ view.matrix[:3, :3]
    return cam, -cam[:, 2]


def self_depth(view, surface_points: np.ndarray) -> tuple[np.ndarray, float, float, float, float]:
    """
    The model's own depth as this view sees it, at SELF_DEPTH_WIDTH: its
    points splatted, nearest kept, the gaps between them closed. Returns it
    and its intrinsics.
    """
    h, w = view.image.shape[:2]
    k = SELF_DEPTH_WIDTH / w
    sw, sh = SELF_DEPTH_WIDTH, max(1, int(round(h * k)))
    fx, fy = view.fx * k, view.fy * k
    cx, cy = (view.cx + 0.5) * k - 0.5, (view.cy + 0.5) * k - 0.5
    cam, z = _camera(view, surface_points)
    ahead = z > 0.05
    u = np.rint(fx * cam[ahead, 0] / z[ahead] + cx).astype(np.int64)
    v = np.rint(-fy * cam[ahead, 1] / z[ahead] + cy).astype(np.int64)
    inside = (u >= 0) & (u < sw) & (v >= 0) & (v < sh)
    depth = np.full(sw * sh, np.inf, np.float32)
    np.minimum.at(depth, v[inside] * sw + u[inside], z[ahead][inside].astype(np.float32))
    depth = cv2.erode(depth.reshape(sh, sw), np.ones((3, 3), np.uint8))
    return depth, fx, fy, cx, cy


# sRGB (0-255) to linear light, by table.
LINEAR = linear(np.arange(256) / 255).astype(np.float32)


def bake(points: np.ndarray, normals: np.ndarray, views: list, surface_points: np.ndarray, voxel: float) -> tuple[np.ndarray, np.ndarray]:
    """Step 4: each texel's colour in linear light (RGB) from the photos, and how much they saw it (0: not at all)."""
    points = points.astype(np.float32)
    normals = normals.astype(np.float32)
    total = np.zeros((len(points), 3), np.float32)
    weight = np.zeros(len(points), np.float32)
    for view in views:
        rot = view.matrix[:3, :3].astype(np.float32)
        eye = view.matrix[:3, 3].astype(np.float32)
        # Facing the camera, and in front of it: the rest is left at once.
        to_camera = eye - points
        cos = np.einsum("ij,ij->i", normals, to_camera)
        idx = np.nonzero(cos > 0)[0]
        cos = cos[idx] / np.linalg.norm(to_camera[idx], axis=1)
        facing = cos > FACING
        idx, ci = idx[facing], cos[facing]
        cam = (points[idx] - eye) @ rot
        zi = -cam[:, 2]
        h, w = view.image.shape[:2]
        ahead = zi > 0.1
        idx, ci, cam, zi = idx[ahead], ci[ahead], cam[ahead], zi[ahead]
        u = view.fx * cam[:, 0] / zi + view.cx
        v = -view.fy * cam[:, 1] / zi + view.cy
        inside = (u >= 1) & (u <= w - 2) & (v >= 1) & (v <= h - 2)
        idx, ci, cam, zi, u, v = idx[inside], ci[inside], cam[inside], zi[inside], u[inside], v[inside]
        if not len(idx):
            continue
        slant = np.sqrt(np.maximum(0, 1 - ci * ci)) / ci

        # Not hidden behind another part of the model. Slanted surfaces vary within a pixel: allow for that.
        own, fx, fy, cx, cy = self_depth(view, surface_points)
        su = np.clip(np.rint(fx * cam[:, 0] / zi + cx), 0, own.shape[1] - 1).astype(np.int32)
        sv = np.clip(np.rint(-fy * cam[:, 1] / zi + cy), 0, own.shape[0] - 1).astype(np.int32)
        keep = zi <= own[sv, su] + 2 * voxel + 2 * zi / fx * slant

        # Nor behind something the depth saw in front of it, that the model does not have.
        dfx, dfy, dcx, dcy = depth_intrinsics(view)
        dh, dw = view.depth.shape
        du = np.clip(np.rint(dfx * cam[:, 0] / zi + dcx), 0, dw - 1).astype(np.int32)
        dv = np.clip(np.rint(-dfy * cam[:, 1] / zi + dcy), 0, dh - 1).astype(np.int32)
        measured = view.depth[dv, du]
        keep &= ~((measured > 0) & (measured < zi - (3 * voxel + 0.03 * zi + 2 * zi / dfx * slant)))

        if not keep.any():
            continue
        idx, ci, zi = idx[keep], ci[keep], zi[keep]
        bgr = _sample(view.image, u[keep], v[keep], cv2.INTER_LINEAR)[:, :3]
        w_ = ci**SHARP / (zi * zi)
        total[idx] += w_[:, None] * LINEAR[bgr[:, ::-1]]
        weight[idx] += w_
    seen = weight > 0
    total[seen] /= weight[seen][:, None]
    return total.astype(np.float64), weight


# --------------------------------------------------------------------------
# 5. Round the charts.


def spread(image: np.ndarray, covered: np.ndarray, steps: int) -> np.ndarray:
    """Colour pushed `steps` texels out from the charts; the rest of the texture their average colour."""
    img = image.astype(np.float32)
    mask = covered.astype(np.float32)
    kernel = np.ones((3, 3), np.uint8)
    for _ in range(steps):
        grown = cv2.dilate(mask, kernel)
        new = (grown > 0) & (mask == 0)
        if not new.any():
            break
        summed = cv2.blur(img * mask[..., None], (3, 3))
        count = cv2.blur(mask, (3, 3))
        img[new] = summed[new] / count[new][:, None]
        mask = grown
    img[mask == 0] = img[covered].mean(0) if covered.any() else 0
    return img


# --------------------------------------------------------------------------


def texture(
    placed: np.ndarray,
    world: np.ndarray,
    triangles: np.ndarray,
    bgr: np.ndarray,
    views: list,
    voxel: float,
    *,
    size: int,
    max_views: int = BAKE_VIEWS,
) -> Textured:
    """
    The model with a texture baked from its photos. `placed` is the
    lined-up model, `world` the same vertices where the photos were taken;
    `bgr` the vertices' own colours (0-255), for what no photo sees.
    """
    flat = lay_flat(placed, triangles, size)
    source, split = flat["source"], flat["triangles"]
    covered, tri, bary = rasterise(flat["texels"], split, size)

    corners = source[split[tri]]  # each texel's three source vertices
    points = np.einsum("ni,nij->nj", bary, world[corners])
    world_normals = vertex_normals(world, triangles)
    normals = np.einsum("ni,nij->nj", bary, world_normals[corners])
    normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12)
    own = linear(np.einsum("ni,nij->nj", bary, bgr[corners][:, :, ::-1]).clip(0, 255) / 255)

    picks = np.unique(np.linspace(0, len(views) - 1, min(max_views, len(views))).round().astype(int)) if views else []
    chosen = [views[i] for i in picks]
    surface_points = np.concatenate([world, world[triangles].mean(1)])
    colour, weight = bake(points, normals, chosen, surface_points, voxel)
    seen = weight > 0
    colour[~seen] = own[~seen]

    image = np.zeros((size, size, 3), np.float32)
    image[covered[:, 0], covered[:, 1]] = srgb(colour)[:, ::-1] * 255
    mask = np.zeros((size, size), bool)
    mask[covered[:, 0], covered[:, 1]] = True
    image = np.round(spread(image, mask, 2 * gap_for(size))).clip(0, 255).astype(np.uint8)

    return Textured(
        positions=placed[source],
        normals=vertex_normals(placed, triangles)[source],
        uvs=flat["texels"] / size,
        triangles=split,
        image=image,
        report={
            "size": size,
            "charts": int(flat["charts"]),
            "texelsPerM": round(float(flat["scale"]), 1),
            "photos": len(chosen),
            "seenPct": round(100 * float(seen.mean()), 1) if len(seen) else 0.0,
        },
    )
