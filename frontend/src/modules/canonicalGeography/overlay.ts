/**
 * Render preparation for the canonical-geography overlay (plan §7.2, WP4).
 *
 * The city has hundreds of islands, so the steady-state overlay is not one mesh per
 * feature. Features are bucketed by (feature class, lifecycle state) and each bucket
 * becomes at most one merged fill buffer, one merged outline buffer and one merged point
 * buffer. The number of draw objects is therefore bounded by the vocabulary —
 * classes × states × 3 — however many features there are. Per-feature meshes belong only
 * to the selection being edited (WP5).
 *
 * Everything here is plain data: typed arrays and style descriptors. The component turns
 * them into Three.js objects; this file uses Three.js only for its triangulator.
 *
 * The overlay lives in a fixed Y band: above the whole reference-layer stack, so canon is
 * drawn over the evidence it was traced from, and below every inherited overlay (the city
 * reference lines at 0.01, sidewalks, water and roads above them).
 */

import { ShapeUtils, Vector2 } from 'three';
import type { CanonicalPolygon, FeatureClass, GeometryType, LifecycleState, WorldXZ } from './types';

// ── Y band ───────────────────────────────────────────────────────────────────

/** Fills sit lowest in the band, outlines above them, points on top. */
export const CANONICAL_FILL_Y = 0.008;
export const CANONICAL_LINE_Y = 0.0085;
export const CANONICAL_POINT_Y = 0.009;
/** The band's ceiling: the lowest inherited overlay (the city reference lines). */
export const CANONICAL_BAND_CEILING_Y = 0.01;
/**
 * Reference layers stack upward from 0.002 in 0.0005 steps; the band clears a stack of this
 * many layers. Pinned by a test against the reference-layer constants.
 */
export const MAX_REFERENCE_LAYERS_BELOW = 12;
/** Drawn after the reference rasters (renderOrder -1000) and before ordinary scene content. */
export const CANONICAL_RENDER_ORDER = -500;

/** A raycast that hits nothing: the overlay is never a click target (vertex handles come in WP5). */
export const CANONICAL_NO_RAYCAST = () => null;

// ── styles ───────────────────────────────────────────────────────────────────

/** The states the overlay draws. Retired canon is hidden (never fetched for the scene). */
export type OverlayState = Extract<LifecycleState, 'accepted' | 'draft' | 'proposed'>;
export const OVERLAY_STATES: readonly OverlayState[] = ['accepted', 'draft', 'proposed'];

export interface OverlayStyle {
  fillColor: string;
  /** 0 means no fill is drawn for this class/state. */
  fillOpacity: number;
  lineColor: string;
  lineOpacity: number;
  dashed: boolean;
  dashSize: number;
  gapSize: number;
  /** Shown beside non-canonical features so a draft can never be mistaken for canon. */
  label: string | null;
}

const CLASS_COLORS: Record<FeatureClass, { fill: string; line: string; fillOpacity: number }> = {
  land: { fill: '#c8b27a', line: '#f2dc9b', fillOpacity: 0.35 },
  water: { fill: '#2f7fd8', line: '#7fc0ff', fillOpacity: 0.35 },
  route: { fill: '#000000', line: '#ffffff', fillOpacity: 0 },
  protected_region: { fill: '#d8452f', line: '#ff8a70', fillOpacity: 0.25 },
  site: { fill: '#9b5de5', line: '#d2a8ff', fillOpacity: 0.35 },
  scope_boundary: { fill: '#000000', line: '#ffd23f', fillOpacity: 0 },
};

/** One colour for everything a program proposed, whatever its class. */
const PROPOSED_COLOR = '#ff3fd2';

