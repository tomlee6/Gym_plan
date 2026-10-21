# TRELLIS.2 worker

The GPU job that turns one cut-out photo of a gym machine into a textured 3D model (GLB), using Microsoft's [TRELLIS.2](https://github.com/microsoft/TRELLIS.2) code and model unchanged. It runs on AWS Batch in Sydney (g6e.xlarge, NVIDIA L40S) and is started by the backend's `asset.build` job.

This folder replaces the Digital Twin project's RunPod worker (`apps/trellis2-worker`), whose model calls were checked against Microsoft's code (sheet "TRELLIS check" in `docs/Tejesh-3D-Tasks.xlsx`) and are kept as they are.

| File | What it is |
|---|---|
| `Dockerfile` | The image. Build stage: every input pinned (L-11). |
| `requirements.in` | Python packages by hand, versions as in Microsoft's demo Space. |
| `requirements.lock` | Generated: every package and dependency, with SHA-256s. |
| `lock_requirements.py` | Regenerates `requirements.lock`. |
| `weights.lock.json` | Generated: every model file, by repository revision and SHA-256. |
| `lock_weights.py` | Regenerates `weights.lock.json` from the Hugging Face API. |
| `fetch_weights.py` | Fetches the weights exactly as locked, or checks a folder against the lock. |
| `upstream-pipeline.json` | Microsoft's pipeline config at the locked revision. |
| `pipeline.json`, `pipeline_config.py` | Ours, made from Microsoft's with three changes (L-12). |
| `cutout.py` | What the worker accepts: a cut-out on a transparent background (L-12). |
| `frames.py` | Picks the frames a machine model is made from, out of the 360 video or the ARKit frames (L-02). |
| `segment.py` | Cuts the machine out of the best candidate frame with BiRefNet, for TRELLIS.2 and the reviewer (L-03). |
| `measured.py` | The measured route: a machine rebuilt from its ARKit frames' depth, no TRELLIS.2 (L-04). |
| `bake.py` | The measured model's photo texture: its surface laid flat, each texel coloured from the frames that see it best (N-04). |
| `sample_arkit.py` | Made-up ARKit frames uploads: the treadmill the measured route is built and tested against, and the route test's five machines, until the app records real ones. |
| `route_test.py` | The route test: both routes on the five hardest kinds of machine, side by side (L-01; how to run it: the runbook). |
| `worker.py` | The AWS Batch entrypoint: S3 in, GLB and metadata out (L-13). |
| `trellis_model.py` | The model-facing code, carried over unchanged (L-13). |
| `publish_weights.py` | Copies the locked weights into our S3, under the lock's digest (L-09). |
| `buildspec.yml` | The image build, run by CodeBuild in the tooling account (L-09). |
| `golden.py`, `golden/` | The golden test every new image passes before use, its fixed input and reference (L-14). |
| `release.py` | The image pipeline's steps (N-05): whether a push changed the image, the golden test as staging's role, the approved digest into `cdk.json`. |
| `tests/` | `python -m unittest discover -s gpu/trellis2/tests`, after `pip install -r gpu/trellis2/tests/requirements.txt` (without OpenCV, the frame tests are skipped). |

## What is pinned, and why (L-11)

Microsoft's `setup.sh` installs from moving targets, so two builds a month apart can differ. Here every input is fixed:

| Input | Pinned to | What setup.sh does |
|---|---|---|
| Base image | `pytorch/pytorch:2.6.0-cuda12.4-cudnn9-devel@sha256:0cf3402e…` (Python 3.11, Ubuntu 22.04) | Tag only |
| Ubuntu packages | `snapshot.ubuntu.com`, 2026-10-12 | Live archive |
| TRELLIS.2 | `75fbf01` (main, 2026-06-05) | — (cloned by us) |
| CuMesh | `12289e1` (2026-05-09), submodule cubvh `ce92267` | `main`, unpinned |
| FlexGEMM | `6dd94a8` (2026-04-22) | `main`, unpinned |
| nvdiffrast | `253ac4f` (tag v0.4.0) | Tag `v0.4.0`, which could be moved |
| utils3d | `9a4eb15` | Same commit |
| o-voxel | In TRELLIS.2 at `75fbf01`, Eigen submodule `21e4582` | Same, but its `pyproject.toml` names CuMesh and FlexGEMM as git URLs with no commit, which pip fetches from `main`; installed here with `--no-deps` |
| flash-attn | 2.7.3, source archive SHA-256 `9078cf92…`, compiled here (`FLASH_ATTENTION_FORCE_BUILD`) | 2.7.3, or a prebuilt wheel it downloads |
| Python packages | `requirements.lock`: 30 packages by version and SHA-256 | Mostly unversioned |
| nvdiffrec | Not installed: only renders preview videos | Branch `renderutils` |

