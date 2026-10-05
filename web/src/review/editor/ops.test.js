import { emptyPlan, summary, validate } from '@shared/plan/index.js';
import { describe, expect, it } from 'vitest';

import {
  addColumn,
  addOpening,
  addWall,
  confirmAllFlags,
  confirmFlag,
  deleteElement,
  joinCandidate,
  joinWalls,
  moveWallEnd,
  objectToColumn,
  rescale,
  slideOpening,
  splitWall,
  updateElement,
} from './ops.js';

const wall = (id, a, b) => ({ id, a, b, confidence: 1, mirror: false });
const room = () =>
  emptyPlan({
    walls: [wall('n', [0, 0], [10, 0]), wall('e', [10, 0], [10, 6]), wall('s', [10, 6], [0, 6]), wall('w', [0, 6], [0, 0])],
    openings: [{ id: 'd', wallId: 'n', type: 'door', offset: 1, width: 0.9, confidence: 0.7 }],
    objects: [{ id: 'b', x: 5, y: 3, w: 0.6, d: 0.6, angle: 0, heightM: 3, confidence: 0.9 }],
    flags: [
      { id: 'f1', kind: 'low_confidence', elementId: 'e', title: 'East wall', detail: '', status: 'open' },
      { id: 'f2', kind: 'column_or_object', elementId: 'b', title: 'Column?', detail: '', status: 'open' },
    ],
  });

describe('editing walls', () => {
  it('drags a corner and the joined wall follows, so the room stays closed', () => {
    const next = moveWallEnd(room(), 'n', 'b', [12, 0]);
    expect(next.walls.find((w) => w.id === 'n').b).toEqual([12, 0]);
    expect(next.walls.find((w) => w.id === 'e').a).toEqual([12, 0]);
    expect(validate(next)).toEqual([]);
    expect(summary(next).areaM2).toBeCloseTo(66);
    // The east wall was flagged; moving it counts as an edit.
    expect(next.flags.find((f) => f.id === 'f1')).toMatchObject({ status: 'resolved', resolution: 'edited' });
  });

  it('can pull a single end loose, which validation then reports', () => {
    const next = moveWallEnd(room(), 'n', 'b', [9, 1], { detach: true });
    expect(validate(next)[0].code).toBe('open_outline');
  });

  it('splits a wall, keeping the door on the half that holds it', () => {
    const { plan, ids } = splitWall(room(), 'n', 0.5);
    expect(plan.walls).toHaveLength(5);
    expect(plan.openings[0].wallId).toBe(ids[0]);
    expect(validate(plan)).toEqual([]);
  });

  it('joins a split wall back into one, and only straight continuations', () => {
    const split = splitWall(room(), 'n', 0.5);
    expect(joinCandidate(split.plan, split.ids[0])).not.toBeNull();
    const joined = joinWalls(split.plan, split.ids[0]);
    expect(joined.plan.walls).toHaveLength(4);
    const n = joined.plan.walls.find((w) => w.id === joined.id);
    expect([n.a, n.b].sort()).toEqual([[0, 0], [10, 0]].sort());
    expect(joined.plan.openings[0].offset).toBeCloseTo(1);
    // A corner is not a straight continuation.
    expect(joinCandidate(room(), 'n')).toBeNull();
  });

  it('adds a wall, and deleting a wall takes its openings', () => {
    const added = addWall(room(), [4, 0], [4, 6]);
    expect(validate(added.plan)).toEqual([]);
    const gone = deleteElement(room(), 'n');
    expect(gone.openings).toHaveLength(0);
  });
});

describe('openings, columns and flags', () => {
  it('drops a door on the nearest wall, centred where clicked', () => {
    const { plan, id } = addOpening(room(), [7, 0.2], { type: 'window', width: 2 });
    const o = plan.openings.find((x) => x.id === id);
    expect(o).toMatchObject({ wallId: 'n', type: 'window', offset: 6, width: 2 });
    expect(addOpening(room(), [5, 3]).id).toBeNull();
  });

  it('slides an opening along its wall but never off it', () => {
    const next = slideOpening(room(), 'd', [50, 0]);
    expect(next.openings[0].offset).toBeCloseTo(10 - 0.9);
  });

  it('turns a flagged block into a column and resolves its flag', () => {
    const { plan } = objectToColumn(room(), 'b');
    expect(plan.objects).toHaveLength(0);
    expect(plan.columns).toHaveLength(1);
    expect(plan.flags.find((f) => f.id === 'f2').resolution).toBe('edited');
  });

  it('confirms flags one by one or all together', () => {
    const one = confirmFlag(room(), 'f1');
    expect(one.flags.filter((f) => f.status === 'open')).toHaveLength(1);
    expect(confirmAllFlags(room()).flags.every((f) => f.resolution === 'confirmed')).toBe(true);
  });

  it('changes an opening type and adds columns', () => {
    const next = updateElement(room(), 'd', { type: 'window' });
    expect(next.openings[0].type).toBe('window');
    expect(addColumn(room(), [2, 2]).plan.columns[0]).toMatchObject({ x: 2, y: 2, w: 0.5 });
  });
});

describe('scale', () => {
  it('rescales everything from one known dimension', () => {
    // The north wall reads 10 m but is really 12.5 m.
    const next = rescale(room(), [0, 0], [10, 0], 12.5);
    expect(next.walls.find((w) => w.id === 'n').b).toEqual([12.5, 0]);
    expect(next.openings[0].width).toBeCloseTo(1.125);
    expect(next.objects[0]).toMatchObject({ x: 6.25, heightM: 3 });
    expect(summary(next).areaM2).toBeCloseTo(93.8, 1);
    expect(next.scale).toMatchObject({ source: 'scan', lengthM: 12.5 });
    expect(validate(next)).toEqual([]);
  });

  it('keeps a drawing’s underlay in step', () => {
    const plan = { ...room(), scale: { source: 'line', metresPerPixel: 0.02 }, underlay: { fileId: 'f', widthPx: 1000, heightPx: 800, metresPerPixel: 0.02 } };
    const next = rescale(plan, [0, 0], [10, 0], 5);
    expect(next.scale.metresPerPixel).toBeCloseTo(0.01);
    expect(next.underlay.metresPerPixel).toBeCloseTo(0.01);
  });
});
