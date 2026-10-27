/**
 * L-06 in a thread of its own. Making a model ready (simplifying it, and
 * above all encoding its textures to KTX2) holds a thread for tens of
 * seconds, and the worker's own thread also answers its health check and
 * runs every other job: so it is done here, and the worker waits for the
 * result without stopping. The encoder's progress lines are dropped.
 *
 * The same module is the thread's code (when started as one) and the
 * function that starts it.
 */
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

import { ModelError, optimiseModel } from './optimise.js';

if (!isMainThread && workerData?.optimise) {
  try {
    const made = await optimiseModel(Buffer.from(workerData.raw), workerData.options);
    parentPort.postMessage({ made });
  } catch (err) {
    parentPort.postMessage({ error: { message: String(err?.message ?? err), model: err instanceof ModelError } });
  }
}

/** optimiseModel, run in a thread of its own. Same result, same errors. */
export function optimiseInThread(raw, options = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { optimise: true, raw: new Uint8Array(raw), options },
      // None of the worker's own command-line flags (a test runner's, say): the thread only needs the code.
      execArgv: [],
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    let stderr = '';
    worker.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    let settled = false;
    worker.once('message', ({ made, error }) => {
      settled = true;
      if (error) {
        reject(error.model ? new ModelError(error.message) : new Error(error.message));
        return;
      }
      // Buffers come back as plain bytes; the rest of the worker expects Buffers.
      for (const lod of made.lods) lod.glb = Buffer.from(lod.glb.buffer, lod.glb.byteOffset, lod.glb.byteLength);
      resolve(made);
    });
    worker.once('error', (err) => {
      settled = true;
      reject(err);
    });
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`The model optimiser stopped (exit ${code})${stderr ? `: ${stderr.trim().slice(-300)}` : ''}`));
    });
  });
}
