/**
 * The in-scene land picker, driven by real DOM pointer events under a real top-down camera
 * (the same jsdom set-up as the tracing tool): click toggles an island, shift-drag
 * box-selects, and the camera never sees a box press.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act, cleanup } from '@testing-library/react';
import * as THREE from 'three';

const three = {} as { camera: THREE.PerspectiveCamera; gl: { domElement: HTMLElement } };
vi.mock('@react-three/fiber', () => ({ useThree: () => three, useFrame: () => {} }));

import { LandSelectionTool } from '../LandSelectionTool';
import { createLandSelection, type LandSelectionStore } from '../landSelection';
import { land } from './wp6Fixtures';

const SIZE = 200;
let el: HTMLDivElement;
let selection: LandSelectionStore;

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
  selection = createLandSelection();
});

afterEach(() => {
  cleanup();
  el.remove();
});

/** Screen pixel for a world point (fov 90 at height 100: 1 px = 1 wu). */
const px = (x: number, z: number) => ({ clientX: SIZE / 2 + x, clientY: SIZE / 2 + z });
const click = (x: number, z: number) => {
  fireEvent.pointerDown(el, { ...px(x, z), button: 0 });
  fireEvent.pointerUp(el, { ...px(x, z), button: 0 });
};

const islands = [land(1, 0, 0), land(2, 20, 0), land(3, 60, 60, 10), land(4, -40, -40, 10, { lifecycle_state: 'draft' })];

function mount(active = true, picking = true) {
  act(() => selection.update(s => ({ ...s, picking })));
  return render(<LandSelectionTool selection={selection} features={islands} active={active} />);
}

describe('LandSelectionTool', () => {
  it('toggles the island under a click, several in turn', () => {
    mount();
    click(5, 5);
    click(25, 5);
    expect(selection.getState().ids).toEqual([1, 2]);
    click(5, 5);
    expect(selection.getState().ids).toEqual([2]);
  });

  it('ignores draft land and explains a click over no accepted land', () => {
    mount();
    click(-35, -35);
    expect(selection.getState().ids).toEqual([]);
    expect(selection.getState().message).toMatch(/No accepted land here/);
  });

  it('a drag is a camera pan, not a selection', () => {
    mount();
    fireEvent.pointerDown(el, { ...px(5, 5), button: 0 });
    fireEvent.pointerUp(el, { ...px(40, 5), button: 0 });
    expect(selection.getState().ids).toEqual([]);
  });

  it('shift-drag adds every island wholly inside the box, and the press never reaches the camera', () => {
    mount();
    const cameraSaw = vi.fn();
    el.addEventListener('pointerdown', cameraSaw);
    fireEvent.pointerDown(el, { ...px(-2, -2), button: 0, shiftKey: true });
    fireEvent.pointerMove(el, { ...px(35, 12) });
    fireEvent.pointerUp(el, { ...px(35, 12), button: 0 });
    expect(selection.getState().ids).toEqual([1, 2]);
    expect(cameraSaw).not.toHaveBeenCalled();
    el.removeEventListener('pointerdown', cameraSaw);
  });

  it('takes no input unless the scene is in the canonical view and picking is on', () => {
    const { unmount } = mount(false, true);
    click(5, 5);
    expect(selection.getState().ids).toEqual([]);
    unmount();
    mount(true, false);
    click(5, 5);
    expect(selection.getState().ids).toEqual([]);
  });

  it('draws the selection and an inside-boundary proposal as non-raycast outlines', () => {
    const { container } = mount(true, false);
    act(() => selection.update(s => ({ ...s, ids: [1], proposal: { scopeId: 9, boundaryFeatureId: 8, inside: [2], straddling: [3] } })));
    const names = [...container.querySelectorAll('linesegments')].map(n => n.getAttribute('name'));
    expect(names).toEqual(expect.arrayContaining(['land-selection', 'land-proposal-inside', 'land-proposal-straddling']));
  });
});
