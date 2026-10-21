"""
Checks on the licence-safe model config and the worker's input (L-12). No
network and no GPU:

    python -m unittest discover -s gpu/trellis2/tests
"""
from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

import fetch_weights  # noqa: E402
import pipeline_config  # noqa: E402
from cutout import CutoutError, check_cutout  # noqa: E402


def load(name):
    return json.loads((HERE / name).read_text(encoding="utf-8"))


class PipelineConfig(unittest.TestCase):
    def test_microsofts_config_is_the_locked_one(self):
        lock = {f["path"]: f for f in load("weights.lock.json")["files"]}
        digest = hashlib.sha256((HERE / "upstream-pipeline.json").read_bytes()).hexdigest()
        self.assertEqual(digest, lock["upstream/pipeline.json"]["sha256"])

    def test_ours_is_microsofts_with_only_the_three_changes(self):
        upstream, ours = load("upstream-pipeline.json"), load("pipeline.json")
        self.assertEqual(ours, pipeline_config.ours(upstream), "run pipeline_config.py")
        differences = []

        def walk(a, b, path=()):
            if isinstance(a, dict):
                self.assertEqual(a.keys(), b.keys(), path)
                for k in a:
                    walk(a[k], b[k], path + (k,))
            elif a != b:
                differences.append(path)

        walk(upstream, ours)
        self.assertEqual(sorted(differences), sorted(pipeline_config.CHANGES))

    def test_nothing_is_fetched_by_name_and_rmbg_is_gone(self):
        text = (HERE / "pipeline.json").read_text(encoding="utf-8")
        self.assertNotIn("RMBG", text)
        self.assertNotIn("briaai", text)
        ours = load("pipeline.json")["args"]
        names = list(ours["models"].values()) + [ours["image_cond_model"]["args"]["model_name"], ours["rembg_model"]["args"]["model_name"]]
        for name in names:
            self.assertFalse(name.startswith(("microsoft/", "facebook/", "ZhengPeng7/")), name)

    def test_every_model_it_names_is_in_the_locked_weights_folder(self):
        locked = {f["path"] for f in load("weights.lock.json")["files"]}
        ours = load("pipeline.json")["args"]
        for model in ours["models"].values():
            self.assertIn(f"{model}.json", locked, model)
            self.assertIn(f"{model}.safetensors", locked, model)
        for folder in (ours["image_cond_model"]["args"]["model_name"], ours["rembg_model"]["args"]["model_name"]):
            self.assertIn(f"{folder}/config.json", locked, folder)
            self.assertIn(f"{folder}/model.safetensors", locked, folder)

    def test_a_changed_upstream_config_is_noticed(self):
        upstream = load("upstream-pipeline.json")
        upstream["args"]["rembg_model"]["args"]["model_name"] = "someone/else"
        with self.assertRaises(ValueError):
            pipeline_config.ours(upstream)

    def test_the_weights_folder_gets_our_config(self):
        root = Path(tempfile.mkdtemp())
        self.assertEqual(fetch_weights.fetch(root, lock=[]), ["pipeline.json"])
        self.assertEqual((root / "pipeline.json").read_bytes(), (HERE / "pipeline.json").read_bytes())
        self.assertEqual(fetch_weights.fetch(root, lock=[], verify_only=True), [])
        (root / "pipeline.json").write_text("{}")
        with self.assertRaises(fetch_weights.WeightsError):
            fetch_weights.fetch(root, lock=[], verify_only=True)


def cutout(size=(200, 200), box=(50, 50, 150, 150), background=0):
    image = Image.new("RGBA", size, (120, 120, 120, background))
    image.paste((30, 30, 30, 255), box)
    return image


class Cutout(unittest.TestCase):
    def test_takes_a_cut_out_as_it_is(self):
        image = cutout()
        self.assertIs(check_cutout(image), image)

    def test_refuses_a_photo_with_its_background(self):
        with self.assertRaisesRegex(CutoutError, "not a cut-out"):
            check_cutout(Image.new("RGB", (200, 200)))
        with self.assertRaisesRegex(CutoutError, "nothing is transparent"):
            check_cutout(cutout(background=255))

    def test_refuses_an_empty_or_barely_cut_image(self):
        with self.assertRaisesRegex(CutoutError, "empty"):
            check_cutout(cutout(box=(0, 0, 3, 3)))
        with self.assertRaisesRegex(CutoutError, "background was not removed"):
            check_cutout(cutout(box=(0, 0, 199, 200)))


if __name__ == "__main__":
    unittest.main()
