/**
 * Per-environment settings (M-01), read from the `environments` block of
 * cdk.json context. Domains, accounts and Hub (OIDC) values are placeholders
 * until the GoalCert team and the product owner confirm them; change them in
 * cdk.json or override a whole environment with `-c environments=...`.
 *
 * Everything runs in ap-southeast-2 (Sydney). The only exception is the ACM
 * certificate CloudFront needs, which AWS requires in us-east-1 (see
 * docs/residency.md).
 */
import { Node } from 'constructs';

/** The one region that holds customer data. */
export const HOME_REGION = 'ap-southeast-2';
/** CloudFront only accepts certificates from this region. */
export const EDGE_CERT_REGION = 'us-east-1';

export type EnvName = 'dev' | 'staging' | 'prod';
export const ENV_NAMES: EnvName[] = ['dev', 'staging', 'prod'];

/** Values the backend reads as HUB_* (sign-in through GoalCert Hub). */
export interface HubConfig {
  issuer: string;
  authorizeUrl: string;
  tokenUrl: string;
  jwksUrl: string;
  clientId: string;
  orgId: string;
  webRedirectUri: string;
  iosRedirectUri: string;
}

export interface EnvConfig {
  name: EnvName;
  account: string;
  region: string;
  /** Route 53 zone we manage for the API (and mail) domain. */
  hostedZoneName: string;
  /** Import an existing zone by id instead of creating one. Empty = create. */
  hostedZoneId: string;
  apiDomain: string;
  /** The GoalCert subdomain that serves the web app. */
  webDomain: string;
  /**
   * True when the web domain lives in GoalCert's DNS (N-04). We then output
   * the records their team must add instead of creating them.
   */
  webDnsManagedByGoalCert: boolean;
  /** Domain the SES identity is created for; must be inside hostedZoneName. */
  mailDomain: string;
  mailFromLocalPart: string;
  /** Content-Security-Policy for the web app. Empty = a sensible default. */
  webCsp: string;
  natGateways: number;
  dbInstanceType: string;
  dbAllocatedStorageGiB: number;
  /** Multi-AZ is only switched on in prod. */
  dbMultiAz: boolean;
  dbBackupRetentionDays: number;
  apiCpu: number;
  apiMemoryMiB: number;
  apiDesiredCount: number;
  apiMaxCount: number;
  workerCpu: number;
  workerMemoryMiB: number;
  workerDesiredCount: number;
  logRetentionDays: number;
  /** Optional address subscribed to the alarm topic. */
  alarmEmail: string;
  /** Optional AWS Chatbot Slack target. Both must be set to enable it. */
  slackWorkspaceId: string;
  slackChannelId: string;
  /** Public key (PEM) for signed model URLs. Empty = no models distribution. */
  modelsSigningPublicKeyPem: string;
  /**
   * The approved TRELLIS.2 worker image, by digest (L-10):
   * <tooling account>.dkr.ecr.ap-southeast-2.amazonaws.com/flexgym/trellis2@sha256:...
   * Empty = no GPU environment. See docs/runbooks/trellis2-worker.md.
   */
  trellis2Image: string;
  /** Most g6e.xlarge GPU hosts running at once; idle, there are none. */
  gpuMaxInstances: number;
  hub: HubConfig;
}

export interface PipelineConfig {
  account: string;
  region: string;
  repositoryName: string;
  branch: string;
}

function fail(message: string): never {
  throw new Error(`cdk.json context: ${message}`);
}

function str(obj: Record<string, unknown>, key: string, where: string, allowEmpty = false): string {
  const value = obj[key];
  if (typeof value !== 'string') fail(`${where}.${key} must be a string`);
  if (!allowEmpty && value === '') fail(`${where}.${key} must not be empty`);
  return value;
}

