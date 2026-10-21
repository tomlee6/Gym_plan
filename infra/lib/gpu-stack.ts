/**
 * The GPU environment for machine models (L-10). OWNED BY THE 3D TEAM.
 *
 * AWS Batch in Sydney on g6e.xlarge (one NVIDIA L40S, 48 GB): no hosts while
 * there is nothing to do, up to gpuMaxInstances when there is. Each job runs
 * the approved TRELLIS.2 worker image (gpu/trellis2, by digest from
 * cdk.json) on one machine's 360 video from the captures bucket (L-05) and
 * writes the model into that machine's assets in the models bucket. Batch's
 * job state changes go to the gpu-jobs queue, where the backend's worker
 * picks up finished and failed jobs.
 *
 *   backend --SubmitJob--> job queue --> g6e.xlarge --> models bucket
 *                                  \--> EventBridge --> gpu-jobs queue --> backend
 *
 * Only built when the environment names an approved image (trellis2Image).
 * See docs/runbooks/trellis2-worker.md.
 */
import { Duration, Size, Stack, StackProps } from 'aws-cdk-lib';
import * as batch from 'aws-cdk-lib/aws-batch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { EnvConfig, HOME_REGION, loadPipelineConfig, resourcePrefix } from './config';
import { DataStack } from './data-stack';

export interface GpuStackProps extends StackProps {
  config: EnvConfig;
  vpc: ec2.IVpc;
  data: DataStack;
}

/** g6e.xlarge: 4 vCPUs, 32 GiB, one L40S, a 250 GB local NVMe disk. */
const INSTANCE_TYPE = 'g6e.xlarge';
const VCPUS_PER_HOST = 4;
/** Less than the host's 32 GiB, leaving room for the ECS agent. */
const JOB_MEMORY_MIB = 28 * 1024;

/** Where the worker's files live in the models bucket. */
export const WEIGHTS_PREFIX = 'gpu/trellis2/weights/';
/** Where the golden test's runs go in the models bucket (gpu/trellis2/golden.py). */
export const GOLDEN_PREFIX = 'models/accounts/_golden/';

/**
 * The image pipeline (trellis2-image.ts, N-05) runs the golden test on a new
 * image in this environment, as GOLDEN_ROLE_NAME here, assumed from its
 * runner role GOLDEN_RUNNER_ROLE_NAME in the tooling account.
 */
export const GOLDEN_ENVIRONMENT = 'staging';
export const GOLDEN_ROLE_NAME = 'flexgym-trellis2-golden-test';
export const GOLDEN_RUNNER_ROLE_NAME = 'flexgym-trellis2-golden';
export const ASSETS_PATTERN = 'models/accounts/*/assets/*';
/** Machines' 360 videos and ARKit frames in the captures bucket. */
export const EQUIPMENT_PATTERN = 'accounts/*/captures/*/equipment/*';

export class GpuStack extends Stack {
  readonly jobQueue: batch.JobQueue;
  readonly jobDefinition: batch.EcsJobDefinition;

