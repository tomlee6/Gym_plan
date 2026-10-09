/**
 * Background jobs (E-01).
 *
 * The `jobs` table is the work list and the outbox at once. A job is
 * written by `enqueue` inside the same transaction as the change that needs
 * it, so the two commit or roll back together: no plan is ever approved
 * without its generation queued, and no generation is queued for an
 * approval that rolled back.
 *
 * After the commit, `jobsCommitted()` moves it along, depending on the driver:
 *
 *   inline  runs due jobs right away, in this process (tests)
 *   db      leaves them for the worker, which polls the table (local work)
 *   sqs     the dispatcher sends each new job's id to SQS and stamps
 *           `enqueued_at`; workers receive from the queue (AWS)
 *
 * Running a job claims it, calls its handler, and records the outcome. A
 * failure is retried with exponential backoff; past `JOB_MAX_ATTEMPTS`, or
 * on an error marked `permanent`, the job is `dead` and its handler's
 * `onDead` puts the work in front of a person (E-02). SQS's own dead-letter
 * queue catches the case where a worker dies mid-job five times over.
 *
 * Handlers are registered by kind (`registerHandler`), so the 3D jobs
 * (plan.generate, asset.build) plug into the same framework.
 */
import { config } from '../config.js';
import { many, one, pool } from '../db/pool.js';
import { newId } from '../ids.js';

const handlers = new Map();

/**
 * `handler` is `{ run(job), onDead?(job, error) }`. `job.payload` is the
 * parsed JSON given to `enqueue`.
 */
export function registerHandler(kind, handler) {
  handlers.set(kind, handler);
}

export function handlerFor(kind) {
  return handlers.get(kind) ?? null;
}

/** An error that retrying cannot fix: the job goes straight to dead. */
export class PermanentJobError extends Error {
  constructor(message) {
    super(message);
    this.permanent = true;
  }
}

/**
 * Queues one job, once: a second enqueue with the same kind and dedupe key
 * returns the first job's id. A job that already died may be queued again,
 * which is how a reviewer retries a failed generation.
 */
export async function enqueue(db, { kind, subjectId, accountId = null, dedupeKey = subjectId, payload = null, runAfter = null }) {
  const id = newId();
  await db.query(
    `INSERT INTO jobs (id, account_id, kind, subject_id, dedupe_key, payload, run_after)
     VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, UTC_TIMESTAMP(3))) AS fresh
     ON DUPLICATE KEY UPDATE
       payload = IF(jobs.status = 'dead', fresh.payload, jobs.payload),
       attempts = IF(jobs.status = 'dead', 0, jobs.attempts),
       last_error = IF(jobs.status = 'dead', NULL, jobs.last_error),
       enqueued_at = IF(jobs.status = 'dead', NULL, jobs.enqueued_at),
       finished_at = IF(jobs.status = 'dead', NULL, jobs.finished_at),
       run_after = IF(jobs.status = 'dead', fresh.run_after, jobs.run_after),
       -- Last, so the tests above still see the old status.
       status = IF(jobs.status = 'dead', 'queued', jobs.status)`,
    [id, accountId, kind, subjectId, dedupeKey, payload ? JSON.stringify(payload) : null, runAfter],
  );
  const row = await one(db, 'SELECT id FROM jobs WHERE kind = ? AND dedupe_key = ?', [kind, dedupeKey]);
  return row.id;
}

/** Retry delay after `attempts` tries: 30 s, 1 min, 2 min … capped at an hour. */
export function backoffSeconds(attempts) {
  return Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));
}

/** A job left `running` this long was abandoned by a worker that died. */
const STALE_RUNNING_MINUTES = 30;

/**
 * Metrics in CloudWatch's embedded format: a JSON log line the agent turns
 * into `FlexGym/Jobs` metrics, which the pipeline-failure alarm watches
 * (M-11). Nothing is printed in tests.
 */
function metric(name, kind) {
  if (config.env === 'test') return;
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{ Namespace: 'FlexGym/Jobs', Dimensions: [['Kind']], Metrics: [{ Name: name, Unit: 'Count' }] }],
      },
      Kind: kind,
      [name]: 1,
    }),
  );
}

/**
 * Runs one job if it is due and not already being run. Returns the outcome,
 * or null if someone else has it.
 */
