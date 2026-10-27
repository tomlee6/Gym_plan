"""
The route test (task L-01): the two ways of making a machine model side by
side, measured (L-04, from the ARKit frames' depth) and generated (L-05,
TRELLIS.2 from one cut-out photo), on the five kinds of machine that are
hardest for one or the other: chrome, black rubber, against a wall, in a
row, and large.

    python route_test.py --out route-test/ --samples                         # the made-up five, measured only
    python route_test.py --out route-test/ --samples --routes measured,generated --weights /weights   # on a GPU host
    python route_test.py --out route-test/ --machines machines.json --routes measured,generated --weights /weights

`machines.json`, for real recordings: a list of {"name", "frames" (the
ARKit frames upload), "video" (the 360 video), "size" {"w", "d", "h"}},
the size measured by hand with a tape: the truth both routes are judged
against.

For each machine and route:
- **Processing time**, and the **file size** and **triangles** of the model
  as made (before L-06).
- **Size off**: the worst of width, depth and height against the true
  size, in per cent. TRELLIS.2's model has no size of its own, so its
  figure is after L-06's one-factor fit, and says how far its proportions
  are off.
- For a made-up machine, whose every surface is known, the measured model's
  **completeness** (the share of the machine's visible surface it has,
  within 2 cm) and **accuracy** (90 % of its surface is within this of the
  true one).
- **Look**: for a person. The models are written beside the report, which
  says where.

Writes report.json and report.md, and each machine's models under
<name>/<route>/. Choosing the main route is a person's call, from real
recordings: the report gives the figures, not the choice.
"""
from __future__ import annotations

import argparse
import json
import math
import shutil
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROUTES = ("measured", "generated")
NEAR_M = 0.02


def size_off(model: dict, truth: dict) -> dict:
    """Each axis's error against the truth (per cent), widths and depths paired by size, as a turn may swap them."""
    have = sorted([model["w"], model["d"]])
    want = sorted([truth["w"], truth["d"]])
    off = {
        "across": abs(have[0] - want[0]) / want[0] * 100,
        "along": abs(have[1] - want[1]) / want[1] * 100,
        "height": abs(model["h"] - truth["h"]) / truth["h"] * 100,
    }
    return {k: round(v, 1) for k, v in off.items()} | {"worst": round(max(off.values()), 1)}


def fitted(extents, truth: dict) -> dict:
    """A model with no size of its own (TRELLIS.2's) fitted as L-06 fits it: one factor, the geometric mean."""
    x, y, z = extents
    across, along = sorted([x, z])
    want_across, want_along = sorted([truth["w"], truth["d"]])
    scale = math.exp((math.log(want_across / across) + math.log(want_along / along) + math.log(truth["h"] / y)) / 3)
    return {"w": across * scale, "d": along * scale, "h": y * scale}


def surface_scores(vertices: np.ndarray, truth: np.ndarray) -> dict:
    """Completeness (share of the true surface the model reaches) and accuracy (90th percentile of its distance from it)."""
    from scipy.spatial import cKDTree  # noqa: PLC0415

    reach, _ = cKDTree(vertices).query(truth)
    off, _ = cKDTree(truth).query(vertices)
    return {"completenessPct": round(float((reach <= NEAR_M).mean() * 100), 1), "accuracyMm90": round(float(np.percentile(off, 90) * 1000), 1)}


def run_measured(machine: dict, out: Path, max_voxels: int) -> dict:
    import measured  # noqa: PLC0415

    started = time.time()
    try:
        made = measured.rebuild(Path(machine["frames"]), machine["size"], max_voxels=max_voxels)
        report = measured.finish(made, out, machine["size"])
    except measured.MeasureError as e:
        return {"ok": False, "reason": str(e), "seconds": round(time.time() - started, 1)}
    result = {
        "ok": True,
        "seconds": round(time.time() - started, 1),
        "bytes": (out / "model.glb").stat().st_size,
        "triangles": report["triangles"],
        "sizeM": report["sizeM"],
        "sizeOffPct": size_off(report["sizeM"], machine["size"]),
        "model": (out / "model.glb").relative_to(out.parent.parent).as_posix(),
    }
    if machine.get("truth") is not None:
        result |= surface_scores(made.vertices, machine["truth"])
    return result


def run_generated(machine: dict, out: Path, model) -> dict:
    """TRELLIS.2 from the walk: frames (L-02), cut-out (L-03), model (L-05). Needs the GPU and the weights."""
    import frames as framing  # noqa: PLC0415
    import segment  # noqa: PLC0415
    from PIL import Image  # noqa: PLC0415

    import golden  # noqa: PLC0415
    from cutout import CutoutError  # noqa: PLC0415
    from trellis_model import settings  # noqa: PLC0415

    started = time.time()
    try:
        framing.pick_frames(Path(machine["video"]), out / "picked")
        segment.make_cutout(out / "picked", out / "cut", segment.BiRefNetSegmenter(model.pipeline.rembg_model), machine["size"])
    except (framing.FramesError, CutoutError) as e:
        return {"ok": False, "reason": str(e), "seconds": round(time.time() - started, 1)}
    with Image.open(out / "cut" / "cutout.png") as opened:
        image = opened.copy()
    glb, _timings = model.generate(image, settings({"seed": 1}))
    (out / "model.glb").write_bytes(glb)
    stats = golden.glb_stats(glb)
    extents = [hi - lo for lo, hi in zip(stats["bounds"]["min"], stats["bounds"]["max"])]
    size = fitted(extents, machine["size"])
    return {
        "ok": True,
        "seconds": round(time.time() - started, 1),
        "bytes": len(glb),
        "triangles": stats["triangles"],
        "sizeM": {k: round(v, 3) for k, v in size.items()},
        "sizeOffPct": size_off(size, machine["size"]),
        "model": (out / "model.glb").relative_to(out.parent.parent).as_posix(),
    }


