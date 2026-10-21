"""
The golden test's own logic (L-14), with Batch and S3 stood in for. The
real run needs a GPU; this checks what it reads, compares and decides.

    python -m unittest discover -s gpu/trellis2/tests
"""
from __future__ import annotations

import contextlib
import io
import unittest.mock
import json
import shutil
import struct
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

import golden  # noqa: E402


def make_glb(triangles=1000, images=1, bounds=((-0.4, -0.5, -0.3), (0.4, 0.5, 0.3)), padding=0):
    """A minimal GLB: one triangle mesh with the given count and bounds."""
    gltf = {
        "asset": {"version": "2.0"},
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1, "material": 0}]}],
        "accessors": [
            {"count": triangles * 3, "type": "VEC3", "componentType": 5126, "min": list(bounds[0]), "max": list(bounds[1])},
            {"count": triangles * 3, "type": "SCALAR", "componentType": 5125},
        ],
        "materials": [{}],
        "images": [{"mimeType": "image/webp"}] * images,
    }
    body = json.dumps(gltf).encode()
    body += b" " * (-len(body) % 4)
    binary = b"\0" * (padding + (-padding % 4))
    chunks = struct.pack("<I4s", len(body), b"JSON") + body + struct.pack("<I4s", len(binary), b"BIN\0") + binary
    return struct.pack("<4sII", b"glTF", 2, 12 + len(chunks)) + chunks


METADATA = {"timings_s": {"generate": 60.0, "extract_glb": 20.0, "total": 140.0}, "settings": {"seed": 42}, "versions": {"trellis2": "75fbf01", "python": ["torch==2.6.0"]}, "gpu": "NVIDIA L40S"}


class GlbStats(unittest.TestCase):
    def test_reads_what_a_glb_holds(self):
        stats = golden.glb_stats(make_glb(triangles=1234))
        self.assertEqual(stats["triangles"], 1234)
        self.assertEqual(stats["vertices"], 3702)
        self.assertEqual((stats["images"], stats["materials"]), (1, 1))
        self.assertEqual(stats["bounds"], {"min": [-0.4, -0.5, -0.3], "max": [0.4, 0.5, 0.3]})

    def test_refuses_something_that_is_not_a_glb(self):
        with self.assertRaises(ValueError):
            golden.glb_stats(b"PK\x03\x04 not a model")


class Compare(unittest.TestCase):
    reference = {"stats": golden.glb_stats(make_glb(triangles=1000, padding=100_000)), "timings_s": {"generate": 60.0}}

    def test_passes_within_tolerance(self):
        stats = golden.glb_stats(make_glb(triangles=1030, padding=105_000))
        self.assertEqual(golden.compare(stats, {**METADATA, "timings_s": {"generate": 80.0}}, self.reference), [])

    def test_fails_on_shape_size_or_speed(self):
        stats = golden.glb_stats(make_glb(triangles=1200, padding=150_000))
        problems = golden.compare(stats, {**METADATA, "timings_s": {"generate": 100.0}}, self.reference)
        self.assertEqual([p.split(":")[0].split(" ")[0] for p in problems], ["triangles", "bytes", "generation"])

    def test_fails_a_model_that_is_untextured_empty_or_out_of_its_cube(self):
        self.assertIn("no textures", " ".join(golden.compare(golden.glb_stats(make_glb(images=0)), METADATA, None)))
        self.assertIn("no triangles", " ".join(golden.compare(golden.glb_stats(make_glb(triangles=0)), METADATA, None)))
        self.assertIn("leaves", " ".join(golden.compare(golden.glb_stats(make_glb(bounds=((-0.6, 0, 0), (0.4, 0.5, 0.3)))), METADATA, None)))
        self.assertIn("too small", " ".join(golden.compare(golden.glb_stats(make_glb(bounds=((-0.1, -0.1, -0.1), (0.1, 0.1, 0.1)))), METADATA, None)))

    def test_lists_what_changed_between_images(self):
        before = {"trellis2": "75fbf01", "python": ["torch==2.6.0", "timm==1.0.22"]}
        after = {"trellis2": "aaaaaaa", "python": ["torch==2.6.0", "timm==1.0.23"]}
        self.assertEqual(golden.version_changes(before, after), ["trellis2: 75fbf01 -> aaaaaaa", "python: -timm==1.0.22", "python: +timm==1.0.23"])


LIVE = {
    "jobDefinitionName": "flexgym-dev-trellis2",
    "revision": 3,
    "parameters": {"params": "{}"},
    "containerProperties": {
        "image": "111111111111.dkr.ecr.ap-southeast-2.amazonaws.com/flexgym/trellis2@sha256:" + "a" * 64,
        "command": ["--input", "Ref::input", "--output", "Ref::output", "--params", "Ref::params"],
        "environment": [{"name": "WEIGHTS_S3", "value": "s3://models-dev/gpu/trellis2/weights/"}],
        "resourceRequirements": [{"type": "GPU", "value": "1"}],
    },
    "timeout": {"attemptDurationSeconds": 3600},
}
CANDIDATE = "111111111111.dkr.ecr.ap-southeast-2.amazonaws.com/flexgym/trellis2@sha256:" + "b" * 64


