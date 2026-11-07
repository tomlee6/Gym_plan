import { emptyPlan } from '@shared/plan/index.js';
import { act, fireEvent, render } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import Canvas from './Canvas.jsx';

const wall = (id, a, b) => ({ id, a, b, confidence: 1, mirror: false });
const plan = () =>
  emptyPlan({
    walls: [wall('n', [0, 0], [10, 0]), wall('e', [10, 0], [10, 6]), wall('s', [10, 6], [0, 6]), wall('w', [0, 6], [0, 0])],
  });

function show(props = {}) {
  const ref = createRef();
  const history = { change: vi.fn(), commit: vi.fn(), cancel: vi.fn(), begin: vi.fn(), preview: vi.fn() };
  const onRotationChange = vi.fn();
  const utils = render(
    <Canvas
      ref={ref}
      plan={plan()}
      tool="select"
      toolOptions={{}}
      selection={null}
      onSelect={vi.fn()}
      readOnly={false}
      history={history}
      flagged={new Set()}
      problems={new Set()}
      onRotationChange={onRotationChange}
      {...props}
    />,
  );
  const turned = () => utils.container.querySelector('svg > g');
  return { ...utils, ref, onRotationChange, turned };
}

describe('two fingers on a tablet', () => {
  const touch = (svg, type, id, x, y) =>
    fireEvent[type](svg, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, button: 0 });

  it('pinch zooms and a twist turns the plan', () => {
    const onZoomChange = vi.fn();
    const { container, onRotationChange } = show({ onZoomChange });
    const svg = container.querySelector('svg');
    const before = onZoomChange.mock.calls.at(-1)[0];

    touch(svg, 'pointerDown', 1, 100, 100);
    touch(svg, 'pointerDown', 2, 200, 100);
    // Fingers twice as far apart, and turned a quarter.
    touch(svg, 'pointerMove', 2, 100, 300);
    expect(onZoomChange.mock.calls.at(-1)[0]).toBeCloseTo(before * 2, 6);
    expect(onRotationChange).toHaveBeenLastCalledWith(90);

    touch(svg, 'pointerUp', 1, 100, 100);
    touch(svg, 'pointerUp', 2, 100, 300);
  });

  it('a pinch does not leave behind the point its first finger drew', () => {
    const { container, ref } = show({ tool: 'wall' });
    const svg = container.querySelector('svg');
    touch(svg, 'pointerDown', 1, 100, 100);
    touch(svg, 'pointerDown', 2, 200, 100);
    touch(svg, 'pointerUp', 1, 100, 100);
    touch(svg, 'pointerUp', 2, 200, 100);
    expect(ref.current.hasDraft()).toBe(false);
  });
});

describe('turning the plan', () => {
  it('starts north up', () => {
    const { turned, onRotationChange } = show();
    expect(turned().getAttribute('transform')).toBeNull();
    expect(onRotationChange).toHaveBeenLastCalledWith(0);
  });

  it('turns any angle, all the way round, and back', () => {
    const { ref, turned, onRotationChange } = show();
    act(() => ref.current.rotateBy(90));
    expect(turned().getAttribute('transform')).toMatch(/^rotate\(90 /);
    expect(onRotationChange).toHaveBeenLastCalledWith(90);

    act(() => ref.current.rotateBy(-105));
    expect(onRotationChange).toHaveBeenLastCalledWith(345);

    act(() => ref.current.rotateBy(15));
    expect(onRotationChange).toHaveBeenLastCalledWith(0);
    expect(turned().getAttribute('transform')).toBeNull();
  });

  it('keeps the turn when the plan is fitted to the screen, and resets on request', () => {
    const { ref, onRotationChange } = show();
    act(() => ref.current.rotateBy(30));
    act(() => ref.current.fit());
    expect(onRotationChange).toHaveBeenLastCalledWith(30);
    act(() => ref.current.resetRotation());
    expect(onRotationChange).toHaveBeenLastCalledWith(0);
  });
});
