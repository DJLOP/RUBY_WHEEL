/**
 * The radial-construction client mirror (plan §15.4, §15.5, §15.14) against the shared
 * synthetic fixtures, plus parity with the server module.
 *
 * `fixtures/radial_construction_cases.v1.json` is a byte-identical copy of the backend's.
 * The expectations in it are plan §15.5 stated by hand (the regular-polygon endpoints are
 * computed independently of either mirror); the backend test runs the same cases against
 * the authority. Here the preview must agree, and on arbitrary inputs it must produce the
 * very same report as the server module.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { createRequire } from 'module';
import { resolve } from 'path';
import {
  aimAngle, boundaryEligibility, boundaryRing, computeRadial, featureCenter, normalizeOffset, normalizeParams, rayRingContacts,
  type RadialReport,
} from '../radialConstruction';
import type { CanonicalFeature, GeometryType, WorldXZ } from '../types';
import { circleFromDefinition, type CircleConstruction } from '../geometry';
import { IDLE_TRACE, addPoint, beginTrace, setMode } from '../tracing';

const LOCAL = resolve(__dirname, 'fixtures', 'radial_construction_cases.v1.json');
const BACKEND_FIXTURE = resolve(__dirname, '../../../../../backend/__tests__/fixtures/radial_construction_cases.v1.json');
const BACKEND_MODULE = resolve(__dirname, '../../../../../backend/canonicalGeography/radialConstruction.js');
const BACKEND_CIRCLES = resolve(__dirname, '../../../../../backend/canonicalGeography/circleConstruction.js');

interface SpokeExpect {
  index: number; status: string; warnings: string[]; angle_deg?: number; geometry?: WorldXZ[]; crossings?: number;
  error?: { code: string; ring: string | null; point?: WorldXZ; t_range?: number[]; from?: WorldXZ; to?: WorldXZ };
}
type CircleSource = { circle: { method: CircleConstruction['method']; points: WorldXZ[] } };
interface Case {
  id: string; group: number; description: string; inner: string | CircleSource; outer: string | CircleSource; center: WorldXZ; count: number;
  offset_deg: number; omit_indices: number[];
  expect: { ok: boolean; errors: { code: string; ring: string; where: string }[]; spokes: SpokeExpect[];
    spoke_count?: number; others_status?: string; geometry_tolerance_wu?: number };
}
interface Doc {
  rings: Record<string, { geometry_type: GeometryType; geometry: unknown }>;
  cases: Case[];
  circles: { id: string; method: CircleConstruction['method']; points: WorldXZ[]; expect: { center: WorldXZ; radius: number; segments: number } | null }[];
  parameters: { offsets: [string, number][]; rejected: Record<string, unknown>[]; accepted: { count: number; offset_deg: number; omit_indices?: number[] }[] };
}

const doc: Doc = JSON.parse(readFileSync(LOCAL, 'utf8'));
/** A case boundary: a named ring, or an inline circle built with the shape creator's own circle helpers. */
const ringOf = (name: string | CircleSource) => {
  if (typeof name === 'object') return circleFromDefinition(name.circle.method, name.circle.points)!.ring;
  const r = boundaryRing(doc.rings[name].geometry_type, doc.rings[name].geometry);
  if (!r.ok) throw new Error(`fixture ring ${name}: ${r.reason}`);
  return r.ring;
};
const run = (c: Case) => computeRadial({
  center: c.center, inner: ringOf(c.inner), outer: ringOf(c.outer), count: c.count, offset_deg: c.offset_deg, omit_indices: c.omit_indices,
});

