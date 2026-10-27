/**
 * Releasing the TRELLIS.2 worker image (N-05): its own pipeline in the
 * tooling account (build, golden test on staging's GPUs, approval, the
 * digest into cdk.json), started by a push that changes the image, and the
 * role staging keeps for the golden test.
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
import { GOLDEN_ROLE_NAME, GOLDEN_RUNNER_ROLE_NAME } from '../lib/gpu-stack';
import { IMAGE_PIPELINE } from '../lib/trellis2-image';

const cdkJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8'));
const IMAGE = `111111111111.dkr.ecr.ap-southeast-2.amazonaws.com/flexgym/trellis2@sha256:${'a'.repeat(64)}`;

type Resource = { Type: string; Properties?: Record<string, any> };

// Every environment with a GPU environment, so dev's and prod's can be told from staging's.
const context = JSON.parse(JSON.stringify(cdkJson.context));
for (const env of ['dev', 'staging', 'prod']) context.environments[env].trellis2Image = IMAGE;
const app = new App({ context: { ...context, deployWebAssets: false }, outdir: fs.mkdtempSync(path.join(os.tmpdir(), 'flexgym-release-')) });
const stacks = buildApp(app).synth().stacksRecursively;
const stack = (id: string) => stacks.find((s) => s.hierarchicalId === id)!;
const resources = (id: string): Resource[] => Object.values(stack(id).template.Resources ?? {});
const ofType = (id: string, type: string) => resources(id).filter((r) => r.Type === type);

const tooling = context.pipeline.account;
const staging = context.environments.staging.account;
const pipelineResources = 'FlexGym-Pipeline';
const [pipeline] = ofType(pipelineResources, 'AWS::CodePipeline::Pipeline').filter((p) => p.Properties!.Name === IMAGE_PIPELINE);
const stage = (name: string) => pipeline.Properties!.Stages.find((s: any) => s.Name === name);
const project = (name: string) => ofType(pipelineResources, 'AWS::CodeBuild::Project').find((p) => p.Properties!.Name === name)!;
const policies = JSON.stringify(ofType(pipelineResources, 'AWS::IAM::Policy').map((p) => p.Properties));
/** A project's build commands, from its inline buildspec. */
const commands = (name: string): string[] => {
  const spec = JSON.parse(project(name).Properties!.Source.BuildSpec);
  return Object.values<any>(spec.phases).flatMap((phase) => phase.commands);
};

test('an image pipeline: source, build, golden test, approval, then the digest into cdk.json', () => {
  assert.ok(pipeline, IMAGE_PIPELINE);
  assert.equal(pipeline.Properties!.PipelineType, 'V2');
  assert.deepEqual(pipeline.Properties!.Stages.map((s: any) => s.Name), ['Source', 'Build', 'Golden', 'Approve', 'Adopt']);
  const source = stage('Source').Actions[0];
  assert.equal(source.Configuration.BranchName, context.pipeline.branch);
  assert.equal(source.Configuration.PollForSourceChanges, false, 'started by the trigger, not by every push');
  assert.deepEqual(pipeline.Properties!.Variables, [
    { Name: 'BASE_REGISTRY', DefaultValue: 'docker.io', Description: 'Where the base images are pulled from: docker.io, or an ECR pull-through cache of it.' },
  ]);
});

