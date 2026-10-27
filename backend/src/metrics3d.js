/**
 * The 3D work's own metrics (task N-03), in CloudWatch's embedded metric
 * format like the jobs' (jobs/index.js): a JSON log line that becomes a
 * metric in the FlexGym/3D namespace. The 3D alarms watch them
 * (infra/lib/models-monitoring.ts; what to do when one fires is in
 * docs/runbooks/3d-alarms.md).
 *
 * A failure is counted twice: once by its reason, for the dashboard, and,
 * when it is ours to look at rather than the plan's or the recording's, once
 * more as a fault, which is what the alarms watch.
 *
 * Nothing is printed in tests; a test can catch what would be (`catchMetrics`).
 */
import { config } from './config.js';

export const NAMESPACE_3D = 'FlexGym/3D';

/** J-09's codes for a plan the reviewer fixes in the editor. Any other reason a level fails is a fault. */
export const PLAN_REASONS = ['too_few_walls', 'open_outline'];

/** Why a machine model failed (`ModelsFailed`, dimension Cause). All but `input` are faults. */
export const CAUSES = Object.freeze({
  input: 'input', // the recording or scan cannot be used, or changed: the reviewer's to act on
  gpu: 'gpu', // the GPU worker failed, or Batch stopped it (a timeout, a host lost)
  ready: 'ready', // L-06 could not make the GPU's model ready for the walkthrough
  lost: 'lost', // the GPU job's outcome never came back
  job: 'job', // the asset.build job itself gave up (sending to the GPU, or a turn)
});

let sink = config.env === 'test' ? () => {} : (line) => console.log(line);

/** Publishes one value of a metric with its dimensions, e.g. ('LevelsFailed', { Reason: 'too_large' }). */
export function metric3d(name, dimensions = {}, { value = 1, unit = 'Count' } = {}) {
  sink(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{ Namespace: NAMESPACE_3D, Dimensions: [Object.keys(dimensions)], Metrics: [{ Name: name, Unit: unit }] }],
      },
      ...dimensions,
      [name]: value,
    }),
  );
}

/**
 * Counts a level that failed for good (plan.generate's onDead), by the code
 * at the end of its reason (J-09). Returns the code.
 */
export function levelFailed(err) {
  const reason = /\[([a-z_]+)\]\s*$/.exec(String(err?.message ?? err ?? ''))?.[1] ?? 'other';
  metric3d('LevelsFailed', { Reason: reason });
  if (!PLAN_REASONS.includes(reason)) metric3d('LevelFaults');
  return reason;
}

/** Counts a machine model that failed for good, by its cause (CAUSES). */
export function modelFailed(cause) {
  metric3d('ModelsFailed', { Cause: cause });
  if (cause !== CAUSES.input) metric3d('ModelFaults');
}

/**
 * For tests: every metric published from now until `stop()`, each as
 * { name, value, unit, ...dimensions }.
 */
export function catchMetrics() {
  const was = sink;
  const seen = [];
  sink = (line) => {
    const { _aws, ...rest } = JSON.parse(line);
    const [{ Namespace, Dimensions: [keys], Metrics: [{ Name, Unit }] }] = _aws.CloudWatchMetrics;
    seen.push({ namespace: Namespace, name: Name, value: rest[Name], unit: Unit, ...Object.fromEntries(keys.map((k) => [k, rest[k]])) });
  };
  return { seen, stop: () => (sink = was) };
}
