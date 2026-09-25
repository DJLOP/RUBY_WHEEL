/**
 * Selecting accepted land on the map (WP6): the one reusable multi-selection of islands.
 *
 * An accepted `land` polygon already *is* an island (plan §3.5) — there is no separate
 * island record, flag or "declare island" step — so this selects accepted land features
 * directly. Scope membership editing uses it now; later generation UI ("generate this
 * island group") is meant to reuse it rather than invent a second selection system.
 *
 * Pure: no React, Three.js, network or reference-layer imports. The in-scene tool
 * (LandSelectionTool.tsx) and the manager read one selection through a tiny external
 * store, like the tracing session.
 *
 * Nothing here persists anything, and nothing here is membership. A selection is local
 * working state; only an explicit scope edit + accept turns it into persisted, explicit
 * membership. "Select land inside a boundary" is a one-off spatial *proposal* of which
 * islands to select — it never becomes a rule that ties membership to geometry.
 */

import type { BBox, CanonicalFeature, CanonicalPolygon, WorldXZ } from './types';
import { locateInRing } from './constraints';
import { polygonArea } from './geometry';

/** A "select land inside this boundary" result, shown for confirmation before anything uses it. */
export interface InsideProposal {
  /** The scope whose boundary was used; the proposal is only ever about that scope. */
  scopeId: number;
  boundaryFeatureId: number;
  /** Accepted land wholly inside the boundary: the proposed selection. */
  inside: number[];
  /** Accepted land that crosses the boundary: listed so the GM can decide, never proposed. */
  straddling: number[];
}

export interface LandSelectionState {
  /** Map clicks select land (the scene is in the canonical view, tracing is not). */
  picking: boolean;
  /** Selected accepted land feature ids, ascending. */
  ids: number[];
  proposal: InsideProposal | null;
  message: string | null;
}

export const EMPTY_SELECTION: LandSelectionState = { picking: false, ids: [], proposal: null, message: null };

export interface LandSelectionStore {
  getState: () => LandSelectionState;
  subscribe: (listener: () => void) => () => void;
  update: (edit: (s: LandSelectionState) => LandSelectionState) => void;
}

