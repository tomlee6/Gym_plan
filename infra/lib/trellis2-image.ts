/**
 * The TRELLIS.2 worker image (L-09) and its release (N-05). OWNED BY THE 3D
 * TEAM.
 *
 * The image (gpu/trellis2/Dockerfile) is built in the tooling account and
 * pushed to one ECR repository that the staging and prod accounts pull from.
 * It is not built inside the release: compiling its CUDA extensions takes
 * hours, and a new image must pass the golden test on a GPU (L-14) before
 * any job uses it. Its own pipeline, flexgym-trellis2-image, does all of it:
 *
 *   Source   the release branch. Started when a push to it changes what the
 *            image is built from (the Dockerfile, its buildspec, the files it
 *            copies in; `release.py changed`), or by hand.
 *   Build    the image, pushed as <commit>-<build number>; its digest out.
 *   Golden   the golden test on that digest, on staging's GPUs, as the role
 *            staging keeps for it (gpu-stack.ts). A failure stops here.
 *   Approve  a person looks at the golden model and approves the digest.
 *   Adopt    the digest committed into cdk.json for every environment with a
 *            GPU environment. The release then deploys exactly that digest:
 *            staging, then prod on its own approval.
 *
 * The image holds no customer data and no model weights; the weights sit in
 * each environment's own models bucket in Sydney.
 */
import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { GOLDEN_ENVIRONMENT, GOLDEN_ROLE_NAME, GOLDEN_RUNNER_ROLE_NAME } from './gpu-stack';

export const IMAGE_PIPELINE = 'flexgym-trellis2-image';

export interface Trellis2ImageProps {
  /** The repository the release builds from. */
  repository: codecommit.IRepository;
  branch: string;
  /** Accounts whose GPU jobs pull the image (staging, prod). */
  pullAccounts: string[];
  /** The account of the environment the golden test runs in (GOLDEN_ENVIRONMENT). */
  goldenAccount: string;
}

const RELEASE_TOOLS = 'pip3 install --quiet boto3';

export class Trellis2Image extends Construct {
  readonly repository: ecr.Repository;
  readonly project: codebuild.PipelineProject;
  readonly pipeline: codepipeline.Pipeline;

