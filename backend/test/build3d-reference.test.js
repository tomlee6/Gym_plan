/**
 * The generator on whole gyms (J-10): a reference gym with one of every
 * element, built the same to the byte however its lists are ordered; a
 * large gym within the size and time limits; and a simulated scan all the
 * way from RoomPlan to a model. Every file is checked with Khronos's glTF
 * validator, not only read back by the library that wrote it.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

import { buildLevel } from '../../shared/build3d/index.js';
import { planFromScan, validate } from '../../shared/plan/index.js';
import { toGlb } from '../src/generator/glb.js';
import { ALL_NODES, largeGym, referenceGym, scannedGym } from './fixtures/gyms.js';

const validator = createRequire(import.meta.url)('gltf-validator');

/** The validator's errors and warnings for a GLB (its notes about unused data are not problems). */
async function problems(glb) {
  const report = await validator.validateBytes(new Uint8Array(glb), { maxIssues: 100 });
  return report.issues.messages.filter((m) => m.severity < 2).map((m) => `${m.code}: ${m.message} (${m.pointer ?? ''})`);
}

const meta = { generatorVersion: 'test', contentHash: 'c'.repeat(64) };

/** A deep copy with every list in the plan, and every list inside them, in reverse order. */
function reversed(value) {
  if (Array.isArray(value)) {
    // Points and coordinates keep their order; lists of elements do not.
    const isPoint = value.length <= 3 && value.every((v) => typeof v === 'number');
    const isPointList = value.every((v) => Array.isArray(v) && v.every((n) => typeof n === 'number'));
    const items = value.map(reversed);
    return isPoint || isPointList ? items : items.reverse();
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, reversed(v)]));
  return value;
}

describe('the reference gym (J-10)', () => {
  it('has one of everything the contract covers, and builds a valid file with nothing left out', async () => {
    const level = buildLevel(referenceGym());
    assert.deepEqual(level.nodes.map((n) => n.name), ALL_NODES);
    assert.deepEqual(level.skipped, []);
    assert.deepEqual(await problems(await toGlb(level, meta)), []);
  });

  it('gives the same bytes whatever order its lists are in (GEN-01)', async () => {
    const plan = referenceGym();
    const shuffled = reversed(plan);
    assert.notDeepEqual(shuffled.walls.map((w) => w.id), plan.walls.map((w) => w.id), 'the copy really is reordered');
    const [a, b] = await Promise.all([toGlb(buildLevel(plan), meta), toGlb(buildLevel(shuffled), meta)]);
    assert.ok(Buffer.from(a).equals(Buffer.from(b)));
    // And again from scratch: nothing carried over between runs.
    assert.ok(Buffer.from(a).equals(Buffer.from(await toGlb(buildLevel(referenceGym()), meta))));
  });

  it('does not change the plan it was given', () => {
    const plan = referenceGym();
    const before = JSON.stringify(plan);
    buildLevel(plan);
    assert.equal(JSON.stringify(plan), before);
  });
});

describe('a large gym (J-10, GEN-05)', () => {
  it('builds 2,400 m² well inside the time and size limits', async () => {
    const started = performance.now();
    const level = buildLevel(largeGym());
    const glb = await toGlb(level, meta);
    const seconds = (performance.now() - started) / 1000;
    // GEN-05 allows ten minutes for 1,000 m²; this takes about a second for 2,400 m².
    assert.ok(seconds < 30, `${seconds.toFixed(1)} s`);
    assert.ok(glb.byteLength < 2 * 1024 * 1024, `${(glb.byteLength / 1024).toFixed(0)} KB, against a 25 MB limit`);
    assert.deepEqual(level.skipped, []);
    assert.deepEqual(await problems(glb), []);
  });
});

describe('from a scan to a model (J-10)', () => {
  it('builds what RoomPlan saw, with the measured heights and the doors and windows in place', async () => {
    const plan = planFromScan(scannedGym(), {});
    assert.deepEqual(validate(plan), [], 'a plan a reviewer could approve as it is');
    const level = buildLevel(plan);
    assert.deepEqual(level.skipped, []);
    // Heights came from the scan, so none were assumed; door hinges and swings were (RoomPlan does not say).
    const assumed = level.defaultsUsed.map((d) => d.kind);
    assert.ok(!assumed.includes('wall_height') && !assumed.includes('opening_height'));
    assert.ok(assumed.includes('door_swing'));
    assert.equal(level.bounds.max[1], 3.2 + 0.3, 'the 3.2 m walls, and the roof on them');
    // The walk starts inside the front door.
    assert.deepEqual([level.walk.start.x, level.walk.start.y], [3, 1.2]);
    assert.deepEqual(await problems(await toGlb(level, meta)), []);
  });
});
