"""
The route test's tool (L-01): its measures, and one made-up machine run
through the measured route. The generated route needs the GPU; its own
steps are tested in test_frames, test_segment and test_worker.

Needs the image's numpy, OpenCV and SciPy (tests/requirements.txt);
skipped without them.
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

try:
    import cv2  # noqa: F401
    import numpy as np
    import scipy  # noqa: F401

    import route_test
except ImportError:  # the image's libraries are not installed here
    np = None

NEEDS = "needs numpy, opencv-python-headless and scipy (tests/requirements.txt)"


@unittest.skipUnless(np, NEEDS)
class Measures(unittest.TestCase):
    def test_size_off_pairs_width_and_depth_by_size(self):
        # A model turned a quarter has its width and depth the other way round: no error for that.
        self.assertEqual(route_test.size_off({"w": 1.9, "d": 0.8, "h": 1.45}, {"w": 0.8, "d": 1.9, "h": 1.45})["worst"], 0)
        off = route_test.size_off({"w": 0.88, "d": 1.9, "h": 1.16}, {"w": 0.8, "d": 1.9, "h": 1.45})
        self.assertEqual(off, {"across": 10.0, "along": 0.0, "height": 20.0, "worst": 20.0})

    def test_fits_a_model_with_no_size_of_its_own_by_one_factor(self):
        size = route_test.fitted([0.4, 0.725, 0.95], {"w": 0.8, "d": 1.9, "h": 1.45})
        self.assertAlmostEqual(size["w"], 0.8, places=6)
        self.assertAlmostEqual(size["d"], 1.9, places=6)
        self.assertAlmostEqual(size["h"], 1.45, places=6)
        # Proportions off: the fit cannot hide it.
        self.assertGreater(route_test.size_off(route_test.fitted([0.4, 0.4, 0.95], {"w": 0.8, "d": 1.9, "h": 1.45}), {"w": 0.8, "d": 1.9, "h": 1.45})["worst"], 20)

    def test_completeness_and_accuracy(self):
        grid = np.stack(np.meshgrid(np.linspace(0, 1, 51), np.linspace(0, 1, 51)), -1).reshape(-1, 2)
        truth = np.c_[grid[:, 0], np.zeros(len(grid)), grid[:, 1]]
        half = truth[truth[:, 0] <= 0.5] + [0, 0.005, 0]
        scores = route_test.surface_scores(half, truth)
        self.assertAlmostEqual(scores["completenessPct"], 51.0, delta=2)
        self.assertAlmostEqual(scores["accuracyMm90"], 5.0, delta=0.5)


@unittest.skipUnless(np, NEEDS)
class Run(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir, True)

    def test_runs_a_made_up_machine_through_the_measured_route(self):
        machines = route_test.sample_machines(self.dir, frames=36, image_size=(160, 120), depth_size=(128, 96), scenes=["wall"])
        import measured

        # A small photo texture: this is a test of the route test, not of the texture (test_bake.py).
        with mock.patch.object(measured, "TEXTURE", 256):
            report = route_test.run(machines, self.dir, routes=("measured",), max_voxels=400_000)
        result = report["machines"][0]["routes"]["measured"]
        self.assertTrue(result["ok"], result)
        self.assertLess(result["sizeOffPct"]["worst"], 10)
        # Against a wall, its far side is never seen: the model has most of the machine, not all.
        self.assertGreater(result["completenessPct"], 40)
        self.assertLess(result["completenessPct"], 95)
        self.assertTrue((self.dir / result["model"]).is_file())
        self.assertEqual(json.loads((self.dir / "report.json").read_text(encoding="utf-8")), report)
        table = (self.dir / "report.md").read_text(encoding="utf-8")
        self.assertIn("| wall | measured | Yes |", table)
        self.assertIn("Made-up machines", table)


if __name__ == "__main__":
    unittest.main()
