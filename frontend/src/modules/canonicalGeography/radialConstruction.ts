/**
 * Radial construction, client mirror (plan §15): exact straight spokes cast from a center
 * at θₙ = θ₀ + n · (360° / N), each from where the ray last leaves an inner closed ring to
 * where it first leaves an outer closed ring.
 *
 * Pure: no React, Three.js, network or reference-layer imports. This is the live preview
 * only. It mirrors `backend/canonicalGeography/radialConstruction.js` constant for
 * constant and formula for formula, and the two are held together by the shared fixture
 * `radial_construction_cases.v1.json`; but the server computes every persisted spoke, and
 * after Create the UI shows the server's geometry.
 *
 * It knows only a center, two closed rings, N, θ₀ and explicit omissions, and attaches no
 * meaning to what the rings or spokes are. Input rings are never modified.
 */

import type { CanonicalFeature, GeometryType, WorldXZ } from './types';
import { locateInRing } from './constraints';
import { geometryIssues } from './geometry';
import { worldUnitsToMeters } from './physicalScale';

/** Perpendicular distance at which a ring vertex counts as lying on the ray (one grid step). */
export const CONTACT_TOLERANCE_WU = 0.001;
/** Shortest spoke persisted. */
export const MIN_SPOKE_LENGTH_WU = 1;
export const MAX_SPOKE_COUNT = 360;
export const ANGLE_CONVENTION = 'deg_from_+x_toward_+z';

const roundCoordinate = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return r === 0 ? 0 : r;
};
/** A point on the stored 0.001-wu grid, rounded exactly as the server rounds it. */
export const roundGridPoint = (p: WorldXZ): WorldXZ => ({ x: roundCoordinate(p.x), z: roundCoordinate(p.z) });

// ── parameters (§15.3.3, §15.4) ──────────────────────────────────────────────

/** θ₀ normalized to [0, 360) at 1e-6° resolution, exactly as the server does it. */
export function normalizeOffset(deg: number): number {
  let o = ((deg % 360) + 360) % 360;
  o = Math.round(o * 1e6) / 1e6;
  if (o >= 360 || o === 0) o = 0;
  return o;
}

/** θₙ in degrees, evaluated in exactly this order in both mirrors. */
export function spokeAngle(offset: number, n: number, count: number): number {
  const step = 360 / count;
  const raw = offset + n * step;
  return raw >= 360 ? raw - 360 : raw;
}

/** Unit direction for θ degrees, exact on the axes. */
export function direction(theta: number): WorldXZ {
  if (theta === 0) return { x: 1, z: 0 };
  if (theta === 90) return { x: 0, z: 1 };
  if (theta === 180) return { x: -1, z: 0 };
  if (theta === 270) return { x: 0, z: -1 };
  const r = (theta * Math.PI) / 180;
  return { x: Math.cos(r), z: Math.sin(r) };
}

/** The angle from `center` to `p` in degrees (+X toward +Z), rounded to 0.001° — "aim spoke 0". */
export function aimAngle(center: WorldXZ, p: WorldXZ): number | null {
  const dx = p.x - center.x;
  const dz = p.z - center.z;
  if (dx === 0 && dz === 0) return null;
  const deg = (Math.atan2(dz, dx) * 180) / Math.PI;
  const r = Math.round((deg < 0 ? deg + 360 : deg) * 1000) / 1000;
  return r >= 360 ? 0 : r;
}

export interface ParamIssue { code: string; message: string }
export type NormalizedParams = { ok: true; count: number; offset_deg: number; omit_indices: number[] } | { ok: false; issues: ParamIssue[] };

/** Validate the spoke parameters without rounding anything into validity. */
export function normalizeParams({ count, offset_deg: offset, omit_indices: omit }:
  { count: unknown; offset_deg: unknown; omit_indices?: unknown }): NormalizedParams {
  const issues: ParamIssue[] = [];
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > MAX_SPOKE_COUNT) {
    issues.push({ code: 'invalid_count', message: `count must be an integer from 1 to ${MAX_SPOKE_COUNT}` });
  }
  if (typeof offset !== 'number' || !Number.isFinite(offset)) {
    issues.push({ code: 'invalid_offset', message: 'offset_deg must be a finite number of degrees' });
  }
  let omitted: number[] = [];
  if (omit !== undefined && omit !== null) {
    if (!Array.isArray(omit) || !omit.every(i => typeof i === 'number' && Number.isInteger(i))) {
      issues.push({ code: 'invalid_omit_indices', message: 'omit_indices must be an array of integer spoke indices' });
    } else {
      omitted = omit as number[];
      const n = count as number;
      if (omitted.some((v, k) => k > 0 && v <= omitted[k - 1])) {
        issues.push({ code: 'invalid_omit_indices', message: 'omit_indices must be sorted ascending with no repeats' });
      }
      if (!issues.length && omitted.some(i => i < 0 || i >= n)) {
        issues.push({ code: 'invalid_omit_indices', message: `omit_indices must lie in [0, ${n})` });
      }
      if (!issues.length && omitted.length >= n) {
        issues.push({ code: 'all_omitted', message: 'at least one spoke must remain; not every index can be omitted' });
      }
    }
  }
  if (issues.length) return { ok: false, issues };
  return { ok: true, count: count as number, offset_deg: normalizeOffset(offset as number), omit_indices: omitted.slice() };
}

