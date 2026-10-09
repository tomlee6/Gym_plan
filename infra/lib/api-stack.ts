/**
 * Compute (M-05): the backend API and the Node job worker on ECS Fargate.
 *
 * Both services run the same image, built from backend/Dockerfile with the
 * repository root as build context (the image needs shared/ as well):
 *
 *   API     node src/server.js  port 8080, behind an internet-facing ALB with
 *           HTTPS only (HTTP redirects), AWS WAF in front, CPU autoscaling.
 *   worker  node src/worker.js  no load balancer, scales on jobs queue depth.
 *
 * Configuration reaches the containers as environment variables; secrets as
 * ECS secrets read from Secrets Manager at task start (M-10).
 */
import * as path from 'node:path';
import { CfnOutput, Duration, IgnoreMode, Stack, StackProps } from 'aws-cdk-lib';
import * as appscaling from 'aws-cdk-lib/aws-applicationautoscaling';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { EnvConfig, HOME_REGION, resourcePrefix } from './config';
import { DataStack, DB_NAME } from './data-stack';
import { MailStack } from './mail-stack';
import { ApiWaf } from './waf';

/** Repository root: the Docker build context. */
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Port the backend listens on (PORT). */
export const API_PORT = 8080;

export interface ApiStackProps extends StackProps {
  config: EnvConfig;
  vpc: ec2.IVpc;
  zone: route53.IHostedZone;
  data: DataStack;
  mail: MailStack;
}

export class ApiStack extends Stack {
  readonly cluster: ecs.Cluster;
  readonly api: ecsPatterns.ApplicationLoadBalancedFargateService;
  readonly worker: ecs.FargateService;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { config, vpc, zone, data, mail } = props;
    const prefix = resourcePrefix(config);

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: prefix,
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // One image for both services. Only backend/ and shared/ are sent to the
    // build (the rest of the repo is large and irrelevant); keep this in step
    // with backend/Dockerfile.dockerignore.
    const image = new ecrAssets.DockerImageAsset(this, 'BackendImage', {
      directory: REPO_ROOT,
      file: 'backend/Dockerfile',
      platform: ecrAssets.Platform.LINUX_AMD64,
      ignoreMode: IgnoreMode.DOCKER,
      exclude: [
        '*',
        '!backend',
        '!shared',
        '**/node_modules',
        '**/.env',
        '**/.env.*',
        'backend/data',
        'backend/test',
        'backend/docs',
        'backend/docker',
        'backend/docker-compose.yml',
      ],
    });
    const containerImage = ecs.ContainerImage.fromDockerImageAsset(image);

    // ---- Environment shared by API and worker --------------------------------
    const environment: Record<string, string> = {
      NODE_ENV: 'production',
      PORT: String(API_PORT),
      PUBLIC_API_URL: `https://${config.apiDomain}`,
      PUBLIC_WEB_URL: `https://${config.webDomain}`,
      DB_HOST: data.database.dbInstanceEndpointAddress,
      DB_PORT: data.database.dbInstanceEndpointPort,
      DB_NAME,
      DB_SSL: 'true',
      STORAGE_DRIVER: 's3',
      S3_BUCKET: data.capturesBucket.bucketName,
      MODELS_BUCKET: data.modelsBucket.bucketName,
      S3_REGION: HOME_REGION,
      AWS_REGION: HOME_REGION,
      QUEUE_DRIVER: 'sqs',
      JOBS_QUEUE_URL: data.jobsQueue.queueUrl,
      GPU_JOBS_QUEUE_URL: data.gpuJobsQueue.queueUrl,
      MAIL_DRIVER: 'ses',
      MAIL_FROM: mail.fromAddress,
      SES_CONFIGURATION_SET: mail.configurationSet.configurationSetName,
      HUB_DRIVER: 'oidc',
      HUB_ISSUER: config.hub.issuer,
      HUB_AUTHORIZE_URL: config.hub.authorizeUrl,
      HUB_TOKEN_URL: config.hub.tokenUrl,
      HUB_JWKS_URL: config.hub.jwksUrl,
      HUB_CLIENT_ID: config.hub.clientId,
      HUB_ORG_ID: config.hub.orgId,
      HUB_WEB_REDIRECT_URI: config.hub.webRedirectUri,
      HUB_IOS_REDIRECT_URI: config.hub.iosRedirectUri,
      ALLOW_SIMULATED_SCANS: 'false',
    };
    if (data.modelsDistribution) {
      environment.MODELS_CDN_DOMAIN = data.modelsDistribution.distribution.distributionDomainName;
      environment.MODELS_SIGNING_KEY_ID = data.modelsDistribution.publicKey.publicKeyId;
    }

