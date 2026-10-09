/** H-01 and H-02: the format 3 editing operations. */
import { emptyPlan } from '@shared/plan/index.js';
import { describe, expect, it } from 'vitest';

import {
  addBeam,
  addCeilingZone,
  addLevelChange,
  addMirror,
  addOpening,
  addSpace,
  addVoid,
  deleteElement,
  findElement,
  movePolygon,
  movePolygonPoint,
  placeEquipment,
  removeMirror,
  rescale,
  setColumnShape,
  setFacing,
  setOpeningKind,
  setWallCurve,
  setWallMirror,
  spaceAt,
  unplacedEquipment,
  updateElement,
  updateMirror,
} from './ops.js';
import { withLists } from './planKinds.js';

const wall = (id, a, b) => ({ id, a, b, confidence: 1, mirror: false, heightM: 3 });
const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const room = () =>
  emptyPlan({
    walls: [wall('n', [0, 0], [10, 0]), wall('e', [10, 0], [10, 6]), wall('s', [10, 6], [0, 6]), wall('w', [0, 6], [0, 0])],
    openings: [{ id: 'd', wallId: 'n', type: 'door', kind: 'single_door', offset: 1, width: 0.9, confidence: 1, leaves: 1, hinge: 'left', swingInto: null }],
    columns: [{ id: 'c', x: 2, y: 2, w: 0.5, d: 0.4, angle: 0.3, shape: 'rect', heightM: null }],
    objects: [{ id: 'b', x: 5, y: 3, w: 1, d: 2, angle: 0, heightM: 1.5, confidence: 0.9, facingDeg: null }],
    flags: [{ id: 'f', kind: 'low_confidence', elementId: 'n', title: 'North', detail: '', status: 'open' }],
  });

describe('format 2 plans', () => {
  it('gain the format 3 lists without being changed when they already have them', () => {
    const old = { ...room() };
    delete old.spaces;
    delete old.voids;
    const next = withLists(old);
    expect(next.spaces).toEqual([]);
    expect(next.voids).toEqual([]);
    const v3 = room();
    expect(withLists(v3)).toBe(v3);
  });

  it('can have a space drawn on them, and lookups do not trip on the missing lists', () => {
    const old = { ...room() };
    delete old.spaces;
    expect(findElement(old, 'nope')).toBeNull();
    const { plan, id } = addSpace(old, square(0, 0, 10, 6));
    expect(plan.spaces.map((s) => s.id)).toEqual([id]);
  });
});

describe('spaces and ceiling zones', () => {
  it('draws a space with a name, kind and the plan’s ceiling', () => {
    const { plan, id } = addSpace(room(), square(0, 0, 5, 6), { name: 'Free weights' });
    expect(plan.spaces[0]).toMatchObject({ id, name: 'Free weights', kind: 'gym_floor', floorFinish: null, ceilingHeightM: 3, ceilingZones: [] });
    expect(addSpace(room(), [[0, 0], [1, 1]]).id).toBeNull();
    const edited = updateElement(plan, id, { kind: 'studio', floorFinish: 'timber' });
    expect(edited.spaces[0]).toMatchObject({ kind: 'studio', floorFinish: 'timber' });
  });

  it('nests a ceiling zone in its space, and finds, edits and deletes it there', () => {
    const s = addSpace(room(), square(0, 0, 10, 6));
    expect(spaceAt(s.plan, [3, 3]).id).toBe(s.id);
    const z = addCeilingZone(s.plan, s.id, square(1, 1, 3, 3), 4.2);
    expect(z.plan.spaces[0].ceilingZones).toEqual([{ id: z.id, points: square(1, 1, 3, 3), heightM: 4.2 }]);
    expect(findElement(z.plan, z.id)).toMatchObject({ kind: 'ceilingZones', spaceId: s.id });

    const raised = updateElement(z.plan, z.id, { heightM: 4.5 });
    expect(raised.spaces[0].ceilingZones[0].heightM).toBe(4.5);
    const gone = deleteElement(raised, z.id);
    expect(gone.spaces[0].ceilingZones).toEqual([]);
    expect(addCeilingZone(s.plan, 'nope', square(1, 1, 3, 3)).id).toBeNull();
  });

  it('moves a space with its ceiling zones, and one corner on its own', () => {
    const s = addSpace(room(), square(0, 0, 4, 4));
    const z = addCeilingZone(s.plan, s.id, square(1, 1, 2, 2));
    const moved = movePolygon(z.plan, s.id, [1, 0.5]);
    expect(moved.spaces[0].points[0]).toEqual([1, 0.5]);
    expect(moved.spaces[0].ceilingZones[0].points[0]).toEqual([2, 1.5]);
    const corner = movePolygonPoint(moved, s.id, 2, [6, 6]);
    expect(corner.spaces[0].points[2]).toEqual([6, 6]);
    expect(corner.spaces[0].points[0]).toEqual([1, 0.5]);
  });

  it('deleting a space clears the doors that swung into it', () => {
    const s = addSpace(room(), square(0, 0, 10, 6));
    const swung = updateElement(s.plan, 'd', { swingInto: s.id });
    expect(deleteElement(swung, s.id).openings[0].swingInto).toBeNull();
  });
});

