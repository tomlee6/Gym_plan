"""
Fetches the TRELLIS.2 worker's model weights exactly as weights.lock.json
pins them (task L-11): each file checked for size and SHA-256 before it is
kept, then our pipeline.json (L-12) beside them. A file already in place
and matching is left alone, so a run can be repeated or resumed, and
`--verify` only checks a folder without downloading.

Files come from Hugging Face (each repository at its locked revision) when
the weights are first copied, and from our own S3 copy on the GPU hosts
(the worker, L-13). Either way the lock decides what is accepted.

A file with no hash in the lock (DINOv3 until access to it is approved and
lock_weights.py is run with HF_TOKEN) is refused, never fetched unchecked.

    HF_TOKEN=... python fetch_weights.py /data/trellis2-weights
    python fetch_weights.py /data/trellis2-weights --verify
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.request
from pathlib import Path
from typing import BinaryIO, Callable

HERE = Path(__file__).resolve().parent
LOCK = HERE / "weights.lock.json"
CHUNK = 8 << 20
# Written once a folder has been checked in full: hashing 18 GB on every job would cost a minute.
MARKER = ".verified.json"

# Opens one locked file for reading: (lock entry) -> binary stream.
Source = Callable[[dict], BinaryIO]


class WeightsError(Exception):
    pass


def load_lock(path: Path = LOCK) -> list[dict]:
    files = json.loads(path.read_text(encoding="utf-8"))["files"]
    unhashed = [f["path"] for f in files if not f.get("sha256")]
    if unhashed:
        raise WeightsError(
            f"No hash is locked for {unhashed}. For DINOv3: get access approved on Hugging Face, "
            "then run lock_weights.py with HF_TOKEN set, and commit the new weights.lock.json."
        )
    return files


def lock_digest(lock: list[dict], config: bytes) -> str:
    """Names one exact set of weights and config: it changes if any pin does."""
    return hashlib.sha256(json.dumps([lock, hashlib.sha256(config).hexdigest()], sort_keys=True).encode()).hexdigest()


def s3_folder(base: str, lock: list[dict], config: bytes) -> str:
    """Where one exact set of weights and config lives in our S3 copy: <base>/<lock digest>/."""
    base = base if base.endswith("/") else base + "/"
    return f"{base}{lock_digest(lock, config)}/"


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def matches(path: Path, entry: dict) -> bool:
    return path.is_file() and path.stat().st_size == entry["size"] and sha256_of(path) == entry["sha256"]


def url_of(entry: dict) -> str:
    return f"https://huggingface.co/{entry['repo']}/resolve/{entry['revision']}/{entry['source']}"


def hugging_face(opener=urllib.request.urlopen) -> Source:
    """Reads locked files from Hugging Face, each at its revision (HF_TOKEN for gated ones)."""
    def open_entry(entry: dict) -> BinaryIO:
        headers = {"Authorization": f"Bearer {os.environ['HF_TOKEN']}"} if os.environ.get("HF_TOKEN") else {}
        return opener(urllib.request.Request(url_of(entry), headers=headers))

    return open_entry


def download(entry: dict, dest: Path, source: Source) -> None:
    """Copies one locked file into `dest`, keeping it only if its size and SHA-256 match the lock."""
    part = dest.with_name(dest.name + ".part")
    dest.parent.mkdir(parents=True, exist_ok=True)
    h = hashlib.sha256()
    size = 0
    with source(entry) as r, part.open("wb") as out:
        for chunk in iter(lambda: r.read(CHUNK), b""):
            h.update(chunk)
            size += len(chunk)
            out.write(chunk)
    if size != entry["size"] or h.hexdigest() != entry["sha256"]:
        part.unlink()
        raise WeightsError(f"{entry['path']}: got {size} bytes with SHA-256 {h.hexdigest()}, the lock says {entry['size']} and {entry['sha256']}")
    part.replace(dest)


def _stamp(root: Path, paths: list[str]) -> dict:
    return {p: [(root / p).stat().st_size, (root / p).stat().st_mtime_ns] for p in paths}


def fetch(
    root: Path,
    *,
    verify_only: bool = False,
    lock: list[dict] | None = None,
    source: Source | None = None,
    config: Path = HERE / "pipeline.json",
) -> list[str]:
    """
    Makes `root` hold exactly the locked files and our pipeline.json, which
    points TRELLIS.2 at them. Returns what was fetched or written; raises on
    any mismatch. A folder checked in full before, untouched since (same
    lock, same sizes and modification times), is not hashed again.
    """
    lock = load_lock() if lock is None else lock
    ours = config.read_bytes()
    digest = lock_digest(lock, ours)
    paths = [e["path"] for e in lock] + ["pipeline.json"]
    marker = root / MARKER
    try:
        seen = json.loads(marker.read_text(encoding="utf-8"))
        if seen["digest"] == digest and seen["files"] == _stamp(root, paths):
            return []
    except (OSError, ValueError, KeyError):
        pass

    source = source or hugging_face()
    fetched = []
    for entry in lock:
        path = root / entry["path"]
        if matches(path, entry):
            continue
        if verify_only:
            raise WeightsError(f"{entry['path']} is missing or does not match the lock")
        download(entry, path, source)
        fetched.append(entry["path"])
    target = root / "pipeline.json"
    if not target.is_file() or target.read_bytes() != ours:
        if verify_only:
            raise WeightsError("pipeline.json is missing or is not ours")
        root.mkdir(parents=True, exist_ok=True)
        target.write_bytes(ours)
        fetched.append("pipeline.json")
    marker.write_text(json.dumps({"digest": digest, "files": _stamp(root, paths)}), encoding="utf-8")
    return fetched


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("root", type=Path, help="folder to hold the weights")
    parser.add_argument("--verify", action="store_true", help="only check the folder against the lock")
    args = parser.parse_args()
    try:
        fetched = fetch(args.root, verify_only=args.verify)
    except WeightsError as e:
        sys.exit(str(e))
    print(f"{args.root}: every locked file present and matching" + (f" ({len(fetched)} fetched)" if fetched else ""))


if __name__ == "__main__":
    main()
