import { emptyPlan, MAX_SPACE_NAME, nextSpaceName, spaceNameProblem, tidySpaceName, validate } from '@shared/plan/index.js';
import { describe, expect, it } from 'vitest';

import { addSpace, updateElement } from './ops.js';

const square = (x, y, w, h) => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];
const wall = (id, a, b) => ({ id, a, b, confidence: 1, mirror: false });
const room = () =>
  emptyPlan({
    format: 3,
    walls: [wall('n', [0, 0], [10, 0]), wall('e', [10, 0], [10, 6]), wall('s', [10, 6], [0, 6]), wall('w', [0, 6], [0, 0])],
  });

describe('room names', () => {
  const spaces = [
    { id: 'a', name: 'Free weights' },
    { id: 'b', name: 'Cardio' },
  ];

  it('accepts a new, unused name', () => {
    expect(spaceNameProblem('Studio', spaces, 'a')).toBeNull();
  });

  it('accepts a room keeping its own name', () => {
    expect(spaceNameProblem('Free weights', spaces, 'a')).toBeNull();
  });

  it('refuses a blank name', () => {
    expect(spaceNameProblem('   ', spaces, 'a')).toMatch(/Give the room a name/);
  });

  it('refuses a name another room has, whatever the case or spacing', () => {
    expect(spaceNameProblem('  cardio ', spaces, 'a')).toMatch(/already called “Cardio”/);
    expect(spaceNameProblem('FREE   WEIGHTS', spaces, 'b')).toMatch(/already called/);
  });

  it('refuses a name that is too long', () => {
    expect(spaceNameProblem('x'.repeat(MAX_SPACE_NAME + 1), spaces, 'a')).toMatch(/60 characters/);
    expect(spaceNameProblem('x'.repeat(MAX_SPACE_NAME), spaces, 'a')).toBeNull();
  });

  it('tidies the spacing of a typed name', () => {
    expect(tidySpaceName('  Free   weights ')).toBe('Free weights');
  });

  it('numbers a new room past the names already taken', () => {
    expect(nextSpaceName([])).toBe('Room 1');
    expect(nextSpaceName([{ id: 'x', name: 'Room 2' }])).toBe('Room 3');
  });

  it('gives a drawn room a name no other room has', () => {
    let plan = room();
    const first = addSpace(plan, square(0, 0, 5, 6));
    plan = first.plan;
    plan = updateElement(plan, first.id, { name: 'Room 2' });
    const second = addSpace(plan, square(5, 0, 5, 6));
    const names = second.plan.spaces.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('flags two rooms with the same name when the plan is checked', () => {
    let plan = room();
    const a = addSpace(plan, square(0, 0, 5, 6), { name: 'Gym' });
    const b = addSpace(a.plan, square(5, 0, 5, 6), { name: 'gym' });
    plan = b.plan;
    const issues = validate(plan).filter((i) => i.code === 'space_name');
    expect(issues.length).toBe(2);
    expect(issues[0].message).toMatch(/already called/);
  });
});
