/**
 * What the world scene actually draws for a reference layer.
 *
 * Three things matter and none of them is visual. A hidden layer draws nothing. A layer
 * whose texture fails to load takes only itself out, not the Canvas. And every texture is
 * released on unmount — a texture holds a GPU allocation that garbage collection does not
 * reach, so a leak here is one upload per visit to the world view.
 *
 * There is no Three.js renderer in jsdom, so this checks the element tree React produces
 * and the loader calls the component makes. The transform itself is arithmetic and is
 * covered in calibration.test.ts.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { act } from 'react';

type LoadArgs = {
  url: string;
  onLoad: (t: any) => void;
  onError: (e: any) => void;
};

const loads: LoadArgs[] = [];
const disposed: any[] = [];

vi.mock('three', async () => {
  const actual = await vi.importActual<any>('three');
  class FakeTextureLoader {
    load(url: string, onLoad: any, _onProgress: any, onError: any) {
      loads.push({ url, onLoad, onError });
    }
  }
  return { ...actual, TextureLoader: FakeTextureLoader };
});

import { ReferenceLayers } from '../ReferenceLayers';
import { referenceMaterialProps } from '../calibration';
import type { ReferenceLayer } from '../types';

const makeTexture = (tag: string) => ({ tag, colorSpace: '', dispose: vi.fn(() => disposed.push(tag)) });

const layer = (over: Partial<ReferenceLayer> = {}): ReferenceLayer => ({
  id: 1,
  name: 'Imperial City',
  asset_id: 1,
  asset_url: '/uploads/reference_layers/aaa.png',
  original_name: 'city.png',
  format: 'png',
  source_width_px: 6032,
  source_height_px: 4584,
  world_center_x: 0,
  world_center_z: 0,
  world_units_per_pixel: 0.5,
  rotation_rad: 0,
  opacity: 1,
  is_visible: true,
  is_locked: false,
  provenance: 'imported',
  replacement_state: 'non_replaceable',
  ...over,
});

/** Let every pending texture load succeed. */
const resolveAll = () => act(() => {
  loads.forEach((l, i) => l.onLoad(makeTexture(`tex-${i}`)));
});

beforeEach(() => { loads.length = 0; disposed.length = 0; });
afterEach(() => vi.clearAllMocks());

