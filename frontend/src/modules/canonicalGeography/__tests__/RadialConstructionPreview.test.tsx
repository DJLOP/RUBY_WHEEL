/**
 * The in-scene radial preview (plan §15.6 step 7, §15.14): a PREVIEW style unlike
 * accepted/draft/proposed canon, spoke 0 emphasized, invalid spokes as error rays, drawn
 * non-raycast in the canonical Y band, world branch only — and map clicks only while the
 * panel asks for one, never on a camera drag.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act, cleanup } from '@testing-library/react';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import * as THREE from 'three';

const three = {} as { camera: THREE.PerspectiveCamera; gl: { domElement: HTMLElement } };
vi.mock('@react-three/fiber', () => ({ useThree: () => three, useFrame: () => {} }));

import {
  RadialConstructionPreview, CIRCLE_DRAFT_COLOR, CIRCLE_INPUT_COLOR, HOVER_COLOR, INVALID_COLOR, OMITTED_COLOR, PREVIEW_COLOR, SPOKE0_COLOR,
} from '../RadialConstructionPreview';
import { createRadialSession, rayToBBox, type RadialSession } from '../radialSession';
import { computeRadial } from '../radialConstruction';
import { OVERLAY_STATES, overlayStyle, CANONICAL_BAND_CEILING_Y, CANONICAL_LINE_Y } from '../overlay';
import { TRACE_Y } from '../TracingTool';
import { land } from './wp6Fixtures';
import type { FeatureClass } from '../types';

const SIZE = 200;
let el: HTMLDivElement;
let session: RadialSession;

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
  session = createRadialSession();
});

afterEach(() => {
  cleanup();
  el.remove();
});

const sq = (h: number) => [{ x: -h, z: -h }, { x: h, z: -h }, { x: h, z: h }, { x: -h, z: h }];
const px = (x: number, z: number) => ({ clientX: SIZE / 2 + x, clientY: SIZE / 2 + z });
const click = (x: number, z: number) => {
  fireEvent.pointerDown(el, { ...px(x, z), button: 0 });
  fireEvent.pointerUp(el, { ...px(x, z), button: 0 });
};
const features = [land(1, -20, -20, 40), land(2, 30, 30, 10)];
const mount = (active = true) => render(<RadialConstructionPreview session={session} features={features} active={active} />);

/** A report with a valid spoke 0, an invalid spoke 1 (rings cross along +Z), and an omitted spoke 3. */
function previewReport() {
  const inner = [{ x: -10, z: -60 }, { x: 10, z: -60 }, { x: 10, z: 60 }, { x: -10, z: 60 }];
  const outer = [{ x: -50, z: -40 }, { x: 50, z: -40 }, { x: 50, z: 40 }, { x: -50, z: 40 }];
  return computeRadial({ center: { x: 0, z: 0 }, inner, outer, count: 4, offset_deg: 0, omit_indices: [3] });
}

const lineByName = (c: HTMLElement, name: string) => c.querySelector(`linesegments[name="${name}"]`);
const colorOf = (node: Element | null) => node?.querySelector('linebasicmaterial')?.getAttribute('color');

