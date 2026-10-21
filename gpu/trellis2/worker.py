"""
The machine model job on AWS Batch (tasks L-13, L-05, L-04): a machine's
textured model (GLB) and what made it, written back to S3. Three kinds of
input:

- A machine's 360 video (the backend's builds, L-05), when --params holds
  `machine`: frames are picked from it (frames.py, L-02), the machine is cut
  out of the best of them (segment.py, L-03), and the cut-out is modelled.
- Its ARKit frames, when `machine.route` is `measured` (L-04): the model is
  rebuilt from the measured depth (measured.py), with no TRELLIS.2 at all.

    python worker.py --input s3://captures/.../360.mov --output s3://models/.../try-1/ \\
        --params '{"seed": 1, "machine": {"box": {"w": 2.0, "d": 0.9, "h": 1.5}, "frames": "s3://captures/.../frames.zip"}}'

    python worker.py --input s3://captures/.../360.mov --output s3://models/.../try-1/ \\
        --params '{"machine": {"route": "measured", "box": {"w": 0.8, "d": 1.9, "h": 1.45}, "frames": "s3://captures/.../frames.zip"}}'

- A cut-out photo, modelled as it is (the golden test, L-14).

    python worker.py --input s3://bucket/.../cutout.png --output s3://bucket/.../out/ [--params '{"seed": 7}']

Replaces the Digital Twin's RunPod handler, which took the image as base64
in the request and returned the GLB as base64 in the response (and so ran
into the response size limit). The model-facing code is unchanged
(trellis_model.py).

Environment:
    WEIGHTS_DIR  local folder for the weights (default /weights: a host volume,
                 so a GPU host keeps them between jobs)
    WEIGHTS_S3   s3://bucket/prefix/ under which publish_weights.py put our copy
                 of the weights, in a folder named by the lock's digest (L-09)

Writes under --output either `model.glb` and `metadata.json`, or `error.json`;
from a video, also `frames.json`, `cutout.json` and `cutout.png`, as far as
it got; from ARKit frames, `measured.json`. Exits 0 when done; 2 when the input cannot be used, which a retry
will not fix; 1 for anything else, which may be retried.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import os
import sys
import tempfile
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent

DONE, FAILED, BAD_INPUT = 0, 1, 2


class InputError(Exception):
    """The job's input cannot be used: retrying will not help."""


def split(uri: str) -> tuple[str, str]:
    if not uri.startswith("s3://") or "/" not in uri[5:]:
        raise InputError(f"Not an S3 location: {uri!r}")
    bucket, key = uri[5:].split("/", 1)
    return bucket, key


class S3:
    """The few S3 calls the worker makes, through boto3."""

    def __init__(self, client=None, client_error=None):
        if client is None:
            import boto3  # noqa: PLC0415

            client = boto3.client("s3")
        if client_error is None:
            from botocore.exceptions import ClientError as client_error  # noqa: PLC0415, N813
        self.client = client
        self.client_error = client_error

    def get(self, uri: str) -> bytes:
        with contextlib.closing(self.open(uri)) as body:
            return body.read()

    def open(self, uri: str):
        bucket, key = split(uri)
        try:
            return self.client.get_object(Bucket=bucket, Key=key)["Body"]
        except self.client.exceptions.NoSuchKey as e:
            raise FileNotFoundError(uri) from e

    def put(self, uri: str, body: bytes, content_type: str) -> None:
        bucket, key = split(uri)
        self.client.put_object(Bucket=bucket, Key=key, Body=body, ContentType=content_type)

    def size(self, uri: str) -> int | None:
        """An object's size, or None if there is none."""
        bucket, key = split(uri)
        try:
            return self.client.head_object(Bucket=bucket, Key=key)["ContentLength"]
        except self.client_error as e:
            if e.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
                return None
            raise

    def upload(self, path: Path, uri: str) -> None:
        """A large local file, in parts (boto3's managed transfer)."""
        bucket, key = split(uri)
        self.client.upload_file(str(path), bucket, key)

    def download(self, uri: str, path: Path) -> None:
        """A large object to a local file, in parts."""
        bucket, key = split(uri)
        self.client.download_file(bucket, key, str(path))