describe('ReferenceLayers', () => {
  it('renders nothing at all when there are no layers', () => {
    const { container } = render(<ReferenceLayers layers={[]} />);
    expect(container.querySelector('group')).toBeNull();
    expect(loads).toHaveLength(0);
  });

  it('loads each visible layer\'s asset exactly once', () => {
    render(<ReferenceLayers layers={[layer(), layer({ id: 2, asset_url: '/uploads/reference_layers/bbb.jpg' })]} />);
    expect(loads.map(l => l.url)).toEqual([
      '/uploads/reference_layers/aaa.png',
      '/uploads/reference_layers/bbb.jpg',
    ]);
  });

  // Hiding a layer is a display control, so it must cost nothing: no plane, and no texture
  // fetched for something nobody can see.
  it('neither draws nor loads a hidden layer', () => {
    const { container } = render(
      <ReferenceLayers layers={[layer({ is_visible: false }), layer({ id: 2, asset_url: '/b.png' })]} />
    );
    resolveAll();
    expect(loads.map(l => l.url)).toEqual(['/b.png']);
    expect(container.querySelectorAll('mesh')).toHaveLength(1);
    expect(container.querySelector('[name="reference-layer-1"]')).toBeNull();
    expect(container.querySelector('[name="reference-layer-2"]')).not.toBeNull();
  });

  it('draws nothing until a texture has arrived', () => {
    const { container } = render(<ReferenceLayers layers={[layer()]} />);
    expect(container.querySelectorAll('mesh')).toHaveLength(0);
    resolveAll();
    expect(container.querySelectorAll('mesh')).toHaveLength(1);
  });

  it('sizes the plane from the persisted source dimensions and scale', () => {
    const { container } = render(<ReferenceLayers layers={[layer()]} />);
    resolveAll();
    // 6032 x 4584 source at 0.5 world units per pixel.
    expect(container.querySelector('planeGeometry')?.getAttribute('args')).toBe('3016,2292');
  });

  it('places the plane at the persisted world centre', () => {
    const { container } = render(
      <ReferenceLayers layers={[layer({ world_center_x: -120, world_center_z: 45 })]} />
    );
    resolveAll();
    const position = container.querySelector('[name="reference-layer-1"]')?.getAttribute('position');
    expect(position?.startsWith('-120,')).toBe(true);
    expect(position?.endsWith(',45')).toBe(true);
  });

  it('passes each layer\'s opacity to its own material', () => {
    const { container } = render(
      <ReferenceLayers layers={[layer({ opacity: 0.35 }), layer({ id: 2, asset_url: '/b.png', opacity: 1 })]} />
    );
    resolveAll();
    const opacities = [...container.querySelectorAll('meshBasicMaterial')].map(m => m.getAttribute('opacity'));
    expect(opacities).toEqual(['0.35', '1']);
  });

  it('keeps the material out of the depth buffer so overlays composite predictably', () => {
    // React drops false-valued props on an unknown element, so `depthWrite` never reaches
    // the DOM. The derived object is asserted directly; the opacity test above proves the
    // component actually spreads it onto the material.
    expect(referenceMaterialProps(layer({ opacity: 0.4 }))).toEqual({
      toneMapped: false,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
    });
  });

  // Without this a 3016-unit plane is a click target covering the whole city, and tracing
  // roads over the drawing stops working.
  it('renders planes that raycasting cannot hit', () => {
    const { container } = render(<ReferenceLayers layers={[layer()]} />);
    resolveAll();
    // `raycast` is a function prop, so it does not reach the DOM; `renderOrder` comes from
    // the same derived object, which is what proves that object was spread onto the mesh.
    expect(container.querySelector('[name="reference-layer-1"]')?.getAttribute('renderOrder')).toBe('-1000');
  });

  it('attaches no pointer handlers to a layer', () => {
    const { container } = render(<ReferenceLayers layers={[layer()]} />);
    resolveAll();
    const mesh = container.querySelector('mesh')!;
    for (const attr of ['onpointerdown', 'onclick', 'onpointerover']) {
      expect(mesh.getAttribute(attr)).toBeNull();
    }
  });

  it('keeps a failed texture load to the layer that failed', () => {
    const { container } = render(
      <ReferenceLayers layers={[layer(), layer({ id: 2, asset_url: '/b.png' })]} />
    );
    act(() => {
      loads[0].onError(new Error('404'));
      loads[1].onLoad(makeTexture('good'));
    });
    expect(container.querySelector('[name="reference-layer-1"]')).toBeNull();
    expect(container.querySelector('[name="reference-layer-2"]')).not.toBeNull();
  });

  it('disposes every texture on unmount', () => {
    const { unmount } = render(
      <ReferenceLayers layers={[layer(), layer({ id: 2, asset_url: '/b.png' })]} />
    );
    resolveAll();
    expect(disposed).toEqual([]);
    unmount();
    expect(disposed).toEqual(['tex-0', 'tex-1']);
  });

  it('disposes the old texture when a layer\'s source changes', () => {
    const { rerender } = render(<ReferenceLayers layers={[layer()]} />);
    resolveAll();
    rerender(<ReferenceLayers layers={[layer({ asset_url: '/changed.png' })]} />);
    expect(disposed).toEqual(['tex-0']);
    expect(loads[loads.length - 1].url).toBe('/changed.png');
  });

  // A load that lands after the component is gone would otherwise leak the texture it
  // just built and set state on something unmounted.
  it('disposes a texture that arrives after unmount', () => {
    const { unmount } = render(<ReferenceLayers layers={[layer()]} />);
    const pending = loads[0];
    unmount();
    const late = makeTexture('late');
    pending.onLoad(late);
    expect(late.dispose).toHaveBeenCalled();
  });
});
