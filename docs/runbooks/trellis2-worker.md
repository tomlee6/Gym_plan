# TRELLIS.2 worker: image, weights and release (L-09)

The GPU job that turns a machine's cut-out into its 3D model runs Microsoft's TRELLIS.2 in a container on AWS Batch in Sydney. Its code is `gpu/trellis2/` (see its README for what is pinned and why). This runbook covers getting a new image and the model weights into use. Owner: 3D team.

Three things have to be in place, in this order:

1. **The weights**, copied once per environment into that environment's models bucket.
2. **An image**, built in the tooling account and pushed to ECR `flexgym/trellis2`.
3. **That image approved**: the golden test passed on it, a person approved it, and its digest is in `cdk.json`, which the next release deploys. The image pipeline does steps 2 and 3 (N-05).

## 1. Copy the weights into S3 (once per environment, and again whenever the lock changes)

Before the first time: DINOv3 is gated. Someone who can bind the company accepts its licence on Hugging Face from the company's account, Meta approves access, and `gpu/trellis2/lock_weights.py` is run with that account's `HF_TOKEN` to lock DINOv3's hashes (see the README). Until then the copy refuses to start.

On a machine with about 20 GB free, Python 3.11, `boto3`, and credentials that can write the environment's models bucket (an EC2 instance in that account in Sydney is quickest):

```sh
cd gpu/trellis2
HF_TOKEN=<company token> python publish_weights.py s3://<models-bucket>/gpu/trellis2/weights/ --work /data/trellis2-weights
```

It downloads each locked file from Hugging Face, checks it against the lock, uploads everything under `gpu/trellis2/weights/<lock digest>/`, checks the uploaded sizes, and writes `READY` last. It can be run again to resume or check. A new lock goes to a new folder; delete an old folder only once no image that uses it is in service.

## 2 and 3. Build an image, test it, approve it (the image pipeline, N-05)

A new image is built, tested and offered for approval by its own pipeline in the tooling account, `flexgym-trellis2-image` (`infra/lib/trellis2-image.ts`). It is not part of the release: compiling takes hours, and an image must pass the golden test on a GPU first.

**When it starts.** A push to the release branch that changes what the image is built from: the Dockerfile, `buildspec.yml`, or a file the Dockerfile copies in (`gpu/trellis2/release.py changed` decides). A change to a README, a test or the rest of the app does not start it. To start it by hand (tooling account, ap-southeast-2):

```sh
aws codepipeline start-pipeline-execution --name flexgym-trellis2-image
```

**What it does:**

1. **Build.** It runs the checks in `gpu/trellis2/tests`, compiles the CUDA extensions (two to four hours), and pushes `flexgym/trellis2:<commit>-<build number>`. Its digest goes to the next steps.
2. **Golden.** The golden test (L-14) runs on that digest on **staging's** GPUs, as the role staging keeps for it (`flexgym-trellis2-golden-test`, which only the pipeline's runner can assume). It runs one fixed job before anything uses the image:
   - the input is Microsoft's own example cut-out (`gpu/trellis2/golden/input.png`), with Microsoft's default settings and seed 42;
   - it runs under a temporary copy of the job definition, so the live one is untouched.

   Its model is compared with `gpu/trellis2/golden/reference.json`:
   - valid and textured, filling TRELLIS.2's unit cube;
   - triangles within 5 %, file size within 15 %;
   - generation no slower than 1.5 times the reference.

   Changed versions are listed in the step's log. A failure stops the pipeline here: the image is not used.
3. **Approve.** The pipeline waits for a person. The approval names the digest and where the golden model is: `models/accounts/_golden/assets/release-<build>/out/model.glb` in staging's models bucket. Download it and look at it. Approve only if it looks right; reject otherwise.
4. **Adopt.** The digest is committed into `infra/cdk.json`, as `trellis2Image` for every environment that has a GPU environment. An environment without one is left alone. The release pipeline then deploys it to staging, and to prod on its own approval.

**Docker Hub pull limits.** The base images come from Docker Hub, which limits anonymous pulls from shared build hosts. If a build fails pulling `pytorch/pytorch`, set up an ECR pull-through cache once in the tooling account:
- a Docker Hub access token in Secrets Manager under `ecr-pullthroughcache/docker-hub`;
- a pull-through cache rule with prefix `docker-hub` for `registry-1.docker.io`.

Then start the pipeline with:

```sh
aws codepipeline start-pipeline-execution --name flexgym-trellis2-image \
  --variables name=BASE_REGISTRY,value=<tooling account>.dkr.ecr.ap-southeast-2.amazonaws.com/docker-hub
```

The image digests in the Dockerfile stay the same either way.

**By hand.** The golden test can still be run from a laptop, with credentials in the environment's account that can do what `flexgym-trellis2-golden-test` can:
- register and deregister job definitions, and pass the job's two roles;
- submit and describe jobs;
- read and write `models/accounts/_golden/` in the models bucket.

```sh
cd gpu/trellis2
python golden.py --image <tooling account>.dkr.ecr.ap-southeast-2.amazonaws.com/flexgym/trellis2@sha256:<digest> --env staging
```

