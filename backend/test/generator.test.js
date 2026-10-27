/**
 * The 3D level generator (J-01): shared/build3d plus the GLB writer and the
 * stored key. No database: the job wiring itself is covered in jobs.test.js.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { getBounds } from '@gltf-transform/functions';

import { Build3dError, buildLevel, canonicalRing, GENERATOR_VERSION } from '../../shared/build3d/index.js';
import { emptyPlan } from '../../shared/plan/index.js';
import { config, productionProblems } from '../src/config.js';
import { readGlb } from '../src/generator/glb.js';
import { GenerationError, generateLevel, levelKey } from '../src/generator/index.js';
import { PermanentJobError } from '../src/jobs/index.js';
import { LocalStorage } from '../src/storage/local.js';

const wall = (id, a, b, extra = {}) => ({ id, a, b, confidence: 1, mirror: false, ...extra });

/** A 10 × 6 m gym with a partition and one space, as plan reading leaves it. */
function gym(overrides = {}) {
  return emptyPlan({
    ceilingHeightM: 3,
    walls: [
      wall('w1', [0, 0], [10, 0]),
      wall('w2', [10, 0], [10, 6]),
      wall('w3', [10, 6], [0, 6]),
      wall('w4', [0, 6], [0, 0]),
      wall('w5', [6, 0], [6, 6]),
    ],
    spaces: [
      { id: 's1', name: 'Gym floor', kind: 'gym_floor', points: [[0, 0], [6, 0], [6, 6], [0, 6]], floorFinish: null, ceilingHeightM: null, ceilingZones: [] },
      { id: 's2', name: 'Studio', kind: 'studio', points: [[6, 0], [10, 0], [10, 6], [6, 6]], floorFinish: null, ceilingHeightM: 3.4, ceilingZones: [] },
    ],
    ...overrides,
  });
}

const version = (plan) => ({ account_id: 'acct-1', content_hash: 'a'.repeat(64), plan_json: plan });
const nodeNames = (level) => level.nodes.map((n) => n.name);
const defaults = (level) => Object.fromEntries(level.defaultsUsed.map((d) => [d.kind, d.count]));

describe('building a level (shared/build3d)', () => {
  it('builds floors, ceilings, walls, the roof and the ground', () => {
    const level = buildLevel(gym());
    assert.deepEqual(nodeNames(level), ['ceilings', 'floors', 'ground', 'roof', 'walls', 'walls-exterior']);
    assert.ok(level.stats.triangles > 0);
    assert.deepEqual(Object.keys(level.materials), [
      'ceiling',
      'floor_rubber',
      'floor_timber',
      'ground',
      'roof',
      'wall_exterior',
      'wall_interior',
    ]);
  });

  it('puts an outer wall’s thickness outside the scanned line, in plan metres', () => {
    const { bounds } = buildLevel(gym());
    // Plan x → glTF x, height → y, plan y → z. Outer walls 0.2 m thick, outwards;
    // the roof 0.3 m on the 3.4 m walls. The ground is not part of the bounds.
    assert.deepEqual(bounds.min, [-0.2, 0, -0.2]);
    assert.deepEqual(bounds.max, [10.2, 3.7, 6.2]);
  });

  it('raises a wall to the higher ceiling of the spaces either side', () => {
    const level = buildLevel(gym());
    const walls = level.nodes.find((n) => n.name === 'walls').primitives[0];
    const ys = walls.positions.filter((_, i) => i % 3 === 1);
    assert.equal(Math.max(...ys), 3.4, 'the partition reaches the studio’s 3.4 m ceiling');
  });

  it('uses measured thickness and height, and records every default it filled', () => {
    const measured = gym();
    for (const w of measured.walls) Object.assign(w, { heightM: 3.1, thicknessM: 0.25, kind: w.id === 'w5' ? 'partition' : 'exterior' });
    measured.spaces.forEach((s) => (s.floorFinish = 'rubber'));
    assert.deepEqual(defaults(buildLevel(measured)), {});
    assert.deepEqual(defaults(buildLevel(gym())), { floor_finish: 2, wall_height: 5, wall_kind: 5, wall_thickness: 5 });
  });

  it('builds a plan in an older format, with the outline as one space', () => {
    const old = { format: 'gymplan/1', scale: { source: 'scan' }, ceilingHeightM: 3, walls: gym().walls.slice(0, 4), openings: [], columns: [], objects: [], zones: [], tags: [], flags: [] };
    const level = buildLevel(old);
    assert.ok(level.stats.triangles > 0);
    assert.equal(defaults(level).space_from_outline, 1);
  });

  it('leaves out walls and spaces it cannot use, and says so', () => {
    const plan = gym();
    plan.walls.push(wall('w6', [3, 3], [3, 3]), { id: 'w7', a: null, b: [1, 1], confidence: 1, mirror: false });
    plan.spaces.push({ id: 's3', name: 'Nowhere', kind: 'other', points: [[1, 1], [2, 2]], floorFinish: null, ceilingHeightM: null, ceilingZones: [] });
    const level = buildLevel(plan);
    assert.deepEqual(level.skipped, [
      { kind: 'wall', id: 'w6', reason: 'no length' },
      { kind: 'wall', id: 'w7', reason: 'no length' },
      { kind: 'space', id: 's3', reason: 'no shape' },
    ]);
  });

  it('refuses a plan with no room to build', () => {
    assert.throws(() => buildLevel(emptyPlan()), (e) => e instanceof Build3dError && e.code === 'too_few_walls');
    const open = gym();
    open.walls[1].b = [10, 5];
    open.walls.pop();
    assert.throws(() => buildLevel(open), (e) => e instanceof Build3dError && e.code === 'open_outline');
  });

  it('traces the same outline whatever order the walls are listed in', () => {
    const ring = [[0, 6], [0, 0], [10, 0], [10, 6]];
    assert.deepEqual(canonicalRing(ring), canonicalRing([...ring].reverse()));
    assert.deepEqual(canonicalRing(ring)[0], [0, 0]);
  });
});

