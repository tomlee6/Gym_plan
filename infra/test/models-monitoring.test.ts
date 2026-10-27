/**
 * The 3D team's alarms and dashboard row (N-03), in every environment's
 * monitoring stack, on the metrics the backend publishes
 * (backend/src/metrics3d.js).
 *
 * Run: npm test
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { buildApp } from '../lib/app';
import { NAMESPACE_3D, OUTCOME_WAIT, RUNBOOK_3D, STUCK_AFTER } from '../lib/models-monitoring';

const cdkJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8'));

type Resource = { Type: string; Properties?: Record<string, any> };

const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'flexgym-3d-monitoring-'));
const app = new App({ context: { ...cdkJson.context, deployWebAssets: false }, outdir });
const monitoring = buildApp(app)
  .synth()
  .stacksRecursively.find((s) => s.hierarchicalId === 'FlexGym-Dev/Monitoring')!;
const resources = Object.values<Resource>(monitoring.template.Resources ?? {});
const alarms = new Map(
  resources.filter((r) => r.Type === 'AWS::CloudWatch::Alarm').map((r) => [String(r.Properties!.AlarmName), r.Properties!]),
);
const topicId = Object.entries<Resource>(monitoring.template.Resources).find(([, r]) => r.Type === 'AWS::SNS::Topic')![0];

const alarm = (name: string) => {
  const found = [...alarms.entries()].find(([n]) => n.endsWith(`-${name}`));
  assert.ok(found, `an alarm named …-${name}`);
  return found[1];
};

test('an alarm on the first level that fails for a reason of ours, not the plan’s', () => {
  const a = alarm('3d-level-faults');
  assert.deepEqual(
    { ns: a.Namespace, metric: a.MetricName, stat: a.Statistic, period: a.Period, threshold: a.Threshold, op: a.ComparisonOperator, periods: a.EvaluationPeriods },
    { ns: NAMESPACE_3D, metric: 'LevelFaults', stat: 'Sum', period: 60, threshold: 0, op: 'GreaterThanThreshold', periods: 1 },
  );
  assert.equal(a.TreatMissingData, 'notBreaching');
  assert.match(a.AlarmDescription, /Level faults/);
});

test('an alarm on the first machine model that fails for a cause of ours, not the recording’s', () => {
  const a = alarm('3d-model-faults');
  assert.deepEqual([a.Namespace, a.MetricName, a.Statistic, a.Period, a.Threshold], [NAMESPACE_3D, 'ModelFaults', 'Sum', 60, 0]);
  assert.match(a.AlarmDescription, /Machine model faults/);
});

test('an alarm when a build has been on the GPU too long, well before the worker gives up on it', () => {
  const a = alarm('3d-builds-stuck');
  assert.deepEqual([a.Namespace, a.MetricName, a.Statistic, a.Threshold], [NAMESPACE_3D, 'OldestBuildSeconds', 'Maximum', STUCK_AFTER.toSeconds()]);
  // The worker publishes every 5 minutes, so each period holds a value.
  assert.ok(a.Period >= 10 * 60);
  // Longer than one attempt's hour on the GPU; shorter than the worker's six-hour sweep.
  assert.ok(STUCK_AFTER.toMinutes() > 60 && STUCK_AFTER.toMinutes() < 6 * 60);
  const outcomes = fs.readFileSync(path.join(__dirname, '..', '..', 'backend', 'src', 'assets', 'outcomes.js'), 'utf8');
  assert.match(outcomes, /export const STUCK_MINUTES = 6 \* 60;/);
});

test('an alarm when GPU outcomes wait on the gpu-jobs queue', () => {
  const a = alarm('3d-gpu-outcomes-old');
  assert.deepEqual([a.Namespace, a.MetricName, a.Threshold, a.EvaluationPeriods], ['AWS/SQS', 'ApproximateAgeOfOldestMessage', OUTCOME_WAIT.toSeconds(), 5]);
  assert.match(JSON.stringify(a.Dimensions), /GpuJobsQueue/);
});

test('each 3D alarm tells the alarm topic when it fires and when it clears, and names its runbook section', () => {
  const runbook = fs.readFileSync(path.join(__dirname, '..', '..', RUNBOOK_3D), 'utf8');
  for (const name of ['3d-level-faults', '3d-model-faults', '3d-builds-stuck', '3d-gpu-outcomes-old']) {
    const a = alarm(name);
    assert.deepEqual(a.AlarmActions, [{ Ref: topicId }], name);
    assert.deepEqual(a.OKActions, [{ Ref: topicId }], name);
    const section = /"([^"]+)"\.$/.exec(a.AlarmDescription)![1];
    assert.ok(runbook.includes(`## ${section}`), `${RUNBOOK_3D} has a section "${section}"`);
  }
  // And the gpu-jobs dead-letter queue's alarm, which was already there.
  assert.ok(alarm('gpu-jobs-dlq-not-empty'));
  assert.ok(runbook.includes('## GPU outcomes in the dead-letter queue'));
});

test('a 3D row on the dashboard: levels, machine models, the GPU', () => {
  const [dashboard] = resources.filter((r) => r.Type === 'AWS::CloudWatch::Dashboard');
  const body = JSON.stringify(dashboard.Properties!.DashboardBody);
  assert.match(body, /3D: levels and machine models/);
  // Metrics Insights, summed per value of the dimension (the quotes round the namespace are escaped twice over here).
  for (const [metric, by] of [['LevelsFailed', 'Reason'], ['ModelsBuilt', 'Route'], ['ModelsFailed', 'Cause']]) {
    assert.match(body, new RegExp(`SELECT SUM\\(${metric}\\) FROM [\\\\"]+FlexGym/3D[\\\\"]+ GROUP BY ${by}`), metric);
  }
  assert.match(body, /BuildsOnGpu/);
  assert.match(body, /OldestBuildSeconds/);
});
