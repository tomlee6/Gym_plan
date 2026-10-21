# 3D alarms: levels and machine models (N-03)

What to do when one of the 3D team's alarms fires. Owner: 3D team. The alarms go to the environment's alarm topic (email, and Slack where set up) like every other alarm, and each tells you when it clears.

| Alarm | Fires when | Section |
|---|---|---|
| `flexgym-<env>-3d-level-faults` | A level failed for good, for a reason that is ours, not the plan's | [Level faults](#level-faults) |
| `flexgym-<env>-3d-model-faults` | A machine model failed for good, for a cause that is ours, not the recording's | [Machine model faults](#machine-model-faults) |
| `flexgym-<env>-3d-builds-stuck` | A machine model has been on the GPU for more than 90 minutes | [Builds stuck on the GPU](#builds-stuck-on-the-gpu) |
| `flexgym-<env>-3d-gpu-outcomes-old` | A GPU job's outcome has waited on the `gpu-jobs` queue for more than 15 minutes, for 5 minutes | [GPU outcomes waiting](#gpu-outcomes-waiting) |
| `flexgym-<env>-gpu-jobs-dlq-not-empty` | A GPU job's outcome could not be handled five times | [GPU outcomes in the dead-letter queue](#gpu-outcomes-in-the-dead-letter-queue) |

A level or model job that dies also raises the general `flexgym-<env>-jobs-dead` alarm. When both fire, follow this runbook.

## Before you start

**The dashboard.** CloudWatch dashboard `flexgym-<env>` has a row "3D: levels and machine models". It shows:
- levels built, and failed by their J-09 code;
- machine models built by route, and failed by cause;
- the builds on the GPU, and how long ago the oldest was sent there.

**The metrics.** These are published by the backend in namespace `FlexGym/3D` (`backend/src/metrics3d.js`). The full list is in `docs/3d-contract.md`, "Monitoring (N-03)".

**Faults and other failures.** A failure is counted by its reason. When the reason is ours, it is also counted as a fault, and only faults raise an alarm:
- **The plan's or the recording's.** A plan whose walls do not meet, or a video that shows no machine, is the reviewer's to fix. It is already in front of them with its reason, so it raises no alarm.
- **Ours.** Everything else, for the 3D team to look at.

**Where to look:**
- **Backend worker log:** log group `/flexgym/<env>/worker`.
- **GPU jobs' log:** log group `/flexgym/<env>/trellis2`.
- **The database:** connect from inside the VPC, as in `database-restore.md`, section 3.
- **AWS Batch:** job queue `flexgym-<env>-trellis2`.

A query that finds what the worker said about a failure, for CloudWatch Logs Insights on the worker log:

```
fields @timestamp, @message
| filter @message like /died|3D build of plan version|GPU outcome|GPU outcomes|Could not delete the old model file/
| sort @timestamp desc
| limit 50
```

## Level faults

A level is the 3D model of one floor, built from the approved plan (J-01). This alarm means one failed for good, and the review queue shows it as `generation_failed` with its reason. The code at the end of the reason (J-09) says what happened:

| Code | What it means | What to do |
|---|---|---|
| `build_error` | A fault in the generator itself. The worker log has the whole error: search for `3D build of plan version <id> failed`. | Reproduce it from the version's `plan_json`, using `buildLevel` in `shared/build3d`, then fix and release. Changing the plan may get round it in the meantime. |
| `too_large` | The level is over the size limit (`GENERATOR_MAX_BYTES`, 25 MB). | Find what made it large: a huge floor, or many curved walls. That is a generator matter: ask the 3D team. Do not raise the limit without checking the walkthrough budget (`docs/3d-contract.md`, K-04). |
| `no_plan` | The approved version has no plan or no content hash: a data fault. | Look at the version's row. It should not happen; find how it was approved without one. |
| `store_failed` | The level could not be saved to the models bucket after all the job's tries. | Check the worker can write to the models bucket and use its KMS key. Look for S3 or KMS errors in the worker log at that time. |
| `other` | No code: something unforeseen, such as the database lost mid-job. | The worker log has `Job plan.generate <job id> died: <reason>`. |

The failed levels, newest first:

```sql
SELECT v.id AS version_id, v.plan_id, v.version_no, g.failure_reason, g.finished_at
FROM generated_models g JOIN plan_versions v ON v.id = g.plan_version_id
WHERE g.status = 'failed'
ORDER BY g.finished_at DESC
LIMIT 20;
```

**When the cause is fixed,** a reviewer tries the version again from the review queue (`POST /v1/review/versions/<version id>/regenerate`). It builds the same plan again; a fixed fault lets it through.

## Machine model faults

A machine model is the 3D model of one machine, made on the GPU from its 360 video or ARKit frames (L-05, L-04). This alarm means one failed for good, for one of these causes (dimension `Cause` on `ModelsFailed`):

| Cause | What it means | What to do |
|---|---|---|
| `gpu` | The GPU worker failed (its `error.json` says `internal`), Batch stopped the job (a timeout, a host lost three times), or the job said it succeeded but left no model. | Describe the job (below) and read its log stream. "The GPU worker failed" has the worker's own reason. `trellis2-worker.md`, "When a job fails", explains it: out of GPU memory, or weights not matching the lock. If many fail just after a release, the new image is the suspect: go back to the previous digest in `infra/cdk.json` (`trellis2-worker.md`, step 3). |
| `ready` | The GPU's model could not be made ready for the walkthrough (L-06): not a GLB that can be read, no triangles, or flat. The reason says which. | The GPU's own model is kept as `model.glb` in the try's folder (`models/accounts/<account>/assets/<model>/try-<n>/`). Download it and run it through `optimiseModel` in `backend/src/assets/optimise.js`. |
| `lost` | The job's outcome never came back, and six hours on Batch no longer knew the job. | Usually comes after [Builds stuck on the GPU](#builds-stuck-on-the-gpu) or [GPU outcomes waiting](#gpu-outcomes-waiting). Look there for why outcomes went missing. |
| `job` | The backend's `asset.build` job gave up. It could not send the build to Batch, or a reviewer's turn could not be made. | The worker log has `Job asset.build <job id> died: <reason>`. "The GPU job queue is not set up here" means `TRELLIS2_JOB_QUEUE` is missing from the worker; Batch access errors mean the worker role lacks `batch:SubmitJob` or `batch:ListJobs`. |

The failed models, with their cause, newest first:

```sql
SELECT created_at,
       JSON_UNQUOTE(JSON_EXTRACT(detail, '$.modelId')) AS model_id,
       JSON_UNQUOTE(JSON_EXTRACT(detail, '$.cause')) AS cause,
       JSON_UNQUOTE(JSON_EXTRACT(detail, '$.reason')) AS reason
FROM audit_log
WHERE action = 'MACHINE_MODEL_FAILED'
ORDER BY created_at DESC
LIMIT 20;
```

Then look at the GPU job, by the model's `gpu_job_id` (`SELECT route, attempt, gpu_job_id FROM machine_models WHERE id = '<model id>'`):

```sh
aws batch describe-jobs --jobs <gpu_job_id> \
  --query 'jobs[0].{status:status,reason:statusReason,attempts:attempts[*].{exit:container.exitCode,reason:container.reason,log:container.logStreamName}}'
```

**When the cause is fixed,** a reviewer builds the machine again in the editor (`POST /v1/review/machines/<machine id>/models`, with `{"route": "measured"}` for the measured route). Each build is a new try in its own folder.

## Builds stuck on the GPU

The worker publishes, every 5 minutes, how long ago the oldest model still `building` was sent to the GPU. A build normally takes minutes. This alarm means one has taken more than 90 minutes: longer than a whole attempt on the GPU (an hour) and a host's start.

The worker would give up on it by itself at six hours. This alarm is so that someone finds out why first.

Which builds, oldest first:

```sql
SELECT id, machine_id, route, attempt, gpu_job_id, TIMESTAMPDIFF(MINUTE, updated_at, UTC_TIMESTAMP()) AS minutes
FROM machine_models
WHERE status = 'building' AND gpu_job_id IS NOT NULL
ORDER BY updated_at
LIMIT 20;
```

Then ask Batch about the oldest (`aws batch describe-jobs --jobs <gpu_job_id>`), and go by its status:

- **`RUNNABLE` (or `SUBMITTED`, `PENDING`) all this time: no GPU host came up.** Look at the job queue's compute environment:

  ```sh
  aws batch describe-job-queues --job-queues flexgym-<env>-trellis2 --query 'jobQueues[0].computeEnvironmentOrder'
  aws batch describe-compute-environments --compute-environments <arn> --query 'computeEnvironments[0].{state:state,status:status,reason:statusReason}'
  ```

  - **No hosts at all.** The usual reason is the "Running On-Demand G and VT instances" quota: new accounts have 0. See `service-quotas.md`, section 1.
  - **Hosts could not be had.** The EC2 console's Auto Scaling activity for the environment says if Sydney had no `g6e.xlarge` capacity. The jobs start when capacity returns.
  - **Every host busy.** Many builds at once queue behind `gpuMaxInstances` (`infra/cdk.json`). Raise it if this is the normal load, and the quota with it.
- **`RUNNING` with more than one attempt:** the earlier attempts failed and Batch tried again. Each attempt's log stream says why. Usually this ends as a failure, with its own alarm.
- **`RUNNING`, first attempt, close to an hour:** a slow build. Batch stops it at the hour, and it fails with "ran out of time".
- **`SUCCEEDED` or `FAILED`:** the job is over, but its outcome has not reached the backend. See [GPU outcomes waiting](#gpu-outcomes-waiting). The six-hour sweep settles it by asking Batch. If a reviewer is waiting, they can build again; when the old try's outcome comes, it is ignored.

The alarm clears by itself once nothing on the GPU is older than 90 minutes.

## GPU outcomes waiting

Batch's "job finished" events go through EventBridge to the `flexgym-<env>-gpu-jobs` queue, which the backend worker reads. This alarm means the oldest has waited more than 15 minutes, for 5 minutes. A message the worker cannot handle comes back after 15 minutes. So either nobody is reading the queue, or the worker fails on a message every time.

1. **Is the worker running?** Check ECS service `flexgym-<env>-worker`. Its environment must have `ASSET_BUILDER=trellis2` and `GPU_JOBS_QUEUE_URL`; without them it does not read this queue. The Api stack sets both when the environment has a GPU stack.
2. **Is it failing on a message?** Search the worker log for `GPU outcome not handled, left on the queue` (one message) and `GPU outcomes:` (the whole loop). Common causes:
   - the database or the models bucket was out of reach;
   - L-06 ran out of memory in the worker task (`The model optimiser stopped`): raise the worker's memory.
3. **Fix the cause.** Messages left on the queue are tried again on their own; nothing needs resending.

After five failed tries (about an hour), a message moves to the dead-letter queue and the next alarm fires.

## GPU outcomes in the dead-letter queue

An outcome the worker failed to handle five times. The model it belongs to is still `building`.

1. **Look at one.** The body is Batch's event. `detail.jobName` is `machine-model-<model id>-try-<n>`, and `detail.status` is `SUCCEEDED` or `FAILED`.

   ```sh
   aws sqs receive-message --queue-url <gpu-jobs-dlq url> --max-number-of-messages 1 --visibility-timeout 60
   ```

2. **Find why it failed.** Search the worker log for `GPU outcome not handled` around the times the message was tried. Fix that first, as in [GPU outcomes waiting](#gpu-outcomes-waiting).
3. **Move the messages back** to the `gpu-jobs` queue, to be handled again:

   ```sh
   aws sqs start-message-move-task --source-arn <gpu-jobs-dlq arn> --destination-arn <gpu-jobs arn>
   ```

   Handling an outcome twice does no harm: an outcome for a model that has moved on is ignored.

If you do nothing, the worker's six-hour sweep asks Batch about the model and settles it all the same. Moving the messages back only does it sooner. Once all are settled, the queue can be emptied (`aws sqs purge-queue`).
