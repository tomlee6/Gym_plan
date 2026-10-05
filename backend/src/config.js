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

const env = optional('NODE_ENV', 'development');

export const config = Object.freeze({
  env,
  isProduction: env === 'production',
  port: int('PORT', 8080),
  publicApiUrl: optional('PUBLIC_API_URL', 'http://localhost:8080').replace(/\/$/, ''),
  publicWebUrl: optional('PUBLIC_WEB_URL', 'http://localhost:3000').replace(/\/$/, ''),

  db: {
    host: optional('DB_HOST', '127.0.0.1'),
    port: int('DB_PORT', 3317),
    user: required('DB_USER'),
    password: optional('DB_PASSWORD', ''),
    database: required('DB_NAME'),
  },

  auth: {
    jwtSecret: required('JWT_SECRET'),
    accessTokenTtlSeconds: int('ACCESS_TOKEN_TTL_SECONDS', 1800),
    refreshTokenTtlDays: int('REFRESH_TOKEN_TTL_DAYS', 30),
    passwordResetTtlMinutes: int('PASSWORD_RESET_TTL_MINUTES', 60),
  },

  storage: {
    driver: optional('STORAGE_DRIVER', 'local'),
    localDir: optional('STORAGE_LOCAL_DIR', './data/storage'),
    signingSecret: required('STORAGE_SIGNING_SECRET'),
    uploadUrlTtlSeconds: int('UPLOAD_URL_TTL_SECONDS', 6 * 60 * 60),
    s3Bucket: optional('S3_BUCKET', ''),
    s3Region: optional('S3_REGION', 'eu-west-2'),
  },

  uploads: {
    /** Smallest part the app may use: S3's multipart minimum. */
    minPartSize: 5 * 1024 * 1024,
    maxPartSize: 64 * 1024 * 1024,
    /** A single file may not exceed this; generous for a USDZ plus room data. */
    maxFileBytes: 2 * 1024 * 1024 * 1024,
    maxFilesPerCapture: 50,
    allowSimulatedScans: optional('ALLOW_SIMULATED_SCANS', 'false') === 'true',
  },
});

if (config.isProduction) {
  for (const [name, value] of [
    ['JWT_SECRET', config.auth.jwtSecret],
    ['STORAGE_SIGNING_SECRET', config.storage.signingSecret],
  ]) {
    if (value.length < 32 || value.startsWith('change-me')) {
      throw new Error(`${name} must be a long random secret in production`);
    }
  }
}
