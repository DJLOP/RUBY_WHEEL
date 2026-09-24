/**
 * The tracing session (plan §7.2, WP5): the geometry being traced or edited, as plain data
 * and pure edits, plus snapping and the click-versus-drag rule.
 *
 * Pure: no React, Three.js, network or reference-layer imports. The in-scene tool
 * (TracingTool.tsx) and the manager panel both read one session through a tiny external
 * store, so pointer movement updates the readout without re-rendering the whole app.
 *
 * Nothing here persists anything. A session is local working state until the manager
 * saves it as a draft; saving never accepts.
 */

import type { GeometryType, WorldXZ } from './types';
import {
  circleFromCenter, circleThroughPoints, closestOnSegment, distance, ellipseFromPoints, rectangleFromPoints,
  roundPoint, simplifyLine, simplifyRing, type Construction, type Constructed,
} from './geometry';

// ── click versus drag ───────────────────────────────────────────────────────

/**
 * Screen pixels the pointer may move between press and release and still count as a
 * click. More than this is a drag, which belongs to the inherited left-button camera truck.
 */
export const CLICK_MAX_MOVE_PX = 5;

export const isClick = (down: { x: number; y: number }, up: { x: number; y: number }, threshold = CLICK_MAX_MOVE_PX) =>
  Math.hypot(up.x - down.x, up.y - down.y) <= threshold;

/** Snap reach, in screen pixels; converted to world units at the current zoom. */
export const SNAP_RADIUS_PX = 10;

// ── session state ───────────────────────────────────────────────────────────

export type TraceMode = 'vertex' | 'circle_3pt' | 'circle_center' | 'ellipse' | 'rect';

/** Clicks each constructor needs before it produces a ring. */
export const CONSTRUCTOR_CLICKS: Record<Exclude<TraceMode, 'vertex'>, number> = {
  circle_3pt: 3, circle_center: 2, ellipse: 3, rect: 3,
};

export type SnapKind = 'vertex' | 'edge';

export interface TraceState {
  active: boolean;
  /** The saved feature being edited, if any; excluded from its own snap targets. */
  featureId: number | null;
  geometryType: GeometryType;
  /** Outer ring (stored open) for a polygon, the line for a linestring, one entry for a point. */
  vertices: WorldXZ[];
  /** A polygon ring is complete, or a linestring is a closed loop. */
  closed: boolean;
  /** Holes of an edited polygon, kept as they were; the tool edits the outer ring only. */
  holes: WorldXZ[][];
  /** Parameters of the normalization aid that produced `vertices`; cleared by any manual edit. */
  construction: Construction | null;
  mode: TraceMode;
  constructionPoints: WorldXZ[];
  selectedVertex: number | null;
  hover: WorldXZ | null;
  hoverSnap: SnapKind | null;
  snapping: boolean;
  /** Last refusal or notice, in words. */
  message: string | null;
}

export const IDLE_TRACE: TraceState = {
  active: false, featureId: null, geometryType: 'polygon', vertices: [], closed: false, holes: [],
  construction: null, mode: 'vertex', constructionPoints: [], selectedVertex: null,
  hover: null, hoverSnap: null, snapping: true, message: null,
};

export interface TraceStart {
  geometryType: GeometryType;
  featureId?: number | null;
  vertices?: WorldXZ[];
  closed?: boolean;
  holes?: WorldXZ[][];
  construction?: Construction | null;
}

/** Start a session, optionally from saved geometry (polygon outer ring, line, or point). */
export function beginTrace(prev: TraceState, start: TraceStart): TraceState {
  return {
    ...IDLE_TRACE,
    snapping: prev.snapping,
    active: true,
    featureId: start.featureId ?? null,
    geometryType: start.geometryType,
    vertices: (start.vertices ?? []).map(p => ({ x: p.x, z: p.z })),
    closed: start.closed ?? false,
    holes: start.holes ?? [],
    construction: start.construction ?? null,
  };
}