function checkCase(c: Case, report: RadialReport) {
  const e = c.expect;
  expect(report.ok).toBe(e.ok);
  expect(report.errors.map(x => ({ code: x.code, ring: x.ring, where: x.where }))).toEqual(e.errors);
  expect(report.spokes).toHaveLength(e.spokes.length === 0 ? 0 : (e.spoke_count ?? c.count));
  const listed = new Set(e.spokes.map(s => s.index));
  for (const want of e.spokes) {
    const got = report.spokes[want.index];
    const where = `${c.id} spoke ${want.index}`;
    expect(got.status, where).toBe(want.status);
    expect(got.warnings.map(w => w.code), where).toEqual(want.warnings);
    if (want.angle_deg !== undefined) expect(got.angle_deg, where).toBe(want.angle_deg);
    if (want.geometry) {
      const tol = e.geometry_tolerance_wu ?? 0;
      want.geometry.forEach((p, k) => {
        expect(Math.abs(got.geometry![k].x - p.x), `${where} x${k}`).toBeLessThanOrEqual(tol);
        expect(Math.abs(got.geometry![k].z - p.z), `${where} z${k}`).toBeLessThanOrEqual(tol);
      });
    } else {
      expect(got.geometry, where).toBeUndefined();
    }
    if (want.error) {
      expect(got.error, where).toMatchObject({ code: want.error.code, ring: want.error.ring });
      if (want.error.point) expect(got.error!.point, where).toEqual(want.error.point);
      if (want.error.t_range) expect(got.error!.t_range, where).toEqual(want.error.t_range);
      if (want.error.from) expect({ from: got.error!.from, to: got.error!.to }, where).toEqual({ from: want.error.from, to: want.error.to });
    } else {
      expect(got.error, where).toBeUndefined();
    }
  }
  if (e.others_status) {
    for (const s of report.spokes) if (!listed.has(s.index)) expect(s.status, `${c.id} spoke ${s.index}`).toBe(e.others_status);
  }
}

describe('shared fixture', () => {
  it.runIf(existsSync(BACKEND_FIXTURE))('is byte-identical to the backend copy', () => {
    expect(readFileSync(LOCAL, 'utf8').replace(/\r\n/g, '\n')).toBe(readFileSync(BACKEND_FIXTURE, 'utf8').replace(/\r\n/g, '\n'));
  });

  for (const c of doc.cases) {
    it(`${c.id}: ${c.description}`, () => checkCase(c, run(c)));
  }
});

describe('parity with the server module', () => {
  const backend = existsSync(BACKEND_MODULE) ? createRequire(import.meta.url)(BACKEND_MODULE) : null;

  it.runIf(!!backend)('produces byte-identical reports for every fixture case', () => {
    for (const c of doc.cases) {
      const args = { center: c.center, inner: ringOf(c.inner), outer: ringOf(c.outer), count: c.count, offset_deg: c.offset_deg, omit_indices: c.omit_indices };
      expect(JSON.stringify(computeRadial(args)), c.id).toBe(JSON.stringify(backend.computeRadial(args)));
    }
  });

  it.runIf(!!backend)('produces byte-identical reports on seeded irregular rings, centers, counts and offsets', () => {
    let seed = 20260925;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const star = (rMin: number, rMax: number, k: number) => Array.from({ length: k }, (_, i) => {
      const a = (2 * Math.PI * i) / k;
      const r = rMin + (rMax - rMin) * rnd();
      return { x: Math.round(r * Math.cos(a) * 1000) / 1000, z: Math.round(r * Math.sin(a) * 1000) / 1000 };
    });
    for (let trial = 0; trial < 40; trial++) {
      const args = {
        center: { x: Math.round((rnd() - 0.5) * 20000) / 1000, z: Math.round((rnd() - 0.5) * 20000) / 1000 },
        inner: star(60, 140, 5 + Math.floor(rnd() * 60)),
        outer: star(150, 400, 5 + Math.floor(rnd() * 200)),
        count: 1 + Math.floor(rnd() * 72),
        offset_deg: normalizeOffset((rnd() - 0.5) * 1000),
      };
      expect(JSON.stringify(computeRadial(args)), `trial ${trial}`).toBe(JSON.stringify(backend.computeRadial(args)));
    }
  });
});