export function createLandSelection(initial: LandSelectionState = EMPTY_SELECTION): LandSelectionStore {
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

// ── edits ────────────────────────────────────────────────────────────────────

const sorted = (ids: Iterable<number>) => [...new Set(ids)].sort((a, b) => a - b);

export const setSelection = (s: LandSelectionState, ids: Iterable<number>): LandSelectionState =>
  ({ ...s, ids: sorted(ids), message: null });

export const toggleLand = (s: LandSelectionState, id: number): LandSelectionState =>
  setSelection(s, s.ids.includes(id) ? s.ids.filter(x => x !== id) : [...s.ids, id]);

export const addLand = (s: LandSelectionState, ids: Iterable<number>): LandSelectionState =>
  setSelection(s, [...s.ids, ...ids]);

export const removeLand = (s: LandSelectionState, ids: Iterable<number>): LandSelectionState => {
  const drop = new Set(ids);
  return setSelection(s, s.ids.filter(x => !drop.has(x)));
};

export const clearSelection = (s: LandSelectionState): LandSelectionState => ({ ...s, ids: [], proposal: null, message: null });

/** Keep only ids that are still selectable (accepted land), e.g. after a refresh. */
export const pruneSelection = (s: LandSelectionState, selectable: Set<number>): LandSelectionState => {
  const ids = s.ids.filter(id => selectable.has(id));
  return ids.length === s.ids.length ? s : { ...s, ids };
};

// ── what can be selected ─────────────────────────────────────────────────────

/** Accepted land polygons — every one is an island; nothing else needs declaring. */
export const selectableLand = (features: CanonicalFeature[]): CanonicalFeature[] =>
  features.filter(f => f.feature_class === 'land' && f.lifecycle_state === 'accepted' && f.geometry_type === 'polygon');

const inBBox = (p: WorldXZ, b: BBox) => p.x >= b.min_x && p.x <= b.max_x && p.z >= b.min_z && p.z <= b.max_z;

/** Where a point sits in a polygon (holes excluded). */
function locate(p: WorldXZ, poly: CanonicalPolygon): 'inside' | 'boundary' | 'outside' {
  const outer = locateInRing(p.x, p.z, poly.outer);
  if (outer !== 'inside') return outer;
  for (const hole of poly.holes ?? []) {
    const h = locateInRing(p.x, p.z, hole);
    if (h === 'inside') return 'outside';
    if (h === 'boundary') return 'boundary';
  }
  return 'inside';
}

/**
 * The land under a map click. Accepted land never overlaps, so at most one polygon
 * contains a point; the smallest is chosen anyway, so an inconsistent working set still
 * picks something predictable.
 */
export function landAt(land: CanonicalFeature[], p: WorldXZ): CanonicalFeature | null {
  let best: CanonicalFeature | null = null;
  let bestArea = Infinity;
  for (const f of land) {
    if (!inBBox(p, f.bbox)) continue;
    const poly = f.geometry as CanonicalPolygon;
    if (locate(p, poly) === 'outside') continue;
    const area = polygonArea(poly.outer, poly.holes ?? []);
    if (area < bestArea) { best = f; bestArea = area; }
  }
  return best;
}

/** Box ("window") selection: land whose whole extent lies inside the dragged rectangle. */
export function landInBox(land: CanonicalFeature[], a: WorldXZ, b: WorldXZ): number[] {
  const box = { min_x: Math.min(a.x, b.x), max_x: Math.max(a.x, b.x), min_z: Math.min(a.z, b.z), max_z: Math.max(a.z, b.z) };
  return land.filter(f => f.bbox.min_x >= box.min_x && f.bbox.max_x <= box.max_x
    && f.bbox.min_z >= box.min_z && f.bbox.max_z <= box.max_z).map(f => f.id).sort((x, y) => x - y);
}

const bboxesOverlap = (a: BBox, b: BBox) => a.min_x <= b.max_x && b.min_x <= a.max_x && a.min_z <= b.max_z && b.min_z <= a.max_z;

const orient = (a: WorldXZ, b: WorldXZ, c: WorldXZ) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
/** Two segments cross at a single interior point (touching or collinear overlap does not count). */
const properlyCross = (a: WorldXZ, b: WorldXZ, c: WorldXZ, d: WorldXZ) => {
  const o1 = orient(a, b, c); const o2 = orient(a, b, d); const o3 = orient(c, d, a); const o4 = orient(c, d, b);
  return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0));
};

const ringEdges = (ring: WorldXZ[]) => ring.map((p, i) => [p, ring[(i + 1) % ring.length]] as const);

/**
 * Accepted land inside a boundary polygon, as a proposal: which islands lie wholly inside,
 * and which cross it. Touching the boundary (a boundary snapped to a shoreline) still
 * counts as inside. Predicates only, no clipping (plan §2.3).
 *
 * This answers "which islands would I select?" once, now. It is not membership, and it is
 * not a rule: moving the boundary later reassigns nothing.
 */
export function landInsideBoundary(land: CanonicalFeature[], boundary: CanonicalPolygon, boundaryBBox: BBox):
  { inside: number[]; straddling: number[] } {
  const inside: number[] = [];
  const straddling: number[] = [];
  const boundaryRings = [boundary.outer, ...(boundary.holes ?? [])];
  for (const f of land) {
    if (!bboxesOverlap(f.bbox, boundaryBBox)) continue;
    const poly = f.geometry as CanonicalPolygon;
    const ring = poly.outer;
    const samples = [...ring, ...ringEdges(ring).map(([a, b]) => ({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }))];
    const where = samples.map(p => locate(p, boundary));
    const allIn = where.every(w => w !== 'outside');
    const anyStrictlyIn = where.some(w => w === 'inside');
    // A boundary vertex strictly inside the island means the boundary cuts into it.
    const boundaryCuts = boundaryRings.some(r => r.some(p => inBBox(p, f.bbox) && locate(p, poly) === 'inside'));
    const crosses = !boundaryCuts && ringEdges(ring).some(([a, b]) =>
      boundaryRings.some(r => ringEdges(r).some(([c, d]) => properlyCross(a, b, c, d))));
    if (allIn && !boundaryCuts && !crosses) inside.push(f.id);
    else if (anyStrictlyIn || boundaryCuts || crosses) straddling.push(f.id);
  }
  return { inside: inside.sort((a, b) => a - b), straddling: straddling.sort((a, b) => a - b) };
}