/** Session start values for a saved feature's geometry. */
export function traceStartFromGeometry(geometryType: GeometryType, geometry: unknown, featureId: number | null,
  construction: Construction | null = null): TraceStart {
  if (geometryType === 'point') {
    const p = geometry as WorldXZ;
    return { geometryType, featureId, vertices: [p], construction };
  }
  if (geometryType === 'linestring') {
    const line = geometry as WorldXZ[];
    const closed = line.length > 2 && line[0].x === line[line.length - 1].x && line[0].z === line[line.length - 1].z;
    return { geometryType, featureId, vertices: closed ? line.slice(0, -1) : line.slice(), closed, construction };
  }
  const poly = geometry as { outer: WorldXZ[]; holes?: WorldXZ[][] };
  return { geometryType, featureId, vertices: poly.outer.slice(), closed: true, holes: poly.holes ?? [], construction };
}

const edited = (s: TraceState, patch: Partial<TraceState>): TraceState =>
  ({ ...s, construction: null, message: null, ...patch });

const minVertices = (s: TraceState) => (s.geometryType === 'polygon' || s.closed ? 3 : s.geometryType === 'linestring' ? 2 : 1);

function construct(mode: Exclude<TraceMode, 'vertex'>, pts: WorldXZ[]): Constructed | null {
  switch (mode) {
    case 'circle_3pt': return circleThroughPoints(pts[0], pts[1], pts[2]);
    case 'circle_center': return circleFromCenter(pts[0], pts[1]);
    case 'ellipse': return ellipseFromPoints(pts[0], pts[1], pts[2]);
    case 'rect': return rectangleFromPoints(pts[0], pts[1], pts[2]);
  }
}

/** The ring a constructor would produce if the cursor were its next click — for preview only. */
export function constructionPreview(s: TraceState): WorldXZ[] | null {
  if (s.mode === 'vertex' || !s.hover) return null;
  const pts = [...s.constructionPoints, s.hover];
  if (pts.length !== CONSTRUCTOR_CLICKS[s.mode]) return null;
  return construct(s.mode, pts)?.ring ?? null;
}

/** A click on the ground: a vertex, or the next constructor point. */
export function addPoint(s: TraceState, raw: WorldXZ): TraceState {
  const p = roundPoint(raw);
  if (s.mode !== 'vertex') {
    const pts = [...s.constructionPoints, p];
    if (pts.length < CONSTRUCTOR_CLICKS[s.mode]) return { ...s, constructionPoints: pts, message: null };
    const built = construct(s.mode, pts);
    if (!built) return { ...s, constructionPoints: [], message: 'Those points do not define a shape (collinear or coincident); try again.' };
    return {
      ...s, vertices: built.ring, closed: true, holes: s.holes, construction: built.construction,
      constructionPoints: [], mode: 'vertex', selectedVertex: null, message: null,
    };
  }
  if (s.geometryType === 'point') return edited(s, { vertices: [p], selectedVertex: 0 });
  if (s.closed) return { ...s, message: 'The shape is closed. Drag, insert or delete vertices to edit it.' };
  const last = s.vertices[s.vertices.length - 1];
  if (last && last.x === p.x && last.z === p.z) return s;
  return edited(s, { vertices: [...s.vertices, p], selectedVertex: s.vertices.length });
}

/** Undo the last step: a pending constructor point, the ring closure, or the last vertex. */
export function undoLast(s: TraceState): TraceState {
  if (s.constructionPoints.length) return { ...s, constructionPoints: s.constructionPoints.slice(0, -1) };
  if (s.closed && s.geometryType !== 'point') return edited(s, { closed: false });
  if (!s.vertices.length) return s;
  return edited(s, { vertices: s.vertices.slice(0, -1), selectedVertex: null });
}

export function closeRing(s: TraceState): TraceState {
  if (s.geometryType === 'point' || s.closed) return s;
  if (s.vertices.length < 3) return { ...s, message: 'Closing needs at least 3 vertices.' };
  return edited(s, { closed: true });
}

export function moveVertex(s: TraceState, index: number, raw: WorldXZ): TraceState {
  if (index < 0 || index >= s.vertices.length) return s;
  const vertices = s.vertices.slice();
  vertices[index] = roundPoint(raw);
  return edited(s, { vertices, selectedVertex: index });
}