    const secrets: Record<string, ecs.Secret> = {
      DB_USER: ecs.Secret.fromSecretsManager(data.databaseSecret, 'username'),
      DB_PASSWORD: ecs.Secret.fromSecretsManager(data.databaseSecret, 'password'),
      JWT_SECRET: ecs.Secret.fromSecretsManager(data.secrets.jwtSecret),
      STORAGE_SIGNING_SECRET: ecs.Secret.fromSecretsManager(data.secrets.storageSigningSecret),
      HUB_CLIENT_SECRET: ecs.Secret.fromSecretsManager(data.secrets.hubClientSecret),
      HUB_EVENTS_SECRET: ecs.Secret.fromSecretsManager(data.secrets.hubEventsSecret),
    };

    // ---- Task role: what the backend code may do in AWS ----------------------
    // Shared by API and worker; both run the same code base and the API also
    // enqueues jobs and sends mail directly.
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Flex Gym Scan backend (API and worker)',
    });
    // Read/write includes PutObjectTagging, which the retention job uses.
    data.capturesBucket.grantReadWrite(taskRole);
    data.modelsBucket.grantReadWrite(taskRole);
    data.jobsQueue.grantSendMessages(taskRole);
    data.jobsQueue.grantConsumeMessages(taskRole);
    data.gpuJobsQueue.grantSendMessages(taskRole);
    data.key.grantEncryptDecrypt(taskRole);
    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: [
          `arn:aws:ses:${this.region}:${this.account}:identity/${config.mailDomain}`,
          `arn:aws:ses:${this.region}:${this.account}:configuration-set/${mail.configurationSet.configurationSetName}`,
        ],
      }),
    );
    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringLike: { 'cloudwatch:namespace': 'FlexGym/*' } },
      }),
    );

    const logGroup = (name: string) =>
      new logs.LogGroup(this, `${name}Logs`, {
        logGroupName: `/flexgym/${config.name}/${name.toLowerCase()}`,
        retention: config.logRetentionDays as logs.RetentionDays,
      });

    // src/healthcheck.js exits 0 when the process is healthy.
    const containerHealthCheck: ecs.HealthCheck = {
      command: ['CMD', 'node', 'src/healthcheck.js'],
      interval: Duration.seconds(30),
      timeout: Duration.seconds(5),
      retries: 3,
      startPeriod: Duration.seconds(30),
    };

    // ---- API -----------------------------------------------------------------
    const apiTask = new ecs.FargateTaskDefinition(this, 'ApiTask', {
      family: `${prefix}-api`,
      cpu: config.apiCpu,
      memoryLimitMiB: config.apiMemoryMiB,
      taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    apiTask.addContainer('api', {
      image: containerImage,
      command: ['node', 'src/server.js'],
      portMappings: [{ containerPort: API_PORT }],
      environment,
      secrets,
      healthCheck: containerHealthCheck,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'api', logGroup: logGroup('Api') }),
    });

    const apiCertificate = new acm.Certificate(this, 'ApiCertificate', {
      domainName: config.apiDomain,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    // Creates the ALB, HTTPS listener, HTTP->HTTPS redirect and the alias
    // record for apiDomain in our zone (M-08).
    this.api = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'Api', {
      cluster: this.cluster,
      serviceName: `${prefix}-api`,
      taskDefinition: apiTask,
      desiredCount: config.apiDesiredCount,
      publicLoadBalancer: true,
      loadBalancerName: `${prefix}-api`,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificate: apiCertificate,
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      redirectHTTP: true,
      domainName: config.apiDomain,
      domainZone: zone,
      taskSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      healthCheckGracePeriod: Duration.seconds(60),
      enableExecuteCommand: false,
    });
    this.api.targetGroup.configureHealthCheck({
      path: '/health',
      healthyHttpCodes: '200',
      interval: Duration.seconds(15),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
    });
    this.api.targetGroup.setAttribute('deregistration_delay.timeout_seconds', '30');
    this.api.loadBalancer.setAttribute('routing.http.drop_invalid_header_fields.enabled', 'true');
    this.api.loadBalancer.logAccessLogs(data.logsBucket, `alb/${config.name}`);

    const apiScaling = this.api.service.autoScaleTaskCount({
      minCapacity: config.apiDesiredCount,
      maxCapacity: config.apiMaxCount,
    });
    apiScaling.scaleOnCpuUtilization('Cpu', {
      targetUtilizationPercent: 60,
      scaleInCooldown: Duration.minutes(5),
      scaleOutCooldown: Duration.minutes(1),
    });

    // WAF in front of the ALB (D-10 rate limits live in waf.ts).
    new ApiWaf(this, 'Waf', { name: `${prefix}-api`, loadBalancer: this.api.loadBalancer });

    // ---- Worker --------------------------------------------------------------
    const workerTask = new ecs.FargateTaskDefinition(this, 'WorkerTask', {
      family: `${prefix}-worker`,
      cpu: config.workerCpu,
      memoryLimitMiB: config.workerMemoryMiB,
      taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    workerTask.addContainer('worker', {
      image: containerImage,
      command: ['node', 'src/worker.js'],
      // The worker answers /health on WORKER_HEALTH_PORT, and the health
      // check script asks HEALTH_PORT.
      environment: { ...environment, WORKER_HEALTH_PORT: '8081', HEALTH_PORT: '8081' },
      secrets,
      healthCheck: containerHealthCheck,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'worker', logGroup: logGroup('Worker') }),
      // A job in progress gets time to finish (the queue's visibility timeout
      // covers anything longer) when ECS replaces the task.
      stopTimeout: Duration.seconds(120),
    });

    this.worker = new ecs.FargateService(this, 'Worker', {
      cluster: this.cluster,
      serviceName: `${prefix}-worker`,
      taskDefinition: workerTask,
      desiredCount: config.workerDesiredCount,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });
    const workerScaling = this.worker.autoScaleTaskCount({
      minCapacity: config.workerDesiredCount,
      maxCapacity: Math.max(config.workerDesiredCount * 4, 2),
    });
    workerScaling.scaleOnMetric('QueueDepth', {
      metric: data.jobsQueue.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1) }),
      // Under 5 waiting jobs: shrink by one. 20+: add one. 100+: add three.
      scalingSteps: [
        { upper: 5, change: -1 },
        { lower: 20, change: +1 },
        { lower: 100, change: +3 },
      ],
      adjustmentType: appscaling.AdjustmentType.CHANGE_IN_CAPACITY,
      cooldown: Duration.minutes(3),
    });

    // ---- Database access -----------------------------------------------------
    // The rules are created in this stack on purpose. connections.allowFrom
    // would put them in the Data stack, which would then depend on this one.
    const dbSecurityGroupId = data.database.connections.securityGroups[0].securityGroupId;
    for (const [name, service] of [
      ['Api', this.api.service],
      ['Worker', this.worker],
    ] as const) {
      new ec2.CfnSecurityGroupIngress(this, `${name}ToDatabase`, {
        groupId: dbSecurityGroupId,
        sourceSecurityGroupId: service.connections.securityGroups[0].securityGroupId,
        ipProtocol: 'tcp',
        fromPort: 3306,
        toPort: 3306,
        description: `${name} tasks to MySQL`,
      });
    }

    new CfnOutput(this, 'ApiUrl', { value: `https://${config.apiDomain}` });
    new CfnOutput(this, 'LoadBalancerDns', { value: this.api.loadBalancer.loadBalancerDnsName });
    new CfnOutput(this, 'ImageUri', { value: image.imageUri });
  }
}
