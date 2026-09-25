/**
 * Whole-shape dragging in the tracing tool, under real DOM pointer events and a real
 * top-down camera (1 px = 1 wu): body drag moves the shape and never reaches the camera;
 * handles keep precedence; a still click stays a click; nothing moves when not editing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act, cleanup } from '@testing-library/react';
import * as THREE from 'three';

const three = {} as { camera: THREE.PerspectiveCamera; gl: { domElement: HTMLElement } };
vi.mock('@react-three/fiber', () => ({ useThree: () => three, useFrame: () => {} }));

import { TracingTool } from '../TracingTool';
import { addPoint, beginTrace, closeRing, createTracingSession, undoLast, type TracingSession } from '../tracing';

const SIZE = 200;
let el: HTMLDivElement;
let session: TracingSession;
let setIsDragging: ReturnType<typeof vi.fn>;
let cameraSaw: ReturnType<typeof vi.fn>;

beforeEach(() => {
  el = document.createElement('div');
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: SIZE, height: SIZE, right: SIZE, bottom: SIZE, x: 0, y: 0, toJSON() {} });
  document.body.appendChild(el);
  const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 10000);
  camera.position.set(0, 100, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  three.camera = camera;
  three.gl = { domElement: el };
  session = createTracingSession();
  setIsDragging = vi.fn();
  // Stands in for the camera controls: a bubbling listener on the canvas.
  cameraSaw = vi.fn();
  el.addEventListener('pointerdown', cameraSaw);
});

afterEach(() => {
  cleanup();
  el.remove();
});

const px = (x: number, z: number) => ({ clientX: SIZE / 2 + x, clientY: SIZE / 2 + z });
function drag(from: [number, number], to: [number, number]) {
  fireEvent.pointerDown(el, { ...px(...from), button: 0 });
  fireEvent.pointerMove(el, { ...px((from[0] + to[0]) / 2, (from[1] + to[1]) / 2) });
  fireEvent.pointerMove(el, { ...px(...to) });
  fireEvent.pointerUp(el, { ...px(...to), button: 0 });
}
const mountSquare = () => {
  act(() => session.update(s => closeRing([[-40, -40], [40, -40], [40, 40], [-40, 40]]
    .reduce((acc, [x, z]) => addPoint(acc, { x, z }), beginTrace(s, { geometryType: 'polygon', featureId: 9 })))));
  return render(<TracingTool session={session} features={[]} setIsDragging={setIsDragging} />);
};

describe('whole-shape drag', () => {
  it('dragging a polygon body moves every vertex by the drag delta, holding the camera still', () => {
    mountSquare();
    drag([10, 10], [25, 15]);
    expect(session.getState().vertices).toEqual([{ x: -25, z: -35 }, { x: 55, z: -35 }, { x: 55, z: 45 }, { x: -25, z: 45 }]);
    expect(cameraSaw).not.toHaveBeenCalled();
    expect(setIsDragging).toHaveBeenNthCalledWith(1, true);
    expect(setIsDragging).toHaveBeenLastCalledWith(false);
    act(() => session.update(undoLast));
    expect(session.getState().vertices[0]).toEqual({ x: -40, z: -40 });
  });

  it('a press on a vertex handle is left to the handle (no whole-shape move, not captured)', () => {
    mountSquare();
    drag([40, 40], [60, 60]);
    expect(session.getState().vertices[2]).toEqual({ x: 40, z: 40 });
    expect(session.getState().vertices[0]).toEqual({ x: -40, z: -40 });
    expect(cameraSaw).toHaveBeenCalled(); // reached the canvas, where R3F routes it to the handle
  });

  it('a still click on the body stays an ordinary click (nothing moves)', () => {
    mountSquare();
    fireEvent.pointerDown(el, { ...px(10, 10), button: 0 });
    fireEvent.pointerUp(el, { ...px(10, 10), button: 0 });
    expect(session.getState().vertices[0]).toEqual({ x: -40, z: -40 });
    expect(session.getState().message).toMatch(/closed/);
  });

  it('moves a line by its body, and a point by the point itself', () => {
    act(() => session.update(s => addPoint(addPoint(beginTrace(s, { geometryType: 'linestring' }), { x: -60, z: 0 }), { x: 60, z: 0 })));
    const { unmount } = render(<TracingTool session={session} features={[]} setIsDragging={setIsDragging} />);
    drag([20, 1], [20, 21]);
    expect(session.getState().vertices).toEqual([{ x: -60, z: 20 }, { x: 60, z: 20 }]);
    unmount();

    act(() => session.update(s => addPoint(beginTrace(s, { geometryType: 'point' }), { x: 5, z: 5 })));
    render(<TracingTool session={session} features={[]} setIsDragging={setIsDragging} />);
    drag([5, 5], [15, -5]);
    expect(session.getState().vertices).toEqual([{ x: 15, z: -5 }]);
    expect(session.getState().translateUndo).toHaveLength(1);
  });

  it('when nothing is being edited, a drag is an ordinary camera pan and moves nothing', () => {
    render(<TracingTool session={session} features={[]} setIsDragging={setIsDragging} />);
    drag([10, 10], [30, 30]);
    expect(cameraSaw).toHaveBeenCalled();
    expect(session.getState().active).toBe(false);
    expect(setIsDragging).not.toHaveBeenCalled();
  });

  it('a drag outside the shape still pans while editing', () => {
    mountSquare();
    drag([90, 90], [95, 95]);
    expect(cameraSaw).toHaveBeenCalled();
    expect(session.getState().vertices[0]).toEqual({ x: -40, z: -40 });
  });
});