/** Insert a vertex on the edge that starts at `edgeStart` (the closing edge wraps). */
export function insertVertex(s: TraceState, edgeStart: number, raw: WorldXZ): TraceState {
  const n = s.vertices.length;
  const edges = s.closed ? n : n - 1;
  if (s.geometryType === 'point' || edgeStart < 0 || edgeStart >= edges) return s;
  const vertices = s.vertices.slice();
  vertices.splice(edgeStart + 1, 0, roundPoint(raw));
  return edited(s, { vertices, selectedVertex: edgeStart + 1 });
}

export function deleteVertex(s: TraceState, index: number): TraceState {
  if (index < 0 || index >= s.vertices.length) return s;
  if (s.vertices.length <= minVertices(s) && (s.closed || s.geometryType === 'point')) {
    return { ...s, message: `A ${s.closed ? 'closed shape' : s.geometryType} keeps at least ${minVertices(s)} vertices.` };
  }
  return edited(s, { vertices: s.vertices.filter((_, i) => i !== index), selectedVertex: null });
}

export function simplifyTrace(s: TraceState, toleranceM: number): TraceState {
  if (s.geometryType === 'point') return s;
  const vertices = s.closed ? simplifyRing(s.vertices, toleranceM) : simplifyLine(s.vertices, toleranceM);
  const removed = s.vertices.length - vertices.length;
  return edited(s, { vertices, selectedVertex: null, message: `Simplified at ${toleranceM} m: ${removed} vertex(es) removed.` });
}

export function setMode(s: TraceState, mode: TraceMode): TraceState {
  if (mode !== 'vertex' && s.geometryType !== 'polygon') {
    return { ...s, message: 'Circle, ellipse and rectangle construct polygons.' };
  }
  return { ...s, mode, constructionPoints: [], message: null };
}

/**
 * The geometry as the API takes it, or null while it is incomplete. Rings are sent open;
 * a closed linestring repeats its first vertex, which is how the backend marks closure.
 */
export function traceGeometry(s: TraceState): unknown | null {
  if (s.geometryType === 'point') return s.vertices.length === 1 ? s.vertices[0] : null;
  if (s.geometryType === 'linestring') {
    if (s.vertices.length < 2) return null;
    return s.closed ? [...s.vertices, s.vertices[0]] : s.vertices.slice();
  }
  if (!s.closed || s.vertices.length < 3) return null;
  return { outer: s.vertices.slice(), holes: s.holes };
}

// ── snapping ────────────────────────────────────────────────────────────────

/** The fields snapping needs from a feature record. */
export interface SnapSource {
  id: number;
  geometry_type: GeometryType;
  geometry: unknown;
}

export interface SnapHit {
  point: WorldXZ;
  kind: SnapKind;
  featureId: number;
}

const SNAP_CELL_WU = 64;

/**
 * A uniform grid over the vertices and edges of saved features, so snapping stays cheap
 * with hundreds of traced islands on screen. Built once per feature list, queried per
 * pointer move.
 */
export class SnapIndex {
  private cells = new Map<string, { a: WorldXZ; b: WorldXZ | null; featureId: number }[]>();

  constructor(features: SnapSource[], excludeId: number | null = null) {
    for (const f of features) {
      if (f.id === excludeId) continue;
      for (const ring of ringsOf(f)) {
        const closed = ring.closed;
        const pts = ring.points;
        for (let i = 0; i < pts.length; i++) {
          this.insert(pts[i], null, f.id);
          if (i < pts.length - 1 || closed) this.insert(pts[i], pts[(i + 1) % pts.length], f.id);
        }
      }
    }
  }

  private key = (cx: number, cz: number) => `${cx},${cz}`;