function num(obj: Record<string, unknown>, key: string, where: string): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${where}.${key} must be a number`);
  return value;
}

function bool(obj: Record<string, unknown>, key: string, where: string): boolean {
  const value = obj[key];
  if (typeof value !== 'boolean') fail(`${where}.${key} must be true or false`);
  return value;
}

/** Reads and validates one environment's settings. */
export function loadEnvConfig(node: Node, name: EnvName): EnvConfig {
  const all = node.tryGetContext('environments') as Record<string, Record<string, unknown>> | undefined;
  const raw = all?.[name] ?? fail(`environments.${name} is missing`);
  const where = `environments.${name}`;
  const hubRaw = (raw.hub as Record<string, unknown> | undefined) ?? fail(`${where}.hub is missing`);
  const hubWhere = `${where}.hub`;

  const config: EnvConfig = {
    name,
    account: str(raw, 'account', where),
    region: str(raw, 'region', where),
    hostedZoneName: str(raw, 'hostedZoneName', where),
    hostedZoneId: str(raw, 'hostedZoneId', where, true),
    apiDomain: str(raw, 'apiDomain', where),
    webDomain: str(raw, 'webDomain', where),
    webDnsManagedByGoalCert: bool(raw, 'webDnsManagedByGoalCert', where),
    mailDomain: str(raw, 'mailDomain', where),
    mailFromLocalPart: str(raw, 'mailFromLocalPart', where),
    webCsp: str(raw, 'webCsp', where, true),
    natGateways: num(raw, 'natGateways', where),
    dbInstanceType: str(raw, 'dbInstanceType', where),
    dbAllocatedStorageGiB: num(raw, 'dbAllocatedStorageGiB', where),
    dbMultiAz: bool(raw, 'dbMultiAz', where),
    dbBackupRetentionDays: num(raw, 'dbBackupRetentionDays', where),
    apiCpu: num(raw, 'apiCpu', where),
    apiMemoryMiB: num(raw, 'apiMemoryMiB', where),
    apiDesiredCount: num(raw, 'apiDesiredCount', where),
    apiMaxCount: num(raw, 'apiMaxCount', where),
    workerCpu: num(raw, 'workerCpu', where),
    workerMemoryMiB: num(raw, 'workerMemoryMiB', where),
    workerDesiredCount: num(raw, 'workerDesiredCount', where),
    logRetentionDays: num(raw, 'logRetentionDays', where),
    alarmEmail: str(raw, 'alarmEmail', where, true),
    slackWorkspaceId: str(raw, 'slackWorkspaceId', where, true),
    slackChannelId: str(raw, 'slackChannelId', where, true),
    modelsSigningPublicKeyPem: str(raw, 'modelsSigningPublicKeyPem', where, true),
    trellis2Image: str(raw, 'trellis2Image', where, true),
    gpuMaxInstances: num(raw, 'gpuMaxInstances', where),
    hub: {
      issuer: str(hubRaw, 'issuer', hubWhere),
      authorizeUrl: str(hubRaw, 'authorizeUrl', hubWhere),
      tokenUrl: str(hubRaw, 'tokenUrl', hubWhere),
      jwksUrl: str(hubRaw, 'jwksUrl', hubWhere),
      clientId: str(hubRaw, 'clientId', hubWhere),
      orgId: str(hubRaw, 'orgId', hubWhere),
      webRedirectUri: str(hubRaw, 'webRedirectUri', hubWhere),
      iosRedirectUri: str(hubRaw, 'iosRedirectUri', hubWhere),
    },
  };

  // Data residency (M-16): refuse to build an environment outside Sydney.
  if (config.region !== HOME_REGION) {
    fail(`${where}.region must be ${HOME_REGION} (data residency), got ${config.region}`);
  }
  // The GPU worker runs only an image that passed its golden test, named by digest (L-10).
  if (config.trellis2Image && !/^\d{12}\.dkr\.ecr\.ap-southeast-2\.amazonaws\.com\/flexgym\/trellis2@sha256:[0-9a-f]{64}$/.test(config.trellis2Image)) {
    fail(`${where}.trellis2Image must be flexgym/trellis2 in ECR in ${HOME_REGION}, by digest (@sha256:...), or empty`);
  }
  if (!(config.gpuMaxInstances >= 1)) {
    fail(`${where}.gpuMaxInstances must be at least 1`);
  }
  if (!isInZone(config.apiDomain, config.hostedZoneName)) {
    fail(`${where}.apiDomain must be inside hostedZoneName`);
  }
  if (!isInZone(config.mailDomain, config.hostedZoneName)) {
    fail(`${where}.mailDomain must be inside hostedZoneName`);
  }
  if (!config.webDnsManagedByGoalCert && !isInZone(config.webDomain, config.hostedZoneName)) {
    fail(`${where}.webDomain must be inside hostedZoneName unless webDnsManagedByGoalCert is true`);
  }
  return config;
}

export function loadPipelineConfig(node: Node): PipelineConfig {
  const raw = (node.tryGetContext('pipeline') as Record<string, unknown> | undefined) ?? fail('pipeline is missing');
  const config: PipelineConfig = {
    account: str(raw, 'account', 'pipeline'),
    region: str(raw, 'region', 'pipeline'),
    repositoryName: str(raw, 'repositoryName', 'pipeline'),
    branch: str(raw, 'branch', 'pipeline'),
  };
  if (config.region !== HOME_REGION) fail(`pipeline.region must be ${HOME_REGION}`);
  return config;
}

/** Context flags may arrive as booleans (cdk.json) or strings (-c flag=true). */
export function contextFlag(node: Node, key: string): boolean {
  const value = node.tryGetContext(key);
  return value === true || value === 'true';
}

export function isInZone(domain: string, zone: string): boolean {
  return domain === zone || domain.endsWith(`.${zone}`);
}

/** Short title-case prefix for physical names, e.g. "flexgym-dev". */
export function resourcePrefix(config: EnvConfig): string {
  return `flexgym-${config.name}`;
}
