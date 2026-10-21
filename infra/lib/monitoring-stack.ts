/**
 * Monitoring (M-11): one dashboard per environment, alarms to an SNS topic,
 * and (optionally) that topic forwarded to Slack through AWS Chatbot.
 *
 * Pipeline failures must reach a person within five minutes, so the two
 * "a job died" alarms use one-minute periods and fire on the first breach:
 *  - the jobs dead-letter queue has any visible message;
 *  - the worker's own JobsDead metric (namespace FlexGym/Jobs, published
 *    through CloudWatch embedded metric format, dimension Kind) is above 0.
 *
 * JobsDead is published per Kind, so its alarm uses a Metrics Insights query
 * that sums over every Kind; a new job kind is covered without a change here.
 */
import { Duration, Stack, StackProps } from 'aws-cdk-lib';
import * as chatbot from 'aws-cdk-lib/aws-chatbot';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { ApiStack } from './api-stack';
import { EnvConfig, resourcePrefix } from './config';
import { DataStack } from './data-stack';
import { ModelsMonitoring } from './models-monitoring';

export interface MonitoringStackProps extends StackProps {
  config: EnvConfig;
  data: DataStack;
  api: ApiStack;
}

/** Namespace and metric names the worker publishes (EMF). */
export const JOBS_NAMESPACE = 'FlexGym/Jobs';
export const JOB_METRICS = ['JobsSucceeded', 'JobsFailed', 'JobsDead'] as const;

const ONE_MINUTE = Duration.minutes(1);
const FIVE_MINUTES = Duration.minutes(5);

