/**
 * Client-side canonical geometry (plan §4.1, §7.2): a validation mirror for live feedback
 * while tracing, the normalization aids, and area/length.
 *
 * Pure: no React, Three.js, network or reference-layer imports. The backend
 * (`backend/canonicalGeography/geometry.js`) is the authority — it re-validates and
 * normalizes every save — so the checks here exist to tell the editor what is wrong before
 * they press Save, not to decide what is canon.
 *
 * Normalization aids produce ordinary vertices plus a `construction` record of the
 * parameters they came from ("preserve canon, not pixels", R-006/A-015): a circle clicked
 * on an imperfect raster circle is stored as a clean circle and says so. Segment counts are
 * derived from a fixed maximum chord error, never asked for.
 */

import type { WorldXZ } from './types';
import { metersToWorldUnits } from './physicalScale';

/** Mirrors the backend: coordinates beyond ±this are almost certainly a unit mistake. */
export const WORLD_LIMIT = 20000;
/** Mirrors the backend: total vertices per feature. */
export const MAX_VERTICES = 20000;
/** Mirrors the backend: stored resolution in world units. */
export const COORDINATE_PRECISION_WU = 0.001;
/** Mirrors the backend: smallest polygon area, square world units. */
export const MIN_POLYGON_AREA_WU2 = 1;

/** The largest gap between a true curve and its polygon approximation (plan §4.1). */
export const MAX_CHORD_ERROR_M = 0.25;
const MIN_CURVE_SEGMENTS = 8;
const MAX_CURVE_SEGMENTS = 4096;

// ── construction records (stored as construction_json) ──────────────────────

export interface CircleConstruction {
  type: 'circle';
  center: WorldXZ;
  radius: number;
  /** How it was built: three rim points, or centre plus a rim point. */
  method: 'three_point' | 'center_radius';
  segments: number;
  max_chord_error_m: number;
}

export interface EllipseConstruction {
  type: 'ellipse';
  center: WorldXZ;
  radius_x: number;
  radius_z: number;
  /** Rotation of the X semi-axis, radians, in X/Z. */
  rotation_rad: number;
  segments: number;
  max_chord_error_m: number;
}

export interface RectConstruction {
  type: 'rect';
  center: WorldXZ;
  width: number;
  height: number;
  rotation_rad: number;
}

/**
 * A spoke of a radial construction (plan §15.8). Written only by the server's radial
 * constructor; the client reads and displays it and never constructs, adapts or moves one.
 */
/**
 * A radial boundary built inline from a circle definition (plan §15.3.1): not a canonical
 * feature. `method` and `points` (grid-rounded clicks) reproduce it exactly; `center`,
 * `radius` and `segments` are the server's derived values, recorded for reading.
 */
export interface InlineCircleSource {
  method: CircleConstruction['method'];
  points: WorldXZ[];
  center: WorldXZ;
  radius: number;
  segments: number;
  max_chord_error_m: number;
}

/** A radial boundary input: an accepted feature at a pinned revision, or an inline circle. */
export type RadialBoundaryRecord = { feature_id: number; revision: number }
  /** `materialized_feature_id`: the independent boundary draft the originating request created, if it asked for one (audit only). */
  | { circle: InlineCircleSource; materialized_feature_id?: number };

export interface RadialSpokeConstruction {
  type: 'radial_spoke';
  version: 1;
  construction_id: string;
  center: WorldXZ;
  center_source: { kind: 'coordinate' } | { kind: 'feature_point' | 'feature_construction_center'; feature_id: number; revision: number };
  inner: RadialBoundaryRecord;
  outer: RadialBoundaryRecord;
  count: number;
  offset_deg: number;
  omit_indices: number[];
  index: number;
  angle_deg: number;
  angle_convention: 'deg_from_+x_toward_+z';
}

export type Construction = CircleConstruction | EllipseConstruction | RectConstruction | RadialSpokeConstruction;

export interface Constructed {
  ring: WorldXZ[];
  construction: Construction;
}

// ── basics ──────────────────────────────────────────────────────────────────

const round = (v: number) => Math.round(v / COORDINATE_PRECISION_WU) * COORDINATE_PRECISION_WU;
/** A point on the stored 0.001 wu grid (trims float noise such as 1.0000000002). */
export const roundPoint = (p: WorldXZ): WorldXZ => ({ x: +round(p.x).toFixed(3), z: +round(p.z).toFixed(3) });

