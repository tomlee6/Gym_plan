"""
Photo textures for measured models (N-04, bake.py). The treadmill sample's
console carries level stripes 1 cm wide, narrower than a voxel (1.5 cm):
coloured per vertex they blur into one blue, and the photo texture must
bring them back where they are.

Needs the image's numpy, OpenCV and SciPy (tests/requirements.txt);
skipped without them.
"""
from __future__ import annotations

import json
import shutil
import struct
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

try:
    import cv2
    import numpy as np
    import scipy  # noqa: F401

    import bake
    import measured
    import sample_arkit
except ImportError:  # the image's libraries are not installed here
    cv2 = None

NEEDS = "needs numpy, opencv-python-headless and scipy (tests/requirements.txt)"


def model_of(glb: bytes) -> dict:
    """The mesh measured.py writes: positions, triangles, and UVs and the texture, or vertex colours."""
    length = struct.unpack_from("<I", glb, 12)[0]
    gltf = json.loads(glb[20 : 20 + length])
    binary = glb[20 + length + 8 :]
    views = gltf["bufferViews"]
    view = lambda i: binary[views[i]["byteOffset"] : views[i]["byteOffset"] + views[i]["byteLength"]]  # noqa: E731
    primitive = gltf["meshes"][0]["primitives"][0]
    data = lambda i: view(gltf["accessors"][i]["bufferView"])  # noqa: E731
    out = {
        "gltf": gltf,
        "positions": np.frombuffer(data(primitive["attributes"]["POSITION"]), "<f4").reshape(-1, 3),
        "triangles": np.frombuffer(data(primitive["indices"]), "<u4").reshape(-1, 3),
    }
    if "TEXCOORD_0" in primitive["attributes"]:
        out["uvs"] = np.frombuffer(data(primitive["attributes"]["TEXCOORD_0"]), "<f4").reshape(-1, 2)
        out["image"] = cv2.imdecode(np.frombuffer(view(gltf["images"][0]["bufferView"]), np.uint8), cv2.IMREAD_COLOR)
    else:
        out["colours"] = np.frombuffer(data(primitive["attributes"]["COLOR_0"]), "<u2").reshape(-1, 4)[:, :3] / 65535
    return out


def console_sides(model: dict, n: int = 20000) -> tuple:
    """Points spread over the console's upright faces (only it stands 1.27 to 1.43 m up): their heights and brightness."""
    pos, tri = model["positions"], model["triangles"]
    normals = bake.face_normals(pos, tri)
    heights = pos[tri][:, :, 1]
    faces = np.nonzero((np.abs(normals[:, 1]) < 0.3) & (heights.min(1) > 1.27) & (heights.max(1) < 1.43))[0]
    rng = np.random.default_rng(0)
    pick = rng.choice(faces, n)
    r = rng.random((n, 2))
    r[r.sum(1) > 1] = 1 - r[r.sum(1) > 1]
    bary = np.stack([1 - r.sum(1), r[:, 0], r[:, 1]], axis=1)
    y = np.einsum("ni,ni->n", bary, pos[tri[pick]][:, :, 1])
    if "uvs" in model:
        uv = np.einsum("ni,nij->nj", bary, model["uvs"][tri[pick]])
        size = model["image"].shape[0]
        texel = np.clip((uv * size).astype(int), 0, size - 1)
        rgb = measured.linear(model["image"][texel[:, 1], texel[:, 0], ::-1] / 255)
    else:
        rgb = np.einsum("ni,nij->nj", bary, model["colours"][tri[pick]])
    return y, rgb @ [0.2126, 0.7152, 0.0722]


def stripes_found(y: np.ndarray, brightness: np.ndarray, width: float = sample_arkit.STRIPES_M if cv2 else 0.01) -> float:
    """
    The share of points whose brightness says the stripe their height says
    (light or dark), at the stripes' best phase: the model's floor is
    measured, so a millimetre or two out. Points by a stripe's edge are not
    counted. A blur scores about a half.
    """
    bright = brightness > np.median(brightness)
    best = 0.0
    for phase in np.arange(0, 2 * width, width / 20):
        along = (y + phase) / width
        light = np.floor(along) % 2 == 0
        clear = np.abs(along - np.round(along)) >= 0.2
        agree = float((light == bright)[clear].mean())
        best = max(best, agree, 1 - agree)
    return best


