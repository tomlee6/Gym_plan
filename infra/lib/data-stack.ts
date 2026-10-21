/**
 * Data stores (M-03), queues (M-04) and secrets (M-10).
 *
 * Everything that holds customer data lives in this stack, so it is the one to
 * read when checking residency or encryption. All of it is encrypted with one
 * customer-managed KMS key per environment, except the logs bucket and the
 * secrets (see below for why).
 *
 * Stateful resources are retained (or snapshotted) when the stack is deleted;
 * prod also has deletion protection on the database.
 */
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { EnvConfig, resourcePrefix } from './config';
import { ModelsDistribution } from './models-distribution';

export interface DataStackProps extends StackProps {
  config: EnvConfig;
  vpc: ec2.IVpc;
}

/** Secrets the backend reads as environment variables (M-10). */
export interface AppSecrets {
  jwtSecret: secretsmanager.ISecret;
  storageSigningSecret: secretsmanager.ISecret;
  /** The private key that signs model URLs (M-07); only with a models distribution. */
  modelsSigningKey?: secretsmanager.ISecret;
}

/** MySQL database name the backend uses (DB_NAME). */
export const DB_NAME = 'gymplan';
const DB_USER = 'gymplan';

export class DataStack extends Stack {
  readonly key: kms.Key;
  readonly database: rds.DatabaseInstance;
  readonly databaseSecret: secretsmanager.ISecret;
  readonly capturesBucket: s3.Bucket;
  readonly modelsBucket: s3.Bucket;
  readonly logsBucket: s3.Bucket;
  readonly jobsQueue: sqs.Queue;
  readonly jobsDeadLetterQueue: sqs.Queue;
  readonly gpuJobsQueue: sqs.Queue;
  readonly gpuJobsDeadLetterQueue: sqs.Queue;
  readonly secrets: AppSecrets;
  readonly modelsDistribution?: ModelsDistribution;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { config, vpc } = props;
    const prefix = resourcePrefix(config);
    const isProd = config.name === 'prod';

    this.key = new kms.Key(this, 'DataKey', {
      alias: `alias/${prefix}-data`,
      description: `Flex Gym Scan ${config.name}: database, buckets, queues and secrets`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---- Logs bucket ---------------------------------------------------------
    // ALB access logs and S3 server access logs can only be delivered to a
    // bucket using SSE-S3, so this one bucket cannot use the KMS key. It holds
    // request logs only (IP addresses and paths), no scans or plans.
    this.logsBucket = new s3.Bucket(this, 'LogsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        { id: 'expire-logs', expiration: Duration.days(400) },
        { id: 'abort-multipart', abortIncompleteMultipartUploadAfter: Duration.days(7) },
      ],
    });

