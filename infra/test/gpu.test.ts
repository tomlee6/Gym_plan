/**
 * The GPU environment for machine models (L-10): AWS Batch on g5.2xlarge in
 * Sydney, only when an environment names an approved TRELLIS.2 image.
 *
 * Run: npm test
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { CloudFormationStackArtifact } from 'aws-cdk-lib/cx-api';
import { buildApp } from '../lib/app';

const cdkJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8'));
const IMAGE = `111111111111.dkr.ecr.ap-southeast-2.amazonaws.com/flexgym/trellis2@sha256:${'a'.repeat(64)}`;

type Resource = { Type: string; Properties?: Record<string, any> };

function devStacks(image: string): Map<string, CloudFormationStackArtifact> {
  const context = JSON.parse(JSON.stringify(cdkJson.context));
  context.environments.dev.trellis2Image = image;
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'flexgym-gpu-'));
  const app = new App({ context: { ...context, deployWebAssets: false }, outdir });
  const stacks = buildApp(app).synth().stacksRecursively.filter((s) => s.hierarchicalId.startsWith('FlexGym-Dev/'));
  return new Map(stacks.map((s) => [s.hierarchicalId.split('/').pop()!, s]));
}

const ofType = (stack: CloudFormationStackArtifact, type: string): Resource[] =>
  Object.values<Resource>(stack.template.Resources ?? {}).filter((r) => r.Type === type);

const withGpu = devStacks(IMAGE);
const gpu = withGpu.get('Gpu')!;

test('g5.2xlarge hosts in Sydney, none while idle, on the GPU image, with the weights disk mounted', () => {
  assert.ok(gpu, 'a Gpu stack');
  assert.equal(gpu.environment.region, 'ap-southeast-2');
  const [env] = ofType(gpu, 'AWS::Batch::ComputeEnvironment');
  const resources = env.Properties!.ComputeResources;
  assert.deepEqual(resources.InstanceTypes, ['g5.2xlarge']);
  assert.equal(resources.MinvCpus, 0, 'scales to zero');
  assert.equal(resources.MaxvCpus, 8 * cdkJson.context.environments.dev.gpuMaxInstances);
  assert.equal(resources.Ec2Configuration[0].ImageType, 'ECS_AL2023_NVIDIA');
  const [template] = ofType(gpu, 'AWS::EC2::LaunchTemplate');
  const data = template.Properties!.LaunchTemplateData;
  const userData = JSON.stringify(data.UserData);
  assert.match(userData, /multipart\/mixed/, 'Batch needs MIME user data');
  assert.match(userData, /Instance Storage/);
  assert.match(userData, /chown 1000:1000 \/weights/);
  assert.equal(data.MetadataOptions.HttpTokens, 'required');
  assert.equal(data.BlockDeviceMappings[0].Ebs.VolumeSize, 100);
});

test('a job definition for the approved image by digest, one GPU, the weights volume, no retry on bad input', () => {
  const [job] = ofType(gpu, 'AWS::Batch::JobDefinition');
  const p = job.Properties!;
  assert.equal(p.ContainerProperties.Image, IMAGE);
  const resources = Object.fromEntries(p.ContainerProperties.ResourceRequirements.map((r: any) => [r.Type, r.Value]));
  assert.deepEqual(resources, { GPU: '1', VCPU: '8', MEMORY: String(28 * 1024) });
  assert.deepEqual(p.ContainerProperties.Command, ['--input', 'Ref::input', '--output', 'Ref::output', '--params', 'Ref::params']);
  assert.deepEqual(p.ContainerProperties.Volumes, [{ Name: 'weights', Host: { SourcePath: '/weights' } }]);
  // Writable: the job copies the weights there (ReadOnly left out means false).
  assert.deepEqual(p.ContainerProperties.MountPoints, [{ ContainerPath: '/weights', SourceVolume: 'weights' }]);
  const env = Object.fromEntries(p.ContainerProperties.Environment.map((e: any) => [e.Name, e.Value]));
  assert.match(JSON.stringify(env.WEIGHTS_S3), /gpu\/trellis2\/weights\//);
  assert.equal(p.RetryStrategy.Attempts, 3);
  assert.deepEqual(p.RetryStrategy.EvaluateOnExit, [{ Action: 'EXIT', OnExitCode: '2' }]);
  assert.equal(p.Timeout.AttemptDurationSeconds, 3600);
});

test("a job reads the weights, machines' videos and its own assets, and writes only its assets", () => {
  const policies = ofType(gpu, 'AWS::IAM::Policy').filter((p) => JSON.stringify(p.Properties!.Roles).includes('JobRole'));
  const statements = policies.flatMap((p) => p.Properties!.PolicyDocument.Statement);
  const s3 = JSON.stringify(statements.filter((s: any) => [s.Action].flat().some((a: string) => a.startsWith('s3:'))).map((s: any) => s.Resource));
  assert.match(s3, /gpu\/trellis2\/weights\/\*/);
  assert.match(s3, /models\/accounts\/\*\/assets\/\*/);
  assert.match(s3, /accounts\/\*\/captures\/\*\/equipment\/\*/, 'the 360 videos and frames');
  assert.doesNotMatch(s3, /"\/\*"/, 'never a whole bucket');
  const writes = statements.filter((s: any) => [s.Action].flat().some((a: string) => a === 's3:PutObject' || a.startsWith('s3:DeleteObject')));
  assert.ok(writes.length && writes.every((s: any) => JSON.stringify(s.Resource).includes('assets/*')), 'writes only under assets');
  // Both buckets are encrypted with the data key, so reading them needs it.
  assert.ok(statements.some((s: any) => [s.Action].flat().includes('kms:Decrypt')));
});

