"""
Measured reconstruction (L-04) on the made-up ARKit walk (sample_arkit.py):
a treadmill 0.8 x 1.9 x 1.45 m turned 30 degrees, a bench beside it, a wall
behind, the floor, and the sensor's noise. It must come back as the
treadmill alone, at its size, standing on y = 0, in its colours.

Needs the image's numpy, OpenCV and SciPy (tests/requirements.txt);
skipped without them.
"""
from __future__ import annotations

import json
import math
import shutil
import struct
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

try:
    import cv2
    import numpy as np
    import scipy  # noqa: F401

    import measured
    import sample_arkit
except ImportError:  # the image's libraries are not installed here
    cv2 = None

import golden  # noqa: E402

NEEDS = "needs numpy, opencv-python-headless and scipy (tests/requirements.txt)"
SMALL = {"image_size": (160, 120), "depth_size": (128, 96)}


def quarter_off(degrees: float) -> float:
    """How far an angle is from a whole number of quarter turns."""
    off = degrees % 90
    return min(off, 90 - off)


def mesh_of(glb: bytes):
    """
    The GLB measured.py writes: its JSON, the positions, and each vertex's
    RGB (0-1, linear), from the texture where it has one (N-04), else its
    vertex colours.
    """
    length = struct.unpack_from("<I", glb, 12)[0]
    gltf = json.loads(glb[20 : 20 + length])
    binary = glb[20 + length + 8 :]
    views = gltf["bufferViews"]
    view = lambda i: binary[views[i]["byteOffset"] : views[i]["byteOffset"] + views[i]["byteLength"]]  # noqa: E731
    attributes = gltf["meshes"][0]["primitives"][0]["attributes"]
    data = lambda name: view(gltf["accessors"][attributes[name]]["bufferView"])  # noqa: E731
    positions = np.frombuffer(data("POSITION"), "<f4").reshape(-1, 3)
    if "TEXCOORD_0" in attributes:
        uvs = np.frombuffer(data("TEXCOORD_0"), "<f4").reshape(-1, 2)
        image = cv2.imdecode(np.frombuffer(view(gltf["images"][0]["bufferView"]), np.uint8), cv2.IMREAD_COLOR)
        h, w = image.shape[:2]
        texel = np.clip((uvs * [w, h]).astype(int), 0, [w - 1, h - 1])
        colours = measured.linear(image[texel[:, 1], texel[:, 0], ::-1] / 255)
    else:
        colours = np.frombuffer(data("COLOR_0"), "<u2").reshape(-1, 4)[:, :3] / 65535
    return gltf, positions, colours


