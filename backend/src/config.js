/**
 * Configuration from environment variables, validated once at start-up so a
 * missing secret fails loudly instead of at the first request.
 */

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

const hubDriver = optional('HUB_DRIVER', isProduction ? 'oidc' : 'dev');
// The dev Hub is this API, so its addresses default to it.
const devHub = `${publicApiUrl}/dev-hub`;

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
   * The GoalCert Hub (B-01). `oidc` is the real Hub; `dev` is the stand-in
   * this API serves under /dev-hub for local work and tests, refused in
   * production.
   */
  hub: {
    driver: hubDriver,
    issuer: optional('HUB_ISSUER', hubDriver === 'dev' ? devHub : ''),
    authorizeUrl: optional('HUB_AUTHORIZE_URL', hubDriver === 'dev' ? `${devHub}/authorize` : ''),
    tokenUrl: optional('HUB_TOKEN_URL', hubDriver === 'dev' ? `${devHub}/token` : ''),
    jwksUrl: optional('HUB_JWKS_URL', hubDriver === 'dev' ? `${devHub}/jwks` : ''),
    clientId: optional('HUB_CLIENT_ID', 'flex-gym'),
    clientSecret: optional('HUB_CLIENT_SECRET', hubDriver === 'dev' ? 'dev-hub-client-secret' : ''),
    // The single Flex Gym organisation in the Hub (N-01).
    orgId: optional('HUB_ORG_ID', 'flex-gym'),
    eventsSecret: optional('HUB_EVENTS_SECRET', hubDriver === 'dev' ? 'dev-hub-events-secret' : ''),
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
   * the browser until the generator worker (task J-01) replaces it.
   */
  generator: {
    driver: optional('GENERATOR_DRIVER', 'placeholder'),
    version: optional('GENERATOR_VERSION', 'browser-0'),
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
    ['HUB_EVENTS_SECRET', c.hub.eventsSecret],
  ]) {
    if (!value || value.length < 32 || /^(change-me|dev-|test-)/.test(value)) {
      problems.push(`${name} must be a long random secret in production`);
    }
  }
  if (c.uploads.allowSimulatedScans) problems.push('ALLOW_SIMULATED_SCANS must be false in production');
  if (c.storage.driver !== 's3') problems.push('STORAGE_DRIVER must be s3 in production');
  if (c.storage.s3Region !== HOME_REGION) problems.push(`S3_REGION must be ${HOME_REGION} in production`);
  if (c.awsRegion !== HOME_REGION) problems.push(`AWS_REGION must be ${HOME_REGION} in production`);
  if (c.hub.driver !== 'oidc') problems.push('HUB_DRIVER must be oidc in production');
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
