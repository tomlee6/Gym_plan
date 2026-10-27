"""
The golden test for a TRELLIS.2 worker image (task L-14): run one fixed
cut-out with one fixed seed on the new image, on a real GPU, and compare the
model with the stored reference before the image is used.

    python golden.py --image <account>.dkr.ecr.ap-southeast-2.amazonaws.com/flexgym/trellis2@sha256:<digest> --env dev
    python golden.py --image ... --env dev --record      # after looking at the model: make it the reference

The image is run under a temporary "candidate" copy of the environment's job
definition (`<prefix>-trellis2`), so the live one is untouched, on the live
job queue. The input is Microsoft's own example image (golden/input.png:
assets/example_image/T.png in TRELLIS.2, MIT), with Microsoft's default
settings and seed 42 (`run()`'s own default).

What is compared, against golden/reference.json:
- the GLB is valid and textured, and the model fills TRELLIS.2's unit cube;
- triangles within 5 % and file size within 15 % of the reference;
- generation no slower than 1.5 times the reference.
The GPU's own non-determinism means the bytes are not compared. Any change
in installed versions is listed. Exits 0 when it passes, 1 when not.

Needs AWS credentials in the environment's account allowed to register and
deregister job definitions, pass its job and execution roles, submit and
describe jobs, and read and write under models/accounts/_golden/ in the
models bucket.
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
import time
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
GOLDEN = HERE / "golden"
# Microsoft's defaults (trellis_model.settings), with run()'s default seed.
PARAMS = {"seed": 42}
TOLERANCE = {"triangles": 0.05, "bytes": 0.15, "slower": 1.5}
DONE_STATES = ("SUCCEEDED", "FAILED")


def glb_stats(data: bytes) -> dict:
    """What a GLB holds: triangles, vertices, images, materials and the bounds of its positions."""
    magic, version, length = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF" or version != 2 or length != len(data):
        raise ValueError("not a glTF 2.0 binary")
    chunk_length, chunk_type = struct.unpack_from("<I4s", data, 12)
    if chunk_type != b"JSON":
        raise ValueError("the GLB has no JSON chunk first")
    gltf = json.loads(data[20 : 20 + chunk_length])
    accessors = gltf.get("accessors", [])
    triangles = vertices = 0
    lo, hi = [float("inf")] * 3, [float("-inf")] * 3
    for mesh in gltf.get("meshes", []):
        for prim in mesh.get("primitives", []):
            if prim.get("mode", 4) != 4:
                continue
            position = accessors[prim["attributes"]["POSITION"]]
            vertices += position["count"]
            triangles += (accessors[prim["indices"]]["count"] if "indices" in prim else position["count"]) // 3
            lo = [min(a, b) for a, b in zip(lo, position.get("min", lo))]
            hi = [max(a, b) for a, b in zip(hi, position.get("max", hi))]
    return {
        "bytes": len(data),
        "triangles": triangles,
        "vertices": vertices,
        "images": len(gltf.get("images", [])),
        "materials": len(gltf.get("materials", [])),
        "bounds": {"min": lo, "max": hi},
    }


def compare(stats: dict, metadata: dict, reference: dict | None) -> list[str]:
    """What is wrong with this run; empty when it passes."""
    problems = []
    if stats["triangles"] == 0:
        problems.append("the model has no triangles")
    if stats["images"] == 0 or stats["materials"] == 0:
        problems.append("the model has no textures")
    lo, hi = stats["bounds"]["min"], stats["bounds"]["max"]
    if any(v < -0.501 for v in lo) or any(v > 0.501 for v in hi):
        problems.append(f"the model leaves TRELLIS.2's unit cube: {lo} to {hi}")
    if max(h - l for h, l in zip(hi, lo)) < 0.5:
        problems.append(f"the model is too small for its cube: {lo} to {hi}")
    if reference is None:
        return problems
    ref = reference["stats"]
    for key in ("triangles", "bytes"):
        change = abs(stats[key] - ref[key]) / max(ref[key], 1)
        if change > TOLERANCE[key]:
            problems.append(f"{key}: {stats[key]} against {ref[key]} in the reference ({change:.0%} off, {TOLERANCE[key]:.0%} allowed)")
    took, used_to = metadata["timings_s"]["generate"], reference["timings_s"]["generate"]
    if took > used_to * TOLERANCE["slower"]:
        problems.append(f"generation took {took} s against {used_to} s in the reference")
    return problems


def version_changes(before: dict | None, after: dict | None) -> list[str]:
    """Installed versions that differ between the reference's image and this one."""
    if not before or not after:
        return []
    out = [f"{k}: {before.get(k)} -> {after.get(k)}" for k in sorted(set(before) | set(after)) if k != "python" and before.get(k) != after.get(k)]
    old, new = set(before.get("python", [])), set(after.get("python", []))
    out += [f"python: -{p}" for p in sorted(old - new)] + [f"python: +{p}" for p in sorted(new - old)]
    return out


