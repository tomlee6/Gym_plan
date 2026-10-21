/**
 * Links to stored 3D models (task M-07): a level's GLB, and later the
 * machine models. On AWS the models bucket is private and only CloudFront
 * may read it; the API hands out a CloudFront signed URL (canned policy) for
 * the one file, signed with the private half of the key pair whose public
 * half is in the distribution's key group (infra/lib/models-distribution.ts,
 * docs/runbooks/models-signing-key.md). Without a CDN (local work, tests),
 * the models store signs its own download link.
 *
 * Expiry is rounded up to the next whole window, so every link to a file
 * issued in the same window is the same URL and the browser's cache can
 * reuse a download. A model's key holds its content hash and generator
 * version, so a file under a key never changes.
 */
import { getSignedUrl } from '@aws-sdk/cloudfront-signer';

import { config } from '../config.js';
import { modelStorage } from '../storage/index.js';

/** Links issued within the same window share their expiry, and so their URL. */
const WINDOW_SECONDS = 15 * 60;

/** A PEM from the environment, whether its line breaks came through as real ones or as `\n`. */
const pem = (value) => value.replace(/\\n/g, '\n');

/**
 * A signed link to a stored model: `{ url, expiresAt }`, valid for at least
 * `MODELS_URL_TTL_SECONDS` (one hour by default) and at most one window more.
 */
export async function modelLink(key, { now = Date.now(), store = modelStorage(), models = config.models } = {}) {
  const ttl = models.urlTtlSeconds;
  const expires = Math.ceil((now / 1000 + ttl) / WINDOW_SECONDS) * WINDOW_SECONDS;
  const expiresAt = new Date(expires * 1000).toISOString();

  if (models.cdnDomain) {
    const path = key.split('/').map(encodeURIComponent).join('/');
    const url = getSignedUrl({
      url: `https://${models.cdnDomain}/${path}`,
      keyPairId: models.signingKeyId,
      privateKey: pem(models.signingPrivateKey),
      dateLessThan: expiresAt,
    });
    return { url, expiresAt };
  }
  // No CDN (local work and tests): the store's own link, for the same time by
  // our clock; the store reads its own, so the two can differ by a second.
  return { url: await store.presignDownload(key, expires - Math.floor(now / 1000)), expiresAt };
}

/**
 * A stored model's link as the API returns it: `{ url, urlExpiresAt }`. If
 * it cannot be signed (the signing key not yet set after the first deploy,
 * see docs/runbooks/models-signing-key.md), no link: the viewer then draws
 * the level from the plan, as it did before there were stored models.
 */
export async function linkFields(key, options) {
  try {
    const { url, expiresAt } = await modelLink(key, options);
    return { url, urlExpiresAt: expiresAt };
  } catch (err) {
    console.error('Could not sign a model link (is MODELS_SIGNING_PRIVATE_KEY set?):', err?.message ?? err);
    return { url: null, urlExpiresAt: null };
  }
}
