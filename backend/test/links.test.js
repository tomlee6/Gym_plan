/**
 * Signed links to stored 3D models (M-07): CloudFront signed URLs on AWS,
 * the store's own signed link without a CDN. No database.
 */
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { config, productionProblems } from '../src/config.js';
import { modelLink } from '../src/generator/links.js';
import { LocalStorage } from '../src/storage/local.js';

const KEY = 'models/accounts/acct-1/levels/abc123/build3d-1.glb';
const NOW = Date.parse('2026-10-12T09:07:00Z');
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const cdn = {
  cdnDomain: 'd111111abcdef8.cloudfront.net',
  signingKeyId: 'K2JCJMDEHXQW5F',
  // As it arrives from Secrets Manager through an environment variable.
  signingPrivateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).replace(/\n/g, '\\n'),
  urlTtlSeconds: 3600,
};

/** CloudFront's URL-safe base64, back to bytes. */
const unsafe = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/'), 'base64');

describe('signed model links (M-07)', () => {
  let dir;
  let store;
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'gym-links-'));
    store = new LocalStorage({ dir, secret: 'test-secret', publicUrl: 'http://localhost:4000' });
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it('signs a CloudFront URL for the one file, that CloudFront can check with the public key', async () => {
    const { url, expiresAt } = await modelLink(KEY, { now: NOW, models: cdn });
    const u = new URL(url);
    assert.equal(u.origin, `https://${cdn.cdnDomain}`);
    assert.equal(u.pathname, `/${KEY}`);
    assert.equal(u.searchParams.get('Key-Pair-Id'), cdn.signingKeyId);
    const expires = Number(u.searchParams.get('Expires'));
    assert.equal(new Date(expires * 1000).toISOString(), expiresAt);
    // The canned policy CloudFront rebuilds from the URL, verified as it does (RSA-SHA1).
    const policy = JSON.stringify({
      Statement: [{ Resource: `https://${cdn.cdnDomain}/${KEY}`, Condition: { DateLessThan: { 'AWS:EpochTime': expires } } }],
    });
    const verify = createVerify('RSA-SHA1').update(policy);
    assert.ok(verify.verify(publicKey, unsafe(u.searchParams.get('Signature'))), 'signature checks out');
  });

  it('is good for an hour at least, and the same URL for every request in the same quarter hour', async () => {
    const a = await modelLink(KEY, { now: NOW, models: cdn });
    const b = await modelLink(KEY, { now: NOW + 5 * 60 * 1000, models: cdn });
    assert.equal(a.url, b.url, 'the browser can reuse its download');
    const left = (Date.parse(a.expiresAt) - NOW) / 1000;
    assert.ok(left >= 3600 && left <= 3600 + 15 * 60, `${left} s`);
    const later = await modelLink(KEY, { now: NOW + 20 * 60 * 1000, models: cdn });
    assert.notEqual(later.url, a.url);
  });

  it('falls back to the store’s own signed link without a CDN', async () => {
    await store.write(KEY, Buffer.from('glTF'));
    const { url, expiresAt } = await modelLink(KEY, { now: Date.now(), store, models: { ...cdn, cdnDomain: '' } });
    const u = new URL(url);
    assert.equal(u.origin, 'http://localhost:4000');
    const encoded = u.pathname.split('/').pop();
    assert.ok(store.verifyDownload(encoded, u.searchParams.get('expires'), u.searchParams.get('sig')), 'a link the store accepts');
    // The store stamps the expiry by its own clock, a moment after ours.
    assert.ok(Math.abs(Number(u.searchParams.get('expires')) - Date.parse(expiresAt) / 1000) <= 1);
  });

  it('will not start in production with the generator on and no way to sign model links', () => {
    const rule = /MODELS_CDN_DOMAIN, MODELS_SIGNING_KEY_ID and MODELS_SIGNING_PRIVATE_KEY must be set/;
    const prod = (models) => ({
      ...config,
      isProduction: true,
      generator: { ...config.generator, driver: 'glb' },
      storage: { ...config.storage, modelsBucket: 'models' },
      models,
    });
    assert.ok(productionProblems(prod({ ...cdn, signingPrivateKey: '' })).some((p) => rule.test(p)));
    assert.ok(!productionProblems(prod(cdn)).some((p) => rule.test(p)));
    assert.equal(config.models.urlTtlSeconds, 3600);
  });
});