    // ---- Captures bucket -----------------------------------------------------
    // Raw scans from the iPhone app (multipart uploads straight from the phone
    // with presigned URLs, hence CORS) and the plans made from them.
    this.capturesBucket = new s3.Bucket(this, 'CapturesBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.key,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      serverAccessLogsBucket: this.logsBucket,
      serverAccessLogsPrefix: 's3/captures/',
      removalPolicy: RemovalPolicy.RETAIN,
      cors: [
        {
          // The web app uploads drawings and reads files with presigned URLs.
          // The phone does not need CORS. ETag must be readable so the client
          // can complete a multipart upload.
          allowedOrigins: [`https://${config.webDomain}`],
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3600,
        },
      ],
      lifecycleRules: [
        {
          // The backend's retention job tags a capture's objects retention=cold
          // 90 days after the plan is approved. From then on they are rarely
          // read, so move them to Glacier Instant Retrieval right away
          // (still millisecond reads if a plan has to be re-processed).
          id: 'cold-after-retention-tag',
          tagFilters: { retention: 'cold' },
          transitions: [
            { storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL, transitionAfter: Duration.days(0) },
          ],
        },
        { id: 'abort-multipart', abortIncompleteMultipartUploadAfter: Duration.days(7) },
        {
          // Versioning protects against accidental overwrites; old versions
          // do not need to live forever.
          id: 'expire-old-versions',
          noncurrentVersionExpiration: Duration.days(90),
        },
      ],
    });

    // ---- Models bucket -------------------------------------------------------
    // 3D models produced by the GPU worker, served through the models
    // CloudFront distribution with signed URLs (M-07).
    this.modelsBucket = new s3.Bucket(this, 'ModelsBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.key,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      serverAccessLogsBucket: this.logsBucket,
      serverAccessLogsPrefix: 's3/models/',
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        { id: 'abort-multipart', abortIncompleteMultipartUploadAfter: Duration.days(7) },
        { id: 'expire-old-versions', noncurrentVersionExpiration: Duration.days(90) },
      ],
    });

    // ---- Database ------------------------------------------------------------
    const parameterGroup = new rds.ParameterGroup(this, 'DbParameters', {
      engine: rds.DatabaseInstanceEngine.mysql({ version: rds.MysqlEngineVersion.VER_8_4_10 }),
      description: 'Flex Gym Scan: UTC, utf8mb4, TLS only',
      parameters: {
        time_zone: 'UTC',
        character_set_server: 'utf8mb4',
        collation_server: 'utf8mb4_0900_ai_ci',
        // Refuse plain-text connections; the backend connects with DB_SSL=true.
        require_secure_transport: 'ON',
      },
    });

    this.database = new rds.DatabaseInstance(this, 'Database', {
      instanceIdentifier: prefix,
      engine: rds.DatabaseInstanceEngine.mysql({ version: rds.MysqlEngineVersion.VER_8_4_10 }),
      instanceType: new ec2.InstanceType(config.dbInstanceType),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      multiAz: config.dbMultiAz,
      databaseName: DB_NAME,
      // RDS generates the password and stores it in Secrets Manager.
      credentials: rds.Credentials.fromGeneratedSecret(DB_USER, {
        secretName: `${prefix}/database`,
      }),
      parameterGroup,
      storageEncrypted: true,
      storageEncryptionKey: this.key,
      storageType: rds.StorageType.GP3,
      allocatedStorage: config.dbAllocatedStorageGiB,
      maxAllocatedStorage: config.dbAllocatedStorageGiB * 4,
      backupRetention: Duration.days(config.dbBackupRetentionDays),
      preferredBackupWindow: '15:00-16:00', // 01:00-02:00 Sydney (AEST)
      preferredMaintenanceWindow: 'Sun:16:30-Sun:17:30',
      copyTagsToSnapshot: true,
      autoMinorVersionUpgrade: true,
      cloudwatchLogsExports: ['error', 'slowquery'],
      cloudwatchLogsRetention: config.logRetentionDays,
      enablePerformanceInsights: isProd,
      performanceInsightEncryptionKey: isProd ? this.key : undefined,
      deletionProtection: isProd,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.SNAPSHOT,
    });
    this.databaseSecret = this.database.secret!;

    // ---- Queues --------------------------------------------------------------
    // jobs: the Node worker (plan building, mail, retention). A message that
    // fails five times goes to the DLQ, which pages someone (monitoring).
    this.jobsDeadLetterQueue = new sqs.Queue(this, 'JobsDlq', {
      queueName: `${prefix}-jobs-dlq`,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: this.key,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });
    this.jobsQueue = new sqs.Queue(this, 'JobsQueue', {
      queueName: `${prefix}-jobs`,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: this.key,
      dataKeyReuse: Duration.hours(1),
      visibilityTimeout: Duration.minutes(15),
      retentionPeriod: Duration.days(4),
      enforceSSL: true,
      deadLetterQueue: { queue: this.jobsDeadLetterQueue, maxReceiveCount: 5 },
    });

    // gpu-jobs (owned by the 3D team): the outcomes of the GPU jobs that make
    // machine models. The jobs themselves run on AWS Batch, which scales the
    // GPU hosts to zero when idle; Batch's job state changes arrive here
    // through EventBridge for the backend's worker (gpu-stack.ts, L-10).
    this.gpuJobsDeadLetterQueue = new sqs.Queue(this, 'GpuJobsDlq', {
      queueName: `${prefix}-gpu-jobs-dlq`,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: this.key,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });
    this.gpuJobsQueue = new sqs.Queue(this, 'GpuJobsQueue', {
      queueName: `${prefix}-gpu-jobs`,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: this.key,
      dataKeyReuse: Duration.hours(1),
      visibilityTimeout: Duration.hours(1),
      retentionPeriod: Duration.days(4),
      enforceSSL: true,
      deadLetterQueue: { queue: this.gpuJobsDeadLetterQueue, maxReceiveCount: 5 },
    });

    // ---- Application secrets (M-10) -----------------------------------------
    // Secrets use Secrets Manager's own KMS key (aws/secretsmanager). With the
    // data key, ECS's grant to read them would put the API stack's execution
    // role into this stack's key policy, a circular cross-stack reference.
    // Generated secrets get a random value on first deploy and keep it on later
    // deploys. The sign-in client secret is Cognito's, kept in the Auth stack.
    const generated = (name: string, description: string) =>
      new secretsmanager.Secret(this, name, {
        secretName: `${prefix}/${name}`,
        description,
        generateSecretString: { passwordLength: 64, excludePunctuation: true, includeSpace: false },
        removalPolicy: RemovalPolicy.RETAIN,
      });
    this.secrets = {
      jwtSecret: generated('JWT_SECRET', 'Signs API access tokens. Rotating it signs everyone out of access tokens.'),
      storageSigningSecret: generated('STORAGE_SIGNING_SECRET', 'Signs storage URLs issued by the API.'),
    };

    // ---- Models distribution (M-07, owned by the 3D team) -------------------
    // Hook point: only built once the 3D team supplies the public half of the
    // signing key pair (context modelsSigningPublicKeyPem), because without a
    // key group the distribution would serve models to anyone.
    if (config.modelsSigningPublicKeyPem) {
      this.modelsDistribution = new ModelsDistribution(this, 'ModelsDistribution', {
        bucket: this.modelsBucket,
        publicKeyPem: config.modelsSigningPublicKeyPem,
        allowedOrigin: `https://${config.webDomain}`,
      });
      // The private half, which the backend signs model URLs with
      // (backend/src/generator/links.js). Like the Hub secrets it starts as a
      // random placeholder and is set by hand: docs/runbooks/models-signing-key.md.
      this.secrets.modelsSigningKey = generated(
        'MODELS_SIGNING_PRIVATE_KEY',
        'Private key (PEM) that signs model URLs for the models CloudFront distribution. Placeholder: set it by hand to the private half of the key pair whose public half is modelsSigningPublicKeyPem.',
      );
    }
    // Optional (3D team): a custom domain for the models distribution, which
    // needs a us-east-1 certificate in EdgeCertStack. Signed URLs work on the
    // distribution's own cloudfront.net name without one.

    new CfnOutput(this, 'DatabaseEndpoint', { value: this.database.dbInstanceEndpointAddress });
    new CfnOutput(this, 'CapturesBucketName', { value: this.capturesBucket.bucketName });
    new CfnOutput(this, 'ModelsBucketName', { value: this.modelsBucket.bucketName });
    new CfnOutput(this, 'JobsQueueUrl', { value: this.jobsQueue.queueUrl });
    new CfnOutput(this, 'GpuJobsQueueUrl', { value: this.gpuJobsQueue.queueUrl });
  }
}