export function overlayStyle(featureClass: FeatureClass, state: OverlayState): OverlayStyle {
  const c = CLASS_COLORS[featureClass];
  if (state === 'accepted') {
    return {
      fillColor: c.fill, fillOpacity: c.fillOpacity, lineColor: c.line, lineOpacity: 0.95,
      dashed: featureClass === 'scope_boundary', dashSize: 8, gapSize: 4, label: null,
    };
  }
  if (state === 'draft') {
    return {
      fillColor: c.fill, fillOpacity: c.fillOpacity > 0 ? 0.12 : 0, lineColor: c.line, lineOpacity: 0.9,
      dashed: true, dashSize: 4, gapSize: 3, label: 'DRAFT',
    };
  }
  return {
    fillColor: PROPOSED_COLOR, fillOpacity: c.fillOpacity > 0 ? 0.1 : 0, lineColor: PROPOSED_COLOR, lineOpacity: 0.9,
    dashed: true, dashSize: 2, gapSize: 2, label: 'PROPOSED · generated',
  };
}

// ── geometry preparation ─────────────────────────────────────────────────────

/** The fields the overlay needs from a feature record (or a query-bundle entry). */
export interface OverlayFeature {
  id: number;
  feature_class: FeatureClass;
  geometry_type: GeometryType;
  geometry: unknown;
  lifecycle_state: LifecycleState;
}

export interface FillBuffer {
  key: string;
  featureClass: FeatureClass;
  state: OverlayState;
  /** x, 0, z triples. */
  positions: Float32Array;
  indices: Uint32Array;
  indexCount: number;
}

export interface LineBuffer {
  key: string;
  featureClass: FeatureClass;
  state: OverlayState;
  /** Segment pairs (for LineSegments): x, 0, z per endpoint. */
  positions: Float32Array;
}

export interface PointBuffer {
  key: string;
  featureClass: FeatureClass;
  state: OverlayState;
  positions: Float32Array;
}

export interface OverlayLabel {
  featureId: number;
  state: Exclude<OverlayState, 'accepted'>;
  text: string;
  x: number;
  z: number;
}

export interface OverlayGeometry {
  fills: FillBuffer[];
  lines: LineBuffer[];
  points: PointBuffer[];
  /** One per draft/proposal feature, capped at MAX_LABELS. */
  labels: OverlayLabel[];
  /** Features skipped because their geometry could not be read. */
  skipped: number[];
}

/** Labels are DOM elements; past this many the styling alone marks drafts and proposals. */
export const MAX_LABELS = 64;

const isPoint = (p: unknown): p is WorldXZ =>
  !!p && typeof (p as WorldXZ).x === 'number' && typeof (p as WorldXZ).z === 'number'
  && Number.isFinite((p as WorldXZ).x) && Number.isFinite((p as WorldXZ).z);
const isRing = (r: unknown): r is WorldXZ[] => Array.isArray(r) && r.length >= 2 && r.every(isPoint);
const isPolygon = (g: unknown): g is CanonicalPolygon =>
  !!g && isRing((g as CanonicalPolygon).outer) && (g as CanonicalPolygon).outer.length >= 3
  && ((g as CanonicalPolygon).holes ?? []).every(isRing);

class Growable {
  private data: number[] = [];
  push(...v: number[]) { for (const n of v) this.data.push(n); }
  get length() { return this.data.length; }
  toFloat32() { return Float32Array.from(this.data); }
  toUint32() { return Uint32Array.from(this.data); }
}

function centroid(points: WorldXZ[]): WorldXZ {
  let x = 0;
  let z = 0;
  for (const p of points) { x += p.x; z += p.z; }
  return { x: x / points.length, z: z / points.length };
}

/**
 * Bucket features by class and state into merged buffers. Retired features and anything
 * whose geometry does not match its declared type are left out (and reported as skipped),
 * so one bad record cannot break the overlay.
 */