def weights_from(s3: S3, prefix: str):
    """A fetch_weights source reading our S3 copy of the locked weights."""
    prefix = prefix if prefix.endswith("/") else prefix + "/"
    return lambda entry: contextlib.closing(s3.open(prefix + entry["path"]))


# A 360 walk round one machine is minutes of video, never more than this.
MAX_VIDEO_BYTES = 2 * 1024**3
MAX_FRAMES_BYTES = 4 * 1024**3
VIDEO_TYPES = {".mov", ".mp4"}
# What a video job leaves beside the model, as far as it got: for the reviewer, and for finding out why.
SIDE_FILES = [
    ("picked/frames.json", "frames.json", "application/json"),
    ("cut/cutout.json", "cutout.json", "application/json"),
    ("cut/cutout.png", "cutout.png", "image/png"),
    ("measured/measured.json", "measured.json", "application/json"),
]
ROUTES = ("generated", "measured")


def machine_input(machine) -> tuple[dict | None, str | None]:
    """The scanned box and where the ARKit frames are, from --params' `machine`."""
    if not isinstance(machine, dict):
        raise InputError("params.machine must be a JSON object")
    if machine.get("route", "generated") not in ROUTES:
        raise InputError(f"params.machine.route must be one of {', '.join(ROUTES)}")
    box = machine.get("box")
    if box is not None:
        try:
            box = {k: float(box[k]) for k in ("w", "d", "h")}
        except (KeyError, TypeError, ValueError) as e:
            raise InputError(f"params.machine.box must give w, d and h in metres ({e!r})") from None
        if not all(0 < v <= 30 for v in box.values()):
            raise InputError("params.machine.box sizes must be over 0 and at most 30 m")
    frames = machine.get("frames")
    if frames is not None:
        if not isinstance(frames, str):
            raise InputError("params.machine.frames must be an s3:// location")
        split(frames)
    return box, frames


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(s3, uri: str, path: Path, what: str, limit: int) -> int:
    """Downloads one input; returns its size."""
    size = s3.size(uri)
    if size is None:
        raise InputError(f"No {what} at {uri}")
    if size > limit:
        raise InputError(f"The {what} is {size / 1024**3:.1f} GB, more than {limit / 1024**3:.0f} GB")
    s3.download(uri, path)
    return size


def run(
    args: argparse.Namespace,
    *,
    s3,
    load_model,
    weights_dir: Path,
    weights_s3: str,
    lock_path: Path = HERE / "weights.lock.json",
    config_path: Path = HERE / "pipeline.json",
    versions_path: Path = Path("/opt/trellis2/versions.json"),
    make_segmenter=None,
) -> int:
    """One job. Returns the exit code; whatever happens, leaves its outcome under --output."""
    from trellis_model import settings  # noqa: PLC0415

    started = time.time()
    out = args.output if args.output.endswith("/") else args.output + "/"
    with tempfile.TemporaryDirectory(prefix="trellis2-") as tmp:
        work = Path(tmp)
        try:
            split(out)
            try:
                params = json.loads(args.params or "{}")
            except ValueError as e:
                raise InputError(f"--params is not JSON: {e}") from e
            if not isinstance(params, dict):
                raise InputError("--params must be a JSON object")
            machine = params.pop("machine", None)
            s = settings(params)
            job = Job(args, s3, load_model, weights_dir, weights_s3, lock_path, config_path, s)
            if machine is None:
                glb, metadata = job.from_cutout()
            elif isinstance(machine, dict) and machine.get("route") == "measured":
                glb, metadata = job.from_frames(machine, work)
            else:
                glb, metadata = job.from_video(machine, work, make_segmenter)
            versions = json.loads(versions_path.read_text(encoding="utf-8")) if versions_path.is_file() else None
            metadata.update(versions=versions, settings=s)
            metadata["timings_s"]["total"] = round(time.time() - started, 2)
            _side_files(s3, out, work)
            s3.put(out + "model.glb", glb, "model/gltf-binary")
            s3.put(out + "metadata.json", json.dumps(metadata, indent=1).encode(), "application/json")
            print(json.dumps({"done": out + "model.glb", "bytes": len(glb), "total_s": metadata["timings_s"]["total"]}))
            return DONE
        except InputError as e:
            _side_files(s3, out, work)
            return _failed(s3, out, "input", str(e), BAD_INPUT)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            _side_files(s3, out, work)
            return _failed(s3, out, "internal", f"{type(e).__name__}: {e}", FAILED, trace=traceback.format_exc()[-2000:])


