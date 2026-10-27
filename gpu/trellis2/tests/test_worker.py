"""
The AWS Batch entrypoint (L-13), with S3 and the model stood in for. No
network and no GPU:

    python -m unittest discover -s gpu/trellis2/tests
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

import golden  # noqa: E402
import worker  # noqa: E402
from trellis_model import settings  # noqa: E402

WEIGHTS = "s3://models/gpu/trellis2/weights/"


class FakeS3:
    def __init__(self, objects=None):
        self.objects = dict(objects or {})
        self.types = {}

    def get(self, uri):
        return self.open(uri).read()

    def open(self, uri):
        if uri not in self.objects:
            raise FileNotFoundError(uri)
        return io.BytesIO(self.objects[uri])

    def put(self, uri, body, content_type):
        self.objects[uri] = body
        self.types[uri] = content_type


class FakeModel:
    loads = 0

    def __init__(self, weights):
        FakeModel.loads += 1
        self.weights = weights
        self.gpu = "NVIDIA A10G"
        self.calls = []

    def generate(self, image, s):
        self.calls.append(s)
        return b"glTF fake model", {"generate": 1.5, "extract_glb": 0.5}


class BrokenModel(FakeModel):
    def generate(self, image, s):
        raise RuntimeError("CUDA out of memory")


def png(image):
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def cutout():
    image = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
    image.paste((40, 40, 40, 255), (50, 50, 150, 150))
    return png(image)


class Worker(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        weight = b"tiny weights"
        lock = {"files": [{"path": "ckpts/a.safetensors", "repo": "acme/m", "revision": "a" * 40, "source": "ckpts/a.safetensors", "size": len(weight), "sha256": hashlib.sha256(weight).hexdigest()}]}
        self.lock = self.dir / "weights.lock.json"
        self.lock.write_text(json.dumps(lock))
        self.config = self.dir / "pipeline.json"
        self.config.write_text('{"name": "Trellis2ImageTo3DPipeline"}')
        self.versions = self.dir / "versions.json"
        self.versions.write_text(json.dumps({"trellis2": "75fbf01"}))
        # Our S3 copy of the weights sits in the folder the lock's digest names.
        import fetch_weights
        self.folder = fetch_weights.s3_folder(WEIGHTS, lock["files"], self.config.read_bytes())
        self.s3 = FakeS3({"s3://in/cutout.png": cutout(), self.folder + "ckpts/a.safetensors": weight})

    def job(self, model=FakeModel, **args):
        a = argparse.Namespace(input="s3://in/cutout.png", output="s3://out/m1", params="{}")
        for k, v in args.items():
            setattr(a, k, v)
        # The job's own log lines are not wanted in the test output.
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return worker.run(
                a,
                s3=self.s3,
                load_model=model,
                weights_dir=self.dir / "weights",
                weights_s3=WEIGHTS,
                lock_path=self.lock,
                config_path=self.config,
                versions_path=self.versions,
            )

    def test_makes_a_model_and_says_what_made_it(self):
        self.assertEqual(self.job(params='{"seed": 7}'), worker.DONE)
        self.assertEqual(self.s3.objects["s3://out/m1/model.glb"], b"glTF fake model")
        self.assertEqual(self.s3.types["s3://out/m1/model.glb"], "model/gltf-binary")
        meta = json.loads(self.s3.objects["s3://out/m1/metadata.json"])
        self.assertEqual(meta["model"], "microsoft/TRELLIS.2-4B")
        self.assertEqual(meta["settings"]["seed"], 7)
        self.assertEqual(meta["input"]["sha256"], hashlib.sha256(self.s3.objects["s3://in/cutout.png"]).hexdigest())
        self.assertEqual(meta["glb"], {"bytes": 15, "sha256": hashlib.sha256(b"glTF fake model").hexdigest()})
        self.assertEqual(meta["versions"], {"trellis2": "75fbf01"})
        self.assertEqual(meta["gpu"], "NVIDIA A10G")
        self.assertRegex(meta["weights"], r"^[0-9a-f]{64}$")
        self.assertEqual(meta["timings_s"]["weights_fetched"], 2, "the weight and our pipeline.json")
        # The weights were copied from our S3 copy and checked, with our config beside them.
        self.assertEqual((self.dir / "weights/ckpts/a.safetensors").read_bytes(), b"tiny weights")
        self.assertEqual((self.dir / "weights/pipeline.json").read_bytes(), self.config.read_bytes())
        self.assertNotIn("s3://out/m1/error.json", self.s3.objects)

    def test_a_second_job_on_the_same_host_fetches_nothing(self):
        self.job()
        self.job(output="s3://out/m2/")
        self.assertEqual(json.loads(self.s3.objects["s3://out/m2/metadata.json"])["timings_s"]["weights_fetched"], 0)

    def test_refuses_input_it_cannot_use_without_loading_the_model(self):
        rgb = png(Image.new("RGB", (64, 64)))
        cases = [
            ({"input": "s3://in/missing.png"}, "No cut-out"),
            ({"input": "s3://in/photo.png"}, "not a cut-out"),
            ({"input": "s3://in/junk.png"}, "not an image"),
            ({"params": "{seed: 1"}, "not JSON"),
            ({"params": "[1]"}, "JSON object"),
            ({"output": "out/m1"}, "Not an S3 location"),
        ]
        self.s3.objects.update({"s3://in/photo.png": rgb, "s3://in/junk.png": b"not a png"})
        before = FakeModel.loads
        for args, words in cases:
            with self.subTest(args=args):
                self.assertEqual(self.job(**args), worker.BAD_INPUT)
                out = args.get("output", "s3://out/m1")
                if out.startswith("s3://"):
                    error = json.loads(self.s3.objects[out.rstrip("/") + "/error.json"])
                    self.assertEqual(error["kind"], "input")
                    self.assertIn(words, error["reason"])
        self.assertEqual(FakeModel.loads, before)

    def test_a_failure_in_the_model_may_be_retried_and_says_why(self):
        self.assertEqual(self.job(model=BrokenModel), worker.FAILED)
        error = json.loads(self.s3.objects["s3://out/m1/error.json"])
        self.assertEqual(error["kind"], "internal")
        self.assertIn("CUDA out of memory", error["reason"])
        self.assertNotIn("s3://out/m1/model.glb", self.s3.objects)

    def test_will_not_run_on_weights_that_do_not_match_the_lock(self):
        self.s3.objects[self.folder + "ckpts/a.safetensors"] = b"other weights"
        self.assertEqual(self.job(), worker.FAILED)
        self.assertIn("the lock says", json.loads(self.s3.objects["s3://out/m1/error.json"])["reason"])

    def test_needs_no_gpu_libraries_to_run_the_job_around_the_model(self):
        self.job()
        self.assertNotIn("torch", sys.modules)
        self.assertNotIn("trellis2", sys.modules)


try:
    import cv2
    import numpy as np
except ImportError:  # the image's libraries are not installed here
    cv2 = None

VIDEO = "s3://captures/accounts/a1/captures/c1/equipment/EQ-001/v1/360.mov"


def walk_video(path, seconds=6, machine=True):
    """A 6 s walk past a textured wall, with a red machine kept in the middle of the frame."""
    rng = np.random.default_rng(3)
    wall = cv2.resize(rng.integers(0, 255, (45, 300, 3), dtype=np.uint8), (2400, 360), interpolation=cv2.INTER_CUBIC)
    out = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), 30, (640, 360))
    for i in range(seconds * 30):
        image = wall[:, np.arange(5 * i, 5 * i + 640) % 2400].copy()
        if machine:
            cv2.rectangle(image, (250, 80), (390, 320), (0, 0, 220), -1)
        out.write(image)
    out.release()


class StandIn:
    """BiRefNet's part, for the test: red is the foreground; nobody is about."""

    def foreground(self, rgb):
        red = (rgb[:, :, 0] > 150) & (rgb[:, :, 1] < 80) & (rgb[:, :, 2] < 80)
        return cv2.GaussianBlur(red.astype(np.float32), (5, 5), 0)

    def people(self, rgb):
        return []


