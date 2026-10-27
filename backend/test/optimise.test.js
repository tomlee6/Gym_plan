/**
 * Scale, align and optimise (L-06) on a stand-in for TRELLIS.2's GLB
 * (fixtures/models.js): a dense, textured box with a bump at its front,
 * long along X, in TRELLIS.2's unit cube. No database.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { before, describe, it } from 'node:test';

import { getBounds } from '@gltf-transform/functions';

import { fit, LODS, ModelError, optimiseModel, placement, readModel, turnFor } from '../src/assets/optimise.js';
import { rawModel } from './fixtures/models.js';

const validator = createRequire(import.meta.url)('gltf-validator');
const TREADMILL = { w: 0.85, d: 2.1, h: 1.5 };

/** Every vertex position of a document's meshes, in its scene's frame. */
function positions(doc) {
  const out = [];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const a = prim.getAttribute('POSITION');
      for (let i = 0; i < a.getCount(); i++) out.push(a.getElement(i, []));
    }
  }
  return out;
}

describe('scale, align and optimise (L-06)', () => {
  let raw;
  let made;

  before(async () => {
    raw = await rawModel();
    made = await optimiseModel(raw, { box: TREADMILL });
  });

  it('turns the model so its long side runs the way the footprint’s does', () => {
    // The stand-in is long along X; the treadmill's footprint is long along Z (its depth).
    assert.equal(made.turnDeg, 90);
    assert.ok(made.sizeM.d > made.sizeM.w);
    assert.deepEqual(made.flags, ['front_guessed'], 'the reviewer checks which way the front faces');
  });

  it('scales it by one factor, never stretching it, to the scanned size', () => {
    // 0.42 x 0.62 x 0.9 turned, against 0.85 x 1.5 x 2.1: about 2.25 each way.
    const { w, d, h } = made.sizeM;
    assert.ok(Math.abs(w / 0.42 - h / 0.62) < 0.01 && Math.abs(h / 0.62 - d / 0.9) < 0.01, 'one factor');
    assert.ok(made.scaleErrorPct > 0 && made.scaleErrorPct < 15, String(made.scaleErrorPct));
  });

  it('stands it on the floor, centred on its footprint, its front where the turn takes it', async () => {
    const doc = await readModel(made.lods[0].glb);
    const { min, max } = getBounds(doc.getRoot().listScenes()[0]);
    assert.ok(Math.abs(min[1]) < 0.002, `floor ${min[1]}`);
    assert.ok(Math.abs(min[0] + max[0]) < 0.004 && Math.abs(min[2] + max[2]) < 0.004, 'centred');
    assert.ok(Math.abs(max[0] - min[0] - made.sizeM.w) < 0.004);
    assert.ok(Math.abs(max[1] - min[1] - made.sizeM.h) < 0.004);
    assert.ok(Math.abs(max[2] - min[2] - made.sizeM.d) < 0.004);
    // A quarter turn takes the front (+Z, where the bump is) to +X: only the bump reaches that far.
    const far = positions(doc).filter(([x]) => x > max[0] - 0.05);
    assert.ok(far.length > 0 && far.every(([, , z]) => Math.abs(z) < 0.3), 'the bump is on the +X side');
    assert.ok(positions(doc).some(([x, , z]) => x < min[0] + 0.05 && Math.abs(z) > 0.8), 'the back is the plain body');
  });

  it('makes three levels of detail within their budgets, valid, compressed and named by content', async () => {
    assert.equal(made.lods.length, 3);
    for (const [i, lod] of made.lods.entries()) {
      assert.ok(lod.triangles <= LODS[i].triangles * 1.1, `LOD ${i}: ${lod.triangles} triangles`);
      assert.equal(lod.texture, LODS[i].texture, `LOD ${i} texture`);
      assert.match(lod.sha256, /^[0-9a-f]{64}$/);
      assert.equal(lod.bytes, lod.glb.length);
      const report = await validator.validateBytes(new Uint8Array(lod.glb), { maxIssues: 50 });
      const errors = report.issues.messages.filter((m) => m.severity === 0);
      assert.deepEqual(errors, [], `LOD ${i}`);
      const used = (await readModel(lod.glb)).getRoot().listExtensionsUsed().map((e) => e.extensionName);
      assert.ok(used.includes('EXT_meshopt_compression') && used.includes('EXT_texture_webp'), used.join());
    }
    assert.ok(made.lods[0].triangles > made.lods[1].triangles && made.lods[1].triangles > made.lods[2].triangles);
    assert.ok(made.lods[0].bytes > made.lods[1].bytes && made.lods[1].bytes > made.lods[2].bytes);
    assert.ok(made.lods[0].bytes < raw.length / 4, 'much smaller than the GPU’s model');
    assert.equal(new Set(made.lods.map((l) => l.sha256)).size, 3);
  });

  it('is the same model, byte for byte, made again from the same GLB', async () => {
    const again = await optimiseModel(raw, { box: TREADMILL });
    assert.deepEqual(
      again.lods.map((l) => l.sha256),
      made.lods.map((l) => l.sha256),
    );
  });

  it('takes the reviewer’s turn instead of guessing, and flags no guess', async () => {
    const turned = await optimiseModel(raw, { box: TREADMILL, turnDeg: 270 });
    assert.equal(turned.turnDeg, 270);
    assert.deepEqual(turned.flags, []);
    const doc = await readModel(turned.lods[2].glb);
    const { min } = getBounds(doc.getRoot().listScenes()[0]);
    // Three quarter turns take the front to -X.
    const near = positions(doc).filter(([x]) => x < min[0] + 0.05);
    assert.ok(near.every(([, , z]) => Math.abs(z) < 0.3), 'the bump is on the -X side');
  });

  it('flags a model whose proportions the scan does not bear out, and one with no scanned size', async () => {
    const tall = fit([0.42, 0.62, 0.9], { w: 0.5, d: 0.5, h: 3 });
    assert.ok(tall.flags.includes('size_mismatch'));
    assert.ok(tall.errorPct > 15);
    const unsized = fit([0.42, 0.62, 0.9], { w: null, d: null, h: null });
    assert.deepEqual(unsized.flags, ['no_scanned_size']);
    assert.equal(unsized.sizeM.h, 1.2);
    assert.equal(unsized.errorPct, null);
    // Only the sizes the scan has count.
    const heightOnly = fit([0.42, 0.62, 0.9], { h: 1.24 });
    assert.equal(heightOnly.sizeM.h, 1.24);
    assert.equal(heightOnly.errorPct, 0);
  });

  it('keeps a measured model’s own size, and still says how far it is from the scan', () => {
    const kept = fit([0.82, 1.45, 1.92], { w: 0.8, d: 1.9, h: 1.45 }, { keepScale: true });
    assert.equal(kept.scale, 1);
    assert.deepEqual(kept.sizeM, { w: 0.82, d: 1.92, h: 1.45 });
    assert.equal(kept.errorPct, 2.5);
    assert.deepEqual(kept.flags, []);
    assert.deepEqual(fit([0.4, 0.6, 0.9], { w: 0.8, d: 1.9, h: 1.45 }, { keepScale: true }).flags, ['size_mismatch']);
    // No scan to check it against: its size stands, nothing to flag.
    const unsized = fit([0.82, 1.45, 1.92], null, { keepScale: true });
    assert.equal(unsized.sizeM.h, 1.45);
    assert.deepEqual(unsized.flags, []);
  });

  it('leaves a square footprint, or a square model, unturned', () => {
    assert.equal(turnFor([1, 1, 0.4], { w: 1, d: 1.05, h: 1 }), 0);
    assert.equal(turnFor([1, 1, 0.97], { w: 0.5, d: 2, h: 1 }), 0);
    assert.equal(turnFor([1, 1, 0.4], { w: 0.5, d: 2, h: 1 }), 90);
    assert.equal(turnFor([0.4, 1, 1], { w: 0.5, d: 2, h: 1 }), 0);
    assert.equal(turnFor([1, 1, 0.4], null), 0);
  });

  it('turns about the up axis the right way round, exactly', () => {
    const m = placement(90, 2, [0, 0, 0]);
    // +Z (the front) goes to +X.
    const at = (p) => [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
    assert.deepEqual(at([0, 0, 1]), [2, 0, 0]);
    assert.deepEqual(at([1, 0, 0]), [0, 0, -2]);
    assert.deepEqual(at([0, 1, 0]), [0, 2, 0]);
  });

  it('makes KTX2 textures when asked (N-01): valid, mipmapped, the same every time', async () => {
    const small = await rawModel({ grid: 24, texture: 256 });
    const first = await optimiseModel(small, { box: TREADMILL, textures: 'ktx2' });
    const again = await optimiseModel(small, { box: TREADMILL, textures: 'ktx2' });
    assert.deepEqual(first.lods.map((l) => l.sha256), again.lods.map((l) => l.sha256));
    for (const lod of first.lods) {
      const doc = await readModel(lod.glb);
      const used = doc.getRoot().listExtensionsUsed().map((e) => e.extensionName);
      assert.ok(used.includes('KHR_texture_basisu'), used.join());
      const textures = doc.getRoot().listTextures();
      assert.equal(textures.length, 2);
      for (const texture of textures) {
        assert.equal(texture.getMimeType(), 'image/ktx2');
        assert.equal(Buffer.from(texture.getImage().slice(1, 7)).toString('latin1'), 'KTX 20');
      }
      const report = await validator.validateBytes(new Uint8Array(lod.glb), { maxIssues: 50 });
      assert.deepEqual(report.issues.messages.filter((m) => m.severity === 0), []);
    }
    assert.equal(first.lods[2].texture, 256);
  });

  it('refuses what is not a model', async () => {
    await assert.rejects(optimiseModel(Buffer.from('not a glb')), ModelError);
  });
});