@unittest.skipUnless(cv2, NEEDS)
class Walk(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = Path(tempfile.mkdtemp())
        cls.truth = sample_arkit.make_sample(cls.dir / "walk.zip", frames=48, **SMALL)
        cls.report = measured.reconstruct(cls.dir / "walk.zip", cls.dir / "made", box=sample_arkit.SIZE, max_voxels=700_000, texture_size=512)
        cls.glb = (cls.dir / "made" / "model.glb").read_bytes()
        cls.gltf, cls.positions, cls.colours = mesh_of(cls.glb)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, ignore_errors=True)

    def test_finds_the_machine_where_it_stands(self):
        cx, cz = self.report["centre"]
        self.assertAlmostEqual(cx, 1.2, delta=0.05)
        self.assertAlmostEqual(cz, -0.8, delta=0.05)
        self.assertAlmostEqual(self.report["floorY"], 0.0, delta=0.02)
        self.assertEqual(self.report["leftOut"], {"tracking": 1, "noDepth": 0})

    def test_rebuilds_it_at_its_real_size_lined_up_with_its_footprint(self):
        size = self.report["sizeM"]
        # Measured, so not scaled: within a voxel or two of the truth.
        tolerance = 2.5 * self.report["voxelM"]
        across, along = sorted([size["w"], size["d"]])
        self.assertAlmostEqual(across, 0.8, delta=tolerance)
        self.assertAlmostEqual(along, 1.9, delta=tolerance)
        self.assertAlmostEqual(size["h"], 1.45, delta=tolerance)
        # Turned back by the machine's own 30 degrees (give or take quarter turns: a rectangle has four sides).
        self.assertLess(quarter_off(self.report["turnDeg"] + 30), 3)

    def test_keeps_the_machine_alone_standing_on_the_floor(self):
        # The floor and the bench were in the volume; neither is in the model.
        self.assertGreater(self.report["pieces"], 1)
        lo, hi = self.positions.min(0), self.positions.max(0)
        self.assertLess(hi[0] - lo[0], 1.95 + 2 * self.report["voxelM"])
        self.assertLess(hi[2] - lo[2], 1.95 + 2 * self.report["voxelM"])
        self.assertGreaterEqual(lo[1], 0.0)
        self.assertLess(lo[1], 0.06)
        self.assertAlmostEqual((hi[0] + lo[0]) / 2, 0, delta=0.01)
        self.assertAlmostEqual((hi[2] + lo[2]) / 2, 0, delta=0.01)

    def test_colours_it_from_the_photos(self):
        y = self.positions[:, 1]
        console = self.colours[y > 1.3].mean(0)
        deck = self.colours[y < 0.2].mean(0)
        self.assertGreater(console[2], 2 * console[0], "the console is blue")
        self.assertLess(deck.mean(), 0.1, "the deck is black rubber (linear light)")

    def test_writes_a_glb_of_one_mesh_with_its_photo_texture(self):
        stats = golden.glb_stats(self.glb)
        self.assertEqual(stats["triangles"], self.report["triangles"])
        self.assertGreater(stats["triangles"], 2000)
        self.assertEqual(stats["vertices"], self.report["vertices"])
        primitive = self.gltf["meshes"][0]["primitives"][0]
        # Textured, so no vertex colours (glTF would multiply the two).
        self.assertEqual(sorted(primitive["attributes"]), ["NORMAL", "POSITION", "TEXCOORD_0"])
        material = self.gltf["materials"][primitive["material"]]["pbrMetallicRoughness"]
        self.assertEqual(material["baseColorTexture"], {"index": 0})
        self.assertEqual(self.gltf["images"], [{"bufferView": len(self.gltf["bufferViews"]) - 1, "mimeType": "image/jpeg"}])
        self.assertEqual(self.gltf["samplers"][0]["wrapS"], 33071, "clamped, so a chart's edge does not wrap")
        texture = self.report["texture"]
        self.assertEqual(texture["size"], 512)
        self.assertGreater(texture["seenPct"], 85, "most of the surface is coloured from the photos")
        self.assertGreater(texture["charts"], 6)
        written = json.loads((self.dir / "made" / "measured.json").read_text(encoding="utf-8"))
        self.assertEqual(written, self.report)


@unittest.skipUnless(cv2, NEEDS)
class Refusals(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir, True)

    def test_too_few_frames(self):
        sample_arkit.make_sample(self.dir / "short.zip", frames=8, **SMALL)
        with self.assertRaisesRegex(measured.MeasureError, "Only 8 frames have depth"):
            measured.reconstruct(self.dir / "short.zip", self.dir / "out", max_voxels=200_000)

    def test_nothing_in_the_middle(self):
        sample_arkit.make_sample(self.dir / "empty.zip", frames=16, machine=False, neighbour=False, **SMALL)
        with self.assertRaisesRegex(measured.MeasureError, "Nothing solid"):
            measured.reconstruct(self.dir / "empty.zip", self.dir / "out", box=sample_arkit.SIZE, max_voxels=200_000)

    def test_an_upload_not_as_described(self):
        path = self.dir / "bad.zip"
        with zipfile.ZipFile(path, "w") as z:
            z.writestr("frames.json", json.dumps({"format": "other"}))
        with self.assertRaisesRegex(measured.MeasureError, "version 1"):
            measured.reconstruct(path, self.dir / "out")
        sample_arkit.make_sample(self.dir / "folder", frames=14, **SMALL)
        eight_bit = cv2.imencode(".png", np.zeros((96, 128), np.uint8))[1].tobytes()
        (self.dir / "folder" / "depth" / "000003.png").write_bytes(eight_bit)
        with self.assertRaisesRegex(measured.MeasureError, "16-bit depth map"):
            measured.reconstruct(self.dir / "folder", self.dir / "out", max_voxels=200_000)