export function buildOverlayGeometry(features: OverlayFeature[]): OverlayGeometry {
  const fills = new Map<string, { featureClass: FeatureClass; state: OverlayState; pos: Growable; idx: Growable }>();
  const lines = new Map<string, { featureClass: FeatureClass; state: OverlayState; pos: Growable }>();
  const points = new Map<string, { featureClass: FeatureClass; state: OverlayState; pos: Growable }>();
  const labels: OverlayLabel[] = [];
  const skipped: number[] = [];

  const bucket = <T>(map: Map<string, T>, key: string, make: () => T): T => {
    let b = map.get(key);
    if (!b) { b = make(); map.set(key, b); }
    return b;
  };

  const addRingOutline = (pos: Growable, ring: WorldXZ[], closed: boolean) => {
    const n = ring.length;
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % n];
      pos.push(a.x, 0, a.z, b.x, 0, b.z);
    }
  };

  const ordered = [...features].sort((a, b) => a.id - b.id);
  for (const f of ordered) {
    if (!(OVERLAY_STATES as readonly string[]).includes(f.lifecycle_state)) continue;
    const state = f.lifecycle_state as OverlayState;
    const key = `${f.feature_class}|${state}`;
    const style = overlayStyle(f.feature_class, state);
    let anchorPoint: WorldXZ | null = null;

    if (f.geometry_type === 'polygon' && isPolygon(f.geometry)) {
      const poly = f.geometry;
      const holes = poly.holes ?? [];
      if (style.fillOpacity > 0) {
        const fill = bucket(fills, key, () => ({ featureClass: f.feature_class, state, pos: new Growable(), idx: new Growable() }));
        const base = fill.pos.length / 3;
        const contour = poly.outer.map(p => new Vector2(p.x, p.z));
        const holeVectors = holes.map(h => h.map(p => new Vector2(p.x, p.z)));
        for (const ring of [poly.outer, ...holes]) for (const p of ring) fill.pos.push(p.x, 0, p.z);
        for (const tri of ShapeUtils.triangulateShape(contour, holeVectors)) fill.idx.push(base + tri[0], base + tri[1], base + tri[2]);
      }
      const line = bucket(lines, key, () => ({ featureClass: f.feature_class, state, pos: new Growable() }));
      for (const ring of [poly.outer, ...holes]) addRingOutline(line.pos, ring, true);
      anchorPoint = centroid(poly.outer);
    } else if (f.geometry_type === 'linestring' && isRing(f.geometry)) {
      const line = bucket(lines, key, () => ({ featureClass: f.feature_class, state, pos: new Growable() }));
      addRingOutline(line.pos, f.geometry, false);
      anchorPoint = f.geometry[Math.floor(f.geometry.length / 2)];
    } else if (f.geometry_type === 'point' && isPoint(f.geometry)) {
      const pts = bucket(points, key, () => ({ featureClass: f.feature_class, state, pos: new Growable() }));
      pts.pos.push(f.geometry.x, 0, f.geometry.z);
      anchorPoint = f.geometry;
    } else {
      skipped.push(f.id);
      continue;
    }

    if (state !== 'accepted' && style.label && anchorPoint && labels.length < MAX_LABELS) {
      labels.push({ featureId: f.id, state, text: style.label, x: anchorPoint.x, z: anchorPoint.z });
    }
  }

  const byKey = <T extends { key: string }>(a: T, b: T) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return {
    fills: [...fills].map(([key, b]) => {
      const indices = b.idx.toUint32();
      return { key, featureClass: b.featureClass, state: b.state, positions: b.pos.toFloat32(), indices, indexCount: indices.length };
    }).filter(b => b.indexCount > 0).sort(byKey),
    lines: [...lines].map(([key, b]) => ({ key, featureClass: b.featureClass, state: b.state, positions: b.pos.toFloat32() }))
      .filter(b => b.positions.length > 0).sort(byKey),
    points: [...points].map(([key, b]) => ({ key, featureClass: b.featureClass, state: b.state, positions: b.pos.toFloat32() })).sort(byKey),
    labels,
    skipped,
  };
}