export const distance = (a: WorldXZ, b: WorldXZ) => Math.hypot(b.x - a.x, b.z - a.z);

/** Shoelace area with X first and Z second; positive is counter-clockwise, as stored. */
export function ringSignedArea(ring: WorldXZ[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    s += a.x * b.z - b.x * a.z;
  }
  return s / 2;
}

export const ringArea = (ring: WorldXZ[]) => Math.abs(ringSignedArea(ring));

/** Outer area minus holes, square world units. */
export const polygonArea = (outer: WorldXZ[], holes: WorldXZ[][] = []) =>
  Math.max(0, ringArea(outer) - holes.reduce((s, h) => s + ringArea(h), 0));

export function lineLength(line: WorldXZ[]): number {
  let s = 0;
  for (let i = 1; i < line.length; i++) s += distance(line[i - 1], line[i]);
  return s;
}

export const ringPerimeter = (ring: WorldXZ[]) => (ring.length < 2 ? 0 : lineLength(ring) + distance(ring[ring.length - 1], ring[0]));

/** Nearest point to `p` on segment ab, and the parameter along it. */
export function closestOnSegment(p: WorldXZ, a: WorldXZ, b: WorldXZ): { point: WorldXZ; t: number } {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
  return { point: { x: a.x + t * dx, z: a.z + t * dz }, t };
}

// ── normalization aids ──────────────────────────────────────────────────────

/**
 * Segments for a curve of this radius so no chord strays further than the fixed chord
 * error from the true curve: sagitta = r(1 − cos(π/n)) ≤ e.
 */
export function segmentsForRadius(radiusWu: number, maxChordErrorM = MAX_CHORD_ERROR_M): number {
  const e = metersToWorldUnits(maxChordErrorM);
  if (!(radiusWu > e)) return MIN_CURVE_SEGMENTS;
  const n = Math.ceil(Math.PI / Math.acos(1 - e / radiusWu));
  return Math.max(MIN_CURVE_SEGMENTS, Math.min(MAX_CURVE_SEGMENTS, n));
}

/** The circle through three points, or null when they are (nearly) collinear. */
export function circleFromThreePoints(a: WorldXZ, b: WorldXZ, c: WorldXZ): { center: WorldXZ; radius: number } | null {
  const d = 2 * (a.x * (b.z - c.z) + b.x * (c.z - a.z) + c.x * (a.z - b.z));
  const scale = Math.max(distance(a, b), distance(b, c), distance(a, c));
  if (!scale || Math.abs(d) < 1e-9 * scale * scale) return null;
  const a2 = a.x * a.x + a.z * a.z;
  const b2 = b.x * b.x + b.z * b.z;
  const c2 = c.x * c.x + c.z * c.z;
  const center = {
    x: (a2 * (b.z - c.z) + b2 * (c.z - a.z) + c2 * (a.z - b.z)) / d,
    z: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d,
  };
  return { center, radius: distance(center, a) };
}

function ellipseRing(center: WorldXZ, rx: number, rz: number, rotation: number, segments: number): WorldXZ[] {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const ring: WorldXZ[] = [];
  for (let i = 0; i < segments; i++) {
    const t = (2 * Math.PI * i) / segments;
    const ex = rx * Math.cos(t);
    const ez = rz * Math.sin(t);
    ring.push(roundPoint({ x: center.x + ex * cos - ez * sin, z: center.z + ex * sin + ez * cos }));
  }
  return ring;
}

export function circlePolygon(center: WorldXZ, radius: number, method: CircleConstruction['method']): Constructed | null {
  if (!(radius > 0) || !Number.isFinite(radius)) return null;
  const segments = segmentsForRadius(radius);
  const c = roundPoint(center);
  return {
    ring: ellipseRing(c, radius, radius, 0, segments),
    construction: { type: 'circle', center: c, radius: +radius.toFixed(3), method, segments, max_chord_error_m: MAX_CHORD_ERROR_M },
  };
}

/** Three points on an imperfect raster circle → a clean circle. */
export function circleThroughPoints(a: WorldXZ, b: WorldXZ, c: WorldXZ): Constructed | null {
  const circle = circleFromThreePoints(a, b, c);
  return circle ? circlePolygon(circle.center, circle.radius, 'three_point') : null;
}

/** Centre, then any rim point. */
export const circleFromCenter = (center: WorldXZ, rim: WorldXZ): Constructed | null =>
  circlePolygon(center, distance(center, rim), 'center_radius');

