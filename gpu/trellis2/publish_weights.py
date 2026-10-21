"""
Copies the locked TRELLIS.2 weights into our own S3, once per environment
and per lock (task L-09), so GPU jobs never fetch from Hugging Face.

Fetches every locked file from Hugging Face into a work folder, checking
each against the lock (fetch_weights.py), adds our pipeline.json, uploads
them all under

    <base>/<lock digest>/...

then checks every uploaded size and writes the lock and a READY marker
last. The digest names one exact set of files and config, so a new lock
goes to a new folder and never mixes with an old one; the worker reads
from the folder its own lock names.

    HF_TOKEN=... python publish_weights.py s3://<models-bucket>/gpu/trellis2/weights/ --work /data/trellis2-weights

Needs about 20 GB free in the work folder, Hugging Face access to DINOv3
(see README), and permission to write the bucket. Run it again to resume
or to check: files already in place and matching are left alone.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import fetch_weights
from worker import S3

HERE = Path(__file__).resolve().parent


def publish(base: str, work: Path, s3, *, source=None, lock_path: Path = fetch_weights.LOCK, config_path: Path = HERE / "pipeline.json") -> str:
    lock = fetch_weights.load_lock(lock_path)
    config = config_path.read_bytes()
    prefix = fetch_weights.s3_folder(base, lock, config)
    fetch_weights.fetch(work, lock=lock, source=source or fetch_weights.hugging_face(), config=config_path)

    files = [(e["path"], e["size"]) for e in lock] + [("pipeline.json", len(config))]
    for path, size in files:
        uri = prefix + path
        if s3.size(uri) == size:
            continue
        s3.upload(work / path, uri)
    wrong = [path for path, size in files if s3.size(prefix + path) != size]
    if wrong:
        raise fetch_weights.WeightsError(f"Uploaded files do not match the lock: {wrong}")
    # Written last: a folder with READY is complete.
    s3.put(prefix + "weights.lock.json", lock_path.read_bytes(), "application/json")
    s3.put(prefix + "READY", json.dumps({"files": len(files), "bytes": sum(s for _, s in files)}).encode(), "application/json")
    return prefix


def main() -> None:
    parser = argparse.ArgumentParser(description="Copy the locked TRELLIS.2 weights into S3.")
    parser.add_argument("base", help="s3://bucket/prefix/ under which the lock's folder is made")
    parser.add_argument("--work", type=Path, required=True, help="local folder for the download (about 20 GB)")
    args = parser.parse_args()
    try:
        prefix = publish(args.base, args.work, S3())
    except fetch_weights.WeightsError as e:
        sys.exit(str(e))
    print(f"Weights in place: {prefix}")


if __name__ == "__main__":
    main()