def candidate_definition(live: dict, image: str) -> dict:
    """RegisterJobDefinition arguments: the live definition with the candidate image, one attempt."""
    container = {k: v for k, v in live["containerProperties"].items() if k not in ("networkConfiguration",)}
    container["image"] = image
    return {
        "jobDefinitionName": f"{live['jobDefinitionName']}-candidate",
        "type": "container",
        "parameters": live.get("parameters", {}),
        "containerProperties": container,
        "retryStrategy": {"attempts": 1},
        "timeout": live.get("timeout", {"attemptDurationSeconds": 3600}),
        "platformCapabilities": live.get("platformCapabilities", ["EC2"]),
    }


def wait(batch, job_id: str, *, poll: float = 30, limit: float = 90 * 60, clock=time.monotonic, sleep=time.sleep) -> dict:
    """Waits for a job to finish; returns its description."""
    started, last = clock(), None
    while True:
        job = batch.describe_jobs(jobs=[job_id])["jobs"][0]
        if job["status"] != last:
            last = job["status"]
            print(f"  {last}", flush=True)
        if last in DONE_STATES:
            return job
        if clock() - started > limit:
            raise TimeoutError(f"job {job_id} still {last} after {limit / 60:.0f} minutes")
        sleep(poll)


def run(env: str, image: str, *, batch, s3, record: bool = False, run_id: str | None = None, waiter=wait) -> int:
    prefix = f"flexgym-{env}-trellis2"
    live = max(
        batch.describe_job_definitions(jobDefinitionName=prefix, status="ACTIVE")["jobDefinitions"],
        key=lambda d: d["revision"],
    )
    weights = next(e["value"] for e in live["containerProperties"]["environment"] if e["name"] == "WEIGHTS_S3")
    bucket = weights[len("s3://") :].split("/", 1)[0]
    run_id = run_id or time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + uuid.uuid4().hex[:6]
    folder = f"s3://{bucket}/models/accounts/_golden/assets/{run_id}/"

    candidate = batch.register_job_definition(**candidate_definition(live, image))
    try:
        s3.put(folder + "cutout.png", (GOLDEN / "input.png").read_bytes(), "image/png")
        submitted = batch.submit_job(
            jobName=f"golden-{run_id}",
            jobQueue=prefix,
            jobDefinition=candidate["jobDefinitionArn"],
            parameters={"input": folder + "cutout.png", "output": folder + "out/", "params": json.dumps(PARAMS)},
        )
        print(f"Golden job {submitted['jobId']} on {image}")
        job = waiter(batch, submitted["jobId"])
    finally:
        batch.deregister_job_definition(jobDefinition=candidate["jobDefinitionArn"])

    if job["status"] != "SUCCEEDED":
        try:
            reason = json.loads(s3.get(folder + "out/error.json"))["reason"]
        except Exception:  # noqa: BLE001
            reason = job.get("statusReason", "no reason given")
        print(f"FAILED: the golden job did not finish: {reason}")
        return 1

    glb = s3.get(folder + "out/model.glb")
    metadata = json.loads(s3.get(folder + "out/metadata.json"))
    stats = glb_stats(glb)
    reference_path = GOLDEN / "reference.json"
    reference = json.loads(reference_path.read_text(encoding="utf-8")) if reference_path.is_file() else None
    local = GOLDEN / f"{run_id}.glb"
    local.write_bytes(glb)

    problems = compare(stats, metadata, reference)
    print(json.dumps({"stats": stats, "timings_s": metadata["timings_s"], "gpu": metadata.get("gpu")}, indent=1))
    for change in version_changes((reference or {}).get("versions"), metadata.get("versions")):
        print(f"  changed: {change}")
    print(f"The model is at {local}: open it and look at it.")

    if record:
        if problems and reference is None:
            print("Not recorded: " + "; ".join(problems))
            return 1
        reference_path.write_text(
            json.dumps({"image": image, "run": run_id, "stats": stats, "timings_s": metadata["timings_s"], "versions": metadata.get("versions"), "settings": metadata["settings"]}, indent=1) + "\n",
            encoding="utf-8",
        )
        print(f"Recorded as the reference: {reference_path}. Commit it.")
        return 0
    if reference is None:
        print("FAILED: there is no reference yet. Look at the model; if it is right, run again with --record (first image only).")
        return 1
    if problems:
        print("FAILED: " + "; ".join(problems))
        return 1
    print("PASSED: this image can be approved (its digest into cdk.json).")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="Golden test for a TRELLIS.2 worker image.")
    parser.add_argument("--image", required=True, help="the candidate image, by digest")
    parser.add_argument("--env", required=True, choices=["dev", "staging", "prod"], help="whose GPU environment to run it in")
    parser.add_argument("--record", action="store_true", help="make this run the reference (after looking at the model)")
    args = parser.parse_args()
    if "@sha256:" not in args.image:
        sys.exit("Name the image by digest (@sha256:...).")
    import boto3  # noqa: PLC0415

    from worker import S3  # noqa: PLC0415

    sys.exit(run(args.env, args.image, batch=boto3.client("batch"), s3=S3(), record=args.record))


if __name__ == "__main__":
    main()