/** Clicks each circle method takes: three rim points, or the centre then a rim point. */
export const CIRCLE_METHOD_POINTS: Record<CircleConstruction['method'], number> = { three_point: 3, center_radius: 2 };

/**
 * A circle from its defining clicks, exactly as the tracing tool builds one: every click is
 * put on the 0.001 wu grid first, then the method's constructor runs. The same definition
 * always gives the same ring, so a definition (method + points) is a reproducible input —
 * the radial constructor stores it, and the server's mirror
 * (`backend/canonicalGeography/circleConstruction.js`) recomputes it.
 */
export function circleFromDefinition(method: CircleConstruction['method'], points: WorldXZ[]): Constructed | null {
  if (points.length !== CIRCLE_METHOD_POINTS[method]) return null;
  const p = points.map(roundPoint);
  return method === 'three_point' ? circleThroughPoints(p[0], p[1], p[2]) : circleFromCenter(p[0], p[1]);
}

/** Signed distance of `p` from the line through a in direction (ux, uz) (unit), measured along its left normal. */
const perpendicular = (p: WorldXZ, a: WorldXZ, ux: number, uz: number) => (p.x - a.x) * -uz + (p.z - a.z) * ux;

/**
 * An axis-rotated ellipse: centre, the end of one semi-axis (its length and direction),
 * then any point whose distance from that axis is the other semi-axis.
 */
export function ellipseFromPoints(center: WorldXZ, axisEnd: WorldXZ, extent: WorldXZ): Constructed | null {
  const rx = distance(center, axisEnd);
  if (!(rx > 0)) return null;
  const rotation = Math.atan2(axisEnd.z - center.z, axisEnd.x - center.x);
  const rz = Math.abs(perpendicular(extent, center, Math.cos(rotation), Math.sin(rotation)));
  if (!(rz > 0)) return null;
  const segments = segmentsForRadius(Math.max(rx, rz));
  const c = roundPoint(center);
  return {
    ring: ellipseRing(c, rx, rz, rotation, segments),
    construction: {
      type: 'ellipse', center: c, radius_x: +rx.toFixed(3), radius_z: +rz.toFixed(3), rotation_rad: rotation,
      segments, max_chord_error_m: MAX_CHORD_ERROR_M,
    },
  };
}

/**
 * A rotated rectangle: one edge from a to b (its length and rotation), then any point
 * whose distance from that edge is the rectangle's other side.
 */
export function rectangleFromPoints(a: WorldXZ, b: WorldXZ, extent: WorldXZ): Constructed | null {
  const width = distance(a, b);
  if (!(width > 0)) return null;
  const ux = (b.x - a.x) / width;
  const uz = (b.z - a.z) / width;
  const h = perpendicular(extent, a, ux, uz);
  if (!h) return null;
  const nx = -uz * h;
  const nz = ux * h;
  const ring = [a, b, { x: b.x + nx, z: b.z + nz }, { x: a.x + nx, z: a.z + nz }].map(roundPoint);
  return {
    ring,
    construction: {
      type: 'rect',
      // The midpoint of the diagonal from a to the far corner (b + n).
      center: roundPoint({ x: (a.x + b.x + nx) / 2, z: (a.z + b.z + nz) / 2 }),
      width: +width.toFixed(3), height: +Math.abs(h).toFixed(3), rotation_rad: Math.atan2(uz, ux),
    },
  };
}

// ── simplification ──────────────────────────────────────────────────────────

