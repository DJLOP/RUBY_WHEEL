/**
 * Driving the scene's camera to a top-down view of one layer.
 *
 * The arithmetic is covered in calibration.test.ts. What is covered here is the wiring:
 * that it goes through the scene's existing controls rather than assigning to the camera
 * behind their back, that pressing the button twice moves twice, and that an ordinary
 * re-render does not yank the camera away from somebody who has since moved it.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

const setLookAt = vi.fn();
const controls: { setLookAt?: typeof setLookAt } | null = { setLookAt };
const camera: { fov?: number; near: number; far: number; updateProjectionMatrix: () => void } = {
  fov: 50, near: 0.1, far: 2000, updateProjectionMatrix: vi.fn(),
};
const size = { width: 1600, height: 900 };

vi.mock('@react-three/fiber', () => ({
  useThree: () => ({ camera, controls, size }),
}));

import { ReferenceLayerFraming } from '../ReferenceLayerFraming';
import { topDownFraming, REFERENCE_LAYER_Y } from '../calibration';
import type { ReferenceLayer } from '../types';

// The artwork and working scale from human verification: 6032 x 4584 at 2 units per pixel.
const layer = (over: Partial<ReferenceLayer> = {}): ReferenceLayer => ({
  id: 1,
  name: 'Imperial City',
  asset_id: 1,
  asset_url: '/uploads/reference_layers/abc.png',
  original_name: 'city.png',
  format: 'png',
  source_width_px: 6032,
  source_height_px: 4584,
  world_center_x: 0,
  world_center_z: 0,
  world_units_per_pixel: 2,
  rotation_rad: 0,
  opacity: 1,
  is_visible: true,
  is_locked: false,
  provenance: 'imported',
  replacement_state: 'non_replaceable',
  ...over,
});

const lastCall = () => setLookAt.mock.calls[setLookAt.mock.calls.length - 1];

beforeEach(() => {
  setLookAt.mockClear();
  camera.fov = 50;
  // The planes the inherited camera actually starts with: Three's constructor defaults.
  camera.near = 0.1;
  camera.far = 2000;
  controls!.setLookAt = setLookAt;
});

describe('ReferenceLayerFraming', () => {
  it('does nothing until something asks it to', () => {
    render(<ReferenceLayerFraming request={null} />);
    expect(setLookAt).not.toHaveBeenCalled();
  });

  it('drives the scene controls rather than the camera directly', () => {
    render(<ReferenceLayerFraming request={{ layer: layer(), nonce: 1 }} />);
    expect(setLookAt).toHaveBeenCalledTimes(1);
    // Animated, which keeps the controls' own state consistent instead of teleporting.
    expect(lastCall()[6]).toBe(true);
  });

  it('places the eye above the persisted centre and looks straight down at it', () => {
    render(<ReferenceLayerFraming request={{ layer: layer({ world_center_x: -412.5, world_center_z: 963 }), nonce: 1 }} />);
    const [px, py, pz, tx, ty, tz] = lastCall();

    expect(px).toBe(-412.5);
    expect(pz).toBe(963);
    expect(tx).toBe(-412.5);
    expect(tz).toBe(963);
    expect(ty).toBe(REFERENCE_LAYER_Y);
    expect(py).toBeGreaterThan(ty);
  });

  it('uses the live viewport aspect, not a fixed one', () => {
    const target = layer();
    render(<ReferenceLayerFraming request={{ layer: target, nonce: 1 }} />);
    const wide = lastCall()[1];

    setLookAt.mockClear();
    size.width = 900;
    size.height = 1600;
    render(<ReferenceLayerFraming request={{ layer: target, nonce: 2 }} />);
    const tall = lastCall()[1];

    size.width = 1600;
    size.height = 900;

    // A tall viewport is the narrower one here, so it has to back off further.
    expect(tall).toBeGreaterThan(wide);
    expect(tall).toBeCloseTo(topDownFraming(target, 50, 900 / 1600).position[1], 6);
  });

  // Whatever the camera was doing before, `setLookAt` sets both ends absolutely — there
  // is no relative move here for a previous shallow orientation to survive into.
  it('sets an absolute position and target, not a relative move', () => {
    render(<ReferenceLayerFraming request={{ layer: layer(), nonce: 1 }} />);
    expect(lastCall()).toHaveLength(7);
    expect(lastCall().slice(0, 6).every((n: unknown) => typeof n === 'number' && Number.isFinite(n))).toBe(true);
  });

  it('frames again when the same layer is requested a second time', () => {
    const target = layer();
    const { rerender } = render(<ReferenceLayerFraming request={{ layer: target, nonce: 1 }} />);
    rerender(<ReferenceLayerFraming request={{ layer: target, nonce: 2 }} />);
    expect(setLookAt).toHaveBeenCalledTimes(2);
  });

  // Otherwise every unrelated state change in App would drag the camera back, which is
  // unusable while somebody is panning around checking an edge.
  it('does not re-frame on an unrelated re-render', () => {
    const request = { layer: layer(), nonce: 1 };
    const { rerender } = render(<ReferenceLayerFraming request={request} />);
    rerender(<ReferenceLayerFraming request={request} />);
    rerender(<ReferenceLayerFraming request={{ ...request }} />);
    expect(setLookAt).toHaveBeenCalledTimes(1);
  });

  it('reports back so the request can be cleared', () => {
    const onFramed = vi.fn();
    render(<ReferenceLayerFraming request={{ layer: layer(), nonce: 1 }} onFramed={onFramed} />);
    expect(onFramed).toHaveBeenCalledTimes(1);
  });

  it('does nothing rather than throwing when the controls have not mounted', () => {
    controls!.setLookAt = undefined;
    expect(() => render(<ReferenceLayerFraming request={{ layer: layer(), nonce: 1 }} />)).not.toThrow();
    expect(setLookAt).not.toHaveBeenCalled();
  });

  it('does nothing rather than throwing for a camera with no field of view', () => {
    camera.fov = undefined;
    expect(() => render(<ReferenceLayerFraming request={{ layer: layer(), nonce: 1 }} />)).not.toThrow();
    expect(setLookAt).not.toHaveBeenCalled();
  });
});

/**
 * The camera cannot arrive somewhere it cannot render.
 *
 * `AdaptiveClipping` keeps the depth range matched to the camera's distance every frame,
 * but it runs after this effect. Without widening the range here, the first frame at the
 * new distance is drawn with the inherited far of 2000 — and for a 12064-unit layer framed
 * from 17500 units up, that frame is entirely clipped.
 */