// ── eligible boundaries (§15.3.1) ────────────────────────────────────────────

export type RingResult = { ok: true; ring: WorldXZ[] } | { ok: false; reason: string };

/** A polygon's outer ring (holes ignored) or a closed linestring without its closing vertex. */
export function boundaryRing(geometryType: GeometryType, geometry: unknown): RingResult {
  if (geometryType === 'polygon') {
    const outer = (geometry as { outer?: WorldXZ[] } | null)?.outer;
    if (!Array.isArray(outer) || outer.length < 3) return { ok: false, reason: 'polygon has no usable outer ring' };
    return { ok: true, ring: outer };
  }
  if (geometryType === 'linestring') {
    const line = Array.isArray(geometry) ? (geometry as WorldXZ[]) : [];
    const n = line.length;
    const closed = n > 3 && line[0].x === line[n - 1].x && line[0].z === line[n - 1].z;
    if (!closed) return { ok: false, reason: 'open linestring (only a closed linestring or a polygon is a boundary)' };
    return { ok: true, ring: line.slice(0, -1) };
  }
  return { ok: false, reason: `${geometryType} geometry is not a closed boundary` };
}

export type Eligibility = { eligible: true } | { eligible: false; reason: string };

/** Whether a feature may be picked as a boundary: accepted, and a closed ring (§15.3.1). */
export function boundaryEligibility(f: CanonicalFeature): Eligibility {
  if (f.lifecycle_state !== 'accepted') return { eligible: false, reason: `${f.lifecycle_state} — accept it first` };
  const r = boundaryRing(f.geometry_type, f.geometry);
  return r.ok ? { eligible: true } : { eligible: false, reason: r.reason };
}

export type CenterSourceKind = 'coordinate' | 'feature_point' | 'feature_construction_center';

/** The center a feature supplies for a feature-derived source, or why it cannot (§15.3.2). */
export function featureCenter(f: CanonicalFeature, kind: Exclude<CenterSourceKind, 'coordinate'>):
  { ok: true; center: WorldXZ } | { ok: false; reason: string } {
  if (f.lifecycle_state !== 'accepted') return { ok: false, reason: `${f.lifecycle_state} — accept it first` };
  if (kind === 'feature_point') {
    return f.geometry_type === 'point' ? { ok: true, center: roundGridPoint(f.geometry as WorldXZ) } : { ok: false, reason: `a ${f.geometry_type}, not a point` };
  }
  const c = f.construction as { type?: string; center?: WorldXZ } | null;
  if (c && (c.type === 'circle' || c.type === 'ellipse') && c.center && Number.isFinite(c.center.x) && Number.isFinite(c.center.z)) {
    return { ok: true, center: roundGridPoint(c.center) };
  }
  return { ok: false, reason: 'no circle or ellipse construction' };
}

// ── one ray against one closed ring (§15.5) ──────────────────────────────────

export interface Contact { t: number; point: WorldXZ }
export interface Overlap { t_min: number; t_max: number; from: WorldXZ; to: WorldXZ }

