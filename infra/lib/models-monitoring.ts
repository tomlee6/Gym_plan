/**
 * Monitoring for the 3D work (task N-03): alarms and a dashboard row for the
 * levels (J-01, J-09) and the machine models (L-05 to L-08), added to the
 * environment's monitoring stack and its alarm topic. What to do when each
 * alarm fires is in docs/runbooks/3d-alarms.md.
 *
 * The backend publishes the metrics (backend/src/metrics3d.js), in the
 * FlexGym/3D namespace through CloudWatch embedded metric format:
 *
 *   LevelsBuilt                    a level built and stored
 *   LevelsFailed (Reason)          a level failed for good, by its J-09 code
 *   LevelFaults                    ... for a reason that is ours, not the plan's
 *   ModelsBuilt (Route)            a machine model made and waiting for review
 *   ModelsFailed (Cause)           a machine model failed for good, by cause
 *   ModelFaults                    ... for a cause that is ours, not the recording's
 *   BuildsOnGpu                    models on the GPU now      } every 5 minutes,
 *   OldestBuildSeconds             since the oldest was sent  } from the worker
 *
 * The faults are what the alarms watch: a plan with walls that do not meet,
 * or a video that shows no machine, is the reviewer's to fix and already in
 * front of them.
 *
 * The gpu-jobs dead-letter queue already has its alarm in the monitoring
 * stack (GpuJobsDlqNotEmpty); the same runbook covers it.
 */
import { Duration } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { EnvConfig, resourcePrefix } from './config';
import { DataStack } from './data-stack';

export const NAMESPACE_3D = 'FlexGym/3D';
export const RUNBOOK_3D = 'docs/runbooks/3d-alarms.md';

/**
 * A build on the GPU this long is waiting for a GPU host, retrying, or its
 * outcome was lost. One attempt is allowed an hour (gpu-stack.ts) and a host
 * starting from nothing takes minutes; a normal build is over well within it.
 * The worker gives up on a build at six hours (STUCK_MINUTES in
 * backend/src/assets/outcomes.js): this is well before.
 */
export const STUCK_AFTER = Duration.minutes(90);

/** An outcome waiting this long was not read, or failed and came back (the worker's receive hides it 15 minutes). */
export const OUTCOME_WAIT = Duration.minutes(15);

export interface ModelsMonitoringProps {
  config: EnvConfig;
  data: DataStack;
  topic: sns.ITopic;
  dashboard: cloudwatch.Dashboard;
}

export class ModelsMonitoring extends Construct {
  readonly alarms: cloudwatch.Alarm[] = [];

  constructor(scope: Construct, id: string, props: ModelsMonitoringProps) {
    super(scope, id);
    const { config, data, topic, dashboard } = props;
    const prefix = resourcePrefix(config);
    const action = new actions.SnsAction(topic);
    const runbook = (section: string) => `See ${RUNBOOK_3D}, "${section}".`;

    const metric = (metricName: string, statistic: string, period: Duration, dimensionsMap?: Record<string, string>) =>
      new cloudwatch.Metric({ namespace: NAMESPACE_3D, metricName, statistic, period, dimensionsMap });
    // Every value of a dimension, summed per value: the dashboard's view of why things failed.
    const byDimension = (metricName: string, dimension: string) =>
      new cloudwatch.MathExpression({
        label: `${metricName} by ${dimension}`,
        expression: `SELECT SUM(${metricName}) FROM "${NAMESPACE_3D}" GROUP BY ${dimension}`,
        period: Duration.minutes(5),
        usingMetrics: {},
      });

    const levelFaults = metric('LevelFaults', 'Sum', Duration.minutes(1));
    const modelFaults = metric('ModelFaults', 'Sum', Duration.minutes(1));
    const oldestBuild = metric('OldestBuildSeconds', 'Maximum', Duration.minutes(10));
    const onGpu = metric('BuildsOnGpu', 'Maximum', Duration.minutes(10));
    const outcomeAge = data.gpuJobsQueue.metricApproximateAgeOfOldestMessage({ period: Duration.minutes(1), statistic: 'Maximum' });

    const alarm = (id: string, props: cloudwatch.AlarmProps) => {
      const a = new cloudwatch.Alarm(this, id, {
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        ...props,
      });
      a.addAlarmAction(action);
      a.addOkAction(action);
      this.alarms.push(a);
      return a;
    };

    // Like JobsDead, on the first one: each is a level a customer is waiting for.
    alarm('LevelFaults', {
      alarmName: `${prefix}-3d-level-faults`,
      alarmDescription: `A level could not be built, and not because of its plan (J-09: build_error, too_large, no_plan, store_failed or other). ${runbook('Level faults')}`,
      metric: levelFaults,
      threshold: 0,
      evaluationPeriods: 1,
    });
    alarm('ModelFaults', {
      alarmName: `${prefix}-3d-model-faults`,
      alarmDescription: `A machine model failed, and not because of its recording (the GPU worker, Batch, L-06, or the build job). ${runbook('Machine model faults')}`,
      metric: modelFaults,
      threshold: 0,
      evaluationPeriods: 1,
    });
    // Published every 5 minutes; a 10-minute period always holds one.
    alarm('BuildsStuck', {
      alarmName: `${prefix}-3d-builds-stuck`,
      alarmDescription: `A machine model has been on the GPU for more than ${STUCK_AFTER.toMinutes()} minutes. ${runbook('Builds stuck on the GPU')}`,
      metric: oldestBuild,
      threshold: STUCK_AFTER.toSeconds(),
      evaluationPeriods: 1,
    });
    alarm('GpuOutcomesOld', {
      alarmName: `${prefix}-3d-gpu-outcomes-old`,
      alarmDescription: `A GPU job's outcome has waited on the gpu-jobs queue for more than ${OUTCOME_WAIT.toMinutes()} minutes. ${runbook('GPU outcomes waiting')}`,
      metric: outcomeAge,
      threshold: OUTCOME_WAIT.toSeconds(),
      evaluationPeriods: 5,
    });

    // ---- Dashboard -------------------------------------------------------------
    const graph = (title: string, left: cloudwatch.IMetric[], right: cloudwatch.IMetric[] = [], extra: Partial<cloudwatch.GraphWidgetProps> = {}) =>
      new cloudwatch.GraphWidget({ title, left, right, width: 8, height: 6, ...extra });
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: `## 3D: levels and machine models\nA fault is a failure that is ours, not the plan's or the recording's. Alarms and what to do: ${RUNBOOK_3D}.`,
        width: 24,
        height: 2,
      }),
    );
    dashboard.addWidgets(
      graph('Levels: built, and failed by J-09 code', [metric('LevelsBuilt', 'Sum', Duration.minutes(5))], [byDimension('LevelsFailed', 'Reason')]),
      graph('Machine models: built by route, failed by cause', [byDimension('ModelsBuilt', 'Route')], [byDimension('ModelsFailed', 'Cause')]),
      graph('On the GPU: builds, and the oldest (s)', [onGpu], [oldestBuild], {
        rightAnnotations: [{ value: STUCK_AFTER.toSeconds(), label: 'stuck' }],
      }),
    );
  }
}
