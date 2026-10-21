/**
 * Models delivery (M-07). With a signing public key in an environment's
 * context, the stage gets the models CloudFront distribution (signed URLs
 * only), the private key's secret, and a backend set up to generate levels
 * and sign links to them. Without one, none of it, and the viewer keeps
 * building levels in the browser. See docs/runbooks/models-signing-key.md.
 *
 * Run: npm test
 */
import { strict as assert } from 'node:assert';
import { generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { CloudFormationStackArtifact } from 'aws-cdk-lib/cx-api';
import { buildApp } from '../lib/app';

const cdkJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8'));

type Resource = { Type: string; Properties?: Record<string, any> };

/** The dev stage's stacks, with `publicKeyPem` as the dev models signing key. */
function devStacks(publicKeyPem: string): Map<string, CloudFormationStackArtifact> {
  const context = JSON.parse(JSON.stringify(cdkJson.context));
  context.environments.dev.modelsSigningPublicKeyPem = publicKeyPem;
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

const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const withKey = devStacks(publicKey.export({ type: 'spki', format: 'pem' }).toString());
const withoutKey = devStacks('');

test('a signing key brings a models distribution that serves signed URLs only', () => {
  const data = withKey.get('Data')!;
  const [distribution] = ofType(data, 'AWS::CloudFront::Distribution');
  assert.ok(distribution, 'a models distribution');
  const behaviour = distribution.Properties!.DistributionConfig.DefaultCacheBehavior;
  assert.equal(behaviour.TrustedKeyGroups.length, 1, 'every request must be signed');
  assert.equal(behaviour.ViewerProtocolPolicy, 'https-only');
  assert.equal(ofType(data, 'AWS::CloudFront::PublicKey').length, 1);
  const secretNames = ofType(data, 'AWS::SecretsManager::Secret').map((s) => s.Properties!.Name as string);
  assert.ok(secretNames.some((n) => n.endsWith('/MODELS_SIGNING_PRIVATE_KEY')), 'the private key secret');
});

test('the API and worker can then generate levels and sign links to them', () => {
  const backend = containers(withKey.get('Api')!);
  assert.deepEqual(backend.map((c) => c.name).sort(), ['api', 'worker']);
  for (const c of backend) {
    assert.equal(c.env.GENERATOR_DRIVER, 'glb', `${c.name} generates levels`);
    assert.ok(c.env.MODELS_CDN_DOMAIN, `${c.name} knows the distribution`);
    assert.ok(c.env.MODELS_SIGNING_KEY_ID, `${c.name} knows the key id`);
    assert.ok(c.env.MODELS_BUCKET, `${c.name} knows the bucket`);
    assert.ok(c.secrets.includes('MODELS_SIGNING_PRIVATE_KEY'), `${c.name} can sign`);
  }
});

test('without a signing key there is no distribution and the generator stays off', () => {
  const data = withoutKey.get('Data')!;
  assert.equal(ofType(data, 'AWS::CloudFront::Distribution').length, 0);
  const secretNames = ofType(data, 'AWS::SecretsManager::Secret').map((s) => s.Properties!.Name as string);
  assert.ok(!secretNames.some((n) => n.endsWith('/MODELS_SIGNING_PRIVATE_KEY')));
  for (const c of containers(withoutKey.get('Api')!)) {
    assert.equal(c.env.GENERATOR_DRIVER, undefined, `${c.name} leaves the generator off`);
    assert.equal(c.env.MODELS_CDN_DOMAIN, undefined);
    assert.ok(!c.secrets.includes('MODELS_SIGNING_PRIVATE_KEY'));
  }
});
