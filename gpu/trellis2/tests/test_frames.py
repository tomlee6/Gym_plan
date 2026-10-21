"""
Frame picking (L-02) on made-up walks: a video panning round a textured
strip (with a pause, blurred frames and dark frames), and ARKit frames on a
circle round a known point.

Needs the image's numpy and OpenCV (tests/requirements.txt); skipped
without them.

    python -m unittest discover -s gpu/trellis2/tests
"""
from __future__ import annotations

import io
import json
import math
import shutil
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

    import frames
except ImportError:  # the image's libraries are not installed here
    cv2 = None

NEEDS = "needs numpy and opencv-python-headless (tests/requirements.txt)"
FIXTURES = Path(__file__).resolve().parent / "fixtures"


def strip(width=2400, height=360, seed=1):
    """A wide, detailed image to pan across, that joins up at its ends."""
    rng = np.random.default_rng(seed)
    noise = rng.integers(0, 255, (height // 8, width // 8, 3), dtype=np.uint8)
    image = cv2.resize(noise, (width, height), interpolation=cv2.INTER_CUBIC)
    for x in range(0, width, 60):
        cv2.line(image, (x, 0), (x, height), (255, 255, 255), 2)
        cv2.circle(image, (x + 30, height // 2), 18, (0, 0, 0), 3)
    return image


def view(pano, x, width=640):
    cols = np.arange(int(x), int(x) + width) % pano.shape[1]
    return pano[:, cols]


def write_video(path, images, fps=30):
    h, w = images[0].shape[:2]
    out = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    for image in images:
        out.write(image)
    out.release()


@unittest.skipUnless(cv2, NEEDS)
class Video(unittest.TestCase):
    """12 s at 30 fps: a steady pan, a 3 s pause, then a faster pan; some frames blurred, some dark."""

    FPS = 30
    PAUSE = range(120, 210)  # 4 s to 7 s
    DARK = range(240, 252)

    @classmethod
    def setUpClass(cls):
        cls.dir = Path(tempfile.mkdtemp())
        pano = strip()
        x, images, cls.blurred = 0.0, [], set()
        for i in range(12 * cls.FPS):
            if i not in cls.PAUSE:
                x += 4 if i < 120 else 7
            image = view(pano, x)
            if i % 7 == 3:
                image = cv2.GaussianBlur(image, (0, 0), 6)
                cls.blurred.add(i)
            if i in cls.DARK:
                image = (image * 0.05).astype(np.uint8)
            images.append(image)
        cls.video = cls.dir / "walk.mp4"
        write_video(cls.video, images, cls.FPS)
        cls.out = cls.dir / "out"
        cls.report = frames.pick_frames(cls.video, cls.out, steps=48)
        cls.picked = [f["index"] for f in cls.report["frames"]]

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, ignore_errors=True)

    def test_leaves_out_blurred_and_dark_frames(self):
        self.assertFalse(set(self.picked) & self.blurred)
        self.assertFalse(set(self.picked) & set(self.DARK))
        rejected = self.report["rejected"]
        self.assertGreater(rejected["blurry"], 0)
        self.assertGreater(rejected["dark"], 0)

    def test_spreads_the_picks_by_movement_not_time(self):
        # The pause is a quarter of the time; picking by time would put a quarter of the frames in it.
        in_pause = [i for i in self.picked if i in self.PAUSE]
        self.assertLessEqual(len(in_pause), 0.12 * len(self.picked), in_pause)
        self.assertEqual(self.picked, sorted(self.picked))
        places = [f["place"] for f in self.report["frames"]]
        self.assertEqual(places, sorted(places))
        self.assertGreater(self.report["coverage"], 0.8)

    def test_the_only_wide_gap_is_where_the_frames_were_unusable(self):
        places = [f["place"] for f in self.report["frames"]]
        gaps = sorted(((b - a) * 360, i) for i, (a, b) in enumerate(zip(places, places[1:])))
        widest, at = gaps[-1]
        self.assertAlmostEqual(widest, self.report["largestGapDeg"], delta=0.1)
        self.assertLess(self.picked[at], self.DARK.start)
        self.assertGreaterEqual(self.picked[at + 1], self.DARK.stop)
        self.assertLess(gaps[-2][0], 360 * 2.5 / self.report["steps"], "everywhere else, picks a step or two apart")

    def test_writes_the_frames_and_what_was_picked(self):
        self.assertEqual(self.report["source"], "video")
        self.assertEqual(self.report["input"]["width"], 640)
        self.assertEqual(self.report["input"]["framesRead"], 360)
        written = json.loads((self.out / "frames.json").read_text(encoding="utf-8"))
        self.assertEqual(written, self.report)
        for f in self.report["frames"]:
            image = cv2.imread(str(self.out / f["file"]))
            self.assertEqual(image.shape, (360, 640, 3))
            self.assertEqual(f["camera"], {"uprightTurns": 0})

    def test_offers_sharp_candidates_from_all_round_the_orbit(self):
        names = self.report["candidates"]
        self.assertEqual(len(names), frames.CANDIDATES)
        by_name = {f["file"]: f for f in self.report["frames"]}
        arcs = [int(by_name[n]["place"] * frames.CANDIDATES) for n in names]
        self.assertEqual(len(set(arcs)), len(arcs), "one from each arc")
        sharpness = [by_name[n]["sharpness"] for n in names]
        self.assertEqual(sharpness, sorted(sharpness, reverse=True))


@unittest.skipUnless(cv2, NEEDS)
class VideoInput(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir, True)

    def test_reads_an_iphone_style_video_upright(self):
        # HEVC, stored landscape with a 90 degree rotation, as an iPhone held upright records.
        found, _slides, info = frames.scan_video(FIXTURES / "orbit-hevc-rot90.mov")
        self.assertEqual((info["width"], info["height"]), (180, 320))
        self.assertEqual(info["framesRead"], 120)
        self.assertEqual(len(found), 24, "every fifth frame: 6 a second")

    def test_refuses_what_is_not_a_walk_round(self):
        junk = self.dir / "junk.mov"
        junk.write_bytes(b"not a video" * 100)
        with self.assertRaises(frames.FramesError):
            frames.pick_frames(junk, self.dir / "out")

        short = self.dir / "short.mp4"
        write_video(short, [view(strip(), 4 * i) for i in range(60)])
        with self.assertRaisesRegex(frames.FramesError, "walk all the way round"):
            frames.pick_frames(short, self.dir / "out")

        dark = self.dir / "dark.mp4"
        write_video(dark, [(view(strip(), 4 * i) * 0.03).astype(np.uint8) for i in range(150)])
        with self.assertRaisesRegex(frames.FramesError, "usable frames"):
            frames.pick_frames(dark, self.dir / "out")


@unittest.skipUnless(cv2, NEEDS)
class Places(unittest.TestCase):
    def frames_at(self, n):
        return [frames.Frame(index=i, time_s=i / 6) for i in range(n)]

    def test_a_pause_hardly_moves_on(self):
        found = self.frames_at(31)
        slides = [(-5.0, 0.5)] * 10 + [(0.0, 0.5)] * 10 + [(-5.0, 0.5)] * 10
        frames.video_places(found, slides)
        self.assertAlmostEqual(found[0].place, 0)
        self.assertAlmostEqual(found[-1].place, 1)
        paused = found[20].place - found[10].place
        self.assertAlmostEqual(paused, 0.25 * 10 / 30, places=6)

    def test_falls_back_to_time_when_movement_cannot_be_measured(self):
        found = self.frames_at(21)
        frames.video_places(found, [(3.0, 0.01)] * 20)
        self.assertAlmostEqual(found[10].place, 0.5)

    def test_sliding_back_is_not_progress(self):
        found = self.frames_at(5)
        frames.video_places(found, [(-4.0, 0.5), (2.0, 0.5), (-4.0, 0.5), (-4.0, 0.5)])
        self.assertAlmostEqual(found[2].place - found[1].place, 0.25 * 0.25)

    def test_largest_gap(self):
        picked = [frames.Frame(index=i, time_s=0, place=p) for i, p in enumerate([0.0, 0.25, 0.5])]
        self.assertEqual(frames.largest_gap_deg(picked), 180.0)


def camera(position, target, roll=0):
    """ARKit's camera-to-world transform, column by column, for a camera at `position` looking at `target`."""
    p, t = np.array(position, float), np.array(target, float)
    forward = (t - p) / np.linalg.norm(t - p)
    right = np.cross(forward, [0, 1, 0])
    right /= np.linalg.norm(right)
    up = np.cross(right, forward)
    for _ in range(roll % 4):  # quarter turns of the phone about the lens
        right, up = up, -right
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = right, up, -forward, p
    return [float(v) for v in m.reshape(16, order="F")]


@unittest.skipUnless(cv2, NEEDS)
class Arkit(unittest.TestCase):
    CENTRE = (2.0, -3.0)

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir, True)

    def archive(self, entries, images, manifest=None):
        path = self.dir / "frames.zip"
        with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED) as z:
            z.writestr("frames.json", json.dumps(manifest or {"format": "flexgym-arkit-frames", "version": 1, "device": "iPhone15,3", "frames": entries}))
            for name, data in images.items():
                z.writestr(name, data)
        return path

    def walk(self, n=120, limited=()):
        pano = strip(seed=2)
        entries, images = [], {}
        for i in range(n):
            # Uneven pace: slow at first, fast at the end; one full turn.
            a = 2 * math.pi * (i / n) ** 1.6
            position = (self.CENTRE[0] + 1.5 * math.cos(a), 1.4, self.CENTRE[1] + 1.5 * math.sin(a))
            name = f"images/{i:06d}.jpg"
            ok, data = cv2.imencode(".jpg", view(pano, 2400 * i / n), [cv2.IMWRITE_JPEG_QUALITY, 90])
            images[name] = data.tobytes()
            entries.append({
                "image": name,
                "timeS": i / 5,
                "transform": camera(position, (self.CENTRE[0], 0.8, self.CENTRE[1])),
                "intrinsics": [500.0, 500.0, 320.0, 180.0],
                "tracking": "limited" if i in limited else "normal",
                "depth": f"depth/{i:06d}.png",
                "confidence": None,
            })
        return entries, images

    def test_places_frames_by_bearing_round_the_machine(self):
        entries, images = self.walk(limited={5, 6, 7, 60})
        report = frames.pick_frames(None, self.dir / "out", arkit=self.archive(entries, images), steps=24)
        self.assertEqual(report["source"], "arkit")
        cx, cz = report["input"]["orbitCentre"]
        self.assertAlmostEqual(cx, self.CENTRE[0], delta=0.05)
        self.assertAlmostEqual(cz, self.CENTRE[1], delta=0.05)
        # Evenly round the circle, although the walk bunched at the start.
        self.assertLess(report["largestGapDeg"], 2.5 * 360 / 24)
        self.assertGreaterEqual(report["coverage"], 0.95)
        picked = [f["index"] for f in report["frames"]]
        self.assertFalse({5, 6, 7, 60} & set(picked))
        self.assertEqual(report["rejected"]["tracking"], 4)
        early = [i for i in picked if i < 60]
        self.assertLess(len(early), 0.5 * len(picked), "the slow start does not take the most picks")

    def test_copies_the_images_and_keeps_each_camera(self):
        entries, images = self.walk(n=40)
        out = self.dir / "out"
        report = frames.pick_frames(None, out, arkit=self.archive(entries, images), steps=12)
        f = report["frames"][0]
        self.assertEqual((out / f["file"]).read_bytes(), images[entries[f["index"]]["image"]])
        self.assertEqual(f["camera"]["transform"], entries[f["index"]]["transform"])
        self.assertEqual(f["camera"]["intrinsics"], [500.0, 500.0, 320.0, 180.0])
        self.assertEqual(f["camera"]["depth"], f"depth/{f['index']:06d}.png")
        self.assertEqual(f["camera"]["uprightTurns"], 0)

    def test_works_out_how_to_stand_the_image_upright(self):
        # roll 1: the image's right is the world's up, so three quarter turns clockwise
        # (one anticlockwise) bring it to the top; roll 3: its left is up, one turn.
        for roll, turns in [(0, 0), (1, 3), (2, 2), (3, 1)]:
            m = frames.camera_matrix(camera((0, 1.4, 2), (0, 0.8, 0), roll=roll))
            self.assertEqual(frames.upright_turns(m), turns, f"roll {roll}")
        # Checked on pixels: an arrow pointing at the image's right, turned three times, points up.
        arrow = np.zeros((9, 9), np.uint8)
        arrow[4, 8] = 255
        for _ in range(3):
            arrow = cv2.rotate(arrow, cv2.ROTATE_90_CLOCKWISE)
        self.assertEqual(tuple(np.argwhere(arrow)[0]), (0, 4))

    def test_refuses_an_upload_that_is_not_as_described(self):
        entries, images = self.walk(n=8)
        with self.assertRaisesRegex(frames.FramesError, "version 1"):
            frames.pick_frames(None, self.dir / "o", arkit=self.archive(entries, images, manifest={"format": "other"}))
        bad = [dict(entries[0], image="../../etc/passwd")] + entries[1:]
        with self.assertRaisesRegex(frames.FramesError, "outside the upload"):
            frames.pick_frames(None, self.dir / "o", arkit=self.archive(bad, images))
        missing = [dict(entries[0], image="images/nope.jpg")] + entries[1:]
        with self.assertRaisesRegex(frames.FramesError, "no images/nope.jpg"):
            frames.pick_frames(None, self.dir / "o", arkit=self.archive(missing, images))
        broken = [dict(entries[0], transform=[1, 2, 3])] + entries[1:]
        with self.assertRaisesRegex(frames.FramesError, "16 numbers"):
            frames.pick_frames(None, self.dir / "o", arkit=self.archive(broken, images))
        not_image = dict(images, **{entries[0]["image"]: b"text"})
        with self.assertRaisesRegex(frames.FramesError, "not an image"):
            frames.pick_frames(None, self.dir / "o", arkit=self.archive(entries, not_image))

    def test_reads_an_unpacked_folder_too(self):
        entries, images = self.walk(n=20)
        folder = self.dir / "unpacked"
        with zipfile.ZipFile(self.archive(entries, images)) as z:
            z.extractall(folder)
        report = frames.pick_frames(None, self.dir / "out", arkit=folder, steps=6)
        self.assertEqual(len(report["frames"]), 6)


if __name__ == "__main__":
    unittest.main()
