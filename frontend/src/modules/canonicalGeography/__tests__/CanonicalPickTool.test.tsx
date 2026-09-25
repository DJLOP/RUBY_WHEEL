/**
 * The click-to-inspect scene tool under real DOM pointer events and a real top-down camera:
 * clicks report candidates, drags never do, and tracing / land picking take precedence.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act, cleanup } from '@testing-library/react';
import * as THREE from 'three';

const three = {} as { camera: THREE.PerspectiveCamera; gl: { domElement: HTMLElement } };
vi.mock('@react-three/fiber', () => ({ useThree: () => three, useFrame: () => {} }));

import { CanonicalPickTool } from '../CanonicalPickTool';
import { createMapPickStore, type MapPickStore } from '../mapPick';
import { createLandSelection, type LandSelectionStore } from '../landSelection';
import { beginTrace, createTracingSession, type TracingSession } from '../tracing';
import { land } from './wp6Fixtures';

const SIZE = 200;
let el: HTMLDivElement;
let pick: MapPickStore;
let selection: LandSelectionStore;
let session: TracingSession;

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
  pick = createMapPickStore();
  selection = createLandSelection();
  session = createTracingSession();
});

afterEach(() => {
  cleanup();
  el.remove();
});

const px = (x: number, z: number) => ({ clientX: SIZE / 2 + x, clientY: SIZE / 2 + z });
const click = (x: number, z: number) => {
  fireEvent.pointerDown(el, { ...px(x, z), button: 0 });
  fireEvent.pointerUp(el, { ...px(x, z), button: 0 });
};
const features = [land(1, 0, 0, 20), land(2, 40, 0, 20)];
const mount = (active = true) =>
  render(<CanonicalPickTool pick={pick} session={session} selection={selection} features={features} active={active} />);

describe('CanonicalPickTool', () => {
  it('a click inside a land polygon reports it', () => {
    mount();
    click(5, 5);
    expect(pick.getState().request).toMatchObject({ nonce: 1, ids: [1] });
    click(30, 5); // water: a request with no candidates
    expect(pick.getState().request).toMatchObject({ nonce: 2, ids: [] });
  });

  it('a camera drag never selects', () => {
    mount();
    fireEvent.pointerDown(el, { ...px(5, 5), button: 0 });
    fireEvent.pointerUp(el, { ...px(45, 5), button: 0 });
    expect(pick.getState().request).toBeNull();
  });

  it('is idle while tracing: handles and vertex placement keep the click', () => {
    act(() => session.update(s => beginTrace(s, { geometryType: 'polygon' })));
    mount();
    click(5, 5);
    expect(pick.getState().request).toBeNull();
  });

  it('is idle while WP6 land multi-selection is picking', () => {
    act(() => selection.update(s => ({ ...s, picking: true })));
    mount();
    click(5, 5);
    expect(pick.getState().request).toBeNull();
  });

  it('is idle outside the canonical view, and when SELECT ON MAP is off', () => {
    const { unmount } = mount(false);
    click(5, 5);
    expect(pick.getState().request).toBeNull();
    unmount();
    act(() => pick.update(s => ({ ...s, inspecting: false })));
    mount();
    click(5, 5);
    expect(pick.getState().request).toBeNull();
  });

  it('outlines only the inspected feature, as one non-merged line object beside the unchanged overlay', () => {
    const { container } = mount();
    expect(container.querySelector('linesegments')).toBeNull();
    act(() => pick.update(s => ({ ...s, highlightId: 2 })));
    const lines = container.querySelectorAll('linesegments');
    expect([...lines].map(l => l.getAttribute('name'))).toEqual(['canonical-selected-feature']);
  });

  it('draws a selected scope: translucent extent fill, emphasized boundary, inside vs crossing land — all non-raycast', () => {
    const { container } = mount();
    const extent = { outer: [{ x: -50, z: -50 }, { x: 50, z: -50 }, { x: 50, z: 50 }, { x: -50, z: 50 }], holes: [] };
    act(() => pick.update(s => ({ ...s, scopeOverlay: { scopeId: 2, extent: [extent], boundaryFeatureId: null, inside: [1], crossing: [2] } })));
    const fill = container.querySelector('mesh[name="scope-extent-fill"]');
    expect(fill).not.toBeNull();
    const names = [...container.querySelectorAll('linesegments')].map(l => l.getAttribute('name'));
    expect(names).toEqual(expect.arrayContaining(['scope-extent-outline', 'scope-land-inside', 'scope-land-crossing']));
    expect(container.querySelector('meshbasicmaterial')!.getAttribute('opacity')).toBe('0.14');
  });

  it('outlines a context-pane hover separately from the inspected feature', () => {
    const { container } = mount();
    act(() => pick.update(s => ({ ...s, highlightId: 1, hoverId: 2 })));
    const names = [...container.querySelectorAll('linesegments')].map(l => l.getAttribute('name'));
    expect(names).toEqual(['canonical-selected-feature', 'canonical-hovered-feature']);
  });
});
