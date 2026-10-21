"""
The cut-out (L-03) on made-up frames. BiRefNet needs the GPU, so a stand-in
reads the frames instead: machines are painted red (its foreground) and
people green (its people). Everything else is the real code.

Needs the image's numpy and OpenCV (tests/requirements.txt); skipped
without them.
"""
from __future__ import annotations

import json
import math
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

try:
    import cv2
    import numpy as np
    from PIL import Image

    import segment
    from cutout import CutoutError
except ImportError:  # the image's libraries are not installed here
    cv2 = None

NEEDS = "needs numpy and opencv-python-headless (tests/requirements.txt)"
RED, GREEN = (0, 0, 220), (0, 200, 0)  # BGR, as OpenCV draws


class StandIn:
    """Red is foreground, with a soft edge; green boxes are people."""

    def __init__(self):
        self.calls = 0

    def foreground(self, rgb):
        self.calls += 1
        red = (rgb[:, :, 0] > 150) & (rgb[:, :, 1] < 80) & (rgb[:, :, 2] < 80)
        return cv2.GaussianBlur(red.astype(np.float32), (5, 5), 0) * 0.97

    def people(self, rgb):
        green = ((rgb[:, :, 1] > 150) & (rgb[:, :, 0] < 80)).astype(np.uint8)
        count, _labels, stats, _ = cv2.connectedComponentsWithStats(green)
        return [(int(x), int(y), int(x + w), int(y + h)) for x, y, w, h, _a in stats[1:count]]


def opened(path):
    with Image.open(path) as image:
        image.load()
        return image.copy()


def frame(machines=(), people=(), size=(640, 480), seed=0):
    """A grey, textured frame with red machines and green people, each `(x0, y0, x1, y1)`."""
    rng = np.random.default_rng(seed)
    image = np.full((size[1], size[0], 3), 110, np.uint8)
    image += rng.integers(0, 30, image.shape, dtype=np.uint8)
    for x0, y0, x1, y1 in machines:
        cv2.rectangle(image, (x0, y0), (x1, y1), RED, -1)
    for x0, y0, x1, y1 in people:
        cv2.rectangle(image, (x0, y0), (x1, y1), GREEN, -1)
    return image


