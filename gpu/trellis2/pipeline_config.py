"""
Our TRELLIS.2 pipeline config (task L-12), made from Microsoft's.

`upstream-pipeline.json` is Microsoft's `pipeline.json` from
microsoft/TRELLIS.2-4B at the locked revision (its SHA-256 is in
weights.lock.json). Ours is the same file with three changes, so it loads
only what is locked and licensed for commercial use:

1. Background removal: ZhengPeng7/BiRefNet (MIT) instead of briaai/RMBG-2.0
   (CC BY-NC 4.0, not for commercial use). TRELLIS.2 loads this model at
   every start, even though our cut-outs never need it (see cutout.py).
2. The sparse-structure decoder from the local folder rather than from
   microsoft/TRELLIS-image-large on Hugging Face.
3. DINOv3 from the local folder rather than from Hugging Face.

Paths are relative to the weights folder, which the worker loads the
pipeline from (`from_pretrained(".")` inside it), with Hugging Face
offline, so nothing can be fetched unpinned. Sampler settings, latent
normalisation and the default pipeline type are Microsoft's, untouched.

    python pipeline_config.py      # rewrites pipeline.json
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Where each model sits in the weights folder (fetch_weights.py, weights.lock.json).
SS_DECODER = "ckpts/ss_dec_conv3d_16l8_fp16"
DINOV3 = "dinov3"
BIREFNET = "birefnet"

# Every field we change, as a path into the config, with Microsoft's value and ours.
CHANGES = {
    ("args", "models", "sparse_structure_decoder"): ("microsoft/TRELLIS-image-large/ckpts/ss_dec_conv3d_16l8_fp16", SS_DECODER),
    ("args", "image_cond_model", "args", "model_name"): ("facebook/dinov3-vitl16-pretrain-lvd1689m", DINOV3),
    ("args", "rembg_model", "args", "model_name"): ("briaai/RMBG-2.0", BIREFNET),
}


def ours(upstream: dict) -> dict:
    """Microsoft's config with our three changes. Fails if Microsoft's differs from what we expect to change."""
    config = copy.deepcopy(upstream)
    for path, (theirs, mine) in CHANGES.items():
        node = config
        for key in path[:-1]:
            node = node[key]
        if node[path[-1]] != theirs:
            raise ValueError(f"{'.'.join(path)} is {node[path[-1]]!r}, expected Microsoft's {theirs!r}")
        node[path[-1]] = mine
    # BiRefNet is the class TRELLIS.2 wraps both models in; the name stays.
    assert config["args"]["rembg_model"]["name"] == "BiRefNet"
    return config


def main() -> None:
    upstream = json.loads((HERE / "upstream-pipeline.json").read_text(encoding="utf-8"))
    (HERE / "pipeline.json").write_text(json.dumps(ours(upstream), indent=4) + "\n", encoding="utf-8")
    print("pipeline.json written")


if __name__ == "__main__":
    main()