describe('beams, level changes and voids', () => {
  it('adds each with its kind and height', () => {
    let plan = room();
    const b = addBeam(plan, square(0, 2, 10, 2.3), { kind: 'bulkhead', bottomM: 2.6 });
    plan = b.plan;
    const l = addLevelChange(plan, square(7, 4, 10, 6), { kind: 'ramp', heightM: 0.3, rampAngleDeg: 5 });
    plan = l.plan;
    const v = addVoid(plan, square(8, 0, 10, 2), { kind: 'stair', railHeightM: 1.1 });
    plan = v.plan;
    expect(plan.beams[0]).toMatchObject({ kind: 'bulkhead', bottomM: 2.6 });
    expect(plan.levelChanges[0]).toMatchObject({ kind: 'ramp', heightM: 0.3, rampAngleDeg: 5 });
    expect(plan.voids[0]).toMatchObject({ kind: 'stair', railHeightM: 1.1 });
    expect(findElement(plan, v.id).kind).toBe('voids');
    expect(deleteElement(plan, b.id).beams).toEqual([]);
  });
});

describe('walls', () => {
  it('curves a wall, and straightens it again at zero', () => {
    const curved = setWallCurve(room(), 'n', 1.25);
    expect(curved.walls[0].curveM).toBe(1.25);
    expect(setWallCurve(curved, 'n', 0).walls[0].curveM).toBeNull();
    // Editing the flagged wall resolves its flag.
    expect(curved.flags[0]).toMatchObject({ status: 'resolved', resolution: 'edited' });
  });

  it('adds, trims and removes mirror spans, keeping `mirror` in step', () => {
    const { plan, id } = addMirror(room(), 'n');
    const n = plan.walls[0];
    expect(n.mirror).toBe(true);
    expect(n.mirrors).toEqual([{ id, fromM: 0, toM: 10, bottomM: 0, topM: 2.4 }]);

    // Kept inside the wall and the right way round.
    const trimmed = updateMirror(plan, 'n', id, { fromM: 2, toM: 14, topM: 2.1 });
    expect(trimmed.walls[0].mirrors[0]).toMatchObject({ fromM: 2, toM: 10, topM: 2.1 });
    const backwards = updateMirror(trimmed, 'n', id, { toM: 1 });
    expect(backwards.walls[0].mirrors[0]).toMatchObject({ fromM: 2, toM: 2 });

    const removed = removeMirror(plan, 'n', id);
    expect(removed.walls[0]).toMatchObject({ mirror: false, mirrors: [] });
  });

  it('the mirror tick box adds a whole-wall span and clears them all', () => {
    const on = setWallMirror(room(), 'e', true);
    expect(on.walls[1].mirrors).toHaveLength(1);
    expect(on.walls[1].mirrors[0].toM).toBe(6);
    expect(setWallMirror(on, 'e', false).walls[1]).toMatchObject({ mirror: false, mirrors: [] });
  });
});

describe('openings', () => {
  it('sets the kind, and the old type and leaves follow', () => {
    const double = setOpeningKind(room(), 'd', 'double_door');
    expect(double.openings[0]).toMatchObject({ kind: 'double_door', type: 'door', leaves: 2, hinge: 'left' });
    const single = setOpeningKind(double, 'd', 'single_door');
    expect(single.openings[0].leaves).toBe(1);
    const glazed = setOpeningKind(double, 'd', 'fixed_glazing');
    expect(glazed.openings[0]).toMatchObject({ type: 'window', leaves: null, hinge: null, swingInto: null });
    expect(setOpeningKind(room(), 'd', 'opening').openings[0].type).toBe('opening');
  });

  it('places a new opening of a kind', () => {
    const { plan, id } = addOpening(room(), [5, 0.1], { kind: 'roller_shutter', width: 3 });
    expect(plan.openings.find((o) => o.id === id)).toMatchObject({ kind: 'roller_shutter', type: 'door', leaves: 1, width: 3 });
  });
});