test('the build is tagged with the source commit, and its digest goes to the golden test, the approval and the commit', () => {
  const env = (name: string) => JSON.parse(stage(name).Actions[0].Configuration.EnvironmentVariables ?? '[]');
  assert.deepEqual(env('Build'), [
    { name: 'SOURCE_COMMIT', type: 'PLAINTEXT', value: '#{Source.CommitId}' },
    { name: 'BASE_REGISTRY', type: 'PLAINTEXT', value: '#{variables.BASE_REGISTRY}' },
  ]);
  assert.deepEqual(env('Golden'), [{ name: 'IMAGE', type: 'PLAINTEXT', value: '#{Build.IMAGE_DIGEST}' }]);
  assert.deepEqual(env('Adopt'), [{ name: 'IMAGE', type: 'PLAINTEXT', value: '#{Build.IMAGE_DIGEST}' }]);
  const approval = stage('Approve').Actions[0];
  assert.equal(approval.ActionTypeId.Category, 'Approval');
  assert.match(approval.Configuration.CustomData, /#\{Build\.IMAGE_DIGEST\}/);
  assert.match(approval.Configuration.CustomData, /_golden\/assets\/#\{Golden\.GOLDEN_RUN\}\/out\/model\.glb/);
  // The image project is the pipeline's own step now.
  assert.equal(project('flexgym-trellis2-image').Properties!.Source.Type, 'CODEPIPELINE');
});

test('the golden test runs as staging’s golden-test role, and can do nothing else', () => {
  const golden = project('flexgym-trellis2-golden');
  assert.ok(commands('flexgym-trellis2-golden').includes('python3 release.py golden --image "$IMAGE" --env "$GOLDEN_ENV" --role-arn "$GOLDEN_ROLE" --run-id "$GOLDEN_RUN"'));
  assert.deepEqual(JSON.parse(golden.Properties!.Source.BuildSpec).env['exported-variables'], ['GOLDEN_RUN']);
  const vars = Object.fromEntries(golden.Properties!.Environment.EnvironmentVariables.map((v: any) => [v.Name, v.Value]));
  assert.equal(vars.GOLDEN_ENV, 'staging');
  assert.equal(vars.GOLDEN_ROLE, `arn:aws:iam::${staging}:role/${GOLDEN_ROLE_NAME}`);
  const [runner] = ofType(pipelineResources, 'AWS::IAM::Role').filter((r) => r.Properties!.RoleName === GOLDEN_RUNNER_ROLE_NAME);
  assert.ok(runner, 'a runner role by a fixed name, which staging trusts');
  assert.ok(policies.includes(`"Action":"sts:AssumeRole","Effect":"Allow","Resource":"arn:aws:iam::${staging}:role/${GOLDEN_ROLE_NAME}"`));
});

test('the approved digest is committed by a step that can only read and write the repository', () => {
  assert.ok(commands('flexgym-trellis2-adopt').includes('python3 gpu/trellis2/release.py adopt --image "$IMAGE" --repository "$REPOSITORY" --branch "$BRANCH"'));
  assert.match(policies, /"codecommit:GetBranch","codecommit:GetFile","codecommit:PutFile"\],"Effect":"Allow","Resource":"arn:aws:codecommit:ap-southeast-2:\d+:gym_floor_plan"/);
});

test('a push to the release branch is checked, and starts the pipeline only if the image changed', () => {
  const [rule] = ofType(pipelineResources, 'AWS::Events::Rule').filter((r) => r.Properties!.EventPattern?.source?.includes('aws.codecommit'));
  assert.ok(rule, 'a rule on the repository');
  const pattern = rule.Properties!.EventPattern;
  assert.deepEqual(pattern.detail.referenceName, [context.pipeline.branch]);
  assert.deepEqual(pattern.detail.event.sort(), ['referenceCreated', 'referenceUpdated']);
  const [target] = rule.Properties!.Targets;
  const input = target.InputTransformer.InputTemplate;
  assert.match(input, /"name":"OLD_COMMIT","value":<detail-oldCommitId>/);
  assert.match(input, /"name":"NEW_COMMIT","value":<detail-commitId>/);
  assert.match(input, /"sourceVersion":<detail-commitId>/);
  assert.deepEqual(commands('flexgym-trellis2-image-trigger'), [
    'python3 gpu/trellis2/release.py changed --old "$OLD_COMMIT" --new "$NEW_COMMIT" && aws codepipeline start-pipeline-execution --name "$PIPELINE" || test $? -eq 10',
  ]);
  assert.ok(policies.includes(`"Action":"codepipeline:StartPipelineExecution","Effect":"Allow","Resource":"arn:aws:codepipeline:ap-southeast-2:${tooling}:${IMAGE_PIPELINE}"`));
});

test('staging keeps a golden-test role for the image pipeline’s runner alone, with only what golden.py needs', () => {
  const id = 'FlexGym-Pipeline/FlexGym-Staging/Gpu';
  const [role] = ofType(id, 'AWS::IAM::Role').filter((r) => r.Properties!.RoleName === GOLDEN_ROLE_NAME);
  assert.ok(role, 'the golden-test role');
  assert.equal(role.Properties!.MaxSessionDuration, 7200);
  const [trust] = role.Properties!.AssumeRolePolicyDocument.Statement;
  assert.match(JSON.stringify(trust.Principal), new RegExp(`:iam::${tooling}:root`));
  assert.deepEqual(trust.Condition, { ArnEquals: { 'aws:PrincipalArn': `arn:aws:iam::${tooling}:role/${GOLDEN_RUNNER_ROLE_NAME}` } });

  const statements = ofType(id, 'AWS::IAM::Policy')
    .filter((p) => JSON.stringify(p.Properties!.Roles).includes('GoldenTest'))
    .flatMap((p) => p.Properties!.PolicyDocument.Statement);
  const actions = statements.flatMap((s: any) => [s.Action].flat()).sort();
  assert.deepEqual(
    [...new Set(actions.filter((a: string) => a.startsWith('batch:')))],
    ['batch:DeregisterJobDefinition', 'batch:DescribeJobDefinitions', 'batch:DescribeJobs', 'batch:RegisterJobDefinition', 'batch:SubmitJob'],
  );
  const register = statements.find((s: any) => [s.Action].flat().includes('batch:RegisterJobDefinition'));
  assert.match(JSON.stringify(register.Resource), /job-definition\/flexgym-staging-trellis2-candidate/, 'only the candidate copy');
  assert.ok(actions.includes('iam:PassRole'));
  assert.match(JSON.stringify(statements), /models\/accounts\/_golden\/\*/);
  assert.doesNotMatch(JSON.stringify(statements), /models\/accounts\/\*\/assets/, 'no customer models');
});

test('dev and prod keep no golden-test role', () => {
  for (const id of ['FlexGym-Dev/Gpu', 'FlexGym-Pipeline/FlexGym-Prod/Gpu']) {
    assert.ok(stack(id), id);
    assert.equal(ofType(id, 'AWS::IAM::Role').filter((r) => r.Properties!.RoleName === GOLDEN_ROLE_NAME).length, 0, id);
  }
});