export async function runJob(id) {
  const [claimed] = await pool.query(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = UTC_TIMESTAMP(3)
     WHERE id = ? AND run_after <= UTC_TIMESTAMP(3)
       AND (status IN ('queued', 'failed')
            OR (status = 'running' AND started_at < UTC_TIMESTAMP(3) - INTERVAL ${STALE_RUNNING_MINUTES} MINUTE))`,
    [id],
  );
  if (!claimed.affectedRows) return null;
  const job = await one(pool, 'SELECT * FROM jobs WHERE id = ?', [id]);
  const handler = handlers.get(job.kind);

  try {
    if (!handler) throw new PermanentJobError(`No worker handles ${job.kind} jobs.`);
    await handler.run(job);
    await pool.query(
      `UPDATE jobs SET status = 'succeeded', finished_at = UTC_TIMESTAMP(3), last_error = NULL WHERE id = ?`,
      [id],
    );
    metric('JobsSucceeded', job.kind);
    return 'succeeded';
  } catch (err) {
    const message = String(err?.message ?? err).slice(0, 4000);
    const dead = err?.permanent || job.attempts >= config.jobs.maxAttempts;
    if (dead) {
      await pool.query(
        `UPDATE jobs SET status = 'dead', finished_at = UTC_TIMESTAMP(3), last_error = ? WHERE id = ?`,
        [message, id],
      );
      metric('JobsDead', job.kind);
      if (config.env !== 'test') console.error(`Job ${job.kind} ${id} died: ${message}`);
      try {
        await handler?.onDead?.(job, err);
      } catch (deadErr) {
        console.error(`onDead for ${job.kind} ${id} failed:`, deadErr);
      }
      return 'dead';
    }
    await pool.query(
      `UPDATE jobs SET status = 'failed', last_error = ?, enqueued_at = NULL,
              run_after = UTC_TIMESTAMP(3) + INTERVAL ? SECOND
       WHERE id = ?`,
      [message, backoffSeconds(job.attempts), id],
    );
    metric('JobsFailed', job.kind);
    return 'failed';
  }
}

/** Ids of the jobs that are due, oldest first. */
async function dueJobs(limit = 20) {
  const rows = await many(
    pool,
    `SELECT id FROM jobs
     WHERE status IN ('queued', 'failed') AND run_after <= UTC_TIMESTAMP(3)
     ORDER BY run_after, id LIMIT ?`,
    [limit],
  );
  return rows.map((r) => r.id);
}

/**
 * Runs every due job, including any they queue, until none is left.
 * The inline driver and the `db` worker loop use it; tests call it to
 * let background work finish.
 */
export async function runDueJobs({ max = 200 } = {}) {
  let ran = 0;
  for (;;) {
    const ids = await dueJobs();
    if (!ids.length || ran >= max) return ran;
    for (const id of ids) {
      if ((await runJob(id)) !== null) ran++;
    }
  }
}

/** Sends new and retry-due jobs to SQS (the outbox), stamping each once sent. */
export async function dispatch(queue) {
  const rows = await many(
    pool,
    `SELECT id, kind FROM jobs
     WHERE enqueued_at IS NULL AND status IN ('queued', 'failed') AND run_after <= UTC_TIMESTAMP(3)
     ORDER BY run_after LIMIT 50`,
  );
  for (const row of rows) {
    await queue.send({ jobId: row.id, kind: row.kind });
    await pool.query('UPDATE jobs SET enqueued_at = UTC_TIMESTAMP(3) WHERE id = ? AND enqueued_at IS NULL', [row.id]);
  }
  return rows.length;
}

let sqsQueue = null;

/** The SQS queue, made on first use so tests never load the SDK client. */
export async function queue() {
  if (!sqsQueue) {
    const { SqsQueue } = await import('./sqs.js');
    sqsQueue = new SqsQueue({ url: config.jobs.queueUrl, region: config.awsRegion });
  }
  return sqsQueue;
}

/**
 * Call after committing a transaction that queued jobs. Never throws: the
 * jobs are safely in the table, and the worker will get to them anyway.
 */
export async function jobsCommitted() {
  try {
    if (config.jobs.driver === 'inline') await runDueJobs();
    else if (config.jobs.driver === 'sqs') await dispatch(await queue());
  } catch (err) {
    console.error('Could not hand jobs on straight away:', err);
  }
}