def video_of(frames_zip: Path, path: Path, fps: int = 10) -> Path:
    """A video of a made-up walk's photos, for the generated route, which starts from the video."""
    import zipfile  # noqa: PLC0415

    import cv2  # noqa: PLC0415

    with zipfile.ZipFile(frames_zip) as z:
        manifest = json.loads(z.read("frames.json"))
        images = [cv2.imdecode(np.frombuffer(z.read(e["image"]), np.uint8), cv2.IMREAD_COLOR) for e in manifest["frames"]]
    h, w = images[0].shape[:2]
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    for image in images:
        writer.write(image)
    writer.release()
    return path


def sample_machines(out: Path, frames: int = 72, image_size=None, depth_size=None, scenes=None) -> list:
    """The five made-up machines (sample_arkit.py), each with its walk, its true size and its true surface."""
    import sample_arkit  # noqa: PLC0415

    sizes = {k: v for k, v in (("image_size", image_size), ("depth_size", depth_size)) if v}
    machines = []
    for name in scenes or sample_arkit.ROUTE_TEST:
        folder = out / name
        folder.mkdir(parents=True, exist_ok=True)
        truth = sample_arkit.make_sample(folder / "frames.zip", frames, scene=name, **sizes)
        machines.append({
            "name": name,
            "frames": folder / "frames.zip",
            "video": None,
            "size": truth["size"],
            "truth": sample_arkit.truth_points(sample_arkit.SCENES[name]),
            "madeUp": True,
        })
    return machines


def run(machines: list, out: Path, routes=("measured",), weights: str | None = None, max_voxels: int | None = None) -> dict:
    import measured  # noqa: PLC0415

    model = None
    if "generated" in routes:
        from trellis_model import Trellis2  # noqa: PLC0415

        model = Trellis2(weights)
    results = []
    for machine in machines:
        row = {"machine": machine["name"], "size": machine["size"], "madeUp": machine.get("madeUp", False), "routes": {}}
        for route in routes:
            folder = out / machine["name"] / route
            shutil.rmtree(folder, ignore_errors=True)
            folder.mkdir(parents=True)
            if route == "measured":
                row["routes"][route] = run_measured(machine, folder, max_voxels or measured.MAX_VOXELS)
            else:
                if not machine.get("video"):
                    machine["video"] = video_of(Path(machine["frames"]), out / machine["name"] / "walk.mp4")
                row["routes"][route] = run_generated(machine, folder, model)
            print(f"{machine['name']} {route}: {json.dumps(row['routes'][route])}", flush=True)
        results.append(row)
    report = {"routes": list(routes), "machines": results}
    (out / "report.json").write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8")
    (out / "report.md").write_text(markdown(report), encoding="utf-8")
    return report


def markdown(report: dict) -> str:
    made_up = any(m["madeUp"] for m in report["machines"])
    lines = ["# Route test (L-01)", ""]
    if made_up:
        lines += [
            "Made-up machines (`sample_arkit.py`): the sensor's behaviour on chrome and black rubber is an assumption.",
            "These figures check the tool and the routes' plumbing; the choice of main route waits for real recordings.",
            "",
        ]
    lines += [
        "| Machine | Route | Made | Time (s) | File (KB) | Triangles | Size off (worst %) | Complete (%) | Accuracy (mm, 90 %) | Model |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for m in report["machines"]:
        for route, r in m["routes"].items():
            if not r["ok"]:
                lines.append(f"| {m['machine']} | {route} | No: {r['reason']} | {r['seconds']} | | | | | | |")
                continue
            lines.append(
                f"| {m['machine']} | {route} | Yes | {r['seconds']} | {r['bytes'] // 1024} | {r['triangles']:,} | "
                f"{r['sizeOffPct']['worst']} | {r.get('completenessPct', '—')} | {r.get('accuracyMm90', '—')} | `{r['model']}` |"
            )
    lines += ["", "Look at each model beside the machine's video: shape, the parts the walk did not see, and whether it is the right machine."]
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description="Route test for machine models (L-01).")
    parser.add_argument("--out", type=Path, required=True)
    where = parser.add_mutually_exclusive_group(required=True)
    where.add_argument("--samples", action="store_true", help="the five made-up machines")
    where.add_argument("--machines", type=Path, help="real recordings, described in a JSON file")
    parser.add_argument("--routes", default="measured", help="measured, generated, or both, comma-separated")
    parser.add_argument("--weights", default="/weights", help="the locked weights folder (generated route)")
    parser.add_argument("--frames", type=int, default=72, help="frames in each made-up walk")
    args = parser.parse_args()
    routes = [r.strip() for r in args.routes.split(",") if r.strip()]
    if any(r not in ROUTES for r in routes):
        sys.exit(f"Routes are {', '.join(ROUTES)}.")
    args.out.mkdir(parents=True, exist_ok=True)
    if args.samples:
        machines = sample_machines(args.out, args.frames)
    else:
        machines = json.loads(args.machines.read_text(encoding="utf-8"))
    report = run(machines, args.out, routes, args.weights)
    print(markdown(report))


if __name__ == "__main__":
    main()
