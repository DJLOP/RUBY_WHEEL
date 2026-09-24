/**
 * What the world scene draws for canonical geography (WP4).
 *
 * There is no WebGL renderer in jsdom, so this checks the element tree React produces —
 * names, band positions, materials, labels — plus geometry disposal. drei's `Html` needs a
 * Canvas, so it is replaced by a plain element that keeps its children.
 */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import * as THREE from 'three';

vi.mock('@react-three/drei', () => ({
  Html: ({ children, position }: { children: React.ReactNode; position: number[] }) =>
    <div data-html="" data-position={position.join(',')}>{children}</div>,
}));

import { CanonicalGeographyLayer } from '../CanonicalGeographyLayer';
import { CANONICAL_FILL_Y, CANONICAL_LINE_Y, CANONICAL_POINT_Y, type OverlayFeature } from '../overlay';

const sq = (x: number, z: number, s: number) => [{ x, z }, { x: x + s, z }, { x: x + s, z: z + s }, { x, z: z + s }];
const land = (id: number, state: OverlayFeature['lifecycle_state'] = 'accepted', x = 0): OverlayFeature => ({
  id, feature_class: 'land', geometry_type: 'polygon', geometry: { outer: sq(x, 0, 10), holes: [] }, lifecycle_state: state,
});

afterEach(() => vi.restoreAllMocks());

describe('CanonicalGeographyLayer', () => {
  it('draws nothing while the overlay is hidden', () => {
    const { container } = render(<CanonicalGeographyLayer features={[land(1)]} visible={false} />);
    expect(container.querySelector('[name="canonical-geography"]')).toBeNull();
  });

  it('draws an empty group when there is no canon yet', () => {
    const { container } = render(<CanonicalGeographyLayer features={[]} visible />);
    expect(container.querySelector('[name="canonical-geography"]')).not.toBeNull();
    expect(container.querySelectorAll('mesh, lineSegments, points')).toHaveLength(0);
  });

  it('places fills, outlines and points in the fixed band', () => {
    const { container } = render(<CanonicalGeographyLayer visible features={[
      land(1),
      { id: 2, feature_class: 'site', geometry_type: 'point', geometry: { x: 1, z: 1 }, lifecycle_state: 'accepted' },
    ]} />);
    expect(container.querySelector('[name="canonical-fill-land|accepted"]')!.getAttribute('position')).toBe(`0,${CANONICAL_FILL_Y},0`);
    expect(container.querySelector('[name="canonical-line-land|accepted"]')!.getAttribute('position')).toBe(`0,${CANONICAL_LINE_Y},0`);
    expect(container.querySelector('[name="canonical-points-site|accepted"]')!.getAttribute('position')).toBe(`0,${CANONICAL_POINT_Y},0`);
    expect(container.querySelector('[name="canonical-fill-land|accepted"]')!.getAttribute('renderOrder')).toBe('-500');
  });

  it('draws accepted outlines solid, draft outlines dashed, and proposals dashed in their own colour', () => {
    const { container } = render(<CanonicalGeographyLayer visible features={[land(1), land(2, 'draft', 20), land(3, 'proposed', 40)]} />);
    const material = (key: string) => container.querySelector(`[name="canonical-line-${key}"]`)!.firstElementChild!;
    expect(material('land|accepted').tagName.toLowerCase()).toBe('linebasicmaterial');
    expect(material('land|draft').tagName.toLowerCase()).toBe('linedashedmaterial');
    expect(material('land|proposed').tagName.toLowerCase()).toBe('linedashedmaterial');
    expect(material('land|proposed').getAttribute('color')).not.toBe(material('land|draft').getAttribute('color'));
  });

  it('labels drafts and proposals, and not accepted canon', () => {
    const { container } = render(<CanonicalGeographyLayer visible features={[land(1), land(2, 'draft', 20), land(3, 'proposed', 40)]} />);
    const labels = [...container.querySelectorAll('.canonical-label')].map(l => [l.getAttribute('data-feature-id'), l.textContent]);
    expect(labels).toEqual([['2', 'DRAFT'], ['3', 'PROPOSED · generated']]);
  });

  it('keeps the object count flat as islands are added', () => {
    const few = render(<CanonicalGeographyLayer visible features={[land(1)]} />);
    const fewCount = few.container.querySelectorAll('mesh, lineSegments, points').length;
    few.unmount();
    const many = render(<CanonicalGeographyLayer visible features={Array.from({ length: 300 }, (_, i) => land(i + 1, 'accepted', i * 20))} />);
    expect(many.container.querySelectorAll('mesh, lineSegments, points')).toHaveLength(fewCount);
  });

  it('attaches no pointer handlers', () => {
    const { container } = render(<CanonicalGeographyLayer visible features={[land(1), land(2, 'draft', 20)]} />);
    for (const el of container.querySelectorAll('mesh, lineSegments, points')) {
      for (const attr of ['onpointerdown', 'onclick', 'onpointerover', 'onpointermove']) expect(el.getAttribute(attr)).toBeNull();
    }
  });

  it('releases its buffer geometries on unmount and when the features change', () => {
    const dispose = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const { rerender, unmount } = render(<CanonicalGeographyLayer visible features={[land(1)]} />);
    expect(dispose).not.toHaveBeenCalled();
    rerender(<CanonicalGeographyLayer visible features={[land(1), land(2, 'accepted', 20)]} />);
    expect(dispose).toHaveBeenCalledTimes(2); // the previous fill and outline
    unmount();
    expect(dispose).toHaveBeenCalledTimes(4);
  });
});