class VideoS3(FakeS3):
    """FakeS3 with the two calls a video job adds."""

    def size(self, uri):
        return len(self.objects[uri]) if uri in self.objects else None

    def download(self, uri, path):
        Path(path).write_bytes(self.objects[uri])


@unittest.skipUnless(cv2, "needs numpy and opencv-python-headless (tests/requirements.txt)")
class FromVideo(unittest.TestCase):
    """A machine's 360 video in: frames, cut-out, model (L-05)."""

    def setUp(self):
        Worker.setUp(self)  # the same weights, lock and config; not Worker's tests
        self.s3 = VideoS3(self.s3.objects)
        walk_video(self.dir / "walk.mov")
        self.s3.objects[VIDEO] = (self.dir / "walk.mov").read_bytes()
        self.seen = []

    def video_job(self, machine=None, model=FakeModel, **args):
        params = {"seed": 3, "machine": machine if machine is not None else {"box": {"w": 1.0, "d": 0.6, "h": 1.2}}}
        a = argparse.Namespace(input=VIDEO, output="s3://models/m1/try-1/", params=json.dumps(params))
        for k, v in args.items():
            setattr(a, k, v)

        class Seeing(model):
            def generate(inner, image, s):  # noqa: N805
                self.seen.append(image)
                return super().generate(image, s)

        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return worker.run(
                a,
                s3=self.s3,
                load_model=Seeing,
                weights_dir=self.dir / "weights",
                weights_s3=WEIGHTS,
                lock_path=self.lock,
                config_path=self.config,
                versions_path=self.versions,
                make_segmenter=lambda m: StandIn(),
            )

    def test_models_the_machine_cut_out_of_its_video(self):
        self.assertEqual(self.video_job(), worker.DONE)
        out = "s3://models/m1/try-1/"
        self.assertEqual(self.s3.objects[out + "model.glb"], b"glTF fake model")
        [image] = self.seen
        self.assertEqual(image.mode, "RGBA", "TRELLIS.2 was given the cut-out")
        meta = json.loads(self.s3.objects[out + "metadata.json"])
        self.assertEqual(meta["input"]["uri"], VIDEO)
        self.assertEqual(meta["input"]["sha256"], hashlib.sha256(self.s3.objects[VIDEO]).hexdigest())
        self.assertEqual(meta["input"]["box"], {"w": 1.0, "d": 0.6, "h": 1.2})
        self.assertEqual(meta["input"]["picked"]["source"], "video")
        self.assertEqual(meta["input"]["cutout"]["frame"], json.loads(self.s3.objects[out + "cutout.json"])["chosen"])
        self.assertEqual(meta["settings"]["seed"], 3)
        for key in ("download", "frames", "weights", "load", "cutout", "generate", "total"):
            self.assertIn(key, meta["timings_s"])
        self.assertEqual(self.s3.types[out + "cutout.png"], "image/png")
        self.assertIn(out + "frames.json", self.s3.objects)
        self.assertNotIn(out + "error.json", self.s3.objects)

    def test_refuses_a_walk_it_cannot_use_before_loading_the_model(self):
        before = FakeModel.loads
        self.s3.objects["s3://captures/short.mov"] = b"not a video at all"
        cases = [
            ({"machine": {"box": {"w": 1}}}, "w, d and h"),
            ({"machine": {"box": {"w": 1, "d": 1, "h": 99}}}, "at most 30 m"),
            ({"machine": {"frames": 7}}, "s3:// location"),
            ({"machine": "yes"}, "JSON object"),
            ({"input": "s3://captures/none.mov"}, "No 360 video"),
            ({"input": "s3://captures/clip.avi"}, ".mov or .mp4"),
            ({"input": "s3://captures/short.mov"}, "cannot be read"),
            ({"machine": {"frames": "s3://captures/missing.zip"}}, "No ARKit frames upload"),
        ]
        for args, words in cases:
            with self.subTest(args=args):
                self.assertEqual(self.video_job(**args), worker.BAD_INPUT)
                error = json.loads(self.s3.objects["s3://models/m1/try-1/error.json"])
                self.assertEqual(error["kind"], "input")
                self.assertIn(words, error["reason"])
        self.assertEqual(FakeModel.loads - before, 0)

    def test_a_cut_out_that_fails_leaves_why_beside_the_error(self):
        walk_video(self.dir / "empty.mov", machine=False)
        self.s3.objects[VIDEO] = (self.dir / "empty.mov").read_bytes()
        self.assertEqual(self.video_job(), worker.BAD_INPUT)
        out = "s3://models/m1/try-1/"
        self.assertIn("No frame shows the whole machine", json.loads(self.s3.objects[out + "error.json"])["reason"])
        self.assertIsNone(json.loads(self.s3.objects[out + "cutout.json"])["chosen"])
        self.assertIn(out + "frames.json", self.s3.objects)
        self.assertNotIn(out + "model.glb", self.s3.objects)