/** Where the ray from `c` along unit `d` meets `ring`, ahead of the center only. */
export function rayRingContacts(c: WorldXZ, d: WorldXZ, ring: WorldXZ[]): { crossings: Contact[]; touches: Contact[]; overlaps: Overlap[] } {
  const n = ring.length;
  const side: number[] = new Array(n);
  const along: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const vx = ring[i].x - c.x;
    const vz = ring[i].z - c.z;
    const s = d.x * vz - d.z * vx;
    side[i] = Math.abs(s) <= CONTACT_TOLERANCE_WU ? 0 : s;
    along[i] = d.x * vx + d.z * vz;
  }
  const crossings: Contact[] = [];
  const touches: Contact[] = [];
  const overlaps: Overlap[] = [];
  const forward = (t: number) => t > CONTACT_TOLERANCE_WU;

  const handleRun = (run: number[], before: number, after: number) => {
    if (run.length === 1) {
      const i = run[0];
      if (!forward(along[i])) return;
      const contact = { t: along[i], point: { x: ring[i].x, z: ring[i].z } };
      if ((before > 0) !== (after > 0)) crossings.push(contact);
      else touches.push(contact);
      return;
    }
    if (!run.some(i => forward(along[i]))) return;
    let lo = run[0];
    let hi = run[0];
    for (const i of run) {
      if (along[i] < along[lo]) lo = i;
      if (along[i] > along[hi]) hi = i;
    }
    overlaps.push({
      t_min: along[lo], t_max: along[hi],
      from: { x: ring[lo].x, z: ring[lo].z }, to: { x: ring[hi].x, z: ring[hi].z },
    });
  };

  const start = side.findIndex(s => s !== 0);
  if (start === -1) {
    handleRun([...Array(n).keys()], 0, 0);
  } else {
    let prev = start;
    let run: number[] = [];
    for (let step = 1; step <= n; step++) {
      const i = (start + step) % n;
      if (side[i] === 0) { run.push(i); continue; }
      if (run.length) {
        handleRun(run, side[prev], side[i]);
        run = [];
      } else if ((side[prev] > 0) !== (side[i] > 0)) {
        const a = ring[prev];
        const b = ring[i];
        const k = side[prev] / (side[prev] - side[i]);
        const point = { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k };
        const t = d.x * (point.x - c.x) + d.z * (point.z - c.z);
        if (forward(t)) crossings.push({ t, point });
      }
      prev = i;
    }
  }
  crossings.sort((p, q) => p.t - q.t);
  touches.sort((p, q) => p.t - q.t);
  overlaps.sort((p, q) => p.t_min - q.t_min);
  return { crossings, touches, overlaps };
}

// ── spokes and the report ────────────────────────────────────────────────────

export type SpokeErrorCode = 'collinear_overlap' | 'ambiguous_ray' | 'invalid_radial_order' | 'grazes_inner' | 'grazes_outer'
  | 'too_short' | 'invalid_geometry';

export interface SpokeError {
  code: SpokeErrorCode;
  message: string;
  ring: 'inner' | 'outer' | null;
  point?: WorldXZ;
  t_range?: [number, number];
  from?: WorldXZ;
  to?: WorldXZ;
  count?: number;
}

export interface SpokeWarning { code: 'inner_multiple_crossings' | 'outer_multiple_crossings'; count: number; message: string }

export interface SpokeReport {
  index: number;
  angle_deg: number;
  status: 'valid' | 'invalid' | 'omitted';
  geometry?: WorldXZ[];
  length_wu: number | null;
  length_m: number | null;
  warnings: SpokeWarning[];
  error?: SpokeError;
}

/** A construction-level problem: from this mirror (`center_not_inside`) or the server (inputs, revision mode). */
export interface ConstructionError {
  code: string;
  message: string;
  ring?: 'inner' | 'outer';
  where?: 'outside' | 'boundary';
  [key: string]: unknown;
}

export interface RadialReport {
  ok: boolean;
  normalized: { center: WorldXZ | null; count: number; offset_deg: number; omit_indices: number[] };
  errors: ConstructionError[];
  spokes: SpokeReport[];
}

const fmtDeg = (a: number) => `${a.toFixed(3)}°`;
const fmtPt = (p: WorldXZ) => `(${p.x.toFixed(3)}, ${p.z.toFixed(3)})`;
const RING_WORDS = { inner: 'inner boundary', outer: 'outer boundary' } as const;
const REMEDY = 'Omit this spoke, change the offset, or revise a boundary.';

function spokeError(code: SpokeErrorCode, n: number, angle: number, extra: Omit<SpokeError, 'code' | 'message'>, detail: string): SpokeError {
  return { code, message: `Spoke ${n} (${fmtDeg(angle)}): ${detail} ${REMEDY}`, ...extra };
}

interface BuiltSpoke { index: number; angle_deg: number; warnings: SpokeWarning[]; geometry?: WorldXZ[]; length_wu?: number; length_m?: number; error?: SpokeError }