@unittest.skipUnless(cv2, NEEDS)
class Stripes(unittest.TestCase):
    """The treadmill, photographed at 640 x 480: enough for its console's 1 cm stripes."""

    @classmethod
    def setUpClass(cls):
        cls.dir = Path(tempfile.mkdtemp())
        sample_arkit.make_sample(cls.dir / "walk.zip", frames=24, image_size=(640, 480), depth_size=(128, 96), neighbour=False, wall=False)
        cls.made = measured.rebuild(cls.dir / "walk.zip", sample_arkit.SIZE, max_voxels=700_000)
        cls.textured = measured.finish(cls.made, cls.dir / "textured", sample_arkit.SIZE, texture_size=1024)
        cls.plain = measured.finish(cls.made, cls.dir / "plain", sample_arkit.SIZE, texture_size=0)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, ignore_errors=True)

    def model(self, name: str) -> dict:
        return model_of((self.dir / name / "model.glb").read_bytes())

    def test_the_texture_keeps_detail_finer_than_the_voxels(self):
        textured = stripes_found(*console_sides(self.model("textured")))
        per_vertex = stripes_found(*console_sides(self.model("plain")))
        self.assertGreater(textured, 0.85, "the stripes come back where they are")
        self.assertLess(per_vertex, 0.7, "coloured per vertex, they blur")

    def test_colours_most_of_the_surface_from_the_photos(self):
        texture = self.textured["texture"]
        self.assertEqual(texture["size"], 1024)
        self.assertEqual(texture["photos"], 24)
        self.assertGreater(texture["seenPct"], 85)
        # Each texel a few millimetres of the machine: finer than the voxels, as fine as the photos here.
        self.assertGreater(texture["texelsPerM"], 2 / measured.VOXEL_M)

    def test_the_same_model_and_size_either_way(self):
        self.assertEqual(self.textured["triangles"], self.plain["triangles"])
        self.assertEqual(self.textured["sizeM"], self.plain["sizeM"])
        self.assertGreater(self.textured["vertices"], self.plain["vertices"], "split along the charts' edges")

    def test_without_a_texture_it_is_coloured_per_vertex(self):
        model = self.model("plain")
        self.assertIn("COLOR_0", model["gltf"]["meshes"][0]["primitives"][0]["attributes"])
        self.assertNotIn("images", model["gltf"])
        self.assertIsNone(self.plain["texture"])

    def test_a_texture_too_small_for_its_charts_leaves_it_coloured_per_vertex(self):
        report = measured.finish(self.made, self.dir / "tiny", sample_arkit.SIZE, texture_size=8)
        self.assertRegex(report["texture"]["skipped"], r"^No photo texture: its \d+ charts do not fit in a 8 texture\. Coloured per vertex\.$")
        model = self.model("tiny")
        self.assertIn("COLOR_0", model["gltf"]["meshes"][0]["primitives"][0]["attributes"])


def grid_mesh(size: float = 0.4, step: float = 0.02, keep=None) -> tuple:
    """A flat square in z = 0 facing +z, as triangles; `keep(x, y)` drops the cells it says no to."""
    n = int(round(size / step))
    xs = np.linspace(-size / 2, size / 2, n + 1)
    gx, gy = np.meshgrid(xs, xs, indexing="ij")
    vertices = np.stack([gx.ravel(), gy.ravel(), np.zeros(gx.size)], axis=1)
    index = lambda i, j: i * (n + 1) + j  # noqa: E731
    triangles = []
    for i in range(n):
        for j in range(n):
            if keep and not keep((xs[i] + xs[i + 1]) / 2, (xs[j] + xs[j + 1]) / 2):
                continue
            a, b, c, d = index(i, j), index(i + 1, j), index(i + 1, j + 1), index(i, j + 1)
            triangles += [(a, b, c), (a, c, d)]
    return vertices, np.array(triangles, np.uint32)