The model weights are not in the image. They come from four Hugging Face repositories, which TRELLIS.2 loads by name from `main`; the worker loads them from one local folder instead, filled by `fetch_weights.py` from `weights.lock.json` (29 files, 18 GB):

| Repository | Revision | Licence |
|---|---|---|
| `microsoft/TRELLIS.2-4B` | `af44b45f` | MIT |
| `microsoft/TRELLIS-image-large` (one decoder) | `25e0d31f` | MIT |
| `facebook/dinov3-vitl16-pretrain-lvd1689m` | `ea8dc286` | DINOv3 License: commercial use allowed; access approved by Meta (below) |
| `ZhengPeng7/BiRefNet` (background removal, in place of RMBG-2.0) | `e2bf8e44` | MIT |

### Checked where

- **Here, without a GPU** (`tests/`): wheel and marker handling of the lock generator, the weight fetcher's refusal of anything that does not match, every Dockerfile source pinned by full commit and the base image by digest, the lock in step with `requirements.in`.
- **When the image builds**: the base image is the Python, PyTorch, CUDA, Triton and Ubuntu the pins assume; every checkout is the pinned commit; every package is installed by hash; `pip check`; the installed set is written to `/opt/trellis2/versions.json`, which every model the worker makes carries in its metadata.
- **On a GPU**: the golden test (`golden.py`, L-14) runs Microsoft's own example cut-out with seed 42 on every new image, under a temporary job definition, and compares the model with the stored reference (shape, size, textures, extent, speed). TRELLIS.2 had never been run before this project (all the Digital Twin's saved jobs used TRELLIS 1), so the first image's model is checked by a person and recorded as the reference.

### Moving a pin

1. Change it in `Dockerfile`, `requirements.in` (then run `python lock_requirements.py`) or `lock_weights.py` (then run `python lock_weights.py` with `HF_TOKEN`).
2. Run the tests above.
3. Push: the image pipeline builds the image, runs the golden test (L-14) and, once a person approves, puts its digest in `cdk.json` (N-05).

## Licence-safe configuration (L-12)

