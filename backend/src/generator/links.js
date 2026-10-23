/**
 * Links to stored 3D models (task M-07): a level's GLB, and the machine
 * models with their levels of detail. The models bucket is private; the API
 * hands out a presigned link to the one file, made by the models store (S3
 * in Sydney on AWS, the local folder in local work and tests), and the
 * browser downloads it straight from the bucket, which allows the web app's
 * origin (CORS, infra/lib/data-stack.ts).
 *
 * On AWS the link is signed with the task role's temporary credentials, so
 * it can stop working before `expiresAt` if those run out first. The viewer
 * loads a level and each machine's far level of detail as soon as the page
 * opens; nearer levels load as the visitor walks up, so on a page left open
 * past its links they stay at the far level until the page is reloaded.
 */
import { config } from '../config.js';
import { modelStorage } from '../storage/index.js';

/**
 * A presigned link to a stored model: `{ url, expiresAt }`, valid for
 * `MODELS_URL_TTL_SECONDS` (one hour by default).
 */
export async function modelLink(key, { now = Date.now(), store = modelStorage(), ttlSeconds = config.models.urlTtlSeconds } = {}) {
  const url = await store.presignDownload(key, ttlSeconds);
  // The store stamps the expiry by its own clock, a moment after ours.
  return { url, expiresAt: new Date(now + ttlSeconds * 1000).toISOString() };
}

/**
 * A stored model's link as the API returns it: `{ url, urlExpiresAt }`. If
 * it cannot be made, no link: the viewer then draws the level from the plan,
 * as it did before there were stored models.
 */
export async function linkFields(key, options) {
  try {
    const { url, expiresAt } = await modelLink(key, options);
    return { url, urlExpiresAt: expiresAt };
  } catch (err) {
    console.error('Could not make a model link:', err?.message ?? err);
    return { url: null, urlExpiresAt: null };
  }
}
