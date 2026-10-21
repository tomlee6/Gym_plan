/**
 * Configuration from environment variables, validated once at start-up so a
 * missing secret fails loudly instead of at the first request.
 */
import { GENERATOR_VERSION } from '../../shared/build3d/version.js';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function optional(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function int(name, fallback) {
  const raw = optional(name, String(fallback));
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) throw new Error(`${name} must be a whole number`);
  return value;
}

const bool = (name, fallback) => optional(name, String(fallback)) === 'true';

const env = optional('NODE_ENV', 'development');
const isProduction = env === 'production';
const publicApiUrl = optional('PUBLIC_API_URL', 'http://localhost:8080').replace(/\/$/, '');
const publicWebUrl = optional('PUBLIC_WEB_URL', 'http://localhost:3000').replace(/\/$/, '');

/** Every Flex service runs in Sydney (M-16). */
export const HOME_REGION = 'ap-southeast-2';

const hubDriver = optional('HUB_DRIVER', isProduction ? 'cognito' : 'dev');
if (!['dev', 'oidc', 'cognito'].includes(hubDriver)) throw new Error('HUB_DRIVER must be dev, oidc or cognito');
// The dev Hub is this API, so its addresses default to it.
const devHub = `${publicApiUrl}/dev-hub`;

/*
 * Cognito's addresses follow from the user pool and its sign-in domain, so
 * only those need setting (the HUB_* URLs still win when given).
 */
const cognitoPoolId = optional('COGNITO_USER_POOL_ID', '');
const cognitoRegion = cognitoPoolId.split('_')[0] || HOME_REGION;
const cognitoDomain = optional('COGNITO_DOMAIN', '').replace(/\/$/, '');
const hubDefaults = {
  dev: {
    issuer: devHub,
    authorizeUrl: `${devHub}/authorize`,
    tokenUrl: `${devHub}/token`,
    jwksUrl: `${devHub}/jwks`,
    clientSecret: 'dev-hub-client-secret',
    eventsSecret: 'dev-hub-events-secret',
    orgId: 'flex-gym',
  },
  oidc: { orgId: 'flex-gym' },
  cognito: {
    issuer: cognitoPoolId && `https://cognito-idp.${cognitoRegion}.amazonaws.com/${cognitoPoolId}`,
    authorizeUrl: cognitoDomain && `${cognitoDomain}/oauth2/authorize`,
    tokenUrl: cognitoDomain && `${cognitoDomain}/oauth2/token`,
    jwksUrl: cognitoPoolId && `https://cognito-idp.${cognitoRegion}.amazonaws.com/${cognitoPoolId}/.well-known/jwks.json`,
    // The pool is Flex Gym's alone: no organisation claim to check.
    orgId: '',
  },
}[hubDriver];