describe('columns and machines', () => {
  it('makes a column round, using its width as the diameter', () => {
    const round = setColumnShape(room(), 'c', 'round');
    expect(round.columns[0]).toMatchObject({ shape: 'round', w: 0.5, d: 0.5, angle: 0 });
    expect(setColumnShape(round, 'c', 'rect').columns[0].shape).toBe('rect');
  });

  it('turns a machine’s front, kept in 0..360, and clears it', () => {
    expect(setFacing(room(), 'b', 90).objects[0].facingDeg).toBe(90);
    expect(setFacing(room(), 'b', -90).objects[0].facingDeg).toBe(270);
    expect(setFacing(room(), 'b', 720.04).objects[0].facingDeg).toBe(0);
    expect(setFacing(setFacing(room(), 'b', 45), 'b', null).objects[0].facingDeg).toBeNull();
    // Only machines face anywhere.
    const plan = room();
    expect(setFacing(plan, 'c', 10)).toBe(plan);
  });
});

describe('unplaced machines (H-02)', () => {
  const fromPhone = [
    { equipmentId: 'EQ-004', type: 'rower', name: 'Rower 2', placed: false, widthM: 0.6, depthM: 2.4, heightM: 1.0, video: { status: 'ready' } },
    { equipmentId: 'EQ-005', type: 'bench', name: 'Bench', placed: false },
    { equipmentId: 'EQ-001', type: 'treadmill', name: 'Treadmill 1', placed: true },
  ];

  it('lists the machines with no position that are not on the plan yet', () => {
    expect(unplacedEquipment(room(), fromPhone).map((e) => e.equipmentId)).toEqual(['EQ-004', 'EQ-005']);
  });

  it('places one where the reviewer clicked, with the phone’s size', () => {
    const { plan, id } = placeEquipment(room(), fromPhone[0], [3.21, 4]);
    expect(plan.objects.find((o) => o.id === id)).toEqual({
      id,
      x: 3.21,
      y: 4,
      w: 0.6,
      d: 2.4,
      angle: 0,
      heightM: 1,
      category: 'equipment',
      confidence: 1,
      elevationM: 0,
      equipment: { equipmentId: 'EQ-004', type: 'rower', name: 'Rower 2' },
      source: 'reviewer',
      facingDeg: null,
      modelRef: null,
      sameAs: null,
    });
    // Once placed it is no longer waiting.
    expect(unplacedEquipment(plan, fromPhone).map((e) => e.equipmentId)).toEqual(['EQ-005']);
  });

  it('gives a machine with no recorded size a metre square and the default height', () => {
    const { plan, id } = placeEquipment(room(), fromPhone[1], [1, 1]);
    expect(plan.objects.find((o) => o.id === id)).toMatchObject({ w: 1, d: 1, heightM: 1.2 });
    expect(placeEquipment(room(), {}, [1, 1]).id).toBeNull();
  });
});

describe('rescale, format 3', () => {
  it('scales spaces, zones, beams, level changes, voids, curves and mirror spans', () => {
    let plan = room();
    const s = addSpace(plan, square(0, 0, 10, 6));
    plan = addCeilingZone(s.plan, s.id, square(1, 1, 2, 2)).plan;
    plan = addBeam(plan, square(0, 2, 10, 3)).plan;
    plan = addLevelChange(plan, square(0, 0, 2, 2)).plan;
    plan = addVoid(plan, square(8, 4, 10, 6)).plan;
    plan = setWallCurve(plan, 'n', 1);
    plan = addMirror(plan, 's').plan;

    const next = rescale(plan, [0, 0], [10, 0], 20);
    expect(next.spaces[0].points[2]).toEqual([20, 12]);
    expect(next.spaces[0].ceilingZones[0].points[2]).toEqual([4, 4]);
    expect(next.beams[0].points[2]).toEqual([20, 6]);
    expect(next.levelChanges[0].points[2]).toEqual([4, 4]);
    expect(next.voids[0].points[0]).toEqual([16, 8]);
    expect(next.walls[0].curveM).toBe(2);
    expect(next.walls[2].mirrors[0]).toMatchObject({ fromM: 0, toM: 20, topM: 2.4 });
  });
});
