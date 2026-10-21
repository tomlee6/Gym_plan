# syntax=docker/dockerfile:1.7
#
# The TRELLIS.2 worker image: one cut-out photo of a gym machine in, a
# textured GLB out. Microsoft's code and model, unchanged; this file only
# installs them.
#
# Every input is pinned (task L-11), so two builds install the same things:
#   - the base image by digest (PyTorch 2.6.0, CUDA 12.4, cuDNN 9, Python 3.11,
#     Ubuntu 22.04: the environment TRELLIS.2's setup.sh documents);
#   - Ubuntu packages from the archive as it stood on one date;
#   - TRELLIS.2 and every CUDA extension it builds, by commit (setup.sh clones
#     CuMesh and FlexGEMM from main, and nvdiffrast by a tag that could move);
#   - Python packages by version and SHA-256 (requirements.lock);
#   - flash-attn from its source archive, by SHA-256, compiled here.
# The model weights are pinned separately, by revision and SHA-256
# (weights.lock.json), and are not in the image.
#
# See README.md for what each pin is and how to move one.

# ---- Pins ---------------------------------------------------------------------
# Where the base images are pulled from: Docker Hub, or an ECR pull-through
# cache of it (<account>.dkr.ecr.ap-southeast-2.amazonaws.com/docker-hub) to
# avoid Docker Hub's pull limits on shared build hosts. The digests below fix
# the images either way.
ARG BASE_REGISTRY=docker.io
ARG BASE_DEVEL=${BASE_REGISTRY}/pytorch/pytorch:2.6.0-cuda12.4-cudnn9-devel@sha256:0cf3402e946b7c384ba943ee05c90b4c5a4a05227923921f2b0918c011cfaf56
ARG BASE_RUNTIME=${BASE_REGISTRY}/pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime@sha256:77f17f843507062875ce8be2a6f76aa6aa3df7f9ef1e31d9d7432f4b0f563dee
ARG UBUNTU_SNAPSHOT=20261012T000000Z
ARG TRELLIS2_COMMIT=75fbf0183001ed9876c8dbb35de6b68552ee08bd
ARG CUMESH_COMMIT=12289e1062f0603f2f0d0771b02e1395d247f26f
ARG FLEXGEMM_COMMIT=6dd94a859c26ee8246888502eada3dd8ad85532e
# v0.4.0
ARG NVDIFFRAST_COMMIT=253ac4fcea7de5f396371124af597e6cc957bfae
ARG UTILS3D_COMMIT=9a4eb15e4021b67b12c460c7057d642626897ec8
# flash_attn-2.7.3.tar.gz on PyPI
ARG FLASH_ATTN_SHA256=9078cf92355c4e3f77f01626ece8c71aad26bdbfa827c2af8c6ac5632cc1cc58

# ---- Build: compile the CUDA extensions -----------------------------------------
FROM ${BASE_DEVEL} AS build
ARG UBUNTU_SNAPSHOT TRELLIS2_COMMIT CUMESH_COMMIT FLEXGEMM_COMMIT NVDIFFRAST_COMMIT UTILS3D_COMMIT FLASH_ATTN_SHA256
# Each flash-attn compile job peaks at 8-9 GB of memory: 4 jobs want a 48 GB builder.
ARG MAX_JOBS=4

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    # Ampere (A10G, 8.6) and Ada (L40S on g6e, 8.9): the GPUs the job may land on.
    TORCH_CUDA_ARCH_LIST="8.6;8.9" \
    # sm_80 code runs on both, and is all flash-attn 2.7.3 builds for them.
    FLASH_ATTN_CUDA_ARCHS=80 \
    FLASH_ATTENTION_FORCE_BUILD=TRUE \
    MAX_JOBS=${MAX_JOBS}

# The base image is what the pins assume, or the build stops here.
RUN python -c "import sys, torch, triton; \
assert sys.version_info[:2] == (3, 11), sys.version; \
assert torch.__version__.startswith('2.6.0'), torch.__version__; \
assert torch.version.cuda == '12.4', torch.version.cuda; \
assert triton.__version__ == '3.2.0', triton.__version__" \
 && . /etc/os-release && test "$VERSION_CODENAME" = jammy