class StubBatch:
    def __init__(self, outcome="SUCCEEDED"):
        self.outcome = outcome
        self.registered, self.submitted, self.deregistered = [], [], []

    def describe_job_definitions(self, jobDefinitionName, status):  # noqa: N803 (boto3's names)
        return {"jobDefinitions": [{**LIVE, "revision": 2}, LIVE]}

    def register_job_definition(self, **kwargs):
        self.registered.append(kwargs)
        return {"jobDefinitionArn": "arn:aws:batch:ap-southeast-2:1:job-definition/flexgym-dev-trellis2-candidate:1"}

    def submit_job(self, **kwargs):
        self.submitted.append(kwargs)
        return {"jobId": "job-1"}

    def deregister_job_definition(self, jobDefinition):  # noqa: N803
        self.deregistered.append(jobDefinition)


class StubS3:
    def __init__(self):
        self.objects = {}

    def put(self, uri, body, content_type):
        self.objects[uri] = body

    def get(self, uri):
        return self.objects[uri]


class Run(unittest.TestCase):
    def setUp(self):
        # golden.py keeps its reference and downloads in golden/; use a copy.
        self.dir = Path(tempfile.mkdtemp())
        shutil.copy(golden.GOLDEN / "input.png", self.dir / "input.png")
        self.patch = unittest.mock.patch.object(golden, "GOLDEN", self.dir)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def go(self, batch, s3, glb=None, record=False):
        folder = "s3://models-dev/models/accounts/_golden/assets/r1/"

        def finish(b, job_id):
            if b.outcome == "SUCCEEDED":
                s3.put(folder + "out/model.glb", glb or make_glb(), "model/gltf-binary")
                s3.put(folder + "out/metadata.json", json.dumps(METADATA).encode(), "application/json")
            else:
                s3.put(folder + "out/error.json", json.dumps({"kind": "internal", "reason": "CUDA out of memory"}).encode(), "application/json")
            return {"status": b.outcome}

        with contextlib.redirect_stdout(io.StringIO()) as out:
            code = golden.run("dev", CANDIDATE, batch=batch, s3=s3, record=record, run_id="r1", waiter=finish)
        return code, out.getvalue()

    def test_runs_the_candidate_on_the_live_queue_under_a_copy_of_the_live_definition(self):
        batch, s3 = StubBatch(), StubS3()
        self.go(batch, s3, record=True)
        registered = batch.registered[0]
        self.assertEqual(registered["jobDefinitionName"], "flexgym-dev-trellis2-candidate")
        self.assertEqual(registered["containerProperties"]["image"], CANDIDATE)
        self.assertEqual(registered["retryStrategy"], {"attempts": 1})
        self.assertEqual(registered["containerProperties"]["command"], LIVE["containerProperties"]["command"])
        submitted = batch.submitted[0]
        self.assertEqual(submitted["jobQueue"], "flexgym-dev-trellis2")
        self.assertEqual(json.loads(submitted["parameters"]["params"]), {"seed": 42})
        self.assertTrue(submitted["parameters"]["input"].startswith("s3://models-dev/models/accounts/_golden/assets/"))
        self.assertEqual(s3.objects[submitted["parameters"]["input"]], (golden.GOLDEN / "input.png").read_bytes())
        self.assertEqual(batch.deregistered, ["arn:aws:batch:ap-southeast-2:1:job-definition/flexgym-dev-trellis2-candidate:1"])

    def test_first_image_needs_a_person_to_look_then_record(self):
        code, out = self.go(StubBatch(), StubS3())
        self.assertEqual(code, 1)
        self.assertIn("no reference yet", out)
        code, out = self.go(StubBatch(), StubS3(), record=True)
        self.assertEqual(code, 0)
        reference = json.loads((self.dir / "reference.json").read_text())
        self.assertEqual(reference["image"], CANDIDATE)
        self.assertEqual(reference["stats"]["triangles"], 1000)

    def test_passes_a_matching_image_and_fails_a_different_one(self):
        self.go(StubBatch(), StubS3(), record=True)
        self.assertEqual(self.go(StubBatch(), StubS3())[0], 0)
        code, out = self.go(StubBatch(), StubS3(), glb=make_glb(triangles=500))
        self.assertEqual(code, 1)
        self.assertIn("triangles", out)

    def test_a_failed_job_fails_with_its_reason_and_still_cleans_up(self):
        batch = StubBatch(outcome="FAILED")
        code, out = self.go(batch, StubS3())
        self.assertEqual(code, 1)
        self.assertIn("CUDA out of memory", out)
        self.assertEqual(len(batch.deregistered), 1)


class Wait(unittest.TestCase):
    def test_waits_until_the_job_finishes_and_gives_up_eventually(self):
        states = iter(["SUBMITTED", "RUNNABLE", "RUNNING", "SUCCEEDED"])

        class B:
            def describe_jobs(self, jobs):
                return {"jobs": [{"status": next(states)}]}

        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(golden.wait(B(), "j", sleep=lambda s: None)["status"], "SUCCEEDED")

        class Stuck:
            def describe_jobs(self, jobs):
                return {"jobs": [{"status": "RUNNABLE"}]}

        ticks = iter(range(0, 10_000, 600))
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(TimeoutError):
            golden.wait(Stuck(), "j", sleep=lambda s: None, clock=lambda: next(ticks))


if __name__ == "__main__":
    unittest.main()
