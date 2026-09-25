/**
 * Click-to-inspect on the map (WP6 remediation): which canonical features lie at a
 * clicked ground point.
 *
 * Pure: no React, Three.js, network or reference-layer imports. The steady-state overlay
 * stays merged and non-raycast (WP4); a click is resolved here from its Y=0 world point
 * against feature geometry, never by raycasting render meshes.
 *
 * Hit rules:
 * - points and lines: within `toleranceWu` (the scene converts a few screen pixels);
 * - land, water, protected regions and polygon sites: inside or on the boundary;
 * - scope boundaries: near their edge only. A district is large and its interior is where
 *   islands, routes and parts are clicked; its boundary line is what selects it.
 *
 * Candidates are ordered most specific first — points, lines, boundary edges, then
 * polygons from smallest to largest — so the chooser is deterministic.
 */

import type { CanonicalFeature, CanonicalPolygon, WorldXZ } from './types';
import { locateInRing } from './constraints';
import { polygonArea } from './geometry';

export interface PickRequest {
  /** Increments per click, so the same result twice is still two requests. */
  nonce: number;
  at: WorldXZ;
  /** Candidate feature ids, most specific first. Empty: nothing selectable here. */
  ids: number[];
}

export interface MapPickState {
  /** Map clicks inspect canonical geometry (the manager's SELECT ON MAP mode). */
  inspecting: boolean;
  request: PickRequest | null;
  /** The feature the inspector shows, outlined in the scene. */
  highlightId: number | null;
  /** A row hovered or focused in the context pane, outlined while hovered. */
  hoverId: number | null;
  /**
   * The selected scope drawn in the scene: its extent as a translucent overlay, and the
   * accepted land it spatially holds — derived display only, never membership.
   */
  scopeOverlay: ScopeOverlay | null;
}

export interface ScopeOverlay {
  scopeId: number;
  /** The extent as a set of polygons (never a union). */
  extent: CanonicalPolygon[];
  /** The scope's own boundary feature, emphasized, if it has one. */
  boundaryFeatureId: number | null;
  /** Land wholly inside the extent, and land on or crossing its boundary. */
  inside: number[];
  crossing: number[];
}

export const INITIAL_MAP_PICK: MapPickState = { inspecting: true, request: null, highlightId: null, hoverId: null, scopeOverlay: null };

export interface MapPickStore {
  getState: () => MapPickState;
  subscribe: (listener: () => void) => () => void;
  update: (edit: (s: MapPickState) => MapPickState) => void;
}

export function createMapPickStore(initial: MapPickState = INITIAL_MAP_PICK): MapPickStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    update: (edit) => {
      const next = edit(state);
      if (next === state) return;
      state = next;
      for (const l of [...listeners]) l();
    },
  };
}

export const requestPick = (s: MapPickState, at: WorldXZ, ids: number[]): MapPickState =>
  ({ ...s, request: { nonce: (s.request?.nonce ?? 0) + 1, at, ids } });

// ── hit testing ──────────────────────────────────────────────────────────────

function distanceToSegment(p: WorldXZ, a: WorldXZ, b: WorldXZ): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
}

const nearPath = (p: WorldXZ, pts: WorldXZ[], closed: boolean, tol: number) => {
  const n = pts.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) if (distanceToSegment(p, pts[i], pts[(i + 1) % n]) <= tol) return true;
  return false;
};

function insidePolygon(p: WorldXZ, poly: CanonicalPolygon): boolean {
  const outer = locateInRing(p.x, p.z, poly.outer);
  if (outer === 'outside') return false;
  if (outer === 'boundary') return true;
  return !(poly.holes ?? []).some(h => locateInRing(p.x, p.z, h) === 'inside');
}

const nearBBox = (p: WorldXZ, f: CanonicalFeature, tol: number) =>
  p.x >= f.bbox.min_x - tol && p.x <= f.bbox.max_x + tol && p.z >= f.bbox.min_z - tol && p.z <= f.bbox.max_z + tol;

/** Selectable: visible working-set and canonical geometry — never retired rows. */
export const pickable = (f: CanonicalFeature) => f.lifecycle_state !== 'retired';

/** Canonical features at a clicked world point, most specific first. */
export function featuresAt(features: CanonicalFeature[], p: WorldXZ, toleranceWu: number): number[] {
  const hits: { id: number; rank: number; size: number }[] = [];
  for (const f of features) {
    if (!pickable(f) || !nearBBox(p, f, toleranceWu)) continue;
    if (f.geometry_type === 'point') {
      const g = f.geometry as WorldXZ;
      if (Math.hypot(p.x - g.x, p.z - g.z) <= toleranceWu) hits.push({ id: f.id, rank: 0, size: 0 });
    } else if (f.geometry_type === 'linestring') {
      if (nearPath(p, f.geometry as WorldXZ[], false, toleranceWu)) hits.push({ id: f.id, rank: 1, size: 0 });
    } else {
      const poly = f.geometry as CanonicalPolygon;
      if (f.feature_class === 'scope_boundary') {
        if (nearPath(p, poly.outer, true, toleranceWu)) hits.push({ id: f.id, rank: 2, size: 0 });
      } else if (insidePolygon(p, poly)) {
        hits.push({ id: f.id, rank: 3, size: polygonArea(poly.outer, poly.holes ?? []) });
      }
    }
  }
  return hits.sort((a, b) => a.rank - b.rank || a.size - b.size || a.id - b.id).map(h => h.id);
}