class Job:
    """The steps of one job, in the order each kind of input needs them."""

    def __init__(self, args, s3, load_model, weights_dir, weights_s3, lock_path, config_path, s):
        self.args, self.s3, self.load_model = args, s3, load_model
        self.weights_dir, self.weights_s3 = weights_dir, weights_s3
        self.lock_path, self.config_path, self.s = lock_path, config_path, s
        self.timings: dict = {}
        self.weights = None

    def model(self):
        """The locked weights onto this host (once per host), then the model."""
        import fetch_weights  # noqa: PLC0415

        t = time.time()
        lock = fetch_weights.load_lock(self.lock_path)
        config = self.config_path.read_bytes()
        folder = fetch_weights.s3_folder(self.weights_s3, lock, config)
        fetched = fetch_weights.fetch(self.weights_dir, lock=lock, source=weights_from(self.s3, folder), config=self.config_path)
        self.timings.update(weights=round(time.time() - t, 2), weights_fetched=len(fetched))
        self.weights = fetch_weights.lock_digest(lock, config)
        t = time.time()
        model = self.load_model(str(self.weights_dir))
        self.timings["load"] = round(time.time() - t, 2)
        return model

    def generate(self, model, image, input_meta: dict) -> tuple[bytes, dict]:
        from trellis_model import MODEL  # noqa: PLC0415

        glb, timings = model.generate(image, self.s)
        metadata = {
            "worker": "trellis2",
            "model": MODEL,
            "weights": self.weights,
            "gpu": getattr(model, "gpu", None),
            "input": input_meta,
            "glb": {"bytes": len(glb), "sha256": hashlib.sha256(glb).hexdigest()},
            "timings_s": {**self.timings, **timings},
        }
        return glb, metadata

    def from_cutout(self) -> tuple[bytes, dict]:
        """The golden test's input: a cut-out, checked before the model is loaded."""
        from cutout import CutoutError, check_cutout  # noqa: PLC0415
        from PIL import Image  # noqa: PLC0415

        try:
            raw = self.s3.get(self.args.input)
        except FileNotFoundError as e:
            raise InputError(f"No cut-out at {self.args.input}") from e
        try:
            image = Image.open(io.BytesIO(raw))
            image.load()
            check_cutout(image)
        except CutoutError as e:
            raise InputError(str(e)) from e
        except OSError as e:
            raise InputError(f"The cut-out is not an image: {e}") from e
        model = self.model()
        meta = {"uri": self.args.input, "sha256": hashlib.sha256(raw).hexdigest(), "width": image.width, "height": image.height}
        return self.generate(model, image, meta)

    def from_frames(self, machine, work: Path) -> tuple[bytes, dict]:
        """A machine's ARKit frames, rebuilt from their depth (L-04)."""
        return _measured_job(self, machine, work)

    def from_video(self, machine, work: Path, make_segmenter) -> tuple[bytes, dict]:
        """A machine's 360 video: frames, then the model (its BiRefNet makes the cut-out), then the cut-out modelled."""
        # OpenCV is loaded only for this kind of job.
        import frames as framing  # noqa: PLC0415
        import segment  # noqa: PLC0415
        from cutout import CutoutError  # noqa: PLC0415
        from PIL import Image  # noqa: PLC0415

        box, frames_uri = machine_input(machine)
        suffix = Path(self.args.input).suffix.lower()
        if suffix not in VIDEO_TYPES:
            raise InputError(f"The 360 video must be .mov or .mp4, not {suffix or 'without an extension'}")
        video = work / f"video{suffix}"
        t = time.time()
        size = fetch(self.s3, self.args.input, video, "360 video", MAX_VIDEO_BYTES)
        arkit = None
        if frames_uri:
            arkit = work / "frames.zip"
            fetch(self.s3, frames_uri, arkit, "ARKit frames upload", MAX_FRAMES_BYTES)
        self.timings["download"] = round(time.time() - t, 2)

        # Before the model is loaded: a walk that cannot be used costs no GPU time.
        t = time.time()
        try:
            picked = framing.pick_frames(video, work / "picked", arkit=arkit)
        except framing.FramesError as e:
            raise InputError(str(e)) from e
        self.timings["frames"] = round(time.time() - t, 2)

        model = self.model()
        t = time.time()
        segmenter = (make_segmenter or (lambda m: segment.BiRefNetSegmenter(m.pipeline.rembg_model)))(model)
        try:
            cut = segment.make_cutout(work / "picked", work / "cut", segmenter, box)
        except CutoutError as e:
            raise InputError(str(e)) from e
        self.timings["cutout"] = round(time.time() - t, 2)
        with Image.open(work / "cut" / "cutout.png") as opened:
            image = opened.copy()

        meta = {
            "uri": self.args.input,
            "sha256": sha256_file(video),
            "bytes": size,
            "frames": frames_uri,
            "box": box,
            "picked": {k: picked[k] for k in ("source", "steps", "coverage", "largestGapDeg", "rejected")},
            "cutout": {"frame": cut["chosen"], "width": image.width, "height": image.height},
        }
        return self.generate(model, image, meta)