FRAMES = "s3://captures/accounts/a1/captures/c1/equipment/EQ-001/v1/frames.zip"


@unittest.skipUnless(cv2, "needs numpy, opencv-python-headless and scipy (tests/requirements.txt)")
class Measured(unittest.TestCase):
    """Its ARKit frames in: the model rebuilt from their depth, without TRELLIS.2 (L-04)."""

    @classmethod
    def setUpClass(cls):
        import sample_arkit

        cls.sample_dir = Path(tempfile.mkdtemp())
        sample_arkit.make_sample(cls.sample_dir / "frames.zip", frames=40, image_size=(160, 120), depth_size=(128, 96))
        cls.frames = (cls.sample_dir / "frames.zip").read_bytes()

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.sample_dir, ignore_errors=True)

    def setUp(self):
        Worker.setUp(self)
        self.s3 = VideoS3({**self.s3.objects, VIDEO: b"the 360 video, not needed here", FRAMES: self.frames})

    def job(self, machine):
        class NoModel:
            def __init__(self, weights):
                raise AssertionError("the measured route needs no TRELLIS.2")

        a = argparse.Namespace(input=VIDEO, output="s3://models/m1/try-1/", params=json.dumps({"machine": machine}))
        import measured

        # A small photo texture: the test is of the route, not the texture (test_bake.py).
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()), mock.patch.object(measured, "TEXTURE", 256):
            return worker.run(a, s3=self.s3, load_model=NoModel, weights_dir=self.dir / "weights", weights_s3=WEIGHTS,
                              lock_path=self.lock, config_path=self.config, versions_path=self.versions)

    def test_rebuilds_the_machine_from_its_depth(self):
        box = {"w": 0.8, "d": 1.9, "h": 1.45}
        self.assertEqual(self.job({"route": "measured", "frames": FRAMES, "box": box}), worker.DONE)
        out = "s3://models/m1/try-1/"
        glb = self.s3.objects[out + "model.glb"]
        self.assertEqual(glb[:4], b"glTF")
        self.assertEqual(golden.glb_stats(glb)["images"], 1, "with its photo texture (N-04)")
        meta = json.loads(self.s3.objects[out + "metadata.json"])
        self.assertEqual((meta["worker"], meta["route"]), ("measured", "measured"))
        self.assertEqual(meta["measured"]["texture"]["size"], 256)
        self.assertEqual(meta["input"]["frames"], FRAMES)
        self.assertEqual(meta["input"]["sha256"], hashlib.sha256(self.frames).hexdigest())
        self.assertEqual(meta["glb"]["bytes"], len(glb))
        self.assertIn("reconstruct", meta["timings_s"])
        self.assertNotIn("weights", meta["timings_s"], "no weights fetched")
        self.assertEqual(json.loads(self.s3.objects[out + "measured.json"]), meta["measured"])
        self.assertAlmostEqual(meta["measured"]["sizeM"]["h"], 1.45, delta=0.1)
        self.assertFalse((self.dir / "weights").exists())

    def test_refuses_without_frames_or_with_frames_it_cannot_use(self):
        cases = [
            ({"route": "measured"}, "needs the walk-round's ARKit frames"),
            ({"route": "measured", "frames": "s3://captures/none.zip"}, "No ARKit frames upload"),
            ({"route": "drawn", "frames": FRAMES}, "route must be one of"),
        ]
        self.s3.objects["s3://captures/junk.zip"] = b"not a zip"
        for machine, words in cases:
            with self.subTest(machine=machine):
                self.assertEqual(self.job(machine), worker.BAD_INPUT)
                self.assertIn(words, json.loads(self.s3.objects["s3://models/m1/try-1/error.json"])["reason"])
        import sample_arkit

        sample_arkit.make_sample(self.sample_dir / "empty.zip", frames=16, machine=False, neighbour=False, image_size=(160, 120), depth_size=(128, 96))
        self.s3.objects["s3://captures/empty.zip"] = (self.sample_dir / "empty.zip").read_bytes()
        self.assertEqual(self.job({"route": "measured", "frames": "s3://captures/empty.zip", "box": {"w": 0.8, "d": 1.9, "h": 1.45}}), worker.BAD_INPUT)
        self.assertIn("Nothing solid", json.loads(self.s3.objects["s3://models/m1/try-1/error.json"])["reason"])


