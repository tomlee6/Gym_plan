"""
Rebuilds requirements.lock from requirements.in (task L-11).

Resolves every package and its dependencies for the worker image's
platform (Linux x86_64, CPython 3.11) with pip's resolver, without
installing anything, then writes each one as `name==version` with the
SHA-256 of every matching wheel on PyPI. The image installs the lock with
--require-hashes --no-deps --only-binary=:all:, so it gets exactly these
files or the build fails.

Packages the base image already provides with PyTorch 2.6.0 (torch,
torchvision, triton, and their own dependencies) are resolved against but
left out of the lock; `pip check` in the image confirms the whole set fits.

Run with Python 3.11 and pip 23 or later, from this folder:

    python lock_requirements.py
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent

# What the base image (pytorch/pytorch:2.6.0-cuda12.4-cudnn9-*) carries.
BASE = {"torch": "2.6.0", "torchvision": "0.21.0", "triton": "3.2.0"}
BASE_DEPENDENCIES = {"sympy", "mpmath", "networkx", "jinja2", "markupsafe", "fsspec", "filelock", "typing-extensions", "setuptools"}

PLATFORMS = ["manylinux_2_28_x86_64", "manylinux_2_17_x86_64", "manylinux2014_x86_64", "linux_x86_64"]


def fits(filename: str) -> bool:
    """Whether a wheel installs on the image: CPython 3.11, glibc Linux x86_64 (tags may be compound, a.b.c)."""
    python, abi, platform = filename[: -len(".whl")].split("-")[-3:]
    pythons, abis, platforms = python.split("."), abi.split("."), platform.split(".")
    ok_python = any(t in ("cp311", "py3", "py2") or (t.startswith("cp3") and "abi3" in abis) for t in pythons)
    ok_abi = any(t in ("cp311", "abi3", "none") for t in abis)
    ok_platform = any(t == "any" or t == "linux_x86_64" or (t.startswith("manylinux") and t.endswith("_x86_64")) for t in platforms)
    return ok_python and ok_abi and ok_platform


def canonical(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


# The image's environment, for requirement markers (pip evaluates them for the
# machine it runs on, whatever --platform says, so they are re-checked here).
LINUX = {
    "python_version": "3.11",
    "python_full_version": "3.11.10",
    "sys_platform": "linux",
    "platform_system": "Linux",
    "platform_machine": "x86_64",
    "os_name": "posix",
    "implementation_name": "cpython",
    "platform_python_implementation": "CPython",
    "platform_release": "",
    "platform_version": "",
    "implementation_version": "3.11.10",
}


def from_base(name: str) -> bool:
    """Whether the base image already provides a package."""
    return name in BASE or name in BASE_DEPENDENCIES or name.startswith("nvidia-")


def linux_closure(items: list[dict]) -> list[tuple[str, str]]:
    """What the image needs of a pip report: from the requested packages, every dependency whose marker holds on Linux."""
    from packaging.requirements import Requirement

    by_name = {canonical(i["metadata"]["name"]): i for i in items}
    todo = [(canonical(i["metadata"]["name"]), frozenset()) for i in items if i.get("requested")]
    seen: set[tuple[str, frozenset]] = set()
    while todo:
        name, extras = todo.pop()
        if (name, extras) in seen:
            continue
        seen.add((name, extras))
        # The base image's own packages come with their dependencies already installed.
        if from_base(name):
            continue
        if name not in by_name:
            raise SystemExit(f"{name} is needed on Linux but pip (running here) did not resolve it: add it to requirements.in")
        for spec in by_name[name]["metadata"].get("requires_dist") or []:
            req = Requirement(spec)
            wanted = not req.marker or any(req.marker.evaluate({**LINUX, "extra": e}) for e in (extras or {""}))
            if wanted:
                todo.append((canonical(req.name), frozenset(req.extras)))
    needed = {name for name, _ in seen if name in by_name and not from_base(name)}
    return sorted((n, by_name[n]["metadata"]["version"]) for n in needed)


def resolve() -> list[tuple[str, str]]:
    with tempfile.TemporaryDirectory() as tmp:
        report = Path(tmp) / "report.json"
        cmd = [
            sys.executable, "-m", "pip", "install", "--dry-run", "--ignore-installed", "--quiet",
            "--report", str(report), "--only-binary=:all:", "--python-version", "3.11",
            "--implementation", "cp", "--abi", "cp311",
            *[arg for p in PLATFORMS for arg in ("--platform", p)],
            "-r", str(HERE / "requirements.in"),
            *[f"{name}=={version}" for name, version in BASE.items()],
        ]
        subprocess.run(cmd, check=True)
        items = json.loads(report.read_text(encoding="utf-8"))["install"]
    return linux_closure(items)


def wheel_hashes(name: str, version: str) -> list[str]:
    with urllib.request.urlopen(f"https://pypi.org/pypi/{name}/{version}/json") as r:
        files = json.load(r)["urls"]
    hashes = sorted(f["digests"]["sha256"] for f in files if f["packagetype"] == "bdist_wheel" and fits(f["filename"]))
    if not hashes:
        raise SystemExit(f"{name}=={version} has no wheel for Linux x86_64 CPython 3.11")
    return hashes


def main() -> None:
    locked = resolve()
    lines = [
        "# Generated by lock_requirements.py from requirements.in. Do not edit by hand.",
        "# Install with: pip install --require-hashes --no-deps --only-binary=:all: -r requirements.lock",
        "",
    ]
    for name, version in locked:
        lines.append(f"{name}=={version} \\")
        hashes = wheel_hashes(name, version)
        for i, h in enumerate(hashes):
            lines.append(f"    --hash=sha256:{h}" + (" \\" if i < len(hashes) - 1 else ""))
    (HERE / "requirements.lock").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Locked {len(locked)} packages.")


if __name__ == "__main__":
    main()