describe('inline circle boundaries use the shape creator circle semantics (§15.3.1)', () => {
  const backendCircles = existsSync(BACKEND_CIRCLES) ? createRequire(import.meta.url)(BACKEND_CIRCLES) : null;

  for (const c of doc.circles) {
    it(`${c.id}`, () => {
      const built = circleFromDefinition(c.method, c.points);
      if (c.expect === null) { expect(built).toBeNull(); return; }
      expect(built!.construction).toEqual({ type: 'circle', method: c.method, max_chord_error_m: 0.25, ...c.expect });
      expect(built!.ring).toHaveLength(c.expect.segments);
    });
  }

  it('the three-point circle picked in the tracing tool and the one built for a radial boundary are identical', () => {
    const clicks = [{ x: 150.4, z: -20 }, { x: 50, z: 79.6 }, { x: -49.8, z: -20.3 }];
    let trace = setMode(beginTrace(IDLE_TRACE, { geometryType: 'polygon' }), 'circle_3pt');
    for (const p of clicks) trace = addPoint(trace, p);
    const radial = circleFromDefinition('three_point', clicks)!;
    expect(trace.vertices).toEqual(radial.ring);
    expect(trace.construction).toEqual(radial.construction);
    let rim = setMode(beginTrace(IDLE_TRACE, { geometryType: 'polygon' }), 'circle_center');
    for (const p of [{ x: 3, z: 4 }, { x: 33, z: 44 }]) rim = addPoint(rim, p);
    expect(rim.vertices).toEqual(circleFromDefinition('center_radius', [{ x: 3, z: 4 }, { x: 33, z: 44 }])!.ring);
  });

  it.runIf(!!backendCircles)('the server recomputes byte-identical circles: every fixture definition and seeded clicks', () => {
    for (const c of doc.circles) {
      expect(JSON.stringify(backendCircles.circleFromDefinition(c.method, c.points)), c.id).toBe(JSON.stringify(circleFromDefinition(c.method, c.points)));
    }
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const pt = () => ({ x: (rnd() - 0.5) * 8000, z: (rnd() - 0.5) * 8000 });
    for (let t = 0; t < 60; t++) {
      const method = t % 2 ? 'three_point' : 'center_radius';
      const points = method === 'three_point' ? [pt(), pt(), pt()] : [pt(), pt()];
      expect(JSON.stringify(backendCircles.circleFromDefinition(method, points)), `trial ${t}`).toBe(JSON.stringify(circleFromDefinition(method, points)));
    }
  });
});

describe('parameters (§15.3.3, §15.4)', () => {
  it('normalizes offsets exactly as specified', () => {
    for (const [raw, want] of doc.parameters.offsets) {
      const got = normalizeOffset(Number(raw));
      expect(got, raw).toBe(want);
      expect(Object.is(got, -0), raw).toBe(false);
    }
  });

  it('rejects malformed counts, offsets and omissions', () => {
    for (const p of doc.parameters.rejected) {
      const o = p.offset_deg;
      const offset = typeof o === 'string' && !/^-?\d/.test(o) ? Number(o) : o;
      expect(normalizeParams({ ...p, offset_deg: offset } as never).ok, JSON.stringify(p)).toBe(false);
    }
  });

  it('accepts valid parameters', () => {
    for (const p of doc.parameters.accepted) expect(normalizeParams(p).ok, JSON.stringify(p)).toBe(true);
  });

  it('aims spoke 0 at a point: +X is 0°, +Z is 90°, rounded to 0.001°', () => {
    expect(aimAngle({ x: 0, z: 0 }, { x: 10, z: 0 })).toBe(0);
    expect(aimAngle({ x: 0, z: 0 }, { x: 0, z: 10 })).toBe(90);
    expect(aimAngle({ x: 0, z: 0 }, { x: 0, z: -10 })).toBe(270);
    expect(aimAngle({ x: 1, z: 1 }, { x: 2, z: 2 })).toBe(45);
    expect(aimAngle({ x: 0, z: 0 }, { x: 10, z: 0.00001 })).toBe(0);
    expect(aimAngle({ x: 0, z: 0 }, { x: 0, z: 0 })).toBeNull();
  });
});

