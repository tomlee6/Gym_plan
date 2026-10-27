/**
 * The background worker (E-01): runs jobs until told to stop.
 *
 *   npm run worker
 *
 * With QUEUE_DRIVER=sqs it dispatches the outbox to SQS and receives from
 * it; with QUEUE_DRIVER=db it polls the jobs table directly. Either way it
 * queues the daily retention sweep (E-05) and answers /health on
 * WORKER_HEALTH_PORT for the container health check.
 */
import http from 'node:http';

import { config } from './config.js';
import { pool } from './db/pool.js';
import { queueDailyRetention } from './jobs/handlers.js';
import { dispatch, queue, runDueJobs, runJob } from './jobs/index.js';
// Installs the 3D generator for plan.generate when GENERATOR_DRIVER=glb.
import './generator/index.js';
import './assets/index.js';
import { gpuJobsQueue, pollGpuOutcomes, publishBuildGauges, sweepStuckBuilds } from './assets/outcomes.js';

let stopping = false;
let lastLoopAt = Date.now();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function retentionLoop() {
  while (!stopping) {
    try {
      await queueDailyRetention();
    } catch (err) {
      console.error('Could not queue retention:', err);
    }
    await sleep(60 * 60 * 1000);
  }
}

async function dbLoop() {
  while (!stopping) {
    lastLoopAt = Date.now();
    try {
      const ran = await runDueJobs({ max: 20 });
      if (!ran) await sleep(config.jobs.pollMs);
    } catch (err) {
      console.error('Worker loop:', err);
      await sleep(config.jobs.pollMs);
    }
  }
}

async function sqsLoops() {
  const q = await queue();
  const dispatcher = (async () => {
    while (!stopping) {
      try {
        if (!(await dispatch(q))) await sleep(config.jobs.pollMs);
      } catch (err) {
        console.error('Dispatcher:', err);
        await sleep(config.jobs.pollMs);
      }
    }
  })();
  while (!stopping) {
    lastLoopAt = Date.now();
    try {
      for (const message of await q.receive()) {
        if (message.body.jobId) await runJob(message.body.jobId);
        // The outcome is in the jobs table; a retry is re-dispatched from there.
        await message.done();
      }
    } catch (err) {
      console.error('Receiver:', err);
      await sleep(config.jobs.pollMs);
    }
  }
  await dispatcher;
}

/**
 * Outcomes of machine model jobs on the GPU (L-05); every 5 minutes, how
 * the builds on it stand (N-03); and every 15, a sweep for any that went
 * missing.
 */
async function gpuLoop() {
  const q = await gpuJobsQueue();
  let swept = 0;
  let measured = 0;
  while (!stopping) {
    try {
      await pollGpuOutcomes(q);
      if (Date.now() - measured > 5 * 60 * 1000) {
        measured = Date.now();
        await publishBuildGauges();
      }
      if (Date.now() - swept > 15 * 60 * 1000) {
        swept = Date.now();
        await sweepStuckBuilds();
      }
    } catch (err) {
      console.error('GPU outcomes:', err);
      await sleep(config.jobs.pollMs);
    }
  }
}

const health = http
  .createServer(async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      // A loop stuck for five minutes is unhealthy, so ECS replaces the task.
      const ok = Date.now() - lastLoopAt < 5 * 60 * 1000;
      res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok }));
    } catch {
      res.writeHead(503).end('{"ok":false}');
    }
  })
  .listen(config.jobs.workerHealthPort);

console.log(`Gym Plan worker (${config.env}, queue: ${config.jobs.driver})`);
const main = Promise.all([
  retentionLoop(),
  config.jobs.driver === 'sqs' ? sqsLoops() : dbLoop(),
  ...(config.assets.builder === 'trellis2' ? [gpuLoop()] : []),
]);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    health.close();
    // Finish the job in hand, then go.
    Promise.race([main, sleep(30000)]).finally(() => pool.end().finally(() => process.exit(0)));
  });
}