**The very first image.** There is no GPU environment and no reference yet. Put the first image in `cdk.json` for **dev only** and deploy dev (that creates its `Gpu` stack), copy the weights into dev's bucket (step 1), then run `golden.py --env dev`. It saves the model and reports that there is no reference. Look at the model; if it is right, run it again with `--record` and commit `golden/reference.json`.

From then on, the image pipeline runs the golden test on staging, so staging needs its GPU environment too:
1. Put the same digest under `staging` in `cdk.json` and release.
2. Copy the weights into staging's bucket (step 1).

After that, every new image goes through the pipeline. Its Adopt step updates every environment that already has a GPU environment. Prod gets one the first time a person puts a digest under `prod`.

## When a job fails

The job writes `error.json` into its try's folder (`models/accounts/<account>/assets/<model>/try-<n>/`), with `kind` and `reason`. A build from a video also leaves whatever of `frames.json`, `cutout.json` and `cutout.png` it got as far as, so you can see which frames were picked and why each cut-out candidate was turned down.

| Exit | `kind` | Meaning | Retried |
|---|---|---|---|
| 2 | `input` | The video or frames are missing, too large, unreadable or too short; too few usable frames; no frame shows the whole machine on its own; a measured build with no ARKit frames, or with nothing solid in the middle of them; or (golden test) the cut-out is missing or not a cut-out | No |
| 1 | `internal` | Anything else: out of GPU memory, weights not matching the lock, a fault | By Batch |

"Weights not matching the lock" means the S3 copy is incomplete or from another lock: run step 1 again for the lock in the image.

The backend shows the reviewer the `input` reason as it is, and an `internal` one as "The GPU worker failed: …". When the job left no `error.json` (a timeout, a host lost three times), it shows Batch's own reason.

## Following a build

1. **Submitted.** When a machine's 360 video finishes uploading, the backend queues a build (`ASSET_AUTO_BUILD`); a reviewer can also build one, or build again, in the editor. The `asset.build` job submits one Batch job named `machine-model-<model id>-try-<n>` and stores its id on the model (`machine_models.gpu_job_id`). The model is `building`.
2. **On the GPU.** Batch log group `/flexgym/<env>/trellis2`, stream prefix `trellis2`. The job's last line is either `{"done": ...}` or `{"failed": ...}`.
3. **Back.** Batch's SUCCEEDED or FAILED event goes through EventBridge to the `gpu-jobs` queue. The backend worker reads it and moves the model to `awaiting_review` (or `failed`, with the reason). A message the worker cannot handle comes back after 15 minutes, and goes to the `gpu-jobs` dead-letter queue after repeated failures.
4. **Stuck.** Every 15 minutes the worker asks Batch about any model still `building` six hours after its job was submitted. A finished job is settled as if its event had arrived; a job Batch no longer knows of fails the model with "The GPU job was lost. Build again."

Alarms watch each step (N-03). These cover a build that fails for a reason of ours, one on the GPU for more than 90 minutes, and outcomes waiting on the `gpu-jobs` queue or in its dead-letter queue. What to do when one fires is in `3d-alarms.md`.

To build one machine again by hand, as a reviewer: `POST /v1/review/machines/<machine id>/models`, with `{"route": "measured"}` for a model rebuilt from its ARKit frames (L-04).

To try the measured route without the app, on the sample walk:

    python gpu/trellis2/sample_arkit.py --out sample-frames.zip
    python gpu/trellis2/measured.py --frames sample-frames.zip --out made/ --box 0.8,1.9,1.45

## The route test (L-01)

Which route makes the main machine models, measured (L-04) or TRELLIS.2 (L-05), is decided on five real machines: chrome, black rubber, one against a wall, one in a row, and a large one. `gpu/trellis2/route_test.py` runs both routes on each and writes `report.md` and `report.json`. It covers time, file size, triangles, size against the tape-measured truth, and, for made-up machines, completeness and accuracy. Each model is written beside the report for a person to judge the look.

1. **Record** each machine with the app (I-05: video and ARKit frames), and measure its width, depth and height with a tape.
2. **Describe** them in `machines.json`:

       [{"name": "chrome", "frames": "chrome/frames.zip", "video": "chrome/360.mov", "size": {"w": 1.2, "d": 1.0, "h": 2.1}}, ...]

3. **Run** on a GPU host with the approved image and the weights at `/weights`, with the folder holding `machines.json` mounted at `/work`:

       docker run --rm --gpus all -v /weights:/weights -v "$PWD":/work --entrypoint python <image>            /app/route_test.py --out /work/route-test --machines /work/machines.json --routes measured,generated --weights /weights

4. **Look** at each pair of models beside the machine's video. Choose the main route from the figures and the look, and record the choice and why in the task list.

Without real recordings, `--samples` runs it on five made-up machines (`sample_arkit.py`). The measured route runs anywhere; add `--routes measured,generated` on a GPU host to compare TRELLIS.2 too. How the sensor behaves on chrome and black rubber there is an assumption, so those figures test the tool, not the routes.