function buildSpoke(center: WorldXZ, index: number, angle: number, innerRing: WorldXZ[], outerRing: WorldXZ[]): BuiltSpoke {
  const d = direction(angle);
  const inner = rayRingContacts(center, d, innerRing);
  const outer = rayRingContacts(center, d, outerRing);
  const out: BuiltSpoke = { index, angle_deg: angle, warnings: [] };
  const pairs = [['inner', inner], ['outer', outer]] as const;

  for (const [ring, contacts] of pairs) {
    const ov = contacts.overlaps[0];
    if (ov) {
      out.error = spokeError('collinear_overlap', index, angle,
        { ring, t_range: [ov.t_min, ov.t_max], from: ov.from, to: ov.to, point: ov.from },
        `the ray runs along the ${RING_WORDS[ring]} from ${fmtPt(ov.from)} to ${fmtPt(ov.to)} (collinear overlap).`);
      return out;
    }
  }
  for (const [ring, contacts] of pairs) {
    if (contacts.crossings.length % 2 === 0) {
      out.error = spokeError('ambiguous_ray', index, angle, { ring, count: contacts.crossings.length },
        `the ray crosses the ${RING_WORDS[ring]} ${contacts.crossings.length} times (an even count; the contact is ambiguous).`);
      return out;
    }
  }
  const start = inner.crossings[inner.crossings.length - 1];
  const end = outer.crossings[0];
  if (end.t <= start.t) {
    out.error = spokeError('invalid_radial_order', index, angle, { ring: 'outer', point: end.point },
      `outer boundary reached at ${fmtPt(end.point)} before leaving inner boundary at ${fmtPt(start.point)} — rings cross here.`);
    return out;
  }
  const innerGraze = inner.touches.find(h => h.t > start.t && h.t < end.t);
  if (innerGraze) {
    out.error = spokeError('grazes_inner', index, angle, { ring: 'inner', point: innerGraze.point },
      `the spoke would graze the inner boundary at ${fmtPt(innerGraze.point)}.`);
    return out;
  }
  const outerGraze = outer.touches.find(h => h.t < end.t);
  if (outerGraze) {
    out.error = spokeError('grazes_outer', index, angle, { ring: 'outer', point: outerGraze.point },
      `the spoke would graze the outer boundary at ${fmtPt(outerGraze.point)}.`);
    return out;
  }

  const a = roundGridPoint(start.point);
  const b = roundGridPoint(end.point);
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  out.length_wu = length;
  out.length_m = worldUnitsToMeters(length);
  if (length < MIN_SPOKE_LENGTH_WU) {
    out.error = spokeError('too_short', index, angle, { ring: null, point: a },
      `the spoke would be ${length.toFixed(3)} wu long, under the ${MIN_SPOKE_LENGTH_WU} wu minimum.`);
    return out;
  }
  const issues = geometryIssues('linestring', [a, b]);
  if (issues.length) {
    out.error = spokeError('invalid_geometry', index, angle, { ring: null, point: a },
      `the spoke is not a valid line (${issues.join('; ')}).`);
    return out;
  }
  out.geometry = [a, b];
  if (inner.crossings.length > 1) out.warnings.push({ code: 'inner_multiple_crossings', count: inner.crossings.length,
    message: `Spoke ${index}: the ray crosses the inner boundary ${inner.crossings.length} times; the spoke starts at the outermost exit.` });
  if (outer.crossings.length > 1) out.warnings.push({ code: 'outer_multiple_crossings', count: outer.crossings.length,
    message: `Spoke ${index}: the ray crosses the outer boundary ${outer.crossings.length} times; the spoke ends at the first exit.` });
  return out;
}

/**
 * The construction report, as the server builds it: construction-level errors, then one
 * entry per index (`valid` with two-vertex geometry, `invalid` with its error, or
 * `omitted`, still evaluated). `ok` only when nothing blocks persistence (§15.13).
 */
export function computeRadial({ center: rawCenter, inner, outer, count, offset_deg: offsetDeg, omit_indices: omit = [], labels = {} }: {
  center: WorldXZ; inner: WorldXZ[]; outer: WorldXZ[]; count: number; offset_deg: number; omit_indices?: number[];
  labels?: { inner?: string; outer?: string };
}): RadialReport {
  const center = roundGridPoint(rawCenter);
  const normalized = { center, count, offset_deg: offsetDeg, omit_indices: omit.slice() };
  const errors: ConstructionError[] = [];
  for (const [ring, poly] of [['inner', inner], ['outer', outer]] as const) {
    const where = locateInRing(center.x, center.z, poly);
    if (where !== 'inside') {
      const label = labels[ring] || RING_WORDS[ring];
      errors.push({
        code: 'center_not_inside', ring, where,
        message: `Center ${fmtPt(center)} lies ${where === 'boundary' ? 'on' : 'outside'} the ${label}. Choose a center strictly inside both boundaries.`,
      });
    }
  }
  if (errors.length) return { ok: false, normalized, errors, spokes: [] };

  const omitted = new Set(omit);
  const spokes: SpokeReport[] = [];
  for (let n = 0; n < count; n++) {
    const spoke = buildSpoke(center, n, spokeAngle(offsetDeg, n, count), inner, outer);
    const status = omitted.has(n) ? 'omitted' : spoke.error ? 'invalid' : 'valid';
    spokes.push({
      index: n,
      angle_deg: spoke.angle_deg,
      status,
      ...(spoke.geometry ? { geometry: spoke.geometry } : {}),
      length_wu: spoke.length_wu ?? null,
      length_m: spoke.length_m ?? null,
      warnings: spoke.warnings,
      ...(spoke.error ? { error: spoke.error } : {}),
    });
  }
  return { ok: spokes.every(s => s.status !== 'invalid'), normalized, errors, spokes };
}
