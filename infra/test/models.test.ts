/**
 * Models delivery (M-07). Browsers download 3D models straight from the
 * private models bucket in Sydney, with presigned links the API makes: no
 * CDN and no signing key. The worker builds each approved level into that
 * bucket in every environment.
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

type Resource = { Type: string; Properties?: Record<string, any> };

/** The dev stage's stacks. */
function devStacks(): Map<string, CloudFormationStackArtifact> {
  const context = JSON.parse(JSON.stringify(cdkJson.context));
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'flexgym-models-'));
  const app = new App({ context: { ...context, deployWebAssets: false }, outdir });
  const stacks = buildApp(app).synth().stacksRecursively.filter((s) => s.hierarchicalId.startsWith('FlexGym-Dev/'));
  return new Map(stacks.map((s) => [s.hierarchicalId.split('/').pop()!, s]));
}

const resources = (stack: CloudFormationStackArtifact): Resource[] => Object.values(stack.template.Resources ?? {});
const ofType = (stack: CloudFormationStackArtifact, type: string) => resources(stack).filter((r) => r.Type === type);

/** Each backend container (API and worker): its environment variable names and values, and its secret names. */
function containers(api: CloudFormationStackArtifact) {
  return ofType(api, 'AWS::ECS::TaskDefinition').flatMap((t) =>
    (t.Properties?.ContainerDefinitions ?? []).map((c: any) => ({
      name: c.Name as string,
      env: Object.fromEntries((c.Environment ?? []).map((e: any) => [e.Name, e.Value])),
      secrets: (c.Secrets ?? []).map((s: any) => s.Name as string),
    })),
  );
}

const stacks = devStacks();
const data = stacks.get('Data')!;

/** The models bucket: the one whose access logs go under s3/models/. */
const modelsBucket = ofType(data, 'AWS::S3::Bucket').find(
  (b) => b.Properties?.LoggingConfiguration?.LogFilePrefix === 's3/models/',
)!;

test('no CDN and no signing key for models: they come straight from the bucket', () => {
  assert.equal(ofType(data, 'AWS::CloudFront::Distribution').length, 0);
  assert.equal(ofType(data, 'AWS::CloudFront::PublicKey').length, 0);
  const secretNames = ofType(data, 'AWS::SecretsManager::Secret').map((s) => s.Properties!.Name as string);
  assert.ok(!secretNames.some((n) => /MODELS_SIGNING/.test(n)));
});

test('the models bucket stays private, and lets only the web app read it from a browser', () => {
  assert.ok(modelsBucket, 'a models bucket');
  const block = modelsBucket.Properties!.PublicAccessBlockConfiguration;
  assert.deepEqual(
    [block.BlockPublicAcls, block.BlockPublicPolicy, block.IgnorePublicAcls, block.RestrictPublicBuckets],
    [true, true, true, true],
  );
  const [rule, ...others] = modelsBucket.Properties!.CorsConfiguration.CorsRules;
  assert.equal(others.length, 0);
  assert.deepEqual(rule.AllowedOrigins, [`https://${cdkJson.context.environments.dev.webDomain}`]);
  assert.deepEqual([...rule.AllowedMethods].sort(), ['GET', 'HEAD'], 'reads only');
});

test('the API and worker generate levels and make the links, with no signing secret', () => {
  const backend = containers(stacks.get('Api')!);
  assert.deepEqual(backend.map((c) => c.name).sort(), ['api', 'worker']);
  for (const c of backend) {
    assert.equal(c.env.GENERATOR_DRIVER, 'glb', `${c.name} generates levels`);
    assert.ok(c.env.MODELS_BUCKET, `${c.name} knows the bucket`);
    assert.equal(c.env.MODELS_CDN_DOMAIN, undefined);
    assert.ok(!c.secrets.some((s: string) => /MODELS_SIGNING/.test(s)));
  }
});