@unittest.skipUnless(cv2, NEEDS)
class Cutout(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.frames = self.dir / "picked"
        (self.frames / "frames").mkdir(parents=True)

    def picked(self, images, sharpness=None, cameras=None, centre=None):
        """frames.py's output for these images, every one a candidate."""
        entries = []
        for i, image in enumerate(images):
            name = f"frames/{i:06d}.jpg"
            cv2.imwrite(str(self.frames / name), image, [cv2.IMWRITE_JPEG_QUALITY, 95])
            entries.append({"file": name, "index": i, "sharpness": (sharpness or [100] * len(images))[i], "camera": (cameras or [{"uprightTurns": 0}] * len(images))[i]})
        report = {"source": "arkit" if centre else "video", "input": {"orbitCentre": centre} if centre else {}, "frames": entries, "candidates": [e["file"] for e in entries]}
        (self.frames / "frames.json").write_text(json.dumps(report), encoding="utf-8")

    def test_cuts_out_the_machine_in_the_middle_and_not_its_neighbour(self):
        self.picked([frame(machines=[(220, 140, 420, 400), (480, 160, 600, 400)])])
        out = self.dir / "cut"
        summary = segment.make_cutout(self.frames, out, StandIn(), box={"w": 2.0, "d": 0.9, "h": 1.5})
        self.assertEqual(summary["chosen"], "frames/000000.jpg")
        image = opened(out / "cutout.png")
        self.assertEqual(image.mode, "RGBA")
        alpha = np.asarray(image)[:, :, 3]
        # Cropped round the machine (200 x 260) with an 8 % margin: the neighbour, 60 px away, is not in it.
        self.assertLess(image.width, 260)
        self.assertGreater(alpha.mean(), 0.5 * 255)
        corners = [alpha[0, 0], alpha[0, -1], alpha[-1, 0], alpha[-1, -1]]
        self.assertEqual(corners, [0, 0, 0, 0], "transparent round the machine")
        written = json.loads((out / "cutout.json").read_text(encoding="utf-8"))
        self.assertEqual(written["chosen"], "frames/000000.jpg")
        self.assertEqual(written["candidates"][0]["problems"], [])

    def test_keeps_the_parts_of_a_machine_that_a_gap_splits(self):
        # A bench seen through its frame: two pieces 6 px apart.
        self.picked([frame(machines=[(200, 200, 316, 330), (322, 200, 440, 330)])])
        segment.make_cutout(self.frames, self.dir / "cut", StandIn())
        image = opened(self.dir / "cut" / "cutout.png")
        self.assertGreater(image.width, 240, "both halves are in the cut-out")

    def test_chooses_the_frame_that_shows_all_of_the_machine_on_its_own(self):
        too_close = frame(machines=[(0, 60, 640, 470)])  # sharpest, but runs off both sides
        person = frame(machines=[(200, 150, 440, 420)], people=[(250, 100, 360, 470)])
        clean = frame(machines=[(230, 150, 430, 420)])
        cut_off = frame(machines=[(150, 120, 430, 480)])  # touches the bottom
        self.picked([too_close, person, clean, cut_off], sharpness=[400, 300, 200, 250])
        summary = segment.make_cutout(self.frames, self.dir / "cut", StandIn(), box={"w": 2.0, "d": 0.9, "h": 1.5})
        self.assertEqual(summary["chosen"], "frames/000002.jpg")
        problems = {c["file"]: c["problems"] for c in summary["candidates"]}
        self.assertIn("cut off at the left and right", problems["frames/000000.jpg"])
        self.assertTrue(any("person" in p for p in problems["frames/000001.jpg"]))
        self.assertEqual(problems["frames/000003.jpg"], ["touches the bottom edge"])
        scores = {c["file"]: c["score"] for c in summary["candidates"]}
        self.assertEqual(scores["frames/000000.jpg"], 0)
        self.assertGreater(scores["frames/000002.jpg"], scores["frames/000003.jpg"])
        self.assertGreater(scores["frames/000002.jpg"], scores["frames/000001.jpg"])

    def test_fails_with_the_reasons_when_no_frame_will_do(self):
        self.picked([frame(), frame(machines=[(0, 0, 640, 480)]), frame(machines=[(290, 210, 350, 270)])])
        with self.assertRaises(CutoutError) as caught:
            segment.make_cutout(self.frames, self.dir / "cut", StandIn())
        message = str(caught.exception)
        self.assertIn("nothing stands out", message)
        self.assertIn("too close", message)
        self.assertIn("fills only", message)
        written = json.loads((self.dir / "cut" / "cutout.json").read_text(encoding="utf-8"))
        self.assertIsNone(written["chosen"])
        self.assertFalse((self.dir / "cut" / "cutout.png").exists())

    def test_stands_an_arkit_image_upright_before_cutting(self):
        # Stored the way the sensor lies: the machine, tall in life, lies on its side.
        lying = frame(machines=[(140, 180, 500, 300)])
        self.picked([lying], cameras=[{"uprightTurns": 1}])
        segment.make_cutout(self.frames, self.dir / "cut", StandIn())
        image = opened(self.dir / "cut" / "cutout.png")
        self.assertGreater(image.height, image.width)


@unittest.skipUnless(cv2, NEEDS)
class Pieces(unittest.TestCase):
    def test_takes_the_piece_over_the_middle_before_a_bigger_one_aside(self):
        alpha = np.zeros((100, 200), np.float32)
        alpha[40:60, 90:110] = 1  # small, in the middle
        alpha[10:90, 150:195] = 1  # bigger, at the side
        alpha[0:2, 0:2] = 1  # noise
        mask = segment.machine_piece(alpha)
        self.assertTrue(mask[50, 100])
        self.assertFalse(mask[50, 170])
        self.assertFalse(mask[0, 0])

    def test_nothing_solid_is_no_machine(self):
        self.assertIsNone(segment.machine_piece(np.full((50, 50), 0.3, np.float32)))

    def test_shape_fit_against_the_scanned_box(self):
        box = {"w": 2.0, "d": 0.9, "h": 1.5}
        mask = np.zeros((400, 400), bool)
        mask[100:300, 100:300] = True  # square: fine for this machine
        self.assertEqual(segment.shape_fit(mask, box), 1.0)
        wide = np.zeros((400, 400), bool)
        wide[180:240, 20:380] = True  # six times wider than tall: a neighbour came along
        self.assertLess(segment.shape_fit(wide, box), 0.6)
        self.assertEqual(segment.shape_fit(wide, None), 1.0)

    def test_people_over_the_machine(self):
        mask = np.zeros((100, 100), bool)
        mask[20:80, 20:80] = True
        self.assertEqual(segment.overlap([], mask), 0)
        # The space round the machine is 15 px bigger each way (a quarter of 60): 90 x 90.
        self.assertAlmostEqual(segment.overlap([(5, 5, 50, 95)], mask), 45 * 90 / (90 * 90))
        self.assertEqual(segment.overlap([(0, 0, 4, 4)], mask), 0, "a person well away from it")

    def test_finds_no_people_in_an_empty_frame(self):
        hog = cv2.HOGDescriptor()
        hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
        self.assertEqual(segment.find_people(hog, np.full((480, 640, 3), 128, np.uint8)), [])


def camera(position, target):
    p, t = np.array(position, float), np.array(target, float)
    forward = (t - p) / np.linalg.norm(t - p)
    right = np.cross(forward, [0, 1, 0])
    right /= np.linalg.norm(right)
    up = np.cross(right, forward)
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = right, up, -forward, p
    return [float(v) for v in m.reshape(16, order="F")]


@unittest.skipUnless(cv2, NEEDS)
class Footprint(unittest.TestCase):
    def setUp(self):
        self.CAMERA = {"transform": camera((0, 1.4, 3), (0, 0.8, 0)), "intrinsics": [500, 500, 320, 240]}

    def test_the_columns_a_machine_can_fill(self):
        allowed = segment.footprint_columns(self.CAMERA, (0.0, 0.0), {"w": 1.0, "d": 1.0, "h": 1.2}, (640, 480))
        columns = np.nonzero(allowed[0])[0]
        self.assertTrue(np.all(allowed[:, columns.min() : columns.max() + 1] == 1), "whole columns, top to bottom")
        # Every corner of the real machine (1 x 1 m, 1.2 m tall, on the floor at y = 0), turned any way, is inside them.
        m = np.asarray(self.CAMERA["transform"]).reshape(4, 4, order="F")
        inverse = np.linalg.inv(m)
        us = []
        for turn in np.linspace(0, math.pi / 2, 7):
            for cx, cz in [(0.5, 0.5), (0.5, -0.5), (-0.5, 0.5), (-0.5, -0.5)]:
                x, z = cx * math.cos(turn) - cz * math.sin(turn), cx * math.sin(turn) + cz * math.cos(turn)
                for y in (0.0, 1.2):
                    px, _py, pz, _ = inverse @ np.array([x, y, z, 1.0])
                    us.append(500 * px / -pz + 320)
        self.assertGreaterEqual(min(us), columns.min())
        self.assertLessEqual(max(us), columns.max() + 1)
        # And not much more: well under twice the machine's own width in the image.
        self.assertLess(columns.max() - columns.min(), 1.6 * (max(us) - min(us)))

    def test_drops_a_neighbour_joined_to_the_machine_outside_its_columns(self):
        alpha = np.zeros((480, 640), np.float32)
        alpha[150:400, 230:410] = 1  # the machine
        alpha[200:400, 410:600] = 1  # a neighbour pressed against it
        allowed = segment.footprint_columns(self.CAMERA, (0.0, 0.0), {"w": 1.0, "d": 1.0, "h": 1.2}, (640, 480))
        x0, _y0, x1, _y1 = segment.bounds(segment.machine_piece(alpha, allowed))
        self.assertLessEqual(x1, np.nonzero(allowed[0])[0].max() + 1)
        self.assertLess(x1, 500, "most of the neighbour is gone")
        self.assertGreaterEqual(x0, 230)
        x0, _y0, x1, _y1 = segment.bounds(segment.machine_piece(alpha))
        self.assertEqual(x1, 600, "without the footprint, the neighbour stays")

    def test_needs_a_camera_and_a_size(self):
        self.assertIsNone(segment.footprint_columns({"uprightTurns": 0}, (0, 0), {"w": 1, "d": 1, "h": 1}, (640, 480)))
        self.assertIsNone(segment.footprint_columns(self.CAMERA, None, {"w": 1, "d": 1, "h": 1}, (640, 480)))
        self.assertIsNone(segment.footprint_columns(self.CAMERA, (0, 0), None, (640, 480)))


if __name__ == "__main__":
    unittest.main()
