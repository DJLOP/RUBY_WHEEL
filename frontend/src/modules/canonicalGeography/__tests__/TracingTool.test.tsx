/**
 * The in-scene tracing tool, driven through real DOM pointer events (plan §10 "Tracing tool").
 *
 * There is no WebGL in jsdom, so `useThree` supplies a real top-down PerspectiveCamera and a
 * plain element standing in for the canvas: the tool's own ray/plane arithmetic runs for
 * real. R3F intrinsics render as inert elements, so handle pointer handlers can be fired
 * directly.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act, cleanup } from '@testing-library/react';
import * as THREE from 'three';

const three = {} as { camera: THREE.PerspectiveCamera; gl: { domElement: HTMLElement } };
vi.mock('@react-three/fiber', () => ({ useThree: () => three, useFrame: () => {} }));

import { TracingTool, TRACE_Y, groundPoint } from '../TracingTool';
import { addPoint, beginTrace, createTracingSession, type SnapSource, type TracingSession } from '../tracing';
import { CANONICAL_BAND_CEILING_Y, CANONICAL_POINT_Y } from '../overlay';

const SIZE = 200;
let el: HTMLDivElement;
let session: TracingSession;
let setIsDragging: ReturnType<typeof vi.fn>;

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
});

afterEach(() => {
  cleanup();
  el.remove();
});

/** Screen pixel for a world point under the top-down camera (fov 90 at height 100: 1 px = 1 wu). */
const px = (x: number, z: number) => ({ clientX: SIZE / 2 + x, clientY: SIZE / 2 + z });

function click(x: number, z: number, opts: Partial<PointerEventInit> = {}) {
  const at = px(x, z);
  fireEvent.pointerDown(el, { ...at, button: 0, ...opts });
  fireEvent.pointerUp(el, { ...at, button: 0, ...opts });
}

function mount(features: SnapSource[] = [], geometryType: 'polygon' | 'linestring' | 'point' = 'polygon') {
  act(() => session.update(s => beginTrace(s, { geometryType })));
  return render(<TracingTool session={session} features={features} setIsDragging={setIsDragging} />);
}

const near = (p: { x: number; z: number }, x: number, z: number) => {
  expect(p.x).toBeCloseTo(x, 1);
  expect(p.z).toBeCloseTo(z, 1);
};

describe('TracingTool', () => {
  it('maps the pointer onto the Y=0 plane with the camera’s own ray', () => {
    near(groundPoint(three.camera, el, SIZE / 2, SIZE / 2)!, 0, 0);
    near(groundPoint(three.camera, el, SIZE / 2 + 40, SIZE / 2 - 20)!, 40, -20);
  });

  it('places a vertex on a click', () => {
    mount();
    click(10, 20);
    const v = session.getState().vertices;
    expect(v).toHaveLength(1);
    near(v[0], 10, 20);
  });

  it('leaves a drag to the camera: no vertex beyond the click threshold', () => {
    mount();
    fireEvent.pointerDown(el, { ...px(0, 0), button: 0 });
    fireEvent.pointerUp(el, { ...px(12, 0), button: 0 });
    expect(session.getState().vertices).toHaveLength(0);
    // Right-button (camera rotate) never places a vertex either.
    click(0, 0, { button: 2 });
    expect(session.getState().vertices).toHaveLength(0);
  });

  it('closes the ring when the first vertex is clicked again', () => {
    mount();
    click(0, 0); click(50, 0); click(50, 50);
    click(1, 1);
    expect(session.getState().closed).toBe(true);
    expect(session.getState().vertices).toHaveLength(3);
  });

  it('snaps a click to a saved feature’s vertex so shared shorelines coincide', () => {
    const neighbour: SnapSource = { id: 9, geometry_type: 'polygon', geometry: { outer: [{ x: 30, z: 30 }, { x: 60, z: 30 }, { x: 60, z: 60 }], holes: [] } };
    mount([neighbour]);
    click(33, 28); // within SNAP_RADIUS_PX of (30, 30)
    expect(session.getState().vertices[0]).toEqual({ x: 30, z: 30 });
    act(() => session.update(s => ({ ...s, snapping: false })));
    click(58, 62);
    near(session.getState().vertices[1], 58, 62);
  });

  it('updates the hover point for the readout without placing anything', () => {
    mount();
    fireEvent.pointerMove(el, { ...px(-15, 5) });
    near(session.getState().hover!, -15, 5);
    expect(session.getState().vertices).toHaveLength(0);
  });

  it('drags a vertex handle with the camera held, then releases the camera', () => {
    mount();
    click(0, 0); click(50, 0); click(50, 50);
    const handles = document.querySelectorAll('[name="trace-vertex-handle"]');
    expect(handles).toHaveLength(3);
    fireEvent.pointerDown(handles[1], { ...px(50, 0), button: 0 });
    fireEvent.pointerDown(el, { ...px(50, 0), button: 0 });
    expect(setIsDragging).toHaveBeenLastCalledWith(true);
    fireEvent.pointerMove(window, { ...px(70, -10) });
    fireEvent.pointerUp(window, { ...px(70, -10), button: 0 });
    expect(setIsDragging).toHaveBeenLastCalledWith(false);
    const v = session.getState().vertices;
    expect(v).toHaveLength(3); // moved, not added
    near(v[1], 70, -10);
  });

  it('inserts a vertex from an edge midpoint handle and deletes with Alt-click and the Delete key', () => {
    mount();
    click(0, 0); click(40, 0); click(40, 40);
    const mids = document.querySelectorAll('[name="trace-midpoint-handle"]');
    expect(mids).toHaveLength(2); // open line: two edges
    fireEvent.pointerDown(mids[0], { ...px(20, 0), button: 0 });
    fireEvent.pointerUp(window, { ...px(20, 0), button: 0 });
    expect(session.getState().vertices).toHaveLength(4);
    expect(session.getState().vertices[1]).toEqual({ x: 20, z: 0 });

    const handles = document.querySelectorAll('[name="trace-vertex-handle"]');
    fireEvent.pointerDown(handles[3], { ...px(40, 40), button: 0, altKey: true });
    fireEvent.pointerUp(window, { ...px(40, 40), button: 0 });
    expect(session.getState().vertices).toHaveLength(3);

    act(() => session.update(s => ({ ...s, selectedVertex: 0 })));
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(session.getState().vertices).toEqual([{ x: 20, z: 0 }, { x: 40, z: 0 }]);
  });

  it('draws inside the canonical Y band, above the merged overlay', () => {
    expect(TRACE_Y).toBeGreaterThan(CANONICAL_POINT_Y);
    expect(TRACE_Y).toBeLessThan(CANONICAL_BAND_CEILING_Y);
    mount();
    click(0, 0); click(10, 0);
    const outline = document.querySelector('[name="trace-outline"]')!;
    expect(outline.getAttribute('position')).toBe(`0,${TRACE_Y},0`);
  });

  it('draws nothing and ignores clicks when no session is active', () => {
    render(<TracingTool session={session} features={[]} setIsDragging={setIsDragging} />);
    expect(document.querySelector('[name="canonical-tracing"]')).toBeNull();
    click(0, 0);
    expect(session.getState().vertices).toHaveLength(0);
  });

  it('removes its listeners on unmount', () => {
    const { unmount } = mount();
    unmount();
    click(0, 0);
    expect(session.getState().vertices).toHaveLength(0);
  });
});

