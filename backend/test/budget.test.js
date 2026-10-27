/**
 * The walkthrough's performance budget (K-04, VIEW-09), checked on the
 * reference gym and the 2,400 m² test gym with machine models in place:
 * what must download before the first view fits 8 s at 25 Mbps, and what is
 * drawn at worst stays within the triangles and draw calls that hold 30 fps
 * on the target devices (shared/build3d/budget.js). No database.
 *
 * "At worst" is found on the gym's own layout: standing at each machine in
 * turn, every machine is counted at the level of detail its distance calls
 * for, and the busiest spot is the figure.
 *
 * The machine models are the stand-in for TRELLIS.2's (fixtures/models.js)
 * made ready by L-06: a dense, textured model whose noise texture is the
 * worst case for its file size.
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { BUDGET, firstViewSeconds, LEVELS_OF_DETAIL, sceneBytesAllowed } from '../../shared/build3d/budget.js';
import { buildLevel } from '../../shared/build3d/index.js';
import { optimiseModel, readModel, triangleCount } from '../src/assets/optimise.js';
import { toGlb } from '../src/generator/glb.js';
import { largeGym, referenceGym } from './fixtures/gyms.js';
import { rawModel } from './fixtures/models.js';

const meta = { generatorVersion: 'test', contentHash: 'c'.repeat(64) };

async function levelOf(plan) {
  const glb = await toGlb(buildLevel(plan), meta);
  const doc = await readModel(glb);
  const primitives = doc.getRoot().listMeshes().reduce((n, m) => n + m.listPrimitives().length, 0);
  return { bytes: glb.length, triangles: triangleCount(doc), drawCalls: primitives };
}

/** Which level of detail a machine this far away shows. */
const levelAt = (metres) => LEVELS_OF_DETAIL.findLastIndex((l) => metres >= l.fromM);

/** The most triangles drawn, standing at any machine, and where. */
export function worstDrawn(positions, lods) {
  let worst = { triangles: 0, at: null, byLevel: [] };
  for (const [sx, sy] of positions) {
    const byLevel = LEVELS_OF_DETAIL.map(() => 0);
    for (const [x, y] of positions) byLevel[levelAt(Math.hypot(x - sx, y - sy))]++;
    const triangles = byLevel.reduce((sum, n, i) => sum + n * lods[i].triangles, 0);
    if (triangles > worst.triangles) worst = { triangles, at: [sx, sy], byLevel };
  }
  return worst;
}

/** A gym with its machines' models: first-view bytes, and triangles and draw calls drawn at worst. */
function costs(plan, level, model, uniqueModels, { ktx2 = false } = {}) {
  const positions = plan.objects.filter((o) => o.equipment).map((o) => [o.x, o.y]);
  const farthest = model.lods.at(-1);
  const drawn = worstDrawn(positions, model.lods);
  // KTX2 textures bring the transcoder they need (N-01; off by default).
  const transcoder = uniqueModels && ktx2 ? BUDGET.transcoderKB * 1024 : 0;
  return {
    machines: positions.length,
    sceneBytes: level.bytes + uniqueModels * farthest.bytes + transcoder,
    firstViewS: Number(firstViewSeconds(BUDGET.scriptKB * 1024 + transcoder + level.bytes + uniqueModels * farthest.bytes).toFixed(2)),
    triangles: level.triangles + drawn.triangles,
    machinesByLevel: drawn.byLevel,
    drawCalls: level.drawCalls + positions.length,
  };
}

describe('the walkthrough’s performance budget (K-04)', () => {
  let model;

  before(async () => {
    model = await optimiseModel(await rawModel(), { box: { w: 0.8, d: 2, h: 1.5 } });
  });

  it('allows a scene of about this much to download, besides the app', () => {
    // (8 s - 2.5 s) at 25 Mbps, less the app's 400 KB: some 16.8 MB.
    assert.ok(Math.abs(sceneBytesAllowed() - 16_777_900) < 1);
    assert.equal(firstViewSeconds(0), BUDGET.allowanceS);
  });

  it('makes each machine model’s levels of detail within their budgets', () => {
    model.lods.forEach((lod, i) => assert.ok(lod.triangles <= LEVELS_OF_DETAIL[i].triangles * 1.1, `level ${i}: ${lod.triangles}`));
  });

  it('holds on the reference gym with its machines modelled', async (t) => {
    const plan = referenceGym();
    const c = costs(plan, await levelOf(plan), model, 2);
    t.diagnostic(JSON.stringify(c));
    assert.ok(c.firstViewS <= BUDGET.firstViewS, `${c.firstViewS} s`);
    assert.ok(c.triangles <= BUDGET.triangles, `${c.triangles} triangles`);
    assert.ok(c.drawCalls <= BUDGET.drawCalls, `${c.drawCalls} draw calls`);
  });

  it('holds on a 2,400 m² gym packed with hundreds of machines, of twenty different models', async (t) => {
    const plan = largeGym();
    const c = costs(plan, await levelOf(plan), model, 20);
    t.diagnostic(JSON.stringify(c));
    assert.ok(c.machines >= 300);
    assert.ok(c.firstViewS <= BUDGET.firstViewS, `${c.firstViewS} s`);
    assert.ok(c.triangles <= BUDGET.triangles, `${c.triangles} triangles`);
    assert.ok(c.drawCalls <= BUDGET.drawCalls, `${c.drawCalls} draw calls`);
  });

  it('holds with KTX2 textures too, the transcoder included', async (t) => {
    const plan = largeGym();
    const ktx2 = await optimiseModel(await rawModel({ grid: 24, texture: 512 }), { box: { w: 0.8, d: 2, h: 1.5 }, textures: 'ktx2' });
    const c = costs(plan, await levelOf(plan), ktx2, 20, { ktx2: true });
    t.diagnostic(JSON.stringify(c));
    assert.ok(c.firstViewS <= BUDGET.firstViewS, `${c.firstViewS} s`);
  });

  it('counts the busiest spot, so models as heavy as the first ones would fail', () => {
    // Every 1.4 by 3 m, as the test gym packs them: the earlier 50k / 12k / 3k triangle levels.
    const positions = [];
    for (let i = 0; i < 400; i++) positions.push([2 + (i % 40) * 1.4, 2 + Math.floor(i / 40) * 3]);
    const heavy = worstDrawn(positions, [{ triangles: 50_000 }, { triangles: 12_000 }, { triangles: 3_000 }]);
    assert.ok(heavy.triangles > BUDGET.triangles, `${heavy.triangles}`);
    assert.ok(worstDrawn(positions, LEVELS_OF_DETAIL).triangles < BUDGET.triangles * 0.8, 'today’s leave a fifth spare');
  });
});