export class MonitoringStack extends Stack {
  readonly alarmTopic: sns.Topic;
  readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);
    const { config, data, api } = props;
    const prefix = resourcePrefix(config);

    // Alarm messages hold metric names and thresholds, no customer data, so
    // the topic uses SNS's default encryption at rest rather than a CMK (a CMK
    // would need extra key policy for CloudWatch and Chatbot).
    this.alarmTopic = new sns.Topic(this, 'Alarms', {
      topicName: `${prefix}-alarms`,
      displayName: `Flex Gym Scan ${config.name} alarms`,
      enforceSSL: true,
    });
    if (config.alarmEmail) {
      this.alarmTopic.addSubscription(new subscriptions.EmailSubscription(config.alarmEmail));
    }
    if (config.slackWorkspaceId && config.slackChannelId) {
      // The workspace must be authorised once in the AWS Chatbot console first.
      new chatbot.SlackChannelConfiguration(this, 'Slack', {
        slackChannelConfigurationName: `${prefix}-alarms`,
        slackWorkspaceId: config.slackWorkspaceId,
        slackChannelId: config.slackChannelId,
        notificationTopics: [this.alarmTopic],
        loggingLevel: chatbot.LoggingLevel.ERROR,
        guardrailPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('ReadOnlyAccess')],
      });
    }
    const alarmAction = new actions.SnsAction(this.alarmTopic);
    const alarm = (a: cloudwatch.Alarm) => {
      a.addAlarmAction(alarmAction);
      a.addOkAction(alarmAction);
      return a;
    };

    // ---- Metrics -------------------------------------------------------------
    const alb = api.api.loadBalancer.metrics;
    const tg = api.api.targetGroup.metrics;
    const alb5xx = alb.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, { period: FIVE_MINUTES });
    const target5xx = tg.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { period: FIVE_MINUTES });
    const latencyP95 = tg.targetResponseTime({ period: FIVE_MINUTES, statistic: 'p95' });
    const requests = alb.requestCount({ period: FIVE_MINUTES });

    const db = data.database;
    const queueMetrics = (q: sqs.IQueue) => [
      q.metricApproximateNumberOfMessagesVisible({ period: ONE_MINUTE, statistic: 'Maximum' }),
      q.metricApproximateAgeOfOldestMessage({ period: ONE_MINUTE, statistic: 'Maximum' }),
    ];
    const dlqDepth = (q: sqs.IQueue) =>
      q.metricApproximateNumberOfMessagesVisible({ period: ONE_MINUTE, statistic: 'Maximum' });

    const jobMetric = (metricName: string) =>
      new cloudwatch.MathExpression({
        label: metricName,
        // Metrics Insights: sum over every Kind dimension value.
        expression: `SELECT SUM(${metricName}) FROM "${JOBS_NAMESPACE}"`,
        period: ONE_MINUTE,
        usingMetrics: {},
      });

    // ---- Alarms --------------------------------------------------------------
    alarm(
      new cloudwatch.Alarm(this, 'JobsDlqNotEmpty', {
        alarmName: `${prefix}-jobs-dlq-not-empty`,
        alarmDescription: 'A job failed 5 times and was moved to the dead-letter queue. See docs/runbooks.',
        metric: dlqDepth(data.jobsDeadLetterQueue),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    alarm(
      new cloudwatch.Alarm(this, 'GpuJobsDlqNotEmpty', {
        alarmName: `${prefix}-gpu-jobs-dlq-not-empty`,
        alarmDescription: 'A 3D (GPU) job failed 5 times and was moved to the dead-letter queue.',
        metric: dlqDepth(data.gpuJobsDeadLetterQueue),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    alarm(
      new cloudwatch.Alarm(this, 'JobsDead', {
        alarmName: `${prefix}-jobs-dead`,
        alarmDescription: `The worker gave up on a job (${JOBS_NAMESPACE} JobsDead > 0).`,
        metric: jobMetric('JobsDead'),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    alarm(
      new cloudwatch.Alarm(this, 'JobsBacklogOld', {
        alarmName: `${prefix}-jobs-backlog-old`,
        alarmDescription: 'The oldest job has waited more than 15 minutes; the worker may be stuck.',
        metric: data.jobsQueue.metricApproximateAgeOfOldestMessage({ period: ONE_MINUTE, statistic: 'Maximum' }),
        threshold: 15 * 60,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 5,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    alarm(
      new cloudwatch.Alarm(this, 'Api5xx', {
        alarmName: `${prefix}-api-5xx`,
        alarmDescription: 'API returned more than 10 server errors in 5 minutes.',
        metric: new cloudwatch.MathExpression({
          label: '5xx (ALB + targets)',
          expression: 'FILL(elb, 0) + FILL(target, 0)',
          usingMetrics: { elb: alb5xx, target: target5xx },
          period: FIVE_MINUTES,
        }),
        threshold: 10,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    alarm(
      new cloudwatch.Alarm(this, 'ApiLatency', {
        alarmName: `${prefix}-api-latency-p95`,
        alarmDescription: 'API p95 response time above 2 seconds for 15 minutes.',
        metric: latencyP95,
        threshold: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 3,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    alarm(
      new cloudwatch.Alarm(this, 'ApiUnhealthyHosts', {
        alarmName: `${prefix}-api-unhealthy-hosts`,
        alarmDescription: 'At least one API task is failing its /health check.',
        metric: tg.unhealthyHostCount({ period: ONE_MINUTE, statistic: 'Maximum' }),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 3,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    for (const [name, service] of [
      ['Api', api.api.service],
      ['Worker', api.worker],
    ] as const) {
      alarm(
        new cloudwatch.Alarm(this, `${name}Cpu`, {
          alarmName: `${prefix}-${name.toLowerCase()}-cpu`,
          metric: service.metricCpuUtilization({ period: FIVE_MINUTES }),
          threshold: 85,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
          evaluationPeriods: 3,
        }),
      );
      alarm(
        new cloudwatch.Alarm(this, `${name}Memory`, {
          alarmName: `${prefix}-${name.toLowerCase()}-memory`,
          metric: service.metricMemoryUtilization({ period: FIVE_MINUTES }),
          threshold: 85,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
          evaluationPeriods: 3,
        }),
      );
    }
    alarm(
      new cloudwatch.Alarm(this, 'DbCpu', {
        alarmName: `${prefix}-db-cpu`,
        metric: db.metricCPUUtilization({ period: FIVE_MINUTES }),
        threshold: 80,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 3,
      }),
    );
    alarm(
      new cloudwatch.Alarm(this, 'DbFreeStorage', {
        alarmName: `${prefix}-db-free-storage`,
        alarmDescription: 'Less than 5 GiB free. Storage autoscaling should step in; check it did.',
        metric: db.metricFreeStorageSpace({ period: FIVE_MINUTES, statistic: 'Minimum' }),
        threshold: 5 * 1024 ** 3,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 1,
      }),
    );

    // ---- Dashboard -----------------------------------------------------------
    const graph = (title: string, left: cloudwatch.IMetric[], right: cloudwatch.IMetric[] = []) =>
      new cloudwatch.GraphWidget({ title, left, right, width: 12, height: 6 });

    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: prefix,
      defaultInterval: Duration.hours(6),
    });
    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: `# Flex Gym Scan ${config.name}\nAPI, worker, database and job queues. Runbooks: docs/runbooks/.`,
        width: 24,
        height: 2,
      }),
    );
    this.dashboard.addWidgets(
      graph('API requests and 5xx', [requests], [alb5xx, target5xx]),
      graph('API latency', [latencyP95, tg.targetResponseTime({ period: FIVE_MINUTES, statistic: 'p50' })]),
    );
    this.dashboard.addWidgets(
      graph('ECS CPU %', [api.api.service.metricCpuUtilization(), api.worker.metricCpuUtilization()]),
      graph('ECS memory %', [api.api.service.metricMemoryUtilization(), api.worker.metricMemoryUtilization()]),
    );
    this.dashboard.addWidgets(
      graph('RDS CPU % and connections', [db.metricCPUUtilization()], [db.metricDatabaseConnections()]),
      graph('RDS free storage (bytes)', [db.metricFreeStorageSpace()]),
    );
    this.dashboard.addWidgets(
      graph('jobs queue: depth and oldest (s)', [queueMetrics(data.jobsQueue)[0]], [queueMetrics(data.jobsQueue)[1]]),
      graph('gpu-jobs queue: depth and oldest (s)', [queueMetrics(data.gpuJobsQueue)[0]], [queueMetrics(data.gpuJobsQueue)[1]]),
    );
    this.dashboard.addWidgets(
      graph('Dead-letter queues', [dlqDepth(data.jobsDeadLetterQueue), dlqDepth(data.gpuJobsDeadLetterQueue)]),
      graph('Jobs (all kinds)', JOB_METRICS.map(jobMetric)),
    );

    // The 3D team's alarms and dashboard row (N-03): levels and machine models.
    new ModelsMonitoring(this, 'Models3d', { config, data, topic: this.alarmTopic, dashboard: this.dashboard });
  }
}