# Ubuntu packages from the dated snapshot only (the CUDA apt repository is set
# aside so nothing is taken from it).
RUN mkdir -p /etc/apt/unused && mv /etc/apt/sources.list.d/* /etc/apt/unused/ 2>/dev/null || true; \
    sed -i -E "s#https?://(archive|security)\.ubuntu\.com/ubuntu/?#https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT}/#g" /etc/apt/sources.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends git build-essential \
 && rm -rf /var/lib/apt/lists/*

# Python packages, exactly as locked.
COPY requirements.lock /tmp/requirements.lock
RUN pip install --require-hashes --no-deps --only-binary=:all: -r /tmp/requirements.lock

# flash-attn, compiled from its source archive (no prebuilt wheel is fetched).
RUN echo "flash-attn==2.7.3 --hash=sha256:${FLASH_ATTN_SHA256}" > /tmp/flash-attn.txt \
 && pip install --require-hashes --no-deps --no-binary=flash-attn --no-build-isolation -r /tmp/flash-attn.txt

# Sources at their commits, submodules at the commits they record; each
# checkout is compared with its pin afterwards.
RUN set -eu; \
    at() { \
      git init -q "$3"; git -C "$3" remote add origin "$1"; \
      git -C "$3" fetch -q --depth 1 origin "$2"; git -C "$3" checkout -q FETCH_HEAD; \
      git -C "$3" submodule update -q --init --recursive; \
      test "$(git -C "$3" rev-parse HEAD)" = "$2"; \
    }; \
    at https://github.com/microsoft/TRELLIS.2.git        "$TRELLIS2_COMMIT"   /src/TRELLIS.2; \
    at https://github.com/JeffreyXiang/CuMesh.git        "$CUMESH_COMMIT"     /src/CuMesh; \
    at https://github.com/JeffreyXiang/FlexGEMM.git      "$FLEXGEMM_COMMIT"   /src/FlexGEMM; \
    at https://github.com/NVlabs/nvdiffrast.git          "$NVDIFFRAST_COMMIT" /src/nvdiffrast; \
    at https://github.com/EasternJournalist/utils3d.git  "$UTILS3D_COMMIT"    /src/utils3d

# The extensions, as setup.sh installs them but without fetching anything:
# --no-deps everywhere, because o-voxel names CuMesh and FlexGEMM as git URLs
# with no commit, which pip would otherwise fetch from main. nvdiffrec is left
# out: TRELLIS.2 uses it only to render preview videos.
RUN pip install --no-deps --no-build-isolation /src/utils3d \
 && pip install --no-deps --no-build-isolation /src/nvdiffrast \
 && pip install --no-deps --no-build-isolation /src/CuMesh \
 && pip install --no-deps --no-build-isolation /src/FlexGEMM \
 && pip install --no-deps --no-build-isolation /src/TRELLIS.2/o-voxel

# Everything installed fits together, and what was installed is written down
# for every model the worker makes to carry.
RUN pip check \
 && mkdir -p /opt/trellis2/licenses \
 && cp -r /src/TRELLIS.2/trellis2 /opt/trellis2/trellis2 \
 && cp /src/TRELLIS.2/LICENSE /opt/trellis2/licenses/TRELLIS.2 \
 && cp /src/CuMesh/LICENSE /opt/trellis2/licenses/CuMesh \
 && cp /src/FlexGEMM/LICENSE /opt/trellis2/licenses/FlexGEMM \
 && cp /src/nvdiffrast/LICENSE.txt /opt/trellis2/licenses/nvdiffrast \
 && cp /src/utils3d/LICENSE /opt/trellis2/licenses/utils3d \
 && python -c "import json, importlib.metadata as md; \
json.dump({'trellis2': '${TRELLIS2_COMMIT}', 'cumesh': '${CUMESH_COMMIT}', 'flexgemm': '${FLEXGEMM_COMMIT}', \
'nvdiffrast': '${NVDIFFRAST_COMMIT}', 'utils3d': '${UTILS3D_COMMIT}', 'ubuntu_snapshot': '${UBUNTU_SNAPSHOT}', \
'python': sorted(f'{d.metadata[\"Name\"]}=={d.version}' for d in md.distributions())}, \
open('/opt/trellis2/versions.json', 'w'), indent=1)"

# ---- Runtime: what a job needs, without the CUDA compilers (L-09) -------------
FROM ${BASE_RUNTIME} AS runtime
ARG UBUNTU_SNAPSHOT

# Triton compiles a small launcher with the system C compiler the first time a
# kernel runs (FlexGEMM's sparse convolutions), so gcc stays; nvcc does not.
RUN mkdir -p /etc/apt/unused && mv /etc/apt/sources.list.d/* /etc/apt/unused/ 2>/dev/null || true; \
    sed -i -E "s#https?://(archive|security)\.ubuntu\.com/ubuntu/?#https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT}/#g" /etc/apt/sources.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gcc libc6-dev \
 && rm -rf /var/lib/apt/lists/*

# The build's Python environment: the same PyTorch as this image's, plus
# everything installed and compiled above.
COPY --from=build /opt/conda /opt/conda
COPY --from=build /opt/trellis2 /opt/trellis2

# A user of its own; FlexGEMM's tuned kernel settings, written to the
# builder's home by its install, go to this user's.
RUN useradd --create-home --uid 1000 worker \
 && mkdir -p /weights && chown worker:worker /weights
COPY --from=build --chown=worker:worker /root/.flex_gemm /home/worker/.flex_gemm

COPY --chown=worker:worker worker.py trellis_model.py cutout.py frames.py segment.py measured.py bake.py route_test.py sample_arkit.py golden.py fetch_weights.py weights.lock.json pipeline.json /app/

# Nothing is fetched at run time: the weights come from our S3 copy, checked.
# Compiled kernels are kept on the host volume beside the weights, for the next job.
ENV PYTHONPATH=/opt/trellis2:/app \
    PYTHONUNBUFFERED=1 \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    ATTN_BACKEND=flash-attn \
    PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
    WEIGHTS_DIR=/weights \
    TRITON_CACHE_DIR=/weights/.cache/triton

USER worker
WORKDIR /home/worker

# The worker's own code loads without a GPU (the model is imported only when a job runs).
RUN python -c "import worker, fetch_weights, cutout, trellis_model, boto3, PIL, torch" \
 && test -s /home/worker/.flex_gemm/autotune_cache.json \
 && test -s /opt/trellis2/versions.json

ENTRYPOINT ["python", "-u", "/app/worker.py"]