def view_from(x: float, colour, depth: float, size=(80, 60)) -> "measured.View":
    """A photo of the square from 2 m in front of it (+z), `x` across, all one colour, its depth all `depth`."""
    matrix = np.eye(4)
    matrix[:3, 3] = (x, 0.0, 2.0)
    w, h = size
    image = np.zeros((h, w, 3), np.uint8)
    image[:] = colour
    return measured.View(matrix, np.full((h // 2, w // 2), depth, np.float32), image, 100.0, 100.0, (w - 1) / 2, (h - 1) / 2)


@unittest.skipUnless(cv2, NEEDS)
class Parts(unittest.TestCase):
    GREEN, RED, BLUE = (0, 200, 0), (0, 0, 200), (200, 0, 0)

    def plane(self):
        vertices, triangles = grid_mesh()
        normals = np.tile([0.0, 0.0, 1.0], (len(vertices), 1))
        return vertices, triangles, normals

    def test_a_box_unfolds_into_one_chart_a_side(self):
        # A box 0.4 x 0.3 x 0.2 m, as surface nets make it: edges rounded off by a voxel.
        n, voxel = 40, 0.02
        centres = np.indices((n, n, n)).transpose(1, 2, 3, 0) * voxel + voxel / 2 - 0.4
        half = np.array([0.2, 0.15, 0.1])
        outside = np.abs(centres) - half
        sdf = np.linalg.norm(np.maximum(outside, 0), axis=-1) + np.minimum(outside.max(-1), 0)
        grid = measured.Grid(np.full(3, -0.4), voxel, (n, n, n), np.clip(sdf / (3 * voxel), -1, 1).astype(np.float32),
                             np.ones((n, n, n), np.float32), np.zeros((n, n, n, 3), np.float32), np.ones((n, n, n), np.float32))
        vertices, triangles, _ = measured.surface(grid)
        chart, chart_side = bake.charts(vertices, triangles)
        counts = np.bincount(chart)
        largest = np.argsort(-counts)[:6]
        self.assertEqual(sorted(chart_side[largest]), [0, 1, 2, 3, 4, 5], "one chart for each side")
        self.assertGreater(counts[largest].sum(), 0.95 * len(triangles))

    def test_a_frame_is_cut_so_its_empty_middle_is_not_packed(self):
        # A frame's face, a metre square, its posts and beam 10 cm wide: one stretch on one side.
        vertices, triangles = grid_mesh(1.0, 0.02, keep=lambda x, y: abs(x) > 0.4 or y > 0.4)
        chart, _ = bake.charts(vertices, triangles)
        self.assertGreater(chart.max() + 1, 1, "cut")
        flat = vertices[:, :2]
        a, b, c = (flat[triangles[:, i]] for i in range(3))
        area = 0.5 * np.abs((b - a)[:, 0] * (c - a)[:, 1] - (b - a)[:, 1] * (c - a)[:, 0])
        for k in range(chart.max() + 1):
            on = chart == k
            corners = flat[triangles[on].ravel()]
            extent = corners.max(0) - corners.min(0)
            if extent.max() > bake.MIN_SPLIT_M:
                self.assertGreaterEqual(area[on].sum(), bake.SPARSE * extent.prod() - 1e-9, f"chart {k} fills its rectangle")

    def test_packs_charts_apart_at_one_scale(self):
        rng = np.random.default_rng(3)
        # Small pieces and two large faces, the tall one already on its side (as lay_flat turns them).
        extents = np.concatenate([rng.uniform(0.02, 0.3, (60, 2)), [[1.9, 0.8], [2.3, 0.25]]])
        size = 512
        gap = bake.gap_for(size)
        scale, corners = bake.pack(extents, size)
        boxes = np.concatenate([corners, corners + np.ceil(extents * scale)], axis=1)
        self.assertTrue((boxes[:, :2] >= gap).all() and (boxes[:, 2:] <= size - gap).all(), "inside, with the gap")
        for i in range(len(boxes)):
            for j in range(i + 1, len(boxes)):
                apart = (boxes[i, 2] + gap <= boxes[j, 0] or boxes[j, 2] + gap <= boxes[i, 0]
                         or boxes[i, 3] + gap <= boxes[j, 1] or boxes[j, 3] + gap <= boxes[i, 1])
                self.assertTrue(apart, f"charts {i} and {j} overlap")
        # As large as fits: a little larger does not.
        self.assertIsNone(bake._shelves(extents[np.lexsort((np.arange(len(extents)), -extents[:, 1]))] * scale * 1.01, size, gap))
        self.assertGreater((extents * scale).prod(1).sum() / size**2, 0.5, "half the texture used at least")

    @unittest.skipUnless((HERE.parent.parent / "shared" / "build3d" / "budget.js").is_file(), "needs the repository's shared/")
    def test_bakes_at_the_nearest_level_of_details_texture_size(self):
        import re

        budget = (HERE.parent.parent / "shared" / "build3d" / "budget.js").read_text(encoding="utf-8")
        nearest = re.search(r"LEVELS_OF_DETAIL = Object\.freeze\(\[\s*Object\.freeze\(\{[^}]*texture: (\d+)", budget)
        self.assertEqual(measured.TEXTURE, int(nearest.group(1)), "L-06 cuts any larger texture down to this")

    def test_the_gap_between_charts_follows_the_texture_size(self):
        self.assertEqual([bake.gap_for(s) for s in (2048, 1024, 512, 256)], [8, 4, 2, 2])
        with self.assertRaises(bake.TextureError):
            bake.pack(np.full((500, 2), 0.05), 16)

    def test_a_photo_with_something_in_front_does_not_colour_what_it_hides(self):
        vertices, _, normals = self.plane()
        seen = view_from(0.0, self.GREEN, 2.0)
        # Its depth says something stands a metre in front: a person walking by.
        blocked = view_from(0.3, self.RED, 1.0)
        colour, weight = bake.bake(vertices, normals, [seen, blocked], vertices, measured.VOXEL_M)
        self.assertTrue((weight > 0).all())
        green = measured.linear(np.array([0, 200, 0]) / 255)
        np.testing.assert_allclose(colour, np.tile(green, (len(colour), 1)), atol=1e-3)

    def test_a_part_the_model_hides_from_a_photo_takes_no_colour_from_it(self):
        vertices, _, normals = self.plane()
        # Another part of the model, a metre in front of the left half (the depth missed it).
        xs, ys = np.meshgrid(np.arange(-0.3, 0.0, 0.01), np.arange(-0.3, 0.3, 0.01))
        part = np.stack([xs.ravel(), ys.ravel(), np.full(xs.size, 1.0)], axis=1)
        _, weight = bake.bake(vertices, normals, [view_from(0.0, self.BLUE, 2.0)], np.concatenate([vertices, part]), measured.VOXEL_M)
        left, right = vertices[:, 0] < -0.03, vertices[:, 0] > 0.03
        self.assertTrue((weight[left] == 0).all(), "hidden")
        self.assertTrue((weight[right] > 0).all(), "seen")

    def test_a_texel_no_photo_sees_keeps_the_surface_colour(self):
        vertices, triangles, _ = self.plane()
        own = np.tile([30.0, 60.0, 90.0], (len(vertices), 1))  # BGR
        behind = view_from(0.0, self.GREEN, 2.0)
        behind.matrix[:3, 3] = (0.0, 0.0, -2.0)  # behind the square, looking away: sees nothing of it
        made = bake.texture(vertices, vertices, triangles, own, [behind], measured.VOXEL_M, size=128)
        self.assertEqual(made.report["seenPct"], 0.0)
        middle = made.image[64, 64].astype(float)
        np.testing.assert_allclose(middle, [30, 60, 90], atol=2)

    def test_the_same_frames_give_the_same_texture(self):
        vertices, triangles, _ = self.plane()
        own = np.full((len(vertices), 3), 128.0)
        views = [view_from(x, colour, 2.0) for x, colour in ((-0.2, self.GREEN), (0.2, self.RED))]
        first = bake.texture(vertices, vertices, triangles, own, views, measured.VOXEL_M, size=128)
        again = bake.texture(vertices, vertices, triangles, own, views, measured.VOXEL_M, size=128)
        self.assertTrue(np.array_equal(first.image, again.image))
        self.assertTrue(np.array_equal(first.uvs, again.uvs))
        self.assertTrue(np.array_equal(first.triangles, again.triangles))


if __name__ == "__main__":
    unittest.main()