def _measured_job(job: "Job", machine, work: Path) -> tuple[bytes, dict]:
    """The measured route (L-04): the ARKit frames rebuilt into a model; no weights, no GPU model."""
    import measured  # noqa: PLC0415

    box, frames_uri = machine_input(machine)
    if not frames_uri:
        raise InputError("A measured model needs the walk-round's ARKit frames (depth and camera positions); this one has none.")
    t = time.time()
    arkit = work / "frames.zip"
    size = fetch(job.s3, frames_uri, arkit, "ARKit frames upload", MAX_FRAMES_BYTES)
    job.timings["download"] = round(time.time() - t, 2)
    t = time.time()
    try:
        report = measured.reconstruct(arkit, work / "measured", box)
    except measured.MeasureError as e:
        raise InputError(str(e)) from e
    job.timings["reconstruct"] = round(time.time() - t, 2)
    glb = (work / "measured" / "model.glb").read_bytes()
    metadata = {
        "worker": "measured",
        "route": "measured",
        "input": {"uri": job.args.input, "frames": frames_uri, "sha256": sha256_file(arkit), "bytes": size, "box": box},
        "measured": report,
        "glb": {"bytes": len(glb), "sha256": hashlib.sha256(glb).hexdigest()},
        "timings_s": dict(job.timings),
    }
    return glb, metadata


def _side_files(s3, out: str, work: Path) -> None:
    """Uploads what a video job made along the way, whatever happened after."""
    for local, name, content_type in SIDE_FILES:
        path = work / local
        if path.is_file():
            with contextlib.suppress(Exception):
                s3.put(out + name, path.read_bytes(), content_type)


def _failed(s3, out: str, kind: str, reason: str, code: int, trace: str | None = None) -> int:
    """Leaves error.json for the backend, which shows the reason to the reviewer."""
    print(json.dumps({"failed": kind, "reason": reason}), file=sys.stderr)
    body = {"kind": kind, "reason": reason, **({"trace": trace} if trace else {})}
    with contextlib.suppress(Exception):
        s3.put(out + "error.json", json.dumps(body, indent=1).encode(), "application/json")
    return code


def main() -> None:
    parser = argparse.ArgumentParser(description="One cut-out in, one TRELLIS.2 model out.")
    parser.add_argument("--input", required=True, help="s3:// URI of the cut-out (RGBA PNG or WebP)")
    parser.add_argument("--output", required=True, help="s3:// folder for model.glb and metadata.json (or error.json)")
    parser.add_argument("--params", default="{}", help="JSON object of generation settings (seed, resolution, ...)")
    args = parser.parse_args()

    from trellis_model import Trellis2  # noqa: PLC0415

    sys.exit(
        run(
            args,
            s3=S3(),
            load_model=Trellis2,
            weights_dir=Path(os.environ.get("WEIGHTS_DIR", "/weights")),
            weights_s3=os.environ["WEIGHTS_S3"],
        )
    )


if __name__ == "__main__":
    main()