  constructor(scope: Construct, id: string, props: Trellis2ImageProps) {
    super(scope, id);
    const { account, region } = Stack.of(this);

    this.repository = new ecr.Repository(this, 'Repository', {
      repositoryName: 'flexgym/trellis2',
      // An image is used by digest; a tag never changes what it points at.
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      imageScanOnPush: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ description: 'Keep the last 20 images', maxImageCount: 20 }],
    });
    const accounts = [...new Set(props.pullAccounts)];
    if (accounts.length) {
      this.repository.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'GpuJobsPull',
          principals: accounts.map((a) => new iam.AccountPrincipal(a)),
          actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability'],
        }),
      );
    }

    // ---- Build -----------------------------------------------------------------
    this.project = new codebuild.PipelineProject(this, 'Build', {
      projectName: 'flexgym-trellis2-image',
      description: 'Builds the TRELLIS.2 worker image (gpu/trellis2) and pushes it to ECR. A step of the image pipeline.',
      buildSpec: codebuild.BuildSpec.fromSourceFilename('gpu/trellis2/buildspec.yml'),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        // flash-attn's compile wants up to 9 GB per job; 145 GB and 72 vCPUs.
        computeType: codebuild.ComputeType.X2_LARGE,
        privileged: true,
        environmentVariables: { IMAGE_REPO: { value: this.repository.repositoryUri } },
      },
      timeout: Duration.hours(8),
    });
    this.repository.grantPullPush(this.project);

    // ---- Golden test, as the golden environment's role -------------------------
    const goldenRole = new iam.Role(this, 'GoldenRunner', {
      roleName: GOLDEN_RUNNER_ROLE_NAME,
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      description: `Runs the golden test on a new TRELLIS.2 image, as ${GOLDEN_ROLE_NAME} in ${GOLDEN_ENVIRONMENT} (N-05).`,
    });
    const goldenTestRole = `arn:aws:iam::${props.goldenAccount}:role/${GOLDEN_ROLE_NAME}`;
    goldenRole.addToPolicy(new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: [goldenTestRole] }));
    const golden = new codebuild.PipelineProject(this, 'Golden', {
      projectName: 'flexgym-trellis2-golden',
      description: `Golden test (L-14) of a new TRELLIS.2 image on ${GOLDEN_ENVIRONMENT}'s GPUs.`,
      role: goldenRole,
      environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0, computeType: codebuild.ComputeType.SMALL },
      environmentVariables: { GOLDEN_ROLE: { value: goldenTestRole }, GOLDEN_ENV: { value: GOLDEN_ENVIRONMENT } },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        env: { 'exported-variables': ['GOLDEN_RUN'] },
        phases: {
          install: { commands: [RELEASE_TOOLS] },
          build: {
            commands: [
              'cd gpu/trellis2',
              'GOLDEN_RUN="release-$CODEBUILD_BUILD_NUMBER"',
              'python3 release.py golden --image "$IMAGE" --env "$GOLDEN_ENV" --role-arn "$GOLDEN_ROLE" --run-id "$GOLDEN_RUN"',
            ],
          },
        },
      }),
      // Up to 90 minutes for the job (golden.py), and a host to start first.
      timeout: Duration.hours(2),
    });

    // ---- Adopt: the approved digest into cdk.json ------------------------------
    const adopt = new codebuild.PipelineProject(this, 'Adopt', {
      projectName: 'flexgym-trellis2-adopt',
      description: 'Commits an approved TRELLIS.2 image digest into infra/cdk.json (N-05).',
      environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0, computeType: codebuild.ComputeType.SMALL },
      environmentVariables: { REPOSITORY: { value: props.repository.repositoryName }, BRANCH: { value: props.branch } },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: { commands: [RELEASE_TOOLS] },
          build: { commands: ['python3 gpu/trellis2/release.py adopt --image "$IMAGE" --repository "$REPOSITORY" --branch "$BRANCH"'] },
        },
      }),
      timeout: Duration.minutes(15),
    });
    adopt.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['codecommit:GetBranch', 'codecommit:GetFile', 'codecommit:PutFile'],
        resources: [props.repository.repositoryArn],
      }),
    );

    // ---- The pipeline ----------------------------------------------------------
    const source = new codepipeline.Artifact('Source');
    const sourceAction = new actions.CodeCommitSourceAction({
      actionName: 'Source',
      repository: props.repository,
      branch: props.branch,
      output: source,
      // Started by the trigger below, only when the image's own files changed.
      trigger: actions.CodeCommitTrigger.NONE,
      variablesNamespace: 'Source',
    });
    // Behind Docker Hub's pull limits, a start can name an ECR pull-through cache (runbook).
    const baseRegistry = new codepipeline.Variable({
      variableName: 'BASE_REGISTRY',
      defaultValue: 'docker.io',
      description: 'Where the base images are pulled from: docker.io, or an ECR pull-through cache of it.',
    });
    const build = new actions.CodeBuildAction({
      actionName: 'Build',
      project: this.project,
      input: source,
      variablesNamespace: 'Build',
      environmentVariables: {
        SOURCE_COMMIT: { value: sourceAction.variables.commitId },
        BASE_REGISTRY: { value: baseRegistry.reference() },
      },
    });
    const image = build.variable('IMAGE_DIGEST');
    const goldenAction = new actions.CodeBuildAction({
      actionName: 'Golden',
      project: golden,
      input: source,
      variablesNamespace: 'Golden',
      environmentVariables: { IMAGE: { value: image } },
    });
    this.pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: IMAGE_PIPELINE,
      pipelineType: codepipeline.PipelineType.V2,
      crossAccountKeys: false,
      variables: [baseRegistry],
      stages: [
        { stageName: 'Source', actions: [sourceAction] },
        { stageName: 'Build', actions: [build] },
        { stageName: 'Golden', actions: [goldenAction] },
        {
          stageName: 'Approve',
          actions: [
            new actions.ManualApprovalAction({
              actionName: 'Approve',
              additionalInformation:
                `The golden test passed on ${image}. Look at its model before approving: ` +
                `models/accounts/_golden/assets/${goldenAction.variable('GOLDEN_RUN')}/out/model.glb in ${GOLDEN_ENVIRONMENT}'s models bucket. ` +
                'Approving commits this digest into infra/cdk.json; the release then deploys it to staging, and to prod on its own approval.',
            }),
          ],
        },
        {
          stageName: 'Adopt',
          actions: [
            new actions.CodeBuildAction({
              actionName: 'Adopt',
              project: adopt,
              input: source,
              environmentVariables: { IMAGE: { value: image } },
            }),
          ],
        },
      ],
    });

    // ---- The trigger: a push that changes what the image is built from ---------
    const check = new codebuild.Project(this, 'Changes', {
      projectName: 'flexgym-trellis2-image-trigger',
      description: 'Starts the TRELLIS.2 image pipeline when a push changes what the image is built from (N-05).',
      source: codebuild.Source.codeCommit({ repository: props.repository, branchOrRef: props.branch }),
      environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0, computeType: codebuild.ComputeType.SMALL },
      environmentVariables: { PIPELINE: { value: IMAGE_PIPELINE } },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          build: {
            commands: [
              // release.py exits 0 to build, 10 for no build, anything else for a fault.
              'python3 gpu/trellis2/release.py changed --old "$OLD_COMMIT" --new "$NEW_COMMIT" && aws codepipeline start-pipeline-execution --name "$PIPELINE" || test $? -eq 10',
            ],
          },
        },
      }),
      timeout: Duration.minutes(15),
    });
    check.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['codepipeline:StartPipelineExecution'],
        resources: [`arn:aws:codepipeline:${region}:${account}:${IMAGE_PIPELINE}`],
      }),
    );
    props.repository.onCommit('ImagePush', {
      branches: [props.branch],
      description: 'A push to the release branch: does it change the TRELLIS.2 image? (N-05)',
      target: new targets.CodeBuildProject(check, {
        event: events.RuleTargetInput.fromObject({
          sourceVersion: events.EventField.fromPath('$.detail.commitId'),
          environmentVariablesOverride: [
            { name: 'OLD_COMMIT', value: events.EventField.fromPath('$.detail.oldCommitId'), type: 'PLAINTEXT' },
            { name: 'NEW_COMMIT', value: events.EventField.fromPath('$.detail.commitId'), type: 'PLAINTEXT' },
          ],
        }),
      }),
    });

    new CfnOutput(this, 'Trellis2ImageRepository', { value: this.repository.repositoryUri });
    new CfnOutput(this, 'Trellis2ImagePipeline', { value: IMAGE_PIPELINE });
  }
}
