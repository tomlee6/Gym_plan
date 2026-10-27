"""
The image and the weights' S3 copy (L-09). No network, no Docker, no GPU:

    python -m unittest discover -s gpu/trellis2/tests
"""
from __future__ import annotations

import ast
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
import publish_weights  # noqa: E402
import worker  # noqa: E402

INSTRUCTIONS = {"FROM", "ARG", "ENV", "RUN", "COPY", "USER", "WORKDIR", "ENTRYPOINT", "CMD", "LABEL"}


def instructions(text: str) -> list[tuple[str, str]]:
    """The Dockerfile as Docker reads it: comment lines dropped, continued lines joined."""
    out, current = [], ""
    for line in text.splitlines():
        if line.lstrip().startswith("#") or (not line.strip() and not current):
            continue
        current += line[:-1] + " " if line.endswith("\\") else line
        if not line.endswith("\\"):
            keyword, _, rest = current.strip().partition(" ")
            out.append((keyword, rest.strip()))
            current = ""
    if current:
        raise AssertionError(f"The Dockerfile ends inside a continued line: {current[:80]}")
    return out


class Dockerfile(unittest.TestCase):
    def setUp(self):
        self.all = instructions((HERE / "Dockerfile").read_text(encoding="utf-8"))
        stages, stage = {}, None
        for keyword, rest in self.all:
            if keyword == "FROM":
                stage = rest.split(" AS ")[-1]
                stages[stage] = []
            if stage:
                stages[stage].append((keyword, rest))
        self.stages = stages

    def test_every_line_is_an_instruction(self):
        for keyword, rest in self.all:
            self.assertIn(keyword, INSTRUCTIONS, f"{keyword} {rest[:60]}")

    def test_every_env_is_key_value_pairs(self):
        for keyword, rest in self.all:
            if keyword == "ENV":
                for token in rest.split():
                    self.assertRegex(token, r"^[A-Z_][A-Z0-9_]*=\S+$", rest)

    def test_two_stages_from_pinned_images(self):
        self.assertEqual(list(self.stages), ["build", "runtime"])
        args = dict(re.findall(r"^ARG (\w+)=(\S+)", (HERE / "Dockerfile").read_text(encoding="utf-8"), re.M))
        self.assertRegex(args["BASE_RUNTIME"], r"^\$\{BASE_REGISTRY\}/pytorch/pytorch:2\.6\.0-cuda12\.4-cudnn9-runtime@sha256:[0-9a-f]{64}$")
        self.assertRegex(args["BASE_DEVEL"], r"^\$\{BASE_REGISTRY\}/pytorch/pytorch:2\.6\.0-cuda12\.4-cudnn9-devel@sha256:[0-9a-f]{64}$")
        self.assertEqual(args["BASE_REGISTRY"], "docker.io")
        self.assertEqual(self.stages["runtime"][0], ("FROM", "${BASE_RUNTIME} AS runtime"))

    def test_runtime_runs_the_worker_as_its_own_user_offline(self):
        runtime = self.stages["runtime"]
        self.assertIn(("USER", "worker"), runtime)
        self.assertEqual([r for k, r in runtime if k == "ENTRYPOINT"], ['["python", "-u", "/app/worker.py"]'])
        env = " ".join(r for k, r in runtime if k == "ENV")
        for setting in ["HF_HUB_OFFLINE=1", "TRANSFORMERS_OFFLINE=1", "ATTN_BACKEND=flash-attn", "WEIGHTS_DIR=/weights"]:
            self.assertIn(setting, env)
        self.assertNotIn("SPCONV_ALGO", env, "a TRELLIS 1 setting")

    def test_the_image_holds_every_module_the_worker_imports(self):
        copied = " ".join(r for k, r in self.stages["runtime"] if k == "COPY")
        local = {p.stem for p in HERE.glob("*.py")}
        for name in ["worker.py", "trellis_model.py", "cutout.py", "frames.py", "segment.py", "measured.py", "bake.py", "route_test.py", "fetch_weights.py"]:
            self.assertIn(name, copied)
            tree = ast.parse((HERE / name).read_text(encoding="utf-8"))
            imported = {a.name.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
            imported |= {n.module.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module}
            for module in imported & local:
                self.assertIn(f"{module}.py", copied, f"{name} imports {module}")
        for data in ["weights.lock.json", "pipeline.json"]:
            self.assertIn(data, copied)


class FakeBucket:
    """S3 as publish_weights and the worker use it."""

    def __init__(self):
        self.objects = {}
        self.order = []

    def size(self, uri):
        return len(self.objects[uri]) if uri in self.objects else None

    def upload(self, path, uri):
        self.objects[uri] = Path(path).read_bytes()
        self.order.append(uri)

    def put(self, uri, body, content_type):
        self.objects[uri] = body
        self.order.append(uri)

    def open(self, uri):
        return io.BytesIO(self.objects[uri])

    def get(self, uri):
        return self.objects[uri]


class Hub:
    """Hugging Face, serving locked files by URL."""

    def __init__(self, files):
        self.files = files

    def __call__(self, request):
        return io.BytesIO(self.files[request.full_url])


def locked(path, data):
    return {"path": path, "repo": "acme/m", "revision": "a" * 40, "source": path, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}


class PublishWeights(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.entries = [locked("ckpts/a.safetensors", b"weights a"), locked("dinov3/model.safetensors", b"weights b")]
        self.lock = self.dir / "weights.lock.json"
        self.lock.write_text(json.dumps({"files": self.entries}))
        self.config = self.dir / "pipeline.json"
        self.config.write_text('{"name": "Trellis2ImageTo3DPipeline"}')
        self.hub = fetch_weights.hugging_face(Hub({fetch_weights.url_of(e): d for e, d in zip(self.entries, [b"weights a", b"weights b"])}))
        self.bucket = FakeBucket()

    def publish(self):
        return publish_weights.publish(
            "s3://models/gpu/trellis2/weights", self.dir / "work", self.bucket, source=self.hub, lock_path=self.lock, config_path=self.config
        )

    def test_puts_the_locked_weights_in_the_folder_their_lock_names(self):
        prefix = self.publish()
        self.assertEqual(prefix, fetch_weights.s3_folder("s3://models/gpu/trellis2/weights/", self.entries, self.config.read_bytes()))
        self.assertEqual(self.bucket.objects[prefix + "ckpts/a.safetensors"], b"weights a")
        self.assertEqual(self.bucket.objects[prefix + "pipeline.json"], self.config.read_bytes())
        self.assertEqual(self.bucket.order[-1], prefix + "READY", "READY is written last")
        self.assertEqual(json.loads(self.bucket.objects[prefix + "weights.lock.json"]), {"files": self.entries})

    def test_a_second_run_uploads_nothing_new(self):
        self.publish()
        uploads = len(self.bucket.order)
        self.publish()
        self.assertEqual(len(self.bucket.order) - uploads, 2, "only the lock and READY again")

    def test_the_worker_reads_the_same_folder(self):
        prefix = self.publish()
        source = worker.weights_from(self.bucket, prefix)
        fetched = fetch_weights.fetch(self.dir / "gpu-host", lock=self.entries, source=source, config=self.config)
        self.assertEqual(sorted(fetched), ["ckpts/a.safetensors", "dinov3/model.safetensors", "pipeline.json"])

    def test_a_bad_upload_is_caught(self):
        class Truncating(FakeBucket):
            def upload(self, path, uri):
                super().upload(path, uri)
                self.objects[uri] = self.objects[uri][:-1]

        self.bucket = Truncating()
        with self.assertRaises(fetch_weights.WeightsError):
            self.publish()


class S3Calls(unittest.TestCase):
    def test_size_and_upload_through_boto3(self):
        class NotFound(Exception):
            response = {"Error": {"Code": "404"}}

        class Client:
            uploaded = []

            def head_object(self, Bucket, Key):  # noqa: N803 (boto3's names)
                if Key == "missing":
                    raise NotFound()
                return {"ContentLength": 42}

            def upload_file(self, path, bucket, key):
                self.uploaded.append((path, bucket, key))

        s3 = worker.S3(Client(), client_error=NotFound)
        self.assertEqual(s3.size("s3://b/there"), 42)
        self.assertIsNone(s3.size("s3://b/missing"))
        s3.upload(Path("/data/w/a.safetensors"), "s3://b/x/a.safetensors")
        self.assertEqual(Client.uploaded, [(str(Path("/data/w/a.safetensors")), "b", "x/a.safetensors")])


if __name__ == "__main__":
    unittest.main()