function douglasPeucker(points: WorldXZ[], tol: number): WorldXZ[] {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let worst = -1;
    let worstD = tol;
    for (let i = s + 1; i < e; i++) {
      const d = distance(points[i], closestOnSegment(points[i], points[s], points[e]).point);
      if (d > worstD) { worstD = d; worst = i; }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([s, worst], [worst, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Douglas–Peucker on an open line; the tolerance is given in metres, as the UI shows it. */
export function simplifyLine(line: WorldXZ[], toleranceM: number): WorldXZ[] {
  if (!(toleranceM > 0)) return line.slice();
  return douglasPeucker(line, metersToWorldUnits(toleranceM));
}

/**
 * Douglas–Peucker on a closed ring (stored open). The ring is split at its first vertex
 * and the vertex farthest from it so the result never collapses below a triangle.
 */
export function simplifyRing(ring: WorldXZ[], toleranceM: number): WorldXZ[] {
  if (!(toleranceM > 0) || ring.length <= 3) return ring.slice();
  let far = 1;
  for (let i = 1; i < ring.length; i++) if (distance(ring[0], ring[i]) > distance(ring[0], ring[far])) far = i;
  const tol = metersToWorldUnits(toleranceM);
  const first = douglasPeucker(ring.slice(0, far + 1), tol);
  const second = douglasPeucker([...ring.slice(far), ring[0]], tol);
  const out = [...first, ...second.slice(1, -1)];
  return out.length >= 3 ? out : ring.slice();
}

// ── validation mirror ───────────────────────────────────────────────────────

const orient = (a: WorldXZ, b: WorldXZ, c: WorldXZ) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
const onSeg = (p: WorldXZ, a: WorldXZ, b: WorldXZ) =>
  Math.min(a.x, b.x) <= p.x && p.x <= Math.max(a.x, b.x) && Math.min(a.z, b.z) <= p.z && p.z <= Math.max(a.z, b.z);

export function segmentsIntersect(a: WorldXZ, b: WorldXZ, c: WorldXZ, d: WorldXZ): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  return (o1 === 0 && onSeg(c, a, b)) || (o2 === 0 && onSeg(d, a, b)) || (o3 === 0 && onSeg(a, c, d)) || (o4 === 0 && onSeg(b, c, d));
}

/** Any two non-adjacent segments that touch. O(n²) with a bbox reject; fine for one traced feature. */
function selfContact(points: WorldXZ[], closed: boolean): boolean {
  const n = points.length;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    for (let j = i + 1; j < segs; j++) {
      const adjacent = j === i + 1 || (closed && i === 0 && j === segs - 1);
      if (adjacent) continue;
      const c = points[j];
      const d = points[(j + 1) % n];
      if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.max(c.x, d.x) < Math.min(a.x, b.x)
        || Math.max(a.z, b.z) < Math.min(c.z, d.z) || Math.max(c.z, d.z) < Math.min(a.z, b.z)) continue;
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

function pointIssues(points: WorldXZ[], issues: string[]) {
  if (points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.z))) issues.push('a coordinate is not a finite number');
  else if (points.some(p => Math.abs(p.x) > WORLD_LIMIT || Math.abs(p.z) > WORLD_LIMIT)) {
    issues.push(`a vertex lies beyond ±${WORLD_LIMIT} world units`);
  }
  if (points.length > MAX_VERTICES) issues.push(`more than ${MAX_VERTICES} vertices`);
}

function hasZeroLengthEdge(points: WorldXZ[], closed: boolean) {
  const r = points.map(roundPoint);
  const n = r.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const b = r[(i + 1) % n];
    if (r[i].x === b.x && r[i].z === b.z) return true;
  }
  return false;
}

/**
 * Single-record problems with a traced geometry, in words. Empty means the server's
 * single-record validation is expected to pass; cross-feature rules are checked only at
 * accept, by the server.
 */
export function geometryIssues(geometryType: 'point' | 'linestring' | 'polygon', vertices: WorldXZ[],
  { closed = false, holes = [] as WorldXZ[][] } = {}): string[] {
  const issues: string[] = [];
  if (geometryType === 'point') {
    if (vertices.length !== 1) issues.push('place exactly one point');
    pointIssues(vertices, issues);
    return issues;
  }
  pointIssues([...vertices, ...holes.flat()], issues);
  if (geometryType === 'linestring') {
    if (vertices.length < 2) issues.push('a line needs at least 2 vertices');
    if (closed && vertices.length < 3) issues.push('a closed line needs at least 3 vertices');
    if (hasZeroLengthEdge(vertices, closed)) issues.push('two consecutive vertices coincide');
    else if (vertices.length >= 3 && selfContact(vertices, closed)) issues.push('the line crosses itself');
    return issues;
  }
  if (vertices.length < 3) issues.push('a polygon needs at least 3 vertices');
  if (!closed) issues.push('close the ring');
  if (vertices.length >= 3) {
    if (hasZeroLengthEdge(vertices, true)) issues.push('two consecutive vertices coincide');
    else if (selfContact(vertices, true)) issues.push('the outline crosses itself');
    if (polygonArea(vertices, holes) < MIN_POLYGON_AREA_WU2) issues.push(`area is below ${MIN_POLYGON_AREA_WU2} square world unit`);
  }
  return issues;
}