  private insert(a: WorldXZ, b: WorldXZ | null, featureId: number) {
    const minX = Math.floor(Math.min(a.x, b?.x ?? a.x) / SNAP_CELL_WU);
    const maxX = Math.floor(Math.max(a.x, b?.x ?? a.x) / SNAP_CELL_WU);
    const minZ = Math.floor(Math.min(a.z, b?.z ?? a.z) / SNAP_CELL_WU);
    const maxZ = Math.floor(Math.max(a.z, b?.z ?? a.z) / SNAP_CELL_WU);
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cz = minZ; cz <= maxZ; cz++) {
        const k = this.key(cx, cz);
        let bucket = this.cells.get(k);
        if (!bucket) { bucket = []; this.cells.set(k, bucket); }
        bucket.push({ a, b, featureId });
      }
    }
  }

  /** Nearest vertex within `tolerance`, else nearest point on an edge within it, else null. */
  query(p: WorldXZ, tolerance: number): SnapHit | null {
    let vertex: SnapHit | null = null;
    let vertexD = tolerance;
    let edge: SnapHit | null = null;
    let edgeD = tolerance;
    const minX = Math.floor((p.x - tolerance) / SNAP_CELL_WU);
    const maxX = Math.floor((p.x + tolerance) / SNAP_CELL_WU);
    const minZ = Math.floor((p.z - tolerance) / SNAP_CELL_WU);
    const maxZ = Math.floor((p.z + tolerance) / SNAP_CELL_WU);
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cz = minZ; cz <= maxZ; cz++) {
        for (const item of this.cells.get(this.key(cx, cz)) ?? []) {
          if (!item.b) {
            const d = distance(p, item.a);
            if (d <= vertexD) { vertexD = d; vertex = { point: item.a, kind: 'vertex', featureId: item.featureId }; }
          } else {
            const { point } = closestOnSegment(p, item.a, item.b);
            const d = distance(p, point);
            if (d <= edgeD) { edgeD = d; edge = { point: roundPoint(point), kind: 'edge', featureId: item.featureId }; }
          }
        }
      }
    }
    return vertex ?? edge;
  }
}

function ringsOf(f: SnapSource): { points: WorldXZ[]; closed: boolean }[] {
  const g = f.geometry;
  const ok = (p: unknown): p is WorldXZ =>
    !!p && Number.isFinite((p as WorldXZ).x) && Number.isFinite((p as WorldXZ).z);
  const okRing = (r: unknown): r is WorldXZ[] => Array.isArray(r) && r.every(ok);
  if (f.geometry_type === 'point') return ok(g) ? [{ points: [g], closed: false }] : [];
  if (f.geometry_type === 'linestring') return okRing(g) ? [{ points: g, closed: false }] : [];
  const poly = g as { outer?: unknown; holes?: unknown } | null;
  if (poly && okRing(poly.outer)) {
    const holes = Array.isArray(poly.holes) ? poly.holes.filter(okRing) : [];
    return [poly.outer, ...holes].map(points => ({ points, closed: true }));
  }
  return [];
}

/**
 * Whether a click on the session's own first vertex means "close the ring". This intent
 * is decided before any external vertex/edge snap is considered, so a neighbouring
 * feature within snap reach can never take the click.
 */
export const canCloseOnFirstVertex = (s: TraceState) =>
  s.mode === 'vertex' && s.geometryType !== 'point' && !s.closed && s.vertices.length >= 3;

/**
 * Where a click or drag lands: the session's own first vertex (to close a ring — clicks
 * only, never while dragging a vertex), a saved vertex or edge within reach, or the raw
 * ground point.
 */
export function resolveSnap(s: TraceState, raw: WorldXZ, index: SnapIndex | null, tolerance: number,
  { allowClose = true } = {}): { point: WorldXZ; kind: SnapKind | null; closes: boolean } {
  if (allowClose && canCloseOnFirstVertex(s) && distance(raw, s.vertices[0]) <= tolerance) {
    return { point: s.vertices[0], kind: 'vertex', closes: true };
  }
  if (s.snapping && index) {
    const hit = index.query(raw, tolerance);
    if (hit) return { point: hit.point, kind: hit.kind, closes: false };
  }
  return { point: raw, kind: null, closes: false };
}

// ── the shared session store ────────────────────────────────────────────────

export interface TracingSession {
  getState: () => TraceState;
  subscribe: (listener: () => void) => () => void;
  /** Apply a pure edit; listeners run only if the state object changed. */
  update: (edit: (s: TraceState) => TraceState) => void;
}

export function createTracingSession(initial: TraceState = IDLE_TRACE): TracingSession {
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
