/**
 * The TRELLIS.2 worker image build (L-09), in the tooling account's pipeline
 * stack: its ECR repository and CodeBuild project.
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

const cdkJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8'));
const context = cdkJson.context;

type Resource = { Type: string; Properties?: Record<string, any> };

const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'flexgym-trellis2-'));
const app = new App({ context: { ...context, deployWebAssets: false }, outdir });
const pipeline = buildApp(app)
  .synth()
  .stacksRecursively.find((s) => s.hierarchicalId === 'FlexGym-Pipeline');
const resources: Resource[] = Object.values(pipeline?.template.Resources ?? {});
const ofType = (type: string) => resources.filter((r) => r.Type === type);

test('an ECR repository whose tags never move, scanned on push, pulled by staging and prod', () => {
  const [repo] = ofType('AWS::ECR::Repository').filter((r) => r.Properties?.RepositoryName === 'flexgym/trellis2');
  assert.ok(repo, 'the flexgym/trellis2 repository');
  assert.equal(repo.Properties!.ImageTagMutability, 'IMMUTABLE');
  assert.equal(repo.Properties!.ImageScanningConfiguration.ScanOnPush, true);
  const statement = repo.Properties!.RepositoryPolicyText.Statement.find((s: any) => s.Sid === 'GpuJobsPull');
  const principals = JSON.stringify(statement.Principal);
  for (const env of ['staging', 'prod']) {
    assert.ok(principals.includes(context.environments[env].account), `${env} can pull`);
  }
  assert.deepEqual([...statement.Action].sort(), ['ecr:BatchCheckLayerAvailability', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer']);
});

test('a CodeBuild project big enough to compile the CUDA extensions, building from our buildspec', () => {
  const [project] = ofType('AWS::CodeBuild::Project').filter((r) => r.Properties?.Name === 'flexgym-trellis2-image');
  assert.ok(project, 'the flexgym-trellis2-image project');
  const env = project.Properties!.Environment;
  assert.equal(env.ComputeType, 'BUILD_GENERAL1_2XLARGE');
  assert.equal(env.PrivilegedMode, true, 'docker build needs it');
  assert.equal(project.Properties!.TimeoutInMinutes, 480);
  assert.equal(project.Properties!.Source.BuildSpec, 'gpu/trellis2/buildspec.yml');
  assert.ok(env.EnvironmentVariables.some((v: any) => v.Name === 'IMAGE_REPO'));
});

test('the build can push to the repository', () => {
  const policies = JSON.stringify(ofType('AWS::IAM::Policy').map((p) => p.Properties!.PolicyDocument));
  for (const action of ['ecr:PutImage', 'ecr:InitiateLayerUpload', 'ecr:CompleteLayerUpload', 'ecr:GetAuthorizationToken']) {
    assert.ok(policies.includes(action), action);
  }
});
