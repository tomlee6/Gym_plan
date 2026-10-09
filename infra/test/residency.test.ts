/**
 * Data residency check (M-16). Synthesizes the whole app with the cdk.json
 * context and asserts that every stack is in ap-southeast-2, except the ones
 * that AWS requires in us-east-1 and that hold no customer data:
 *
 *   <stage>/EdgeCerts            the CloudFront certificate
 *   cross-region-stack-...       CDK Pipelines' artifact bucket for deploying
 *                                EdgeCerts (templates, not customer data)
 *
 * It also scans every template for region names, so a hard-coded region
 * slipping in somewhere is caught.
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
import { EDGE_CERT_REGION, ENV_NAMES, HOME_REGION } from '../lib/config';

const cdkJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8'));

function synthesize(): CloudFormationStackArtifact[] {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'flexgym-residency-'));
  const app = new App({ context: { ...cdkJson.context, deployWebAssets: false }, outdir });
  return buildApp(app).synth().stacksRecursively;
}

/** Stacks allowed (and expected) in us-east-1. */
function isEdgeStack(stack: CloudFormationStackArtifact): boolean {
  return stack.hierarchicalId.endsWith('/EdgeCerts') || stack.hierarchicalId.startsWith('cross-region-stack-');
}

const stacks = synthesize();

test('synthesizes a stage for every environment', () => {
  const stages = new Set(stacks.map((s) => s.hierarchicalId.split('/').slice(0, -1).join('/')));
  assert.ok(stages.has('FlexGym-Dev'), 'dev stage');
  assert.ok(stages.has('FlexGym-Pipeline/FlexGym-Staging'), 'staging stage');
  assert.ok(stages.has('FlexGym-Pipeline/FlexGym-Prod'), 'prod stage');
  assert.equal(ENV_NAMES.length, 3);
});

test(`every stack is in ${HOME_REGION} except the us-east-1 certificate stacks`, () => {
  assert.ok(stacks.length > 20, `expected all stacks, got ${stacks.length}`);
  for (const stack of stacks) {
    const expected = isEdgeStack(stack) ? EDGE_CERT_REGION : HOME_REGION;
    assert.equal(stack.environment.region, expected, `${stack.hierarchicalId} is in ${stack.environment.region}`);
  }
});

test('the us-east-1 stacks hold no data stores', () => {
  const dataTypes = [
    'AWS::RDS::DBInstance',
    'AWS::SQS::Queue',
    'AWS::SecretsManager::Secret',
    'AWS::DynamoDB::Table',
    'AWS::Logs::LogGroup',
  ];
  for (const stack of stacks.filter(isEdgeStack)) {
    const types = Object.values<{ Type: string }>(stack.template.Resources ?? {}).map((r) => r.Type);
    for (const type of dataTypes) {
      assert.ok(!types.includes(type), `${stack.hierarchicalId} must not contain ${type}`);
    }
    if (stack.hierarchicalId.endsWith('/EdgeCerts')) {
      assert.deepEqual([...new Set(types)].sort(), ['AWS::CertificateManager::Certificate'].concat(
        types.includes('AWS::SSM::Parameter') ? ['AWS::SSM::Parameter'] : [],
      ).sort(), `${stack.hierarchicalId} should hold only the certificate (and its cross-region reference)`);
    }
  }
});

test('no template names a region other than Sydney or us-east-1', () => {
  const regionPattern =
    /\b(?:us|eu|ap|sa|ca|me|af|il|mx)-(?:north|south|east|west|central|northeast|southeast|northwest|southwest)-\d\b/g;
  for (const stack of stacks) {
    const found = new Set(JSON.stringify(stack.template).match(regionPattern) ?? []);
    for (const region of found) {
      assert.ok(
        region === HOME_REGION || region === EDGE_CERT_REGION,
        `${stack.hierarchicalId} mentions ${region}`,
      );
    }
  }
});

test('prod database is Multi-AZ and the others are not', () => {
  for (const stack of stacks.filter((s) => s.hierarchicalId.endsWith('/Data'))) {
    const db = Object.values<{ Type: string; Properties: { MultiAZ?: boolean } }>(stack.template.Resources).find(
      (r) => r.Type === 'AWS::RDS::DBInstance',
    );
    assert.ok(db, `${stack.hierarchicalId} has a database`);
    const isProd = stack.hierarchicalId.startsWith('FlexGym-Pipeline/FlexGym-Prod/');
    assert.equal(Boolean(db.Properties.MultiAZ), isProd, `${stack.hierarchicalId} MultiAZ`);
  }
});