describe('arriving inside the frustum', () => {
  it('widens the depth range before moving the camera', () => {
    const order: string[] = [];
    (camera.updateProjectionMatrix as ReturnType<typeof vi.fn>).mockImplementation(() => order.push('projection'));
    setLookAt.mockImplementation(() => order.push('lookAt'));

    render(<ReferenceLayerFraming request={{ layer: layer(), nonce: 1 }} />);

    expect(order).toEqual(['projection', 'lookAt']);
  });

  it('pushes far past the distance it is about to move to', () => {
    render(<ReferenceLayerFraming request={{ layer: layer(), nonce: 1 }} />);
    const distance = lastCall()[1] - lastCall()[4];

    expect(distance).toBeGreaterThan(2000);   // beyond the inherited far
    expect(camera.far).toBeGreaterThan(distance);
  });

  it('keeps the depth ratio the inherited planes had', () => {
    render(<ReferenceLayerFraming request={{ layer: layer(), nonce: 1 }} />);
    expect(camera.far / camera.near).toBeCloseTo(20000, 6);
  });

  it('leaves the inherited planes alone for a layer that fits inside them', () => {
    // A small layer framed from well under 500 units needs no change at all.
    render(<ReferenceLayerFraming request={{ layer: layer({ source_width_px: 60, source_height_px: 45, world_units_per_pixel: 1 }), nonce: 1 }} />);
    expect(camera.near).toBe(0.1);
    expect(camera.far).toBe(2000);
  });
});