@unittest.skipUnless(cv2, NEEDS)
class Parts(unittest.TestCase):
    def test_surface_nets_close_round_a_solid_facing_out(self):
        # A ball 0.3 m across, as a signed distance, seen everywhere.
        n, voxel = 40, 0.02
        idx = np.indices((n, n, n)).transpose(1, 2, 3, 0) * voxel + voxel / 2
        centre = np.array([0.4, 0.4, 0.4])
        sdf = np.linalg.norm(idx - centre, axis=-1) - 0.15
        grid = measured.Grid(
            origin=np.zeros(3), voxel=voxel, shape=(n, n, n),
            tsdf=np.clip(sdf / (3 * voxel), -1, 1).astype(np.float32), weight=np.ones((n, n, n), np.float32),
            colour=np.full((n, n, n, 3), 128, np.float32), cweight=np.ones((n, n, n), np.float32),
        )
        vertices, triangles, _ = measured.surface(grid)
        radius = np.linalg.norm(vertices - centre, axis=1)
        self.assertLess(np.abs(radius - 0.15).max(), voxel)
        a, b, c = (vertices[triangles[:, i]] for i in range(3))
        outward = np.einsum("ij,ij->i", np.cross(b - a, c - a), (a + b + c) / 3 - centre)
        self.assertTrue((outward > 0).all(), "every face looks out of the ball")
        # Closed: every edge is shared by exactly two triangles.
        edges = np.sort(np.concatenate([triangles[:, [0, 1]], triangles[:, [1, 2]], triangles[:, [2, 0]]]), axis=1)
        _, counts = np.unique(edges, axis=0, return_counts=True)
        self.assertTrue((counts == 2).all())

    def test_lines_a_turned_rectangle_up_with_the_axes(self):
        rng = np.random.default_rng(1)
        local = np.stack([rng.uniform(-0.4, 0.4, 500), rng.uniform(0, 1, 500), rng.uniform(-0.95, 0.95, 500)], axis=1)
        a = math.radians(30)
        world = local.copy()
        world[:, 0] = math.cos(a) * local[:, 0] + math.sin(a) * local[:, 2] + 3
        world[:, 2] = -math.sin(a) * local[:, 0] + math.cos(a) * local[:, 2] - 2
        world[:, 1] += 0.5
        placed, turn = measured.line_up(world, floor=0.5)
        size = placed.max(0) - placed.min(0)
        self.assertEqual(sorted(np.round([size[0], size[2]], 1)), [0.8, 1.9])
        self.assertAlmostEqual(placed[:, 1].min(), 0, delta=0.01)
        self.assertLess(quarter_off(turn + 30), 0.5)

    def test_voxels_stay_small_for_a_large_machine(self):
        # A 2.6 m cable crossover's volume (3.5 x 3.5 x 2.9 m) still gets 1.5 cm voxels.
        self.assertEqual(measured.voxel_size([3.55, 2.93, 3.55]), measured.VOXEL_M)
        # Only past the cap do they grow.
        self.assertGreater(measured.voxel_size([8, 4, 8]), measured.VOXEL_M)
        self.assertEqual(measured.voxel_size([2.7, 1.9, 2.7], max_voxels=200_000) > measured.VOXEL_M, True)

    def test_photo_colours_become_linear_light(self):
        self.assertAlmostEqual(float(measured.linear(np.array(0.5))), 0.214, places=3)
        self.assertEqual(float(measured.linear(np.array(0.0))), 0.0)
        self.assertAlmostEqual(float(measured.linear(np.array(1.0))), 1.0)


if __name__ == "__main__":
    unittest.main()