describe('generating and storing the level (J-01)', () => {
  let dir;
  let store;
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'gym-models-'));
    store = new LocalStorage({ dir, secret: 'test-secret', publicUrl: 'http://localhost' });
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it('stores a valid GLB under the plan hash and generator version', async () => {
    const v = version(gym());
    const out = await generateLevel(v, { store, generatorVersion: GENERATOR_VERSION });
    assert.equal(out.glbKey, `models/accounts/acct-1/levels/${'a'.repeat(64)}/${GENERATOR_VERSION}.glb`);
    assert.equal(out.glbKey, levelKey(v, GENERATOR_VERSION));

    const bytes = await store.read(out.glbKey);
    assert.equal(bytes.byteLength, out.bytes);
    assert.equal(bytes.subarray(0, 4).toString('ascii'), 'glTF', 'a binary glTF');

    const doc = await readGlb(bytes);
    const root = doc.getRoot();
    assert.deepEqual(root.listNodes().map((n) => n.getName()), ['ceilings', 'floors', 'ground', 'roof', 'walls', 'walls-exterior']);
    const triangles = root.listMeshes().flatMap((m) => m.listPrimitives()).reduce((s, p) => s + p.getIndices().getCount() / 3, 0);
    assert.equal(triangles, out.triangleCount);
    const extras = root.getDefaultScene().getExtras();
    assert.equal(extras.contentHash, 'a'.repeat(64));
    assert.equal(extras.generatorVersion, GENERATOR_VERSION);
  });

  it('gives byte-identical files for the same plan, however its lists are ordered (GEN-01)', async () => {
    // Same key both times, so read the first file before the second overwrites it.
    const a = await generateLevel(version(gym()), { store, generatorVersion: 'test' });
    const x = await store.read(a.glbKey);
    const shuffled = gym();
    shuffled.walls.reverse();
    shuffled.spaces.reverse();
    const b = await generateLevel(version(shuffled), { store, generatorVersion: 'test' });
    const y = await store.read(b.glbKey);
    assert.equal(a.glbKey, b.glbKey);
    assert.ok(x.equals(y), 'the same plan gives the same bytes');
  });

  it('carries each floor finish as a texture a metre square, and the walls plain (J-05)', async () => {
    const out = await generateLevel(version(gym()), { store, generatorVersion: 'textures' });
    const doc = await readGlb(await store.read(out.glbKey));
    const material = (name) => doc.getRoot().listMaterials().find((m) => m.getName() === name);
    for (const name of ['floor_rubber', 'floor_timber']) {
      const texture = material(name).getBaseColorTexture();
      assert.equal(texture.getMimeType(), 'image/png');
      assert.deepEqual(texture.getSize(), [256, 256]);
      // The pattern holds the colour.
      assert.deepEqual(material(name).getBaseColorFactor(), [1, 1, 1, 1]);
    }
    assert.equal(material('wall_interior').getBaseColorTexture(), null);
    // Only the finishes the level uses travel with it.
    assert.deepEqual(doc.getRoot().listTextures().map((t) => t.getName()).sort(), ['rubber', 'timber']);
  });

  it('compresses the geometry and still decodes to the same building (J-08)', async () => {
    const level = buildLevel(gym());
    const out = await generateLevel(version(gym()), { store, generatorVersion: 'packed' });
    const doc = await readGlb(await store.read(out.glbKey));
    const used = doc.getRoot().listExtensionsUsed().map((e) => e.extensionName).sort();
    assert.deepEqual(used, ['EXT_meshopt_compression', 'KHR_mesh_quantization']);
    // The building's bounds after decoding, ground left out: within a millimetre.
    const nodes = doc.getRoot().getDefaultScene().listChildren().filter((n) => n.getName() !== 'ground');
    const boxes = nodes.map((n) => getBounds(n));
    for (let k = 0; k < 3; k++) {
      assert.ok(Math.abs(Math.min(...boxes.map((b) => b.min[k])) - level.bounds.min[k]) < 1e-3);
      assert.ok(Math.abs(Math.max(...boxes.map((b) => b.max[k])) - level.bounds.max[k]) < 1e-3);
    }
    // And the walk travels with it.
    const { walk } = doc.getRoot().getDefaultScene().getExtras();
    assert.deepEqual(walk, level.walk);
    assert.ok(walk.collision.length > 0);
  });

  it('refuses a model over the size limit, saying how big it was', async () => {
    await assert.rejects(
      generateLevel(version(gym()), { store, generatorVersion: 'big', maxBytes: 1000 }),
      (e) => e instanceof PermanentJobError && /MB, over the 0\.0 MB limit/.test(e.message),
    );
    assert.equal(config.generator.maxBytes, 25 * 1024 * 1024, '25 MB unless configured');
  });

  it('fails the job for good when the plan cannot be built, saying why and what to do (J-09)', async () => {
    const reason = (code, words) => (e) =>
      e instanceof GenerationError && e.permanent && e.code === code && words.test(e.message) && e.message.endsWith(`[${code}]`);
    await assert.rejects(generateLevel(version(emptyPlan()), { store }), reason('too_few_walls', /fewer than three walls.*Draw the walls/));
    // Without its end walls the box is two parallel walls and a partition: no room closes.
    const open = gym();
    open.walls = open.walls.filter((w) => w.id !== 'w2' && w.id !== 'w4');
    await assert.rejects(generateLevel(version(open), { store }), reason('open_outline', /do not close.*Join the gaps/));
    await assert.rejects(generateLevel({ account_id: 'a', content_hash: 'h', plan_json: null }, { store }), reason('no_plan', /no plan/));
  });

  it('fails for good on a fault in the build itself, and logs it for the team', async (t) => {
    const logged = t.mock.method(console, 'error', () => {});
    const broken = gym();
    Object.defineProperty(broken, 'openings', {
      enumerable: true,
      get() {
        throw new TypeError('openings went missing');
      },
    });
    await assert.rejects(
      generateLevel({ ...version(broken), id: 'v-1', plan_json: broken }, { store }),
      (e) => e instanceof GenerationError && e.code === 'build_error' && /openings went missing.*Tell the 3D team/.test(e.message),
    );
    assert.equal(logged.mock.callCount(), 1);
    assert.match(String(logged.mock.calls[0].arguments[0]), /plan version v-1/);
  });

  it('leaves a failed save to the job’s retries', async () => {
    const down = { write: async () => Promise.reject(new Error('S3 is down')) };
    await assert.rejects(
      generateLevel(version(gym()), { store: down }),
      (e) => !e.permanent && /could not be saved to storage \(S3 is down\)\. \[store_failed\]$/.test(e.message),
    );
  });

  it('will not start in production with the generator on and nowhere to put models', () => {
    const rule = 'MODELS_BUCKET must be set when GENERATOR_DRIVER is glb';
    const prod = (modelsBucket) => ({
      ...config,
      isProduction: true,
      generator: { ...config.generator, driver: 'glb' },
      storage: { ...config.storage, modelsBucket },
    });
    assert.ok(productionProblems(prod('')).includes(rule));
    assert.ok(!productionProblems(prod('gym-models-ap-southeast-2')).includes(rule));
  });
});