class StubClient:
    """The two boto3 S3 calls the worker uses."""

    class exceptions:  # noqa: N801 (boto3's own name)
        class NoSuchKey(Exception):
            pass

    def __init__(self):
        self.objects = {("in", "cutout.png"): b"bytes"}
        self.puts = []

    def get_object(self, Bucket, Key):  # noqa: N803 (boto3's names)
        if (Bucket, Key) not in self.objects:
            raise self.exceptions.NoSuchKey()
        return {"Body": io.BytesIO(self.objects[(Bucket, Key)])}

    def put_object(self, Bucket, Key, Body, ContentType):  # noqa: N803
        self.puts.append((Bucket, Key, Body, ContentType))

    def download_file(self, bucket, key, filename):
        Path(filename).write_bytes(self.objects[(bucket, key)])


class S3Wrapper(unittest.TestCase):
    def test_reads_and_writes_through_boto3(self):
        client = StubClient()
        s3 = worker.S3(client, client_error=Exception)
        self.assertEqual(s3.get("s3://in/cutout.png"), b"bytes")
        s3.put("s3://out/m1/model.glb", b"glTF", "model/gltf-binary")
        self.assertEqual(client.puts, [("out", "m1/model.glb", b"glTF", "model/gltf-binary")])

    def test_downloads_a_large_object_to_a_file(self):
        path = Path(tempfile.mkdtemp()) / "video.mov"
        worker.S3(StubClient(), client_error=Exception).download("s3://in/cutout.png", path)
        self.assertEqual(path.read_bytes(), b"bytes")

    def test_a_missing_object_is_not_found(self):
        with self.assertRaises(FileNotFoundError):
            worker.S3(StubClient(), client_error=Exception).get("s3://in/missing.png")


