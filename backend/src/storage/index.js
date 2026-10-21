/**
 * Object storage for capture files, as multipart uploads.
 *
 * Every driver implements:
 *
 *   createMultipart(key, contentType)        -> uploadId
 *   presignPart(key, uploadId, partNumber)   -> URL the app PUTs the bytes to
 *   complete(key, uploadId, { partCount, bytes })
 *       assembles the parts, and throws StorageIncomplete if any are
 *       missing or the size is wrong. Safe to call again after success.
 *   abort(key, uploadId)
 *   presignDownload(key, ttlSeconds)         -> URL to GET a stored object
 *   read(key)                                -> Buffer of a stored object
 *   delete(key)                              removes a stored object
 *   deleteFolder(prefix)                     removes every object under prefix/
 *   archive(key)                             moves it to cold storage (E-05)
 *
 * The app never receives storage credentials, only short-lived part URLs
 * (PRD: uploads via short-lived signed URLs).
 */
import { config } from '../config.js';
import { LocalStorage } from './local.js';
import { S3Storage } from './s3.js';

export { StorageIncomplete } from './errors.js';

let instance;

export function storage() {
  if (!instance) {
    const ttl = config.storage.uploadUrlTtlSeconds;
    instance =
      config.storage.driver === 's3'
        ? new S3Storage({
            bucket: config.storage.s3Bucket,
            region: config.storage.s3Region,
            urlTtlSeconds: ttl,
          })
        : new LocalStorage({
            dir: config.storage.localDir,
            secret: config.storage.signingSecret,
            publicUrl: config.publicApiUrl,
            urlTtlSeconds: ttl,
          });
  }
  return instance;
}

/** Tests swap in a driver pointed at a temp folder. */
export function setStorage(driver) {
  instance = driver;
}

let modelsInstance;

/**
 * Where generated 3D levels and machine models are kept: the models bucket
 * on AWS (served through CloudFront, M-07), or the same local folder as
 * everything else in development, under keys that start with models/.
 */
export function modelStorage() {
  if (!modelsInstance) {
    modelsInstance =
      config.storage.driver === 's3'
        ? new S3Storage({
            bucket: config.storage.modelsBucket,
            region: config.storage.s3Region,
            urlTtlSeconds: config.storage.uploadUrlTtlSeconds,
          })
        : storage();
  }
  return modelsInstance;
}

/** Tests swap in a models store. */
export function setModelStorage(driver) {
  modelsInstance = driver;
}
