/**
 * Links to stored 3D models (M-07): presigned links straight to the models
 * bucket, from the models store. No database.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { S3Client } from '@aws-sdk/client-s3';

import { config, productionProblems } from '../src/config.js';
import { linkFields, modelLink } from '../src/generator/links.js';
import { LocalStorage } from '../src/storage/local.js';
import { S3Storage } from '../src/storage/s3.js';

const KEY = 'models/accounts/acct-1/levels/abc123/build3d-1.glb';

describe('model links (M-07)', () => {
  let dir;
  let store;
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'gym-links-'));
    store = new LocalStorage({ dir, secret: 'test-secret', publicUrl: 'http://localhost:4000' });
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it('on AWS, a presigned GET for the one file in the models bucket in Sydney, good for an hour', async () => {
    const client = new S3Client({
      region: 'ap-southeast-2',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', sessionToken: 'token' },
    });
    const s3 = new S3Storage({ bucket: 'flexgym-dev-models', region: 'ap-southeast-2', client });
    const now = Date.now();
    const { url, expiresAt } = await modelLink(KEY, { now, store: s3, ttlSeconds: 3600 });
    const u = new URL(url);
    assert.equal(u.hostname, 'flexgym-dev-models.s3.ap-southeast-2.amazonaws.com');
    assert.equal(u.pathname, `/${KEY}`);
    assert.equal(u.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
    assert.equal(u.searchParams.get('X-Amz-Expires'), '3600');
    assert.equal(u.searchParams.get('x-id'), 'GetObject');
    assert.equal(Date.parse(expiresAt), now + 3600 * 1000);
  });

  it('in local work, the local store’s own signed link', async () => {
    await store.write(KEY, Buffer.from('glTF'));
    const { url, expiresAt } = await modelLink(KEY, { now: Date.now(), store, ttlSeconds: 3600 });
    const u = new URL(url);
    assert.equal(u.origin, 'http://localhost:4000');
    const encoded = u.pathname.split('/').pop();
    assert.ok(store.verifyDownload(encoded, u.searchParams.get('expires'), u.searchParams.get('sig')), 'a link the store accepts');
    // The store stamps the expiry by its own clock, a moment after ours.
    assert.ok(Math.abs(Number(u.searchParams.get('expires')) - Date.parse(expiresAt) / 1000) <= 1);
  });

  it('no link when one cannot be made, so the viewer draws the plan', async () => {
    const broken = { presignDownload: async () => { throw new Error('no credentials'); } };
    const logged = console.error;
    console.error = () => {};
    try {
      assert.deepEqual(await linkFields(KEY, { store: broken }), { url: null, urlExpiresAt: null });
    } finally {
      console.error = logged;
    }
  });

  it('needs only the models bucket in production, no CDN or signing key', () => {
    const prod = (modelsBucket) => ({
      ...config,
      isProduction: true,
      generator: { ...config.generator, driver: 'glb' },
      storage: { ...config.storage, modelsBucket },
    });
    const about = (problems) => problems.filter((p) => /MODELS_/.test(p));
    assert.deepEqual(about(productionProblems(prod('flexgym-prod-models'))), []);
    assert.deepEqual(about(productionProblems(prod(''))), ['MODELS_BUCKET must be set when GENERATOR_DRIVER is glb']);
    assert.equal(config.models.urlTtlSeconds, 3600);
  });
});
