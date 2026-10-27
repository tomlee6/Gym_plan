/**
 * Machines in the walkthrough (J-06): each recorded machine's approved 3D
 * model goes out with every walkthrough of a version on its capture (the
 * reviewer's, the owner's and a share link's), by its reference, with
 * signed links to its levels of detail. A model not approved goes nowhere.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { modelFolder, setBuilder } from '../src/assets/index.js';
import { config } from '../src/config.js';
import { one, pool } from '../src/db/pool.js';
import { PermanentJobError } from '../src/jobs/index.js';
import { setModelStorage } from '../src/storage/index.js';
import { LocalStorage } from '../src/storage/local.js';
import { api, DEMO, login, useTestServer } from './helpers.js';

const ctx = useTestServer();

describe('machines in the walkthrough (J-06)', () => {
  let reviewer;
  let models;
  let modelsDir;
  let machineId;
  let modelId;

  const as = (method, url, token) => api(ctx)[method](url).set('Authorization', `Bearer ${token ?? ctx.token}`);

  after(async () => {
    setBuilder(async () => {
      throw new PermanentJobError('No builder.');
    });
    if (modelsDir) await rm(modelsDir, { recursive: true, force: true });
  });

  it('sends nothing until a machine has an approved model', async () => {
    reviewer = (await login(ctx, DEMO.reviewer)).accessToken;
    modelsDir = await mkdtemp(path.join(os.tmpdir(), 'gym-walk-models-'));
    models = new LocalStorage({ dir: modelsDir, secret: config.storage.signingSecret, publicUrl: config.publicApiUrl });
    setModelStorage(models);
    ({ id: machineId } = await one(pool, `SELECT id FROM machines WHERE account_id = ? AND ref = 'EQ-001'`, [DEMO.account]));

    // The seeded model awaiting review has no files and is not approved.
    const { body } = await as('get', `/v1/review/versions/${DEMO.versions.ng2}`, reviewer).expect(200);
    assert.deepEqual(body.machineModels, {});
  });

  it('sends the approved model, by the machine’s reference, with a link to each level of detail', async () => {
    // A finished build, as L-06 leaves one: three levels, each stored.
    setBuilder(async ({ model }) => {
      const lods = [];
      for (const [i, triangles] of [50000, 12000, 3000].entries()) {
        const key = `${modelFolder(model)}${String(i).repeat(64)}.glb`;
        await models.write(key, Buffer.from(`glTF level ${i}`));
        lods.push({ key, bytes: 12 + i, triangles, texture: 1024 >> i });
      }
      return { glbKey: lods[0].key, lods, bytes: lods[0].bytes, triangleCount: 50000, sizeM: { w: 0.9, d: 2.0, h: 1.4 }, turnDeg: 90 };
    });
    await pool.query(`UPDATE machine_videos SET status = 'ready' WHERE machine_id = ?`, [machineId]);
    const built = await as('post', `/v1/review/machines/${machineId}/models`, reviewer).send({}).expect(202);
    modelId = built.body.modelId;

    let { body } = await as('get', `/v1/review/versions/${DEMO.versions.ng2}`, reviewer).expect(200);
    assert.deepEqual(body.machineModels, {}, 'built is not approved');

    await as('post', `/v1/review/models/${modelId}/approve`, reviewer).send({}).expect(200);
    ({ body } = await as('get', `/v1/review/versions/${DEMO.versions.ng2}`, reviewer).expect(200));
    const treadmill = body.machineModels['EQ-001'];
    assert.equal(treadmill.modelId, modelId);
    assert.deepEqual(treadmill.sizeM, { w: 0.9, d: 2, h: 1.4 });
    assert.deepEqual(treadmill.lods.map((l) => [l.triangles, l.textureSize]), [[50000, 1024], [12000, 512], [3000, 256]]);
    assert.ok(treadmill.lods.every((l) => l.url && l.urlExpiresAt));
    assert.equal(Object.keys(body.machineModels).length, 1, 'only the machine with an approved model');
  });

  it('goes with the owner’s walkthrough and a share link of a version on that capture', async () => {
    // The ready Level 1 version, made from the capture that carries the machines.
    await pool.query('UPDATE plan_versions SET capture_id = ? WHERE id = ?', [DEMO.captureNg2, DEMO.versions.ng1v2]);
    const { body } = await as('get', `/v1/plans/${DEMO.plans.ng1}/model`).expect(200);
    assert.equal(body.machineModels['EQ-001'].modelId, modelId);

    const link = await as('post', `/v1/plans/${DEMO.plans.ng1}/share-links`).send({}).expect(201);
    const token = new URL(link.body.url).pathname.split('/').pop();
    const shared = await api(ctx).raw.get(`/v1/share/${token}`).expect(200);
    assert.equal(shared.body.machineModels['EQ-001'].lods.length, 3);
  });

  it('stops sending a model once it is rejected', async () => {
    await as('post', `/v1/review/models/${modelId}/reject`, reviewer).send({ note: 'Wrong machine.' }).expect(200);
    const { body } = await as('get', `/v1/plans/${DEMO.plans.ng1}/model`).expect(200);
    assert.deepEqual(body.machineModels, {});
  });
});