test('outcomes go to the gpu-jobs queue, and the backend can submit jobs and read them', () => {
  const [rule] = ofType(gpu, 'AWS::Events::Rule');
  assert.deepEqual(rule.Properties!.EventPattern.source, ['aws.batch']);
  assert.deepEqual(rule.Properties!.EventPattern.detail.status, ['SUCCEEDED', 'FAILED']);
  const api = withGpu.get('Api')!;
  const containers = ofType(api, 'AWS::ECS::TaskDefinition').flatMap((t) => t.Properties!.ContainerDefinitions);
  for (const c of containers) {
    const env = Object.fromEntries((c.Environment ?? []).map((e: any) => [e.Name, e.Value]));
    assert.ok(env.TRELLIS2_JOB_QUEUE && env.TRELLIS2_JOB_DEFINITION, c.Name);
    assert.equal(env.ASSET_BUILDER, 'trellis2', c.Name);
    assert.equal(env.ASSET_AUTO_BUILD, 'true', c.Name);
    assert.ok(env.GPU_JOBS_QUEUE_URL, c.Name);
  }
  const apiPolicies = JSON.stringify(ofType(api, 'AWS::IAM::Policy').map((p) => p.Properties!.PolicyDocument));
  assert.ok(apiPolicies.includes('batch:SubmitJob'));
  assert.ok(apiPolicies.includes('batch:ListJobs'), 'to find a try already sent');
  assert.ok(apiPolicies.includes('sqs:ReceiveMessage'));
});

test('no GPU environment until an approved image is named', () => {
  const without = devStacks('');
  assert.equal(without.get('Gpu'), undefined);
  const containers = ofType(without.get('Api')!, 'AWS::ECS::TaskDefinition').flatMap((t) => t.Properties!.ContainerDefinitions);
  assert.ok(containers.every((c: any) => !(c.Environment ?? []).some((e: any) => ['TRELLIS2_JOB_QUEUE', 'ASSET_BUILDER'].includes(e.Name))));
});

test('an image named by tag instead of digest is refused', () => {
  assert.throws(() => devStacks('111111111111.dkr.ecr.ap-southeast-2.amazonaws.com/flexgym/trellis2:latest'), /by digest/);
});