describe('RadialConstructionPreview', () => {
  it('draws nothing while the constructor is closed', () => {
    const { container } = mount();
    act(() => session.update(s => ({ ...s, preview: { center: { x: 0, z: 0 }, spokes: previewReport().spokes, outerBBox: null } })));
    expect(container.querySelector('[name="radial-construction-preview"]')).toBeNull();
  });

  it('draws valid spokes in the PREVIEW colour, spoke 0 emphasized, invalid spokes as error rays, omitted dimmed', () => {
    const { container } = mount();
    const r = previewReport();
    expect(r.spokes.map(s => s.status)).toEqual(['valid', 'invalid', 'valid', 'omitted']);
    act(() => session.update(s => ({ ...s, active: true, preview: { center: { x: 0, z: 0 }, spokes: r.spokes, outerBBox: { min_x: -50, min_z: -40, max_x: 50, max_z: 40 } } })));
    expect(colorOf(lineByName(container, 'radial-preview-spokes'))).toBe(PREVIEW_COLOR);
    expect(colorOf(lineByName(container, 'radial-preview-spoke0'))).toBe(SPOKE0_COLOR);
    expect(colorOf(lineByName(container, 'radial-preview-invalid'))).toBe(INVALID_COLOR);
    expect(colorOf(lineByName(container, 'radial-preview-omitted'))).toBe(OMITTED_COLOR);
    expect(container.querySelectorAll('[name="radial-preview-spoke0-ends-ring"]')).toHaveLength(2);
    expect(container.querySelectorAll('[name="radial-preview-center-ring"]')).toHaveLength(1);
    expect(container.querySelectorAll('[name="radial-preview-errors-ring"]').length).toBeGreaterThan(0);
  });

  it('highlights the hovered table row\'s spoke', () => {
    const { container } = mount();
    act(() => session.update(s => ({ ...s, active: true, hoverIndex: 2, preview: { center: { x: 0, z: 0 }, spokes: previewReport().spokes, outerBBox: null } })));
    expect(colorOf(lineByName(container, 'radial-preview-hover'))).toBe(HOVER_COLOR);
  });

  it('uses colours unlike any accepted, draft or proposed canon style', () => {
    const classes: FeatureClass[] = ['land', 'water', 'route', 'protected_region', 'site', 'scope_boundary'];
    const canon = new Set(classes.flatMap(c => OVERLAY_STATES.map(st => overlayStyle(c, st).lineColor.toLowerCase())));
    for (const color of [PREVIEW_COLOR, SPOKE0_COLOR, INVALID_COLOR]) expect(canon.has(color.toLowerCase()), color).toBe(false);
    expect(PREVIEW_COLOR).not.toBe(SPOKE0_COLOR);
  });

  it('draws in the canonical Y band, above the merged overlay and below the inherited overlays', () => {
    const { container } = mount();
    act(() => session.update(s => ({ ...s, active: true, preview: { center: { x: 0, z: 0 }, spokes: previewReport().spokes, outerBBox: null } })));
    const y = Number(lineByName(container, 'radial-preview-spokes')!.getAttribute('position')!.split(',')[1]);
    expect(y).toBe(TRACE_Y);
    expect(y).toBeGreaterThan(CANONICAL_LINE_Y);
    expect(y).toBeLessThan(CANONICAL_BAND_CEILING_Y);
  });

  it('is never a raycast target (every drawn object disables raycasting)', () => {
    const src = readFileSync(resolve(__dirname, '../RadialConstructionPreview.tsx'), 'utf8');
    // Each opening tag runs to its first ">" that is not part of an arrow "=>".
    const objects = src.match(/<(lineSegments|mesh)\b(?:=>|[^>])*>/g) ?? [];
    expect(objects).toHaveLength(2); // the Segments lines and the Markers rings
    for (const tag of objects) expect(tag).toMatch(/raycast=\{\(\) => null\}/);
  });

  it('ignores clicks unless the panel waits for one; a drag never picks', () => {
    mount();
    act(() => session.update(s => ({ ...s, active: true })));
    click(5, 5);
    expect(session.getState().request).toBeNull();
    act(() => session.update(s => ({ ...s, pickMode: 'inner' })));
    fireEvent.pointerDown(el, { ...px(5, 5), button: 0 });
    fireEvent.pointerUp(el, { ...px(45, 5), button: 0 });
    expect(session.getState().request).toBeNull();
    click(5, 5);
    expect(session.getState().request).toMatchObject({ nonce: 1, mode: 'inner', ids: [1] });
    expect(session.getState().pickMode).toBeNull();
  });

  it('snaps a center click to a saved vertex, and never snaps an aim click', () => {
    mount();
    act(() => session.update(s => ({ ...s, active: true, pickMode: 'center' })));
    click(21, 20); // 1 wu from the vertex (20, 20) at 1 px ≈ 1 wu
    expect(session.getState().request!.at).toEqual({ x: 20, z: 20 });
    act(() => session.update(s => ({ ...s, pickMode: 'aim' })));
    click(21, 20);
    const at = session.getState().request!.at;
    expect(at.x).toBeCloseTo(21, 3);
  });

  it("draws an inline circle boundary and its defining clicks as construction input, and keeps collecting circle clicks", () => {
    const { container } = mount();
    const ring = [{ x: 30, z: 0 }, { x: 0, z: 30 }, { x: -30, z: 0 }, { x: 0, z: -30 }];
    act(() => session.update(s => ({ ...s, active: true, preview: { center: { x: 0, z: 0 }, spokes: [], outerBBox: null, circles: [{ ring, materialize: false }, { ring: ring.map(p => ({ x: p.x * 2, z: p.z * 2 })), materialize: true }], circlePoints: [{ x: 30, z: 0 }] } })));
    expect(colorOf(lineByName(container, "radial-preview-circles"))).toBe(CIRCLE_INPUT_COLOR);
    expect(colorOf(lineByName(container, "radial-preview-circle-drafts"))).toBe(CIRCLE_DRAFT_COLOR); // scheduled to become a draft
    expect(CIRCLE_DRAFT_COLOR).not.toBe(CIRCLE_INPUT_COLOR);
    expect(container.querySelectorAll("[name=\"radial-preview-circle-points-ring\"]")).toHaveLength(1);
    act(() => session.update(s => ({ ...s, pickMode: "outer_circle" })));
    click(21, 20);
    expect(session.getState().request).toMatchObject({ mode: "outer_circle", at: { x: 20, z: 20 } }); // snapped like a tracing constructor click
    expect(session.getState().pickMode).toBe("outer_circle");
  });

  it('is idle outside the canonical view', () => {
    mount(false);
    act(() => session.update(s => ({ ...s, active: true, pickMode: 'inner' })));
    click(5, 5);
    expect(session.getState().request).toBeNull();
  });

  it('is mounted once, in the world branch only, never under the battle map', () => {
    const app = readFileSync(resolve(__dirname, '../../../App.tsx'), 'utf8');
    expect(app.match(/<RadialConstructionPreview\b/g)).toHaveLength(1);
    expect(app.indexOf('<RadialConstructionPreview')).toBeGreaterThan(app.indexOf('<PerspectiveCamera makeDefault'));
    expect(app.indexOf('<RadialConstructionPreview')).toBeGreaterThan(app.indexOf('<BattleMapScene'));
    expect(app).toMatch(/showCanonicalGeographyManager && isPrimaryAdmin && \(\s*<RadialConstructionPreview/);
  });
});

describe('rayToBBox', () => {
  it('ends an error ray where it leaves the outer ring\'s bbox', () => {
    const box = { min_x: -50, min_z: -40, max_x: 50, max_z: 40 };
    expect(rayToBBox({ x: 0, z: 0 }, 0, box)).toEqual({ x: 50, z: 0 });
    const up = rayToBBox({ x: 0, z: 0 }, 90, box)!;
    expect(up.x).toBeCloseTo(0, 9);
    expect(up.z).toBeCloseTo(40, 9);
    expect(rayToBBox({ x: 100, z: 0 }, 0, box)).toBeNull();
    expect(sq(1)).toHaveLength(4);
  });
});
