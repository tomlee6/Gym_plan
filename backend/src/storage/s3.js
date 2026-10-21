/**
 * AWS S3 multipart storage for production.
 *
 * Part URLs are presigned `UploadPart` requests. Only the host is signed, so
 * the app's `Content-Type: application/octet-stream` header is accepted. On
 * completion the parts are listed server side, so the app never has to
 * collect ETags (background transfers do not reliably expose them).
 */
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  PutObjectTaggingCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { StorageIncomplete } from './errors.js';

export class S3Storage {
  constructor({ bucket, region, urlTtlSeconds = 6 * 3600, client }) {
    if (!bucket) throw new Error('S3_BUCKET is required when STORAGE_DRIVER=s3');
    this.bucket = bucket;
    this.urlTtlSeconds = urlTtlSeconds;
    this.client = client ?? new S3Client({ region });
  }

  async createMultipart(key, contentType) {
    const out = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
        // Encrypted at rest by the bucket's default KMS key (M-03).
      }),
    );
    return out.UploadId;
  }

  presignPart(key, uploadId, partNumber, ttlSeconds = this.urlTtlSeconds) {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: ttlSeconds },
    );
  }

  async #listParts(key, uploadId) {
    const parts = [];
    let marker;
    do {
      const page = await this.client.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: marker,
        }),
      );
      parts.push(...(page.Parts ?? []));
      marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
    } while (marker);
    return parts;
  }

  async complete(key, uploadId, { partCount, bytes }) {
    // Already completed on an earlier attempt whose response was lost.
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      if (head.ContentLength === bytes) return;
    } catch (err) {
      if (err?.$metadata?.httpStatusCode !== 404 && err?.name !== 'NotFound') throw err;
    }

    const parts = await this.#listParts(key, uploadId);
    const byNumber = new Map(parts.map((p) => [p.PartNumber, p]));
    let total = 0;
    const missing = [];
    for (let n = 1; n <= partCount; n++) {
      const part = byNumber.get(n);
      if (part) total += part.Size;
      else missing.push(n);
    }
    if (missing.length) {
      throw new StorageIncomplete(`${missing.length} part(s) of ${key} have not arrived.`, missing);
    }
    if (total !== bytes) {
      // Some part is short, but not which: have them all sent again.
      throw new StorageIncomplete(
        `${key} is ${total} bytes; expected ${bytes}.`,
        [...Array(partCount)].map((_, i) => i + 1),
      );
    }

    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [...Array(partCount)].map((_, i) => ({
            PartNumber: i + 1,
            ETag: byNumber.get(i + 1).ETag,
          })),
        },
      }),
    );
  }

  /**
   * Stores a whole object the server produced itself (a generated model).
   * Encrypted at rest by the bucket's default KMS key, like uploads.
   */
  async write(key, body, { contentType = 'application/octet-stream' } = {}) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  /** A stored object's bytes. */
  async read(key) {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await out.Body.transformToByteArray());
  }

  /** Removes a stored object; a missing one is not an error. */
  async delete(key) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /**
   * Removes every object under a folder (`prefix` ends in `/`), a thousand
   * at a time: a model's files from each try, or all of an account's models.
   */
  async deleteFolder(prefix) {
    if (!prefix.endsWith('/')) throw new Error('A folder to delete must end in /');
    let token;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key }));
      if (keys.length) {
        const out = await this.client.send(
          new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys, Quiet: true } }),
        );
        if (out.Errors?.length) throw new Error(`Could not delete ${out.Errors[0].Key}: ${out.Errors[0].Message}`);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }

  /** A short-lived presigned GetObject URL for a stored object. */
  presignDownload(key, ttlSeconds = 3600) {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: ttlSeconds,
    });
  }

  /** Abandons a multipart upload; one already finished or gone is not an error. */
  async abort(key, uploadId) {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
      );
    } catch (err) {
      if (err?.name !== 'NoSuchUpload' && err?.$metadata?.httpStatusCode !== 404) throw err;
    }
  }

  /**
   * Marks an object for cold storage (E-05). The bucket's lifecycle rule
   * moves objects tagged retention=cold to Glacier Instant Retrieval, so
   * they stay readable by the same key if a reviewer ever needs them.
   */
  async archive(key) {
    await this.client.send(
      new PutObjectTaggingCommand({
        Bucket: this.bucket,
        Key: key,
        Tagging: { TagSet: [{ Key: 'retention', Value: 'cold' }] },
      }),
    );
  }
}
