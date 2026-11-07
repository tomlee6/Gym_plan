/** The equipment library (migration 006): reading it, keeping it, importing a maker's catalogue. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EQUIPMENT_LIBRARY } from '../../shared/plan/index.js';
import { pool } from '../src/db/pool.js';
import { api, DEMO, login, useTestServer } from './helpers.js';

const ctx = useTestServer();
let admin;
const as = (method, path) => api(ctx)[method](path).set('Authorization', `Bearer ${admin}`);
const asOwner = (method, path) => api(ctx)[method](path).set('Authorization', `Bearer ${ctx.token}`);

const machine = (over = {}) => ({
  key: 'test-bike',
  name: 'Test bike',
  category: 'Cardio',
  type: 'exerciseBike',
  widthM: 0.62,
  depthM: 1.15,
  heightM: 1.4,
  ...over,
});

describe('equipment library', () => {
  it('starts with exactly the machines the editor offered from code', async () => {
    admin = (await login(ctx, DEMO.admin)).accessToken;
    const { body } = await asOwner('get', '/v1/equipment-library').expect(200);
    assert.equal(body.items.length, EQUIPMENT_LIBRARY.length);
    for (const built of EQUIPMENT_LIBRARY) {
      const row = body.items.find((i) => i.key === built.key);
      assert.ok(row, built.key);
      assert.deepEqual(
        { name: row.name, category: row.category, type: row.type, w: row.widthM, d: row.depthM, h: row.heightM, c: row.clearance },
        { name: built.name, category: built.category, type: built.type, w: built.widthM, d: built.depthM, h: built.heightM, c: built.clearance },
      );
      assert.equal(row.manufacturer, null);
      assert.equal(row.source, 'platform');
    }
  });

  it('needs a sign-in to read, and an admin to change', async () => {
    await api(ctx).get('/v1/equipment-library').expect(401);
    await asOwner('get', '/v1/admin/equipment-library').expect(403);
    await asOwner('post', '/v1/admin/equipment-library').send(machine()).expect(403);
    const { accessToken: reviewer } = await login(ctx, DEMO.reviewer);
    await api(ctx).get('/v1/equipment-library').set('Authorization', `Bearer ${reviewer}`).expect(200);
    await api(ctx).post('/v1/admin/equipment-manufacturers').set('Authorization', `Bearer ${reviewer}`).send({ name: 'X', slug: 'xx' }).expect(403);
  });

  let id;
  it('adds, edits, archives and restores a machine, and logs each change', async () => {
    const { body } = await as('post', '/v1/admin/equipment-library').send(machine({ clearanceAroundM: 0.8 })).expect(201);
    id = body.id;
    assert.deepEqual(body.clearance, { aroundM: 0.8, behindM: 0.8 });
    assert.equal(body.source, 'admin');
    // One key per maker: a second generic "test-bike" is refused.
    await as('post', '/v1/admin/equipment-library').send(machine()).expect(409);

    const { body: edited } = await as('patch', `/v1/admin/equipment-library/${id}`).send({ widthM: 0.7, clearanceBehindM: 1.2 }).expect(200);
    assert.equal(edited.widthM, 0.7);
    assert.deepEqual(edited.clearance, { aroundM: 0.8, behindM: 1.2 });

    await as('patch', `/v1/admin/equipment-library/${id}`).send({ status: 'archived' }).expect(200);
    const { body: shown } = await asOwner('get', '/v1/equipment-library').expect(200);
    assert.ok(!shown.items.some((i) => i.id === id), 'an archived machine is not offered');
    const { body: all } = await as('get', '/v1/admin/equipment-library').expect(200);
    assert.equal(all.items.find((i) => i.id === id).status, 'archived');

    await as('patch', `/v1/admin/equipment-library/${id}`).send({ status: 'active' }).expect(200);
    const [logged] = await pool.query(
      `SELECT action FROM audit_log WHERE target_type = 'library' AND target_id = ? ORDER BY created_at, action`,
      [id],
    );
    assert.deepEqual(new Set(logged.map((r) => r.action)), new Set(['LIBRARY_ITEM_ADDED', 'LIBRARY_ITEM_UPDATED', 'LIBRARY_ITEM_ARCHIVED', 'LIBRARY_ITEM_RESTORED']));
  });

  it('refuses sizes and clearances that cannot be real', async () => {
    await as('post', '/v1/admin/equipment-library').send(machine({ key: 'bad-1', widthM: 0 })).expect(400);
    await as('post', '/v1/admin/equipment-library').send(machine({ key: 'bad-2', depthM: 31 })).expect(400);
    await as('post', '/v1/admin/equipment-library').send(machine({ key: 'bad-3', clearanceAroundM: -1 })).expect(400);
    await as('post', '/v1/admin/equipment-library').send(machine({ key: 'Bad Key' })).expect(400);
    await as('patch', `/v1/admin/equipment-library/${id}`).send({}).expect(400);
    await as('patch', '/v1/admin/equipment-library/not-an-id').send({ widthM: 1 }).expect(404);
  });

  let maker;
  it('keeps manufacturers, whose machines share keys with the generic ones', async () => {
    const { body } = await as('post', '/v1/admin/equipment-manufacturers')
      .send({ name: 'Acme Fitness', slug: 'acme-fitness', website: 'https://acme.example' })
      .expect(201);
    maker = body;
    await as('post', '/v1/admin/equipment-manufacturers').send({ name: 'Acme Fitness', slug: 'acme-2' }).expect(409);
    await as('post', '/v1/admin/equipment-manufacturers').send({ name: 'Bad site', slug: 'bad-site', website: 'javascript:alert(1)' }).expect(400);

    // "treadmill" is a generic key, and Acme may use it for its own treadmill.
    const { body: t } = await as('post', '/v1/admin/equipment-library')
      .send(machine({ key: 'treadmill', name: 'Acme T5 treadmill', type: 'treadmill', manufacturerId: maker.id, modelCode: 'T5' }))
      .expect(201);
    assert.deepEqual(t.manufacturer, { id: maker.id, name: 'Acme Fitness', slug: 'acme-fitness' });

    const { body: list } = await as('get', '/v1/admin/equipment-manufacturers').expect(200);
    assert.equal(list.manufacturers.find((m) => m.id === maker.id).machines, 1);

    // An archived maker's machines leave the editor's library.
    await as('patch', `/v1/admin/equipment-manufacturers/${maker.id}`).send({ status: 'archived' }).expect(200);
    const { body: shown } = await asOwner('get', '/v1/equipment-library').expect(200);
    assert.ok(!shown.items.some((i) => i.id === t.id));
    await as('patch', `/v1/admin/equipment-manufacturers/${maker.id}`).send({ status: 'active' }).expect(200);
  });

  it('imports a maker’s catalogue, adding new machines and updating known ones', async () => {
    const rows = [
      machine({ key: 'treadmill', name: 'Acme T5 treadmill', type: 'treadmill', widthM: 0.95, depthM: 2.2, heightM: 1.6, clearanceBehindM: 2 }),
      machine({ key: 'r3-rower', name: 'Acme R3 rower', type: 'rowingMachine', widthM: 0.6, depthM: 2.4, heightM: 1 }),
    ];
    const { body: dry } = await as('post', '/v1/admin/equipment-library/import').send({ manufacturer: 'acme-fitness', dryRun: true, rows }).expect(200);
    assert.deepEqual({ added: dry.added, updated: dry.updated }, { added: ['r3-rower'], updated: ['treadmill'] });
    let { body: lib } = await asOwner('get', '/v1/equipment-library').expect(200);
    assert.ok(!lib.items.some((i) => i.key === 'r3-rower'), 'a dry run writes nothing');

    const { body: done } = await as('post', '/v1/admin/equipment-library/import').send({ manufacturer: 'acme-fitness', rows }).expect(201);
    assert.deepEqual({ added: done.added, updated: done.updated }, { added: ['r3-rower'], updated: ['treadmill'] });
    ({ body: lib } = await asOwner('get', '/v1/equipment-library').expect(200));
    const acme = lib.items.filter((i) => i.manufacturer?.id === maker.id);
    assert.equal(acme.length, 2);
    assert.equal(acme.find((i) => i.key === 'treadmill').widthM, 0.95);
    assert.equal(acme.find((i) => i.key === 'r3-rower').source, 'import');
    // The generic treadmill is untouched.
    assert.equal(lib.items.find((i) => i.key === 'treadmill' && !i.manufacturer).widthM, 0.9);

    // Running the same file again adds nothing.
    const { body: again } = await as('post', '/v1/admin/equipment-library/import').send({ manufacturer: 'acme-fitness', rows }).expect(201);
    assert.deepEqual(again.added, []);
  });

  it('refuses an import for an unknown maker, or with a key twice', async () => {
    await as('post', '/v1/admin/equipment-library/import').send({ manufacturer: 'nobody', rows: [machine()] }).expect(404);
    await as('post', '/v1/admin/equipment-library/import').send({ rows: [machine({ key: 'twice' }), machine({ key: 'twice' })] }).expect(409);
    await as('post', '/v1/admin/equipment-library/import').send({ rows: [] }).expect(400);
  });
});