export const config = Object.freeze({
  env,
  isProduction,
  port: int('PORT', 8080),
  publicApiUrl,
  publicWebUrl,
  awsRegion: optional('AWS_REGION', HOME_REGION),

  db: {
    host: optional('DB_HOST', '127.0.0.1'),
    port: int('DB_PORT', 3317),
    user: required('DB_USER'),
    password: optional('DB_PASSWORD', ''),
    database: required('DB_NAME'),
    ssl: bool('DB_SSL', false),
    // The CA bundle to verify the server with (the image ships RDS's).
    sslCa: optional('DB_SSL_CA', ''),
  },

  auth: {
    jwtSecret: required('JWT_SECRET'),
    accessTokenTtlSeconds: int('ACCESS_TOKEN_TTL_SECONDS', 1800),
    /*
     * Session rules (B-06). The web keeps its refresh token for the tab
     * only, and its session ends after a working day whatever happens. The
     * phone stays signed in on a 60-day sliding token in the Keychain, so a
     * surveyor is not asked to sign in mid-site, up to a hard limit.
     */
    web: {
      idleDays: int('WEB_SESSION_IDLE_DAYS', 1),
      absoluteHours: int('WEB_SESSION_ABSOLUTE_HOURS', 12),
    },
    ios: {
      idleDays: int('IOS_SESSION_IDLE_DAYS', 60),
      absoluteDays: int('IOS_SESSION_ABSOLUTE_DAYS', 180),
    },
    inviteTtlDays: int('INVITE_TTL_DAYS', 14),
  },

  /*
   * The sign-in provider (B-01). `cognito` is Amazon Cognito in Sydney;
   * `oidc` is the GoalCert Hub; `dev` is the stand-in this API serves under
   * /dev-hub for local work and tests, refused in production.
   */
  hub: {
    driver: hubDriver,
    issuer: optional('HUB_ISSUER', hubDefaults.issuer ?? ''),
    authorizeUrl: optional('HUB_AUTHORIZE_URL', hubDefaults.authorizeUrl ?? ''),
    tokenUrl: optional('HUB_TOKEN_URL', hubDefaults.tokenUrl ?? ''),
    jwksUrl: optional('HUB_JWKS_URL', hubDefaults.jwksUrl ?? ''),
    clientId: optional('HUB_CLIENT_ID', 'flex-gym'),
    clientSecret: optional('HUB_CLIENT_SECRET', hubDefaults.clientSecret ?? ''),
    // The single Flex Gym organisation in the Hub (N-01); empty = not checked.
    orgId: process.env.HUB_ORG_ID ?? hubDefaults.orgId,
    // Cognito sends no events: the endpoint then refuses every delivery.
    eventsSecret: optional('HUB_EVENTS_SECRET', hubDefaults.eventsSecret ?? ''),
    cognito: { userPoolId: cognitoPoolId, region: cognitoRegion },
    webRedirectUri: optional('HUB_WEB_REDIRECT_URI', `${publicWebUrl}/auth/callback`),
    iosRedirectUri: optional('HUB_IOS_REDIRECT_URI', 'flexgymscan://auth/callback'),
    scope: 'openid profile email',
  },

  storage: {
    driver: optional('STORAGE_DRIVER', 'local'),
    localDir: optional('STORAGE_LOCAL_DIR', './data/storage'),
    signingSecret: required('STORAGE_SIGNING_SECRET'),
    uploadUrlTtlSeconds: int('UPLOAD_URL_TTL_SECONDS', 6 * 60 * 60),
    s3Bucket: optional('S3_BUCKET', ''),
    s3Region: optional('S3_REGION', HOME_REGION),
    // Generated 3D levels and machine models (M-03, M-07). Local storage
    // keeps them in the same folder, under models/.
    modelsBucket: optional('MODELS_BUCKET', ''),
  },

  /*
   * Background jobs (E-01). `inline` runs a job as soon as the transaction
   * that queued it commits (tests); `db` has the worker poll the jobs table
   * (local development); `sqs` sends through the outbox to SQS (AWS).
   */
  jobs: {
    driver: optional('QUEUE_DRIVER', env === 'test' ? 'inline' : 'db'),
    queueUrl: optional('JOBS_QUEUE_URL', ''),
    maxAttempts: int('JOB_MAX_ATTEMPTS', 5),
    pollMs: int('JOB_POLL_MS', 2000),
    // Raw scans, frames and videos go to cold storage this long after approval (E-05).
    retentionDays: int('RETENTION_DAYS', 90),
    workerHealthPort: int('WORKER_HEALTH_PORT', 8081),
  },

  /*
   * Which 3D generator handles plan.generate. `placeholder` marks the plan
   * ready with no stored level file, so the viewer keeps building the 3D in
   * the browser; `glb` builds and stores the level (J-01, src/generator/).
   * The version defaults to the generator's own, so a generator change
   * rebuilds stored levels instead of reusing them.
   */
  generator: {
    driver: optional('GENERATOR_DRIVER', 'placeholder'),
    version: optional(
      'GENERATOR_VERSION',
      optional('GENERATOR_DRIVER', 'placeholder') === 'glb' ? GENERATOR_VERSION : 'browser-0',
    ),
    // The most a level's model may weigh, machines included (J-08: 25 MB).
    maxBytes: int('GENERATOR_MAX_BYTES', 25 * 1024 * 1024),
  },

  /*
   * Machine models (L-07): what asset.build runs. `none` installs no
   * builder, so a build fails with a reason saying so; `trellis2` sends it to
   * the GPU worker as an AWS Batch job (L-05), whose outcome comes back on
   * the gpu-jobs queue. The generator version is part of a model's identity,
   * so a new generator builds again rather than reusing an older model.
   */
  assets: {
    builder: optional('ASSET_BUILDER', 'none'),
    generatorVersion: optional('ASSET_GENERATOR_VERSION', 'trellis2-1'),
    // Build a machine's model as soon as its 360 video is in.
    autoBuild: bool('ASSET_AUTO_BUILD', false),
    // Machine model textures (N-01): ktx2 (compressed on the graphics card; the web app's transcoder is
    // built without eval, web/vendor/basis), or webp.
    textures: optional('MODEL_TEXTURES', 'ktx2'),
    jobQueue: optional('TRELLIS2_JOB_QUEUE', ''),
    jobDefinition: optional('TRELLIS2_JOB_DEFINITION', ''),
    outcomesQueueUrl: optional('GPU_JOBS_QUEUE_URL', ''),
  },

  /**
   * Links to stored 3D models (M-07). On AWS: the models CloudFront
   * distribution and the key pair its signed URLs use (the private key is a
   * secret, PEM). Without a CDN domain the models store signs its own links.
   */
  models: {
    cdnDomain: optional('MODELS_CDN_DOMAIN', ''),
    signingKeyId: optional('MODELS_SIGNING_KEY_ID', ''),
    signingPrivateKey: optional('MODELS_SIGNING_PRIVATE_KEY', ''),
    urlTtlSeconds: int('MODELS_URL_TTL_SECONDS', 3600),
  },

  mail: {
    // log | ses (D-07)
    driver: optional('MAIL_DRIVER', 'log'),
    from: optional('MAIL_FROM', 'Flex Gym Scan <no-reply@flexgym.example>'),
    configurationSet: optional('SES_CONFIGURATION_SET', ''),
  },

  uploads: {
    /** Smallest part the app may use: S3's multipart minimum. */
    minPartSize: 5 * 1024 * 1024,
    maxPartSize: 64 * 1024 * 1024,
    /** A single file may not exceed this; generous for a USDZ plus room data. */
    maxFileBytes: 2 * 1024 * 1024 * 1024,
    /** Room for about one keyframe a second over a long scan (F-02). */
    maxFilesPerCapture: 2000,
    allowSimulatedScans: bool('ALLOW_SIMULATED_SCANS', false),
  },
});