describe('click-to-close takes priority over external snapping', () => {
  // An external island whose vertex (4, 3) and edge (x = 4) both lie within snap reach of
  // the traced polygon's first vertex at (0, 0), plus a vertex far from it at (60, 60).
  const neighbour: SnapSource = {
    id: 9, geometry_type: 'polygon',
    geometry: { outer: [{ x: 4, z: 3 }, { x: 4, z: 40 }, { x: 60, z: 60 }, { x: 40, z: 3 }], holes: [] },
  };
  const openTriangle = () => act(() => session.update(s =>
    [[0, 0], [30, -30], [-30, -30]].reduce((acc, [x, z]) => addPoint(acc, { x, z }), s)));
  const firstHandle = () => document.querySelectorAll('[name="trace-vertex-handle"]')[0];

  /** A click on the first vertex's handle, with the small jitter a real click has. */
  function clickFirstHandle(jitter = { x: 2, z: 1 }) {
    fireEvent.pointerDown(firstHandle(), { ...px(0, 0), button: 0 });
    fireEvent.pointerDown(el, { ...px(0, 0), button: 0 });
    fireEvent.pointerMove(window, { ...px(jitter.x, jitter.z) });
    fireEvent.pointerUp(window, { ...px(jitter.x, jitter.z), button: 0 });
  }

  it('closes the ring from the first vertex handle, with SNAP on and an external vertex/edge in range', () => {
    mount([neighbour]);
    openTriangle();
    clickFirstHandle();
    const s = session.getState();
    expect(s.closed).toBe(true);
    expect(s.vertices).toEqual([{ x: 0, z: 0 }, { x: 30, z: -30 }, { x: -30, z: -30 }]); // vertex 0 not snapped away
    expect(setIsDragging).toHaveBeenLastCalledWith(false); // camera released
  });

  it('closes the ring from a ground click near the first vertex, with SNAP on and an external vertex in range', () => {
    mount([neighbour]);
    openTriangle();
    click(1, 1);
    expect(session.getState().closed).toBe(true);
    expect(session.getState().vertices).toHaveLength(3);
  });

  it('still snaps ordinary clicks away from the first vertex to external features', () => {
    mount([neighbour]);
    openTriangle();
    click(58, 62);
    expect(session.getState().closed).toBe(false);
    expect(session.getState().vertices[3]).toEqual({ x: 60, z: 60 });
  });

  it('still drags the first vertex (and snaps it) once the pointer moves past the click threshold', () => {
    mount([neighbour]);
    openTriangle();
    fireEvent.pointerDown(firstHandle(), { ...px(0, 0), button: 0 });
    fireEvent.pointerMove(window, { ...px(59, 58) });
    fireEvent.pointerUp(window, { ...px(59, 58), button: 0 });
    expect(session.getState().closed).toBe(false);
    expect(session.getState().vertices[0]).toEqual({ x: 60, z: 60 });
  });

  it('behaves the same with SNAP off: first-vertex click closes, other clicks land where clicked', () => {
    mount([neighbour]);
    openTriangle();
    act(() => session.update(s => ({ ...s, snapping: false })));
    click(58, 62);
    near(session.getState().vertices[3], 58, 62);
    clickFirstHandle();
    expect(session.getState().closed).toBe(true);
    expect(session.getState().vertices[0]).toEqual({ x: 0, z: 0 });
  });

  it('does not treat a first-vertex click as a close when the ring cannot close yet', () => {
    mount([neighbour]);
    act(() => session.update(s => addPoint(addPoint(s, { x: 0, z: 0 }), { x: 30, z: -30 })));
    clickFirstHandle({ x: 0, z: 0 });
    expect(session.getState().closed).toBe(false);
    expect(session.getState().vertices).toHaveLength(2);
  });
});