  constructor(scope: Construct, id: string, props: GpuStackProps) {
    super(scope, id, props);
    const { config, vpc, data } = props;
    const prefix = resourcePrefix(config);

    // ---- Hosts -------------------------------------------------------------
    // The local NVMe disk holds the weights (18 GB) between jobs, at /weights,
    // owned by the image's user (uid 1000). The root volume holds the image.
    const boot = ec2.UserData.forLinux();
    boot.addCommands(
      'mkdir -p /weights',
      "dev=$(lsblk -dpno NAME,MODEL | awk '/Instance Storage/ {print $1; exit}')",
      'if [ -n "$dev" ] && ! mountpoint -q /weights; then mkfs.xfs -f "$dev" && mount -o noatime "$dev" /weights; fi',
      'chown 1000:1000 /weights',
    );
    // Batch needs launch template user data in MIME multipart form.
    const userData = new ec2.MultipartUserData();
    userData.addPart(ec2.MultipartBody.fromUserData(boot));
    const launchTemplate = new ec2.LaunchTemplate(this, 'GpuHost', {
      launchTemplateName: `${prefix}-gpu-host`,
      userData,
      requireImdsv2: true,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(100, { volumeType: ec2.EbsDeviceVolumeType.GP3, encrypted: true }),
        },
      ],
    });

    const securityGroup = new ec2.SecurityGroup(this, 'GpuHosts', {
      vpc,
      description: 'GPU hosts: no inbound; out to S3, ECR and logs',
      allowAllOutbound: true,
    });

    const computeEnvironment = new batch.ManagedEc2EcsComputeEnvironment(this, 'Gpu', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [securityGroup],
      instanceTypes: [new ec2.InstanceType(INSTANCE_TYPE)],
      useOptimalInstanceClasses: false,
      images: [{ imageType: batch.EcsMachineImageType.ECS_AL2023_NVIDIA }],
      minvCpus: 0,
      maxvCpus: VCPUS_PER_HOST * config.gpuMaxInstances,
      allocationStrategy: batch.AllocationStrategy.BEST_FIT_PROGRESSIVE,
      launchTemplate,
      updateToLatestImageVersion: true,
    });

    this.jobQueue = new batch.JobQueue(this, 'Queue', {
      jobQueueName: `${prefix}-trellis2`,
      priority: 1,
      computeEnvironments: [{ computeEnvironment, order: 1 }],
    });

    // ---- What a job may do ---------------------------------------------------
    // Read the weights; read a machine's 360 video and frames; read and write
    // under a customer's assets in the models bucket. Nothing else.
    const jobRole = new iam.Role(this, 'JobRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'TRELLIS.2 job: weights and 360 video in, model out',
    });
    data.modelsBucket.grantRead(jobRole, `${WEIGHTS_PREFIX}*`);
    data.modelsBucket.grantReadWrite(jobRole, ASSETS_PATTERN);
    data.capturesBucket.grantRead(jobRole, EQUIPMENT_PATTERN);

    // Pulls the image from the tooling account's ECR repository.
    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')],
    });
    const repositoryArn = config.trellis2Image.replace(
      /^(\d{12})\.dkr\.ecr\.([\w-]+)\.amazonaws\.com\/([^@]+)@.*$/,
      'arn:aws:ecr:$2:$1:repository/$3',
    );
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability'],
        resources: [repositoryArn],
      }),
    );

    const logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: `/flexgym/${config.name}/trellis2`,
      retention: config.logRetentionDays as logs.RetentionDays,
    });

    // ---- The job -------------------------------------------------------------
    this.jobDefinition = new batch.EcsJobDefinition(this, 'Job', {
      jobDefinitionName: `${prefix}-trellis2`,
      container: new batch.EcsEc2ContainerDefinition(this, 'Worker', {
        image: ecs.ContainerImage.fromRegistry(config.trellis2Image),
        cpu: VCPUS_PER_HOST,
        memory: Size.mebibytes(JOB_MEMORY_MIB),
        gpu: 1,
        command: ['--input', 'Ref::input', '--output', 'Ref::output', '--params', 'Ref::params'],
        environment: {
          WEIGHTS_S3: `s3://${data.modelsBucket.bucketName}/${WEIGHTS_PREFIX}`,
          AWS_DEFAULT_REGION: HOME_REGION,
        },
        jobRole,
        executionRole,
        logging: ecs.LogDriver.awsLogs({ streamPrefix: 'trellis2', logGroup }),
        volumes: [batch.EcsVolume.host({ name: 'weights', hostPath: '/weights', containerPath: '/weights' })],
      }),
      parameters: { params: '{}' },
      timeout: Duration.hours(1),
      retryAttempts: 3,
      // The worker exits 2 when its input cannot be used: no attempt will do better.
      retryStrategies: [batch.RetryStrategy.of(batch.Action.EXIT, batch.Reason.custom({ onExitCode: '2' }))],
    });

    // ---- The golden test, from the image pipeline (N-05) ------------------------
    // What golden.py does, and no more: a candidate copy of the job definition
    // with the new image, one job on the live queue, its files under _golden/.
    if (config.name === GOLDEN_ENVIRONMENT) {
      const tooling = loadPipelineConfig(this.node).account;
      const golden = new iam.Role(this, 'GoldenTest', {
        roleName: GOLDEN_ROLE_NAME,
        description: 'The TRELLIS.2 image pipeline runs the golden test on a new image here (N-05).',
        assumedBy: new iam.AccountPrincipal(tooling).withConditions({
          ArnEquals: { 'aws:PrincipalArn': `arn:aws:iam::${tooling}:role/${GOLDEN_RUNNER_ROLE_NAME}` },
        }),
        maxSessionDuration: Duration.hours(2),
      });
      const candidate = `arn:aws:batch:${this.region}:${this.account}:job-definition/${prefix}-trellis2-candidate`;
      golden.addToPolicy(new iam.PolicyStatement({ actions: ['batch:DescribeJobDefinitions', 'batch:DescribeJobs'], resources: ['*'] }));
      golden.addToPolicy(
        new iam.PolicyStatement({
          actions: ['batch:RegisterJobDefinition', 'batch:DeregisterJobDefinition'],
          resources: [candidate, `${candidate}:*`],
        }),
      );
      golden.addToPolicy(
        new iam.PolicyStatement({ actions: ['batch:SubmitJob'], resources: [this.jobQueue.jobQueueArn, `${candidate}:*`] }),
      );
      jobRole.grantPassRole(golden);
      executionRole.grantPassRole(golden);
      data.modelsBucket.grantReadWrite(golden, `${GOLDEN_PREFIX}*`);
    }

    // ---- Outcomes back to the backend ------------------------------------------
    new events.Rule(this, 'JobDone', {
      description: 'TRELLIS.2 jobs that succeeded or failed, to the gpu-jobs queue',
      eventPattern: {
        source: ['aws.batch'],
        detailType: ['Batch Job State Change'],
        detail: { jobQueue: [this.jobQueue.jobQueueArn], status: ['SUCCEEDED', 'FAILED'] },
      },
      targets: [new targets.SqsQueue(data.gpuJobsQueue)],
    });
  }
}
