"""
The model-facing code of the TRELLIS.2 worker (task L-13).

Carried over unchanged from the Digital Twin's RunPod worker
(apps/trellis2-worker/handler.py at commit 4caafe1, SHA-256 c5cc66b2...),
whose settings, defaults, ranges and export arguments were checked one by
one against Microsoft's app.py and example.py (sheet "TRELLIS check" in
docs/Tejesh-3D-Tasks.xlsx). Nothing here is "improved": the point is
Microsoft's published quality. What changed is only around it:

- no RunPod and no base64: worker.py reads and writes S3;
- the pipeline loads from the locked weights folder (fetch_weights.py)
  with our pipeline.json (L-12), with Hugging Face offline;
- the input is our cut-out (cutout.py), so TRELLIS.2's own preprocessing
  crops and centres it but never removes a background.

torch and trellis2 are imported only when the model is loaded, so the
rest of the worker can be tested without a GPU.
"""
from __future__ import annotations

import inspect
import os
import time

MODEL = "microsoft/TRELLIS.2-4B"

# Upstream app.py exposes resolution as a 3-way choice and maps it to the
# pipeline's cascade variants. The "_cascade" suffix is not cosmetic: it
# selects a different multi-stage sampling path.
PIPELINE_TYPES = {"512": "512", "1024": "1024_cascade", "1536": "1536_cascade"}


def _num(inp, key, default, lo, hi, cast=float):
    try:
        return max(lo, min(hi, cast(inp.get(key, default))))
    except Exception:  # noqa: BLE001
        return default


def settings(inp: dict) -> dict:
    """
    Generation settings from a job's parameters. Ranges are the upstream
    slider bounds; defaults are the upstream slider defaults. Do not "tune"
    these without a measured reason.
    """
    resolution = str(inp.get("resolution", os.environ.get("TRELLIS2_RESOLUTION", "1024")))
    if resolution not in PIPELINE_TYPES:
        resolution = "1024"
    return {
        "seed": _num(inp, "seed", 1, 0, 2**31 - 1, int),
        "resolution": resolution,
        "pipeline_type": PIPELINE_TYPES[resolution],
        "sparse_structure_sampler_params": {
            "steps": _num(inp, "ss_sampling_steps", 12, 1, 50, int),
            "guidance_strength": _num(inp, "ss_guidance_strength", 7.5, 1.0, 10.0),
            "guidance_rescale": _num(inp, "ss_guidance_rescale", 0.7, 0.0, 1.0),
            "rescale_t": _num(inp, "ss_rescale_t", 5.0, 1.0, 6.0),
        },
        "shape_slat_sampler_params": {
            "steps": _num(inp, "shape_slat_sampling_steps", 12, 1, 50, int),
            "guidance_strength": _num(inp, "shape_slat_guidance_strength", 7.5, 1.0, 10.0),
            "guidance_rescale": _num(inp, "shape_slat_guidance_rescale", 0.5, 0.0, 1.0),
            "rescale_t": _num(inp, "shape_slat_rescale_t", 3.0, 1.0, 6.0),
        },
        "tex_slat_sampler_params": {
            "steps": _num(inp, "tex_slat_sampling_steps", 12, 1, 50, int),
            "guidance_strength": _num(inp, "tex_slat_guidance_strength", 1.0, 1.0, 10.0),
            "guidance_rescale": _num(inp, "tex_slat_guidance_rescale", 0.0, 0.0, 1.0),
            "rescale_t": _num(inp, "tex_slat_rescale_t", 3.0, 1.0, 6.0),
        },
        "decimation_target": _num(inp, "decimation_target", 500_000, 100_000, 1_000_000, int),
        "texture_size": _num(inp, "texture_size", 2048, 1024, 4096, int),
        "extension_webp": bool(inp.get("extension_webp", True)),
    }