TRELLIS.2 builds its pipeline from `pipeline.json`. Ours (`pipeline.json`, made by `pipeline_config.py` from Microsoft's, kept as `upstream-pipeline.json` and checked against the lock) changes exactly three things and nothing else:

| Field | Microsoft's | Ours | Why |
|---|---|---|---|
| `rembg_model.args.model_name` | `briaai/RMBG-2.0` | `birefnet` (ZhengPeng7/BiRefNet) | RMBG-2.0 is CC BY-NC 4.0: no commercial use. TRELLIS.2 loads it at every start, used or not. |
| `models.sparse_structure_decoder` | `microsoft/TRELLIS-image-large/...` | `ckpts/ss_dec_conv3d_16l8_fp16` | From the locked folder, not fetched by name. |
| `image_cond_model.args.model_name` | `facebook/dinov3-vitl16-pretrain-lvd1689m` | `dinov3` | Same. |

The worker loads the pipeline from inside the weights folder with Hugging Face offline, so a missing file fails rather than being fetched unpinned.

**Our own cut-out.** The worker takes only a cut-out on a transparent background (`cutout.py`: RGBA, some of it transparent, between 1 % and 95 % of it the machine). TRELLIS.2 uses such an image as it is and never runs its own background removal. The cut-out is made by our step (`segment.py`, L-03), with the BiRefNet (MIT) the pipeline loads, so the only matting model that sees a customer's photo is one we chose. An image that is not a usable cut-out is refused with the reason.

**DINOv3 licence.** Read at the pinned revision (DINOv3 License, 19 August 2025): commercial use is allowed. It must be accepted, by someone who can bind the company, which is what the gated access request does; a copy must go with the weights only if they are redistributed (they are not: they run on our GPU job, and the licence file is kept beside them anyway); research publications must acknowledge DINOv3. It does **not** require a "Built with DINOv3" credit, so none is added (an earlier note said it did; that was wrong).

## The job (L-13, L-05)

One AWS Batch job makes one model, from one of two inputs:

    # A machine's 360 video: what the backend submits for every build (L-05)
    python worker.py --input s3://<captures>/.../360.mov --output s3://<models>/models/accounts/<a>/assets/<model>/try-<n>/ \
        --params '{"seed": 1, "machine": {"box": {"w": 2.0, "d": 0.9, "h": 1.5}, "frames": "s3://<captures>/.../frames.zip"}}'

    # A cut-out, modelled as it is: the golden test (L-14)
    python worker.py --input s3://<bucket>/.../cutout.png --output s3://<bucket>/.../<model>/ [--params '{"seed": 7}']

| | |
|---|---|
| Input: video | With `machine` in `--params`: the 360 video (`.mov` or `.mp4`, at most 2 GB) and, when the app sent them, the ARKit frames. In order: frames are picked (`frames.py`, before the model is loaded, so an unusable walk costs no GPU time); the model is loaded; the machine is cut out of the best frame with the pipeline's BiRefNet (`segment.py`); the cut-out is modelled. `box` is the scanned size in metres, which the cut-out checks the outline against. |
| Input: measured | With `machine.route` `measured`: the ARKit frames only (`machine.frames`, required). Rebuilt from their depth by `measured.py`, with a photo texture baked from the same frames (`bake.py`); no weights are fetched and no model loaded. |
| Input: cut-out | Without `machine`: the cut-out itself (`cutout.py`), RGBA PNG or WebP on a transparent background, checked before the model is loaded. |
| `--params` | Generation settings: `seed`, `resolution` (512, 1024, 1536), sampler steps and guidance, `decimation_target`, `texture_size`. Defaults and bounds are Microsoft's (`trellis_model.settings`); the seed is recorded with every model. |
| Weights | Copied from our S3 copy (`WEIGHTS_S3`) to `WEIGHTS_DIR` and checked against the lock; a host that already holds them, untouched, skips the copy and the hashing. |
| Output | `model.glb`, and `metadata.json`: model, weights digest, installed versions, GPU, input (SHA-256; from a video also its size, the box, the frames' coverage and the frame cut out), settings, GLB size and SHA-256, timings. From a video, also `frames.json`, `cutout.json` and `cutout.png`; measured, `measured.json`. |
| Failure | `error.json` with `kind` (`input` or `internal`) and the reason; from a video, beside whatever of `frames.json`, `cutout.json` and `cutout.png` it got as far as. |
| Exit code | 0 done; 2 the input cannot be used (do not retry); 1 anything else (may be retried). |

The backend gives each try its own `--output` folder (`try-<n>/`), so a try never finds another's files.

The model-facing code (`trellis_model.py`) is the Digital Twin worker's, unchanged: its settings, defaults, ranges and export call were compared with that file mechanically, field by field. Gone with RunPod: base64 in and out (and the response size limit it ran into). Gone from the image: nvdiffrec (preview videos only) and `SPCONV_ALGO` (a TRELLIS 1 setting).

## The image and the weights in AWS (L-09)

- **Image.** Two stages: `build` compiles everything on the CUDA 12.4 development image; `runtime` is the slim CUDA 12.4 runtime image with the build's Python environment, `gcc` (Triton compiles a small launcher the first time it runs a kernel), FlexGEMM's tuned kernel settings, and the worker. It runs as its own user, with Hugging Face offline. Built in the tooling account by the `flexgym-trellis2-image` CodeBuild project (`infra/lib/trellis2-image.ts`), started by hand, and pushed to ECR `flexgym/trellis2` (tags never move; scanned on push; staging and prod pull from it).
- **Weights.** Copied once per environment into its models bucket in Sydney by `publish_weights.py`, under `gpu/trellis2/weights/<lock digest>/`. The worker reads the folder its own lock names, so an image and the weights it was built for always match.
- **Release.** A new image is used only after the golden test passes on it (L-14) and a person approves it; the image pipeline then commits its digest into `cdk.json`, and it ships with the next release (N-05).

- **Where jobs run (L-10).** `infra/lib/gpu-stack.ts`: AWS Batch in Sydney on g6e.xlarge (one L40S), no hosts while idle and at most `gpuMaxInstances` (cdk.json) when busy, Amazon Linux 2023 with NVIDIA drivers. Each host mounts its local NVMe disk at `/weights`, so the 18 GB of weights are copied once per host, not per job. A job may read the weights, read machines' videos and frames (`accounts/*/captures/*/equipment/*` in the captures bucket), and read and write under `models/accounts/*/assets/*`, nothing else; it has an hour, three attempts, and none after exit code 2 (bad input). Job outcomes (succeeded or failed) go through EventBridge to the `gpu-jobs` queue for the backend. The stack exists only once `cdk.json` names an approved image by digest (`trellis2Image`).

How to do each step: `docs/runbooks/trellis2-worker.md`.

## Open before the first real run

- **DINOv3 access.** The repository is gated: Meta approves access by hand, to the company's Hugging Face account, after the licence is accepted by someone who can bind the company. Until then its three files have no SHA-256 in the lock and `fetch_weights.py` refuses them. Once approved, run `lock_weights.py` with that account's `HF_TOKEN` and commit the lock.
- **nvdiffrast licence (O-07, Legal).** TRELLIS.2's GLB export imports nvdiffrast to bake textures. Its licence (NVIDIA Source Code License, "1-Way Commercial", unchanged since 2020) limits use to non-commercial research or evaluation, except by NVIDIA (section 3.3). It must be cleared, licensed from NVIDIA, or replaced before models are made for customers.
