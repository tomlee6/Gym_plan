/** The shared plan library: reading, outline and validation. No database. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  approvalBlockers,
  canonicalJson,
  emptyPlan,
  openingSegment,
  outline,
  planFromScan,
  planFromUpload,
  summary,
  validate,
} from '../../shared/plan/index.js';

/** Column-major 4×4: rotation about y by `deg`, then translation. */
function T(deg, x, z) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x, 1.5, z, 1];
}
const surf = (deg, x, z, w, conf = 'high', h = 3.1) => ({
  confidence: { [conf]: {} },
  dimensions: [w, h, 0],
  transform: T(deg, x, z),
});

/** A 10 × 6 m room whose corners miss by a few centimetres, as scans do. */
const ROOM = {
  walls: [
    surf(0, 5, 0, 10.06),
    surf(90, 10.03, 3, 6),
    surf(0, 5, 6.02, 10, 'low'),
    surf(90, 0, 3, 5.95),
  ],
  doors: [surf(0, 2, 0, 0.9, 'high')],
  windows: [surf(0, 7, 6, 2, 'medium')],
  openings: [],
  objects: [
    { category: { storage: {} }, confidence: { high: {} }, dimensions: [2, 1, 1], transform: T(0, 4, 3) },
    { category: { table: {} }, confidence: { high: {} }, dimensions: [0.6, 2, 0.6], transform: T(0, 8, 2) },
  ],
};

const wall = (id, a, b) => ({ id, a, b, confidence: 1, mirror: false });
const box = (w = 10, h = 6) =>
  emptyPlan({
    walls: [
      wall('n', [0, 0], [w, 0]),
      wall('e', [w, 0], [w, h]),
      wall('s', [w, h], [0, h]),
      wall('w', [0, h], [0, 0]),
    ],
  });

describe('plan reading from a scan', () => {
  const plan = planFromScan(ROOM, {
    floorToFloorM: 3.4,
    tags: [
      { type: 'fireExit', x: 10, y: 3 },
      { type: 'mirror', x: 5, y: 6.02 },
      { type: 'ceiling', x: 5, y: 3, heightM: 3.18 },
    ],
  });

  it('joins corners the scan nearly met, so the outline closes', () => {
    assert.equal(plan.walls.length, 4);
    assert.deepEqual(validate(plan), []);
    assert.ok(outline(plan));
    const s = summary(plan);
    assert.ok(Math.abs(s.areaM2 - 60) < 1, `area ${s.areaM2}`);
  });

  it('attaches doors and windows to their walls', () => {
    const door = plan.openings.find((o) => o.type === 'door');
    const seg = openingSegment(plan, door);
    assert.ok(seg, 'the door is on a wall');
    assert.ok(Math.abs((seg.a[0] + seg.b[0]) / 2 - 2) < 0.05, 'centred where the scan saw it');
    assert.ok(Math.abs(door.width - 0.9) < 1e-6);
  });

  it('carries tags through, takes the tagged ceiling and marks the mirror wall', () => {
    assert.equal(plan.tags.length, 3);
    assert.equal(plan.ceilingHeightM, 3.18);
    const mirrored = plan.walls.filter((w) => w.mirror);
    assert.equal(mirrored.length, 1);
    assert.equal(mirrored[0].confidence, 0.4, 'the south wall, read low');
  });

  it('flags what it was unsure of', () => {
    const kinds = plan.flags.map((f) => f.kind).sort();
    assert.deepEqual(kinds, ['column_or_object', 'low_confidence', 'opening_type']);
    const low = plan.flags.find((f) => f.kind === 'low_confidence');
    assert.equal(low.title, 'South wall, low confidence');
    assert.match(approvalBlockers(plan)[0], /3 flagged elements need/);
  });

  it('reads nothing from a simulated scan, but keeps its tags', () => {
    const empty = planFromScan(null, { tags: [{ type: 'power', x: 1, y: 1 }] });
    assert.equal(empty.walls.length, 0);
    assert.equal(empty.tags.length, 1);
    assert.ok(validate(empty).some((i) => i.code === 'too_few_walls'));
  });
});

describe('plan validation', () => {
  it('passes a closed room', () => {
    assert.deepEqual(validate(box()), []);
  });

  it('reports an open outline, naming the wall', () => {
    const p = box();
    p.walls[1].b = [10, 5]; // East wall stops a metre short.
    const issues = validate(p);
    assert.equal(issues[0].code, 'open_outline');
    assert.ok(issues[0].ids.includes('e'));
  });

  it('accepts an interior wall that meets another in a T', () => {
    const p = box();
    p.walls.push(wall('i', [4, 0], [4, 6]));
    assert.deepEqual(validate(p), []);
    assert.ok(Math.abs(summary(p).areaM2 - 60) < 0.01, 'the outline is still the whole room');
  });

  it('reports walls that cross', () => {
    const p = box();
    p.walls.push(wall('x1', [2, 0], [8, 6]), wall('x2', [8, 0], [2, 6]));
    assert.ok(validate(p).some((i) => i.code === 'walls_cross'));
  });

  it('reports openings that are loose or run off their wall', () => {
    const p = box();
    p.openings.push(
      { id: 'o1', wallId: 'gone', type: 'door', offset: 0, width: 1 },
      { id: 'o2', wallId: 'n', type: 'door', offset: 9.5, width: 1 },
    );
    const codes = validate(p).map((i) => i.code);
    assert.ok(codes.includes('opening_unattached'));
    assert.ok(codes.includes('opening_outside'));
  });

  it('needs a scale on an uploaded drawing', () => {
    const unscaledImage = planFromUpload({ imageFileId: 'file_1' });
    assert.ok(validate(unscaledImage).some((i) => i.code === 'scale_missing'));
    // A DWG has no picture: the reviewer draws it in metres.
    assert.equal(planFromUpload({}).scale.source, 'drawn');
    const scaled = planFromUpload({ scale: { a: [100, 100], b: [600, 100], lengthM: 10 }, imageFileId: 'file_1' });
    assert.equal(scaled.scale.metresPerPixel, 0.02);
    assert.deepEqual(scaled.scale.b, [12, 2]);
    assert.equal(scaled.underlay.fileId, 'file_1');
  });
});

describe('canonical JSON', () => {
  it('is the same whatever order the keys were written in', () => {
    assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
  });
});