class Settings(unittest.TestCase):
    def test_defaults_are_microsofts(self):
        s = settings({})
        self.assertEqual((s["seed"], s["resolution"], s["pipeline_type"]), (1, "1024", "1024_cascade"))
        self.assertEqual(s["sparse_structure_sampler_params"], {"steps": 12, "guidance_strength": 7.5, "guidance_rescale": 0.7, "rescale_t": 5.0})
        self.assertEqual(s["shape_slat_sampler_params"], {"steps": 12, "guidance_strength": 7.5, "guidance_rescale": 0.5, "rescale_t": 3.0})
        self.assertEqual(s["tex_slat_sampler_params"], {"steps": 12, "guidance_strength": 1.0, "guidance_rescale": 0.0, "rescale_t": 3.0})
        self.assertEqual((s["decimation_target"], s["texture_size"], s["extension_webp"]), (500_000, 2048, True))

    def test_keeps_settings_within_microsofts_bounds(self):
        s = settings({"ss_sampling_steps": 500, "texture_size": 99999, "resolution": "4096", "seed": "x"})
        self.assertEqual(s["sparse_structure_sampler_params"]["steps"], 50)
        self.assertEqual(s["texture_size"], 4096)
        self.assertEqual(s["pipeline_type"], "1024_cascade")
        self.assertEqual(s["seed"], 1)


if __name__ == "__main__":
    unittest.main()
