"""
Checks on the TRELLIS.2 worker's pins (L-11). No network and no GPU:

    python -m unittest discover -s gpu/trellis2/tests
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

import fetch_weights  # noqa: E402
import lock_requirements  # noqa: E402


class WheelTags(unittest.TestCase):
    def test_takes_wheels_the_image_can_install(self):
        for name in [
            "glcontext-3.1.0-cp311-cp311-manylinux_2_5_x86_64.manylinux1_x86_64.manylinux_2_17_x86_64.manylinux2014_x86_64.whl",
            "tqdm-4.67.1-py3-none-any.whl",
            "tokenizers-0.22.2-cp39-abi3-manylinux_2_17_x86_64.manylinux2014_x86_64.whl",
            "numpy-2.2.6-cp311-cp311-manylinux_2_17_x86_64.manylinux2014_x86_64.whl",
        ]:
            self.assertTrue(lock_requirements.fits(name), name)

    def test_leaves_out_other_systems_and_pythons(self):
        for name in [
            "numpy-2.2.6-cp311-cp311-musllinux_1_2_x86_64.whl",
            "numpy-2.2.6-cp311-cp311-win_amd64.whl",
            "numpy-2.2.6-cp312-cp312-manylinux_2_17_x86_64.manylinux2014_x86_64.whl",
            "numpy-2.2.6-cp311-cp311-manylinux_2_17_aarch64.manylinux2014_aarch64.whl",
            "numpy-2.2.6-cp311-cp311-macosx_14_0_x86_64.whl",
        ]:
            self.assertFalse(lock_requirements.fits(name), name)


def item(name, version, requires=(), requested=False):
    return {"metadata": {"name": name, "version": version, "requires_dist": list(requires)}, "requested": requested}


class LinuxClosure(unittest.TestCase):
    def test_follows_linux_markers_not_the_machine_running_pip(self):
        items = [
            item("tqdm", "4.67.1", ['colorama; platform_system == "Windows"'], requested=True),
            item("colorama", "0.4.6"),
            item("huggingface-hub", "0.36.2", ['hf-xet<2,>=1.1.3; platform_machine == "x86_64"', "tqdm"], requested=True),
            item("hf-xet", "1.7.0"),
        ]
        self.assertEqual(
            lock_requirements.linux_closure(items),
            [("hf-xet", "1.7.0"), ("huggingface-hub", "0.36.2"), ("tqdm", "4.67.1")],
        )

    def test_stops_when_a_linux_only_dependency_was_not_resolved(self):
        items = [item("huggingface-hub", "0.36.2", ['hf-xet; platform_machine == "x86_64"'], requested=True)]
        with self.assertRaises(SystemExit) as e:
            lock_requirements.linux_closure(items)
        self.assertIn("hf-xet", str(e.exception))

    def test_does_not_walk_into_the_base_images_packages(self):
        items = [
            item("timm", "1.0.22", ["torch", "torchvision"], requested=True),
            item("torch", "2.6.0", ['nvidia-cublas-cu12; platform_system == "Linux"', "sympy"], requested=True),
        ]
        self.assertEqual(lock_requirements.linux_closure(items), [("timm", "1.0.22")])


def entry(path, data):
    return {"path": path, "repo": "acme/model", "revision": "a" * 40, "source": path, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}


class Opener:
    """Serves bytes by URL, as urlopen would, and counts the requests."""

    def __init__(self, files):
        self.files = files
        self.calls = 0

    def __call__(self, request):
        self.calls += 1
        return io.BytesIO(self.files[request.full_url])


class FetchWeights(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())

    def test_fetches_and_keeps_files_that_match_the_lock(self):
        e = entry("ckpts/a.safetensors", b"weights")
        opener = Opener({fetch_weights.url_of(e): b"weights"})
        # The locked file, then our config beside it (L-12).
        self.assertEqual(fetch_weights.fetch(self.root, lock=[e], source=fetch_weights.hugging_face(opener)), ["ckpts/a.safetensors", "pipeline.json"])
        self.assertEqual((self.root / "ckpts/a.safetensors").read_bytes(), b"weights")
        # A second run finds it in place and downloads nothing.
        self.assertEqual(fetch_weights.fetch(self.root, lock=[e], source=fetch_weights.hugging_face(opener)), [])
        self.assertEqual(opener.calls, 1)

    def test_throws_away_a_download_that_does_not_match(self):
        e = entry("ckpts/a.safetensors", b"weights")
        for served in (b"tampered", b"weight"):
            with self.subTest(served=served), self.assertRaises(fetch_weights.WeightsError):
                fetch_weights.fetch(self.root, lock=[e], source=fetch_weights.hugging_face(Opener({fetch_weights.url_of(e): served})))
            self.assertFalse((self.root / "ckpts/a.safetensors").exists())
            self.assertFalse((self.root / "ckpts/a.safetensors.part").exists())

    def test_verify_only_checks(self):
        e = entry("ckpts/a.safetensors", b"weights")
        with self.assertRaises(fetch_weights.WeightsError):
            fetch_weights.fetch(self.root, lock=[e], verify_only=True, source=fetch_weights.hugging_face(Opener({})))

    def test_trusts_a_checked_folder_only_while_it_is_untouched(self):
        e = entry("ckpts/a.safetensors", b"weights")
        opener = Opener({fetch_weights.url_of(e): b"weights"})
        fetch_weights.fetch(self.root, lock=[e], source=fetch_weights.hugging_face(opener))
        self.assertTrue((self.root / fetch_weights.MARKER).is_file())
        self.assertEqual(fetch_weights.fetch(self.root, lock=[e], verify_only=True), [])
        # Same size, different bytes: the file's modification time gives it away.
        import os, time
        path = self.root / "ckpts/a.safetensors"
        time.sleep(0.01)
        path.write_bytes(b"WEIGHTS")
        os.utime(path, ns=(time.time_ns(), time.time_ns()))
        with self.assertRaises(fetch_weights.WeightsError):
            fetch_weights.fetch(self.root, lock=[e], verify_only=True)

    def test_a_new_lock_means_a_full_check(self):
        e = entry("ckpts/a.safetensors", b"weights")
        fetch_weights.fetch(self.root, lock=[e], source=fetch_weights.hugging_face(Opener({fetch_weights.url_of(e): b"weights"})))
        moved = {**entry("ckpts/a.safetensors", b"new weights")}
        with self.assertRaises(fetch_weights.WeightsError):
            fetch_weights.fetch(self.root, lock=[moved], verify_only=True)

    def test_refuses_a_file_with_no_locked_hash(self):
        lock = self.root / "weights.lock.json"
        lock.write_text(json.dumps({"files": [{**entry("dinov3/model.safetensors", b"x"), "sha256": None}]}))
        with self.assertRaises(fetch_weights.WeightsError) as e:
            fetch_weights.load_lock(lock)
        self.assertIn("DINOv3", str(e.exception))

    def test_the_lock_pins_every_file_by_revision(self):
        data = json.loads((HERE / "weights.lock.json").read_text(encoding="utf-8"))
        for f in data["files"]:
            self.assertRegex(f["revision"], r"^[0-9a-f]{40}$", f["path"])
            self.assertGreater(f["size"], 0, f["path"])
            if f["sha256"] is not None:
                self.assertRegex(f["sha256"], r"^[0-9a-f]{64}$", f["path"])
        paths = [f["path"] for f in data["files"]]
        self.assertEqual(len(paths), len(set(paths)), "two files in the same place")
        self.assertNotIn("pipeline.json", paths, "our own pipeline.json (L-12) goes there, not Microsoft's")
        self.assertFalse(any("RMBG" in s["repo"] for s in data["sources"]), "RMBG-2.0 is not for commercial use (L-12)")


class DockerfilePins(unittest.TestCase):
    def setUp(self):
        self.text = (HERE / "Dockerfile").read_text(encoding="utf-8")
        self.args = dict(re.findall(r"^ARG (\w+)=(\S+)", self.text, re.M))

    def test_base_image_is_pinned_by_digest(self):
        self.assertRegex(self.args["BASE_DEVEL"], r"@sha256:[0-9a-f]{64}$")

    def test_sources_are_pinned_by_full_commit(self):
        for name in ["TRELLIS2_COMMIT", "CUMESH_COMMIT", "FLEXGEMM_COMMIT", "NVDIFFRAST_COMMIT", "UTILS3D_COMMIT"]:
            self.assertRegex(self.args[name], r"^[0-9a-f]{40}$", name)
        self.assertRegex(self.args["FLASH_ATTN_SHA256"], r"^[0-9a-f]{64}$")
        self.assertRegex(self.args["UBUNTU_SNAPSHOT"], r"^\d{8}T\d{6}Z$")

    def test_installs_only_with_hashes_and_no_fetching(self):
        self.assertIn("--require-hashes --no-deps --only-binary=:all: -r /tmp/requirements.lock", self.text)
        for line in re.findall(r"pip install [^\n]*", self.text):
            self.assertIn("--no-deps", line, line)
        self.assertNotIn("setup.sh", re.sub(r"#.*", "", self.text), "setup.sh clones unpinned")
        self.assertNotIn("nvdiffrec", re.sub(r"#.*", "", self.text))


class LockMatchesItsSource(unittest.TestCase):
    def test_every_version_pinned_in_requirements_in_is_in_the_lock(self):
        source = (HERE / "requirements.in").read_text(encoding="utf-8")
        lock = (HERE / "requirements.lock").read_text(encoding="utf-8")
        locked = dict(re.findall(r"^([a-z0-9-]+)==(\S+) ", lock, re.M))
        for name in re.findall(r"^([A-Za-z0-9_.-]+)", source, re.M):
            self.assertIn(lock_requirements.canonical(name), locked, f"{name}: run lock_requirements.py")
        for name, version in re.findall(r"^([A-Za-z0-9_.-]+)==(\S+)", source, re.M):
            self.assertEqual(locked[lock_requirements.canonical(name)], version, f"{name}: run lock_requirements.py")


if __name__ == "__main__":
    unittest.main()