def _to_glb(pipeline, mesh, decimation_target: int, texture_size: int):
    """Calls o_voxel.postprocess.to_glb with the arguments this checkout accepts.

    Upstream spells the geometry arguments two ways in two files: example.py
    passes `attr_layout=mesh.layout, voxel_size=mesh.voxel_size, verbose=...`,
    app.py passes `attr_layout=pipeline.pbr_attr_layout, grid_size=res,
    use_tqdm=...`. Reading the signature keeps the call right for whichever
    the pinned o_voxel accepts.
    """
    import o_voxel  # noqa: PLC0415

    fn = o_voxel.postprocess.to_glb
    accepted = set(inspect.signature(fn).parameters)

    kwargs = dict(
        vertices=mesh.vertices,
        faces=mesh.faces,
        attr_volume=mesh.attrs,
        coords=mesh.coords,
        aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
        decimation_target=decimation_target,
        texture_size=texture_size,
        remesh=True,
        remesh_band=1,
        remesh_project=0,
    )

    # attr_layout: prefer the mesh's own, else the pipeline's PBR layout.
    kwargs["attr_layout"] = getattr(mesh, "layout", None)
    if kwargs["attr_layout"] is None:
        kwargs["attr_layout"] = pipeline.pbr_attr_layout

    # Grid description: voxel_size (example.py) or grid_size (app.py).
    if "voxel_size" in accepted and getattr(mesh, "voxel_size", None) is not None:
        kwargs["voxel_size"] = mesh.voxel_size
    elif "grid_size" in accepted:
        grid = getattr(mesh, "resolution", None) or getattr(mesh, "grid_size", None)
        if grid is None:
            raise RuntimeError(
                "to_glb requires grid_size but the mesh exposes neither "
                "`resolution` nor `grid_size` — upstream API changed.")
        kwargs["grid_size"] = grid

    # Progress flag is named differently across the two files.
    if "use_tqdm" in accepted:
        kwargs["use_tqdm"] = False
    elif "verbose" in accepted:
        kwargs["verbose"] = False

    return fn(**{k: v for k, v in kwargs.items() if k in accepted})


class Trellis2:
    """TRELLIS.2, loaded once from the locked weights folder and kept for the job."""

    def __init__(self, weights: str):
        # Read at import time by torch, o_voxel and transformers.
        os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
        os.environ.setdefault("ATTN_BACKEND", "flash-attn")
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        import torch  # noqa: PLC0415
        from trellis2.pipelines import Trellis2ImageTo3DPipeline  # noqa: PLC0415

        # Our pipeline.json names its models relative to the weights folder.
        here = os.getcwd()
        os.chdir(weights)
        try:
            self.pipeline = Trellis2ImageTo3DPipeline.from_pretrained(".")
        finally:
            os.chdir(here)
        self.pipeline.cuda()
        self.gpu = torch.cuda.get_device_name(0)

    def generate(self, image, s: dict) -> tuple[bytes, dict]:
        """One model from one cut-out: the GLB's bytes, and timings."""
        t_gen = time.time()
        mesh = self.pipeline.run(
            image,
            seed=s["seed"],
            preprocess_image=True,
            sparse_structure_sampler_params=s["sparse_structure_sampler_params"],
            shape_slat_sampler_params=s["shape_slat_sampler_params"],
            tex_slat_sampler_params=s["tex_slat_sampler_params"],
            pipeline_type=s["pipeline_type"],
        )[0]
        gen_s = time.time() - t_gen

        # Upstream example.py calls this between run() and to_glb(), commented
        # "nvdiffrast limit": 2^24 is a hard clamp on what the rasteriser can
        # index, not a quality setting.
        try:
            mesh.simplify(16777216)
        except Exception:  # noqa: BLE001
            pass  # builds without .simplify: the clamp is a safety net

        t_glb = time.time()
        glb = _to_glb(self.pipeline, mesh, s["decimation_target"], s["texture_size"])
        # glb.export() writes a path, not a buffer, in the upstream API.
        out_path = "/tmp/out.glb"
        glb.export(out_path, extension_webp=s["extension_webp"])
        with open(out_path, "rb") as f:
            data = f.read()
        os.remove(out_path)
        return data, {"generate": round(gen_s, 2), "extract_glb": round(time.time() - t_glb, 2)}