describe('collinear overlap is never a crossing or a touch (§15.5)', () => {
  it('reports the forward run with its t range and endpoints', () => {
    const ring = [{ x: -50, z: -50 }, { x: 20, z: -50 }, { x: 20, z: 0 }, { x: 30, z: 0 }, { x: 30, z: 50 }, { x: -50, z: 50 }];
    const r = rayRingContacts({ x: 0, z: 0 }, { x: 1, z: 0 }, ring);
    expect(r.overlaps).toEqual([{ t_min: 20, t_max: 30, from: { x: 20, z: 0 }, to: { x: 30, z: 0 } }]);
    expect(r.crossings).toEqual([]);
    expect(r.touches).toEqual([]);
  });
});

describe('eligibility (§15.3)', () => {
  const feature = (over: Partial<CanonicalFeature>): CanonicalFeature => ({
    id: 1, entity_type: 'feature', name: null, description: null, notes: null, lifecycle_state: 'accepted', provenance: 'authored',
    replacement_state: 'non_replaceable', is_locked: false, revision: 1, draft_version: 1, revises_id: null, base_revision: null,
    evidence: null, proposal: null, feature_class: 'site', kind: null, geometry_type: 'polygon',
    geometry: { outer: [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }], holes: [] }, construction: null, attributes: null,
    bbox: { min_x: 0, min_z: 0, max_x: 1, max_z: 1 }, anchor_id: null, part_role: null, constraint_strength: 'hard', ...over,
  });

  it('offers accepted polygons (any class) and closed linestrings; refuses drafts, points and open lines with a reason', () => {
    expect(boundaryEligibility(feature({}))).toEqual({ eligible: true });
    expect(boundaryEligibility(feature({ feature_class: 'land' }))).toEqual({ eligible: true });
    expect(boundaryEligibility(feature({ geometry_type: 'linestring', feature_class: 'route',
      geometry: [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }, { x: 0, z: 0 }] }))).toEqual({ eligible: true });
    expect(boundaryEligibility(feature({ lifecycle_state: 'draft' }))).toEqual({ eligible: false, reason: 'draft — accept it first' });
    expect(boundaryEligibility(feature({ geometry_type: 'point', geometry: { x: 0, z: 0 } }))).toMatchObject({ eligible: false });
    expect(boundaryEligibility(feature({ geometry_type: 'linestring', geometry: [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }] })))
      .toEqual({ eligible: false, reason: expect.stringMatching(/open linestring/) });
  });

  it('derives a center from an accepted point or a circle/ellipse construction only', () => {
    expect(featureCenter(feature({ geometry_type: 'point', geometry: { x: 3.0004, z: 4 } }), 'feature_point')).toEqual({ ok: true, center: { x: 3, z: 4 } });
    expect(featureCenter(feature({}), 'feature_point')).toMatchObject({ ok: false });
    expect(featureCenter(feature({ construction: { type: 'circle', center: { x: 1, z: 2 } } }), 'feature_construction_center'))
      .toEqual({ ok: true, center: { x: 1, z: 2 } });
    expect(featureCenter(feature({ construction: { type: 'rect', center: { x: 1, z: 2 } } }), 'feature_construction_center')).toMatchObject({ ok: false });
    expect(featureCenter(feature({ lifecycle_state: 'draft', geometry_type: 'point', geometry: { x: 0, z: 0 } }), 'feature_point')).toMatchObject({ ok: false });
  });
});

describe('live-preview performance (§15.5)', () => {
  it('N = 16 against two 4,096-vertex rings: recorded, and well within an interactive budget', () => {
    const regular = (r: number, k: number) => Array.from({ length: k }, (_, i) => ({
      x: Math.round(r * Math.cos((2 * Math.PI * i) / k) * 1000) / 1000, z: Math.round(r * Math.sin((2 * Math.PI * i) / k) * 1000) / 1000,
    }));
    const inner = regular(800, 4096);
    const outer = regular(2200, 4096);
    const args = { center: { x: 1.5, z: -2.25 }, inner, outer, count: 16, offset_deg: 7.25 };
    computeRadial(args); // warm
    const runs = 5;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) computeRadial(args);
    const ms = (performance.now() - t0) / runs;
    console.info(`[AT1] radial preview N=16, 2×4096-vertex rings: ${ms.toFixed(2)} ms per recompute`);
    expect(computeRadial(args).ok).toBe(true);
    expect(ms).toBeLessThan(50);
  });
});
