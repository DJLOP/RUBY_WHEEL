/**
 * Render preparation for the canonical overlay (plan §7.2, WP4): merged buffers per
 * (class, state), distinct accepted/draft/proposed styles, and the fixed Y band between the
 * reference-layer stack and the inherited overlays.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  buildOverlayGeometry, overlayStyle, OVERLAY_STATES, MAX_LABELS, MAX_REFERENCE_LAYERS_BELOW,
  CANONICAL_FILL_Y, CANONICAL_LINE_Y, CANONICAL_POINT_Y, CANONICAL_BAND_CEILING_Y, CANONICAL_RENDER_ORDER,
  CANONICAL_NO_RAYCAST, type OverlayFeature,
} from '../overlay';
import { REFERENCE_LAYER_Y, REFERENCE_LAYER_Y_STEP } from '../../referenceLayers/calibration';
import type { FeatureClass, LifecycleState } from '../types';

const sq = (x: number, z: number, s: number) => [{ x, z }, { x: x + s, z }, { x: x + s, z: z + s }, { x, z: z + s }];

let nextId = 1;
const feature = (over: Partial<OverlayFeature> = {}): OverlayFeature => ({
  id: nextId++,
  feature_class: 'land',
  geometry_type: 'polygon',
  geometry: { outer: sq(0, 0, 10), holes: [] },
  lifecycle_state: 'accepted',
  ...over,
});

describe('merged buffers', () => {
  it('draws hundreds of islands with one fill and one outline buffer, not one per island', () => {
    const islands = Array.from({ length: 500 }, (_, i) => feature({ geometry: { outer: sq(i * 20, 0, 10), holes: [] } }));
    const g = buildOverlayGeometry(islands);
    expect(g.fills.map(b => b.key)).toEqual(['land|accepted']);
    expect(g.lines.map(b => b.key)).toEqual(['land|accepted']);
    expect(g.fills[0].indexCount).toBe(500 * 2 * 3); // two triangles per square
    expect(g.lines[0].positions.length).toBe(500 * 4 * 2 * 3); // four segments, two endpoints each
  });

  it('keeps the draw-object count bounded by classes × states, whatever the feature count', () => {
    const classes: FeatureClass[] = ['land', 'water', 'protected_region', 'site', 'scope_boundary'];
    const many: OverlayFeature[] = [];
    for (let k = 0; k < 40; k++) {
      for (const c of classes) for (const s of OVERLAY_STATES) many.push(feature({ feature_class: c, lifecycle_state: s, geometry: { outer: sq(k * 20, 0, 10), holes: [] } }));
      many.push(feature({ feature_class: 'route', geometry_type: 'linestring', geometry: [{ x: k, z: 0 }, { x: k, z: 5 }] }));
      many.push(feature({ feature_class: 'site', geometry_type: 'point', geometry: { x: k, z: 1 } }));
    }
    const g = buildOverlayGeometry(many);
    const objects = g.fills.length + g.lines.length + g.points.length;
    expect(objects).toBeLessThanOrEqual(6 * 3 * 3);
    // Scope boundaries and routes are outlines only.
    expect(g.fills.some(b => b.featureClass === 'scope_boundary' || b.featureClass === 'route')).toBe(false);
  });

  it('separates accepted, draft and proposed features into their own buffers', () => {
    const g = buildOverlayGeometry((['accepted', 'draft', 'proposed'] as LifecycleState[]).map(s => feature({ lifecycle_state: s })));
    expect(g.lines.map(b => b.key)).toEqual(['land|accepted', 'land|draft', 'land|proposed']);
  });

  it('never draws retired canon, and skips unreadable geometry without failing the rest', () => {
    const good = feature();
    const retired = feature({ lifecycle_state: 'retired' });
    const broken = feature({ geometry: { outer: [{ x: 0 }] } });
    const mismatched = feature({ geometry_type: 'point', geometry: { outer: sq(0, 0, 1), holes: [] } });
    const g = buildOverlayGeometry([good, retired, broken, mismatched]);
    expect(g.fills[0].indexCount).toBe(6);
    expect(g.skipped).toEqual([broken.id, mismatched.id]);
  });

  it('triangulates holes out of the fill, and outlines every ring', () => {
    const g = buildOverlayGeometry([feature({ geometry: { outer: sq(0, 0, 10), holes: [sq(4, 4, 2).reverse()] } })]);
    expect(g.fills[0].indexCount / 3).toBe(8);
    expect(g.lines[0].positions.length / 6).toBe(8); // 4 outer + 4 hole segments
    // Everything lies on the plane; the layer lifts the whole buffer into its band.
    const ys = g.fills[0].positions.filter((_, i) => i % 3 === 1);
    expect(new Set(ys)).toEqual(new Set([0]));
  });

  it('outlines an open linestring without closing it, and collects points', () => {
    const g = buildOverlayGeometry([
      feature({ feature_class: 'route', geometry_type: 'linestring', geometry: [{ x: 0, z: 0 }, { x: 5, z: 0 }, { x: 5, z: 5 }] }),
      feature({ feature_class: 'site', geometry_type: 'point', geometry: { x: 3, z: 4 } }),
    ]);
    expect(g.lines.find(b => b.featureClass === 'route')!.positions.length / 6).toBe(2);
    expect([...g.points[0].positions]).toEqual([3, 0, 4]);
  });
});

describe('accepted / draft / proposed distinction', () => {
  it('draws accepted canon solid and unlabelled', () => {
    const s = overlayStyle('land', 'accepted');
    expect(s.dashed).toBe(false);
    expect(s.label).toBeNull();
  });

  it('draws drafts dashed, faint and labelled DRAFT', () => {
    const accepted = overlayStyle('land', 'accepted');
    const draft = overlayStyle('land', 'draft');
    expect(draft.dashed).toBe(true);
    expect(draft.fillOpacity).toBeLessThan(accepted.fillOpacity);
    expect(draft.label).toBe('DRAFT');
  });

  it('draws proposals in their own dashed colour, labelled as generated', () => {
    const draft = overlayStyle('water', 'draft');
    const proposed = overlayStyle('water', 'proposed');
    expect(proposed.dashed).toBe(true);
    expect(proposed.lineColor).not.toBe(draft.lineColor);
    expect(proposed.lineColor).not.toBe(overlayStyle('water', 'accepted').lineColor);
    expect(proposed.label).toBe('PROPOSED · generated');
  });

  it('labels each draft and proposal, never accepted canon, up to a cap', () => {
    const g = buildOverlayGeometry([
      feature(), feature({ lifecycle_state: 'draft' }), feature({ lifecycle_state: 'proposed', geometry: { outer: sq(20, 0, 10), holes: [] } }),
    ]);
    expect(g.labels.map(l => [l.state, l.text])).toEqual([['draft', 'DRAFT'], ['proposed', 'PROPOSED · generated']]);
    expect(g.labels[1]).toMatchObject({ x: 25, z: 5 });

    const drafts = Array.from({ length: MAX_LABELS + 10 }, () => feature({ lifecycle_state: 'draft' }));
    expect(buildOverlayGeometry(drafts).labels).toHaveLength(MAX_LABELS);
  });
});

describe('Y band', () => {
  it('sits above a full reference-layer stack', () => {
    const topReference = REFERENCE_LAYER_Y + (MAX_REFERENCE_LAYERS_BELOW - 1) * REFERENCE_LAYER_Y_STEP;
    expect(CANONICAL_FILL_Y).toBeGreaterThan(topReference);
  });

  it('orders fill < outline < point, all below the ceiling', () => {
    expect(CANONICAL_FILL_Y).toBeLessThan(CANONICAL_LINE_Y);
    expect(CANONICAL_LINE_Y).toBeLessThan(CANONICAL_POINT_Y);
    expect(CANONICAL_POINT_Y).toBeLessThan(CANONICAL_BAND_CEILING_Y);
  });

  it('keeps its ceiling at or below the lowest inherited overlay', () => {
    const src = (rel: string) => readFileSync(resolve(__dirname, '../../..', rel), 'utf8');
    // The city reference lines are the lowest inherited overlay above the plane.
    expect(src('App.tsx')).toMatch(/name="city-ref-lines" position=\{\[0, 0\.01, 0\]\}/);
    expect(CANONICAL_BAND_CEILING_Y).toBeLessThanOrEqual(0.01);
    const sidewalkY = Number(src('components/Sidewalks.tsx').match(/const SIDEWALK_Y = ([0-9.]+)/)![1]);
    expect(CANONICAL_BAND_CEILING_Y).toBeLessThan(sidewalkY);
  });

  it('draws after the reference rasters and is never a raycast target', () => {
    expect(CANONICAL_RENDER_ORDER).toBeGreaterThan(-1000);
    expect(CANONICAL_NO_RAYCAST()).toBeNull();
  });
});
