/**
 * Build and release (M-12) with CDK Pipelines on CodePipeline V2.
 *
 *   Source          CodeCommit gym_floor_plan, branch main
 *   WebTestAndBuild web: npm ci, npm test, npm run build (web/dist feeds synth)
 *   Synth           infra: npm ci, tsc, tests, cdk synth -c deployWebAssets=true
 *   UpdatePipeline  self-mutation, then asset publishing (the backend image)
 *   Staging         backend tests against MySQL 8.4 run first, then deploy
 *   Prod            manual approval, then deploy
 *
 * The pipeline lives in its own (tooling) account and deploys into the staging
 * and prod accounts; each must be bootstrapped to trust it (see
 * docs/runbooks/deploy.md). Dev is not deployed by the pipeline.
 */
import { Stack, StackProps } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as pipelines from 'aws-cdk-lib/pipelines';
import { Construct } from 'constructs';
import { EnvConfig, PipelineConfig } from './config';
import { FlexGymStage } from './stage';

export interface PipelineStackProps extends StackProps {
  pipeline: PipelineConfig;
  staging: EnvConfig;
  prod: EnvConfig;
  /**
   * Upload web/dist with the Web stacks. The pipeline's synth step always
   * passes -c deployWebAssets=true; local synths leave it off.
   */
  deployWebAssets: boolean;
}

/** CodeBuild image with Node 22 and Docker. */
const BUILD_IMAGE = codebuild.LinuxBuildImage.STANDARD_7_0;
const NODE_22 = codebuild.BuildSpec.fromObject({
  phases: { install: { 'runtime-versions': { nodejs: '22' } } },
});

/**
 * Backend tests need a real MySQL 8.4. It runs as a container next to the
 * build (privileged mode gives CodeBuild a Docker daemon), on the same port
 * and with the same users as backend/docker-compose.yml. The image comes from
 * ECR Public to avoid Docker Hub's anonymous pull limits.
 */
const BACKEND_TEST_COMMANDS = [
  'docker run -d --name mysql -p 3317:3306' +
    ' -e MYSQL_ROOT_PASSWORD=gymplan-root -e MYSQL_DATABASE=gymplan' +
    ' -e MYSQL_USER=gymplan -e MYSQL_PASSWORD=gymplan-dev' +
    ' -v "$CODEBUILD_SRC_DIR/backend/docker/mysql-init:/docker-entrypoint-initdb.d:ro"' +
    ' public.ecr.aws/docker/library/mysql:8.4',
  // Wait until MySQL answers over TCP (the init script that creates the test
  // database runs before the server starts listening on the network).
  'for i in $(seq 1 90); do docker exec mysql mysqladmin ping -h 127.0.0.1 -pgymplan-root --silent && break; sleep 2; done',
  'cd backend',
  'npm ci',
  'npm test',
];

export class PipelineStack extends Stack {
  readonly pipeline: pipelines.CodePipeline;

  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);
    const repository = codecommit.Repository.fromRepositoryName(this, 'Repo', props.pipeline.repositoryName);
    const source = pipelines.CodePipelineSource.codeCommit(repository, props.pipeline.branch);

    // Web app: test and build. Its dist folder becomes an input to synth so
    // the Web stacks can upload it.
    const webBuild = new pipelines.CodeBuildStep('WebTestAndBuild', {
      input: source,
      buildEnvironment: { buildImage: BUILD_IMAGE },
      partialBuildSpec: NODE_22,
      commands: ['cd web', 'npm ci', 'npm test', 'npm run build'],
      primaryOutputDirectory: 'web/dist',
    });

    const synth = new pipelines.CodeBuildStep('Synth', {
      input: source,
      additionalInputs: { 'web/dist': webBuild },
      buildEnvironment: { buildImage: BUILD_IMAGE },
      partialBuildSpec: NODE_22,
      commands: ['cd infra', 'npm ci', 'npx tsc --noEmit', 'npm test', 'npx cdk synth -c deployWebAssets=true'],
      primaryOutputDirectory: 'infra/cdk.out',
    });

    this.pipeline = new pipelines.CodePipeline(this, 'Pipeline', {
      pipelineName: 'flexgym-release',
      pipelineType: codepipeline.PipelineType.V2,
      synth,
      // Staging and prod are separate accounts.
      crossAccountKeys: true,
      publishAssetsInParallel: true,
      codeBuildDefaults: { buildEnvironment: { buildImage: BUILD_IMAGE } },
    });

    const backendTests = new pipelines.CodeBuildStep('BackendTests', {
      input: source,
      buildEnvironment: { buildImage: BUILD_IMAGE, privileged: true },
      partialBuildSpec: NODE_22,
      // Same values as backend/.env.test; set here so the build does not
      // depend on that file being committed. Node's --env-file does not
      // override variables that are already set.
      env: {
        NODE_ENV: 'test',
        PUBLIC_API_URL: 'http://localhost:8080',
        PUBLIC_WEB_URL: 'http://localhost:3000',
        DB_HOST: '127.0.0.1',
        DB_PORT: '3317',
        DB_USER: 'gymplan',
        DB_PASSWORD: 'gymplan-dev',
        DB_NAME: 'gymplan_test',
        JWT_SECRET: 'test-jwt-secret-not-for-production',
        STORAGE_SIGNING_SECRET: 'test-storage-secret-not-for-production',
        STORAGE_DRIVER: 'local',
        STORAGE_LOCAL_DIR: './data/test-storage',
        ALLOW_SIMULATED_SCANS: 'true',
      },
      commands: BACKEND_TEST_COMMANDS,
    });

    // TODO(3D team): build and publish the GPU worker image here (its own
    // Dockerfile and ECR repository, CUDA base image) as a pre step of the
    // staging stage, so it ships with the same release.

    const { deployWebAssets } = props;
    // Stack names: FlexGym-Staging-Api, FlexGym-Prod-Data, ...
    const staging = new FlexGymStage(this, 'FlexGym-Staging', { config: props.staging, deployWebAssets });
    const prod = new FlexGymStage(this, 'FlexGym-Prod', { config: props.prod, deployWebAssets });

    this.pipeline.addStage(staging, { pre: [backendTests] });
    this.pipeline.addStage(prod, {
      pre: [
        new pipelines.ManualApprovalStep('PromoteToProd', {
          comment: 'Staging is deployed. Check it, then approve to release to prod.',
        }),
      ],
    });
  }
}