/**
 * Production refuses to start in a state that would be unsafe there (D-09):
 * simulated scans allowed, files on local disk, data outside Sydney, the
 * stand-in Hub, or weak secrets.
 */
export function productionProblems(c = config) {
  const problems = [];
  if (!c.isProduction) return problems;
  for (const [name, value] of [
    ['JWT_SECRET', c.auth.jwtSecret],
    ['STORAGE_SIGNING_SECRET', c.storage.signingSecret],
    ['HUB_CLIENT_SECRET', c.hub.clientSecret],
    ...(c.hub.driver === 'oidc' ? [['HUB_EVENTS_SECRET', c.hub.eventsSecret]] : []),
  ]) {
    if (!value || value.length < 32 || /^(change-me|dev-|test-)/.test(value)) {
      problems.push(`${name} must be a long random secret in production`);
    }
  }
  if (c.uploads.allowSimulatedScans) problems.push('ALLOW_SIMULATED_SCANS must be false in production');
  if (c.storage.driver !== 's3') problems.push('STORAGE_DRIVER must be s3 in production');
  if (c.storage.s3Region !== HOME_REGION) problems.push(`S3_REGION must be ${HOME_REGION} in production`);
  if (c.generator.driver === 'glb' && !c.storage.modelsBucket) {
    problems.push('MODELS_BUCKET must be set when GENERATOR_DRIVER is glb');
  }
  // Models are only ever served through the signed CloudFront distribution (M-07).
  if (c.generator.driver === 'glb' && !(c.models.cdnDomain && c.models.signingKeyId && c.models.signingPrivateKey)) {
    problems.push('MODELS_CDN_DOMAIN, MODELS_SIGNING_KEY_ID and MODELS_SIGNING_PRIVATE_KEY must be set when GENERATOR_DRIVER is glb');
  }
  if (!['none', 'trellis2'].includes(c.assets.builder)) problems.push('ASSET_BUILDER must be none or trellis2');
  if (!['webp', 'ktx2'].includes(c.assets.textures)) problems.push('MODEL_TEXTURES must be webp or ktx2');
  if (c.assets.builder === 'trellis2') {
    for (const [name, value] of [
      ['TRELLIS2_JOB_QUEUE', c.assets.jobQueue],
      ['TRELLIS2_JOB_DEFINITION', c.assets.jobDefinition],
      ['GPU_JOBS_QUEUE_URL', c.assets.outcomesQueueUrl],
      ['MODELS_BUCKET', c.storage.modelsBucket],
    ]) {
      if (!value) problems.push(`${name} must be set when ASSET_BUILDER is trellis2`);
    }
  }
  if (c.awsRegion !== HOME_REGION) problems.push(`AWS_REGION must be ${HOME_REGION} in production`);
  if (c.hub.driver === 'dev') problems.push('HUB_DRIVER must be cognito or oidc in production');
  if (c.hub.driver === 'cognito' && c.hub.cognito.region !== HOME_REGION) {
    problems.push(`COGNITO_USER_POOL_ID must be a user pool in ${HOME_REGION}`);
  }
  for (const [name, value] of [
    ['HUB_ISSUER', c.hub.issuer],
    ['HUB_AUTHORIZE_URL', c.hub.authorizeUrl],
    ['HUB_TOKEN_URL', c.hub.tokenUrl],
    ['HUB_JWKS_URL', c.hub.jwksUrl],
  ]) {
    if (!/^https:\/\//.test(value)) problems.push(`${name} must be an https URL in production`);
  }
  if (c.jobs.driver !== 'sqs') problems.push('QUEUE_DRIVER must be sqs in production');
  if (c.jobs.driver === 'sqs' && !c.jobs.queueUrl.includes(HOME_REGION)) {
    problems.push(`JOBS_QUEUE_URL must be a queue in ${HOME_REGION}`);
  }
  if (c.mail.driver !== 'ses') problems.push('MAIL_DRIVER must be ses in production');
  if (!/^https:\/\//.test(c.publicWebUrl) || !/^https:\/\//.test(c.publicApiUrl)) {
    problems.push('PUBLIC_WEB_URL and PUBLIC_API_URL must be https in production');
  }
  return problems;
}

const problems = productionProblems();
if (problems.length) {
  throw new Error(`Refusing to start in production:\n  - ${problems.join('\n  - ')}`);
}
