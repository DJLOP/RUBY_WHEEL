/**
 * The pure radial-construction core (plan §15.4, §15.5, §15.14) against the shared
 * synthetic fixtures, plus ring extraction.
 *
 * The fixture file is copied byte-identically into the frontend and run against the
 * client mirror there, so the preview and the persisted geometry agree.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require_ = createRequire(import.meta.url);
const radial = require_('../canonicalGeography/radialConstruction.js');
const { computeRadial, normalizeParams, normalizeOffset, boundaryRing, rayRingContacts, spokeAngle, direction } = radial;
const circles = require_('../canonicalGeography/circleConstruction.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'radial_construction_cases.v1.json');
const doc = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
/** A case boundary: a named ring, or an inline circle definition built by the shape creator's semantics. */
const ringOf = (name) => {
  if (typeof name === 'object') return circles.circleFromDefinition(name.circle.method, name.circle.points).ring;
  const r = boundaryRing(doc.rings[name].geometry_type, doc.rings[name].geometry);
  if (!r.ok) throw new Error(`fixture ring ${name}: ${r.reason}`);
  return r.ring;
};
/** JSON carries neither -0 nor non-finite numbers; the fixture spells them as strings. */
const num = (v) => (typeof v === 'string' ? Number(v) : v);

const run = (c) => computeRadial({
  center: c.center, inner: ringOf(c.inner), outer: ringOf(c.outer), count: c.count, offset_deg: c.offset_deg, omit_indices: c.omit_indices,
});

function checkCase(c, report) {
  const e = c.expect;
  expect(report.ok, 'ok').toBe(e.ok);
  expect(report.errors.map(x => ({ code: x.code, ring: x.ring, where: x.where }))).toEqual(e.errors);
  expect(report.spokes).toHaveLength(e.spokes.length === 0 ? 0 : (e.spoke_count ?? c.count));
  const listed = new Set(e.spokes.map(s => s.index));
  for (const want of e.spokes) {
    const got = report.spokes[want.index];
    const where = `${c.id} spoke ${want.index}`;
    expect(got.index, where).toBe(want.index);
    expect(got.status, where).toBe(want.status);
    expect(got.warnings.map(w => w.code), where).toEqual(want.warnings);
    if (want.angle_deg !== undefined) expect(got.angle_deg, where).toBe(want.angle_deg);
    if (want.geometry) {
      const tol = e.geometry_tolerance_wu ?? 0;
      expect(got.geometry, where).toHaveLength(2);
      got.geometry.forEach((p, k) => {
        expect(Math.abs(p.x - want.geometry[k].x), `${where} x${k}`).toBeLessThanOrEqual(tol);
        expect(Math.abs(p.z - want.geometry[k].z), `${where} z${k}`).toBeLessThanOrEqual(tol);
      });
    } else {
      expect(got.geometry, where).toBeUndefined();
    }
    if (want.error) {
      expect(got.error, where).toMatchObject({ code: want.error.code, ring: want.error.ring });
      if (want.error.point) expect(got.error.point, where).toEqual(want.error.point);
      if (want.error.t_range) expect(got.error.t_range, where).toEqual(want.error.t_range);
      if (want.error.from) expect({ from: got.error.from, to: got.error.to }, where).toEqual({ from: want.error.from, to: want.error.to });
      expect(got.error.message, where).toMatch(new RegExp(`^Spoke ${want.index} \\(\\d+\\.\\d{3}°\\): `));
    } else {
      expect(got.error, where).toBeUndefined();
    }
    if (want.crossings) {
      const code = want.warnings[0];
      expect(got.warnings.find(w => w.code === code).count, where).toBe(want.crossings);
    }
  }
  if (e.others_status) {
    for (const s of report.spokes) if (!listed.has(s.index)) expect(s.status, `${c.id} spoke ${s.index}`).toBe(e.others_status);
  }
}

describe('shared fixture cases', () => {
  it('fixture is synthetic, versioned, and covers every §15.14 group', () => {
    expect(doc.format).toBe('ruby_wheel.radial_construction_cases');
    expect(doc.version).toBe(1);
    expect(new Set(doc.cases.map(c => c.group))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 11]));
  });

  for (const c of doc.cases) {
    it(`${c.id}: ${c.description}`, () => checkCase(c, run(c)));
  }
});

describe('inline circle definitions use the shape creator circle semantics (§15.3.1)', () => {
  for (const c of doc.circles) {
    it(`${c.id}`, () => {
      const built = circles.circleFromDefinition(c.method, c.points);
      if (c.expect === null) { expect(built).toBeNull(); return; }
      expect(built.construction).toEqual({ type: 'circle', method: c.method, max_chord_error_m: 0.25, ...c.expect });
      expect(built.ring).toHaveLength(c.expect.segments);
      // Every vertex on the grid and on the circle (to the grid).
      for (const v of built.ring) {
        expect(Math.round(v.x * 1000) / 1000).toBe(v.x);
        expect(Math.abs(Math.hypot(v.x - c.expect.center.x, v.z - c.expect.center.z) - c.expect.radius)).toBeLessThan(0.001);
      }
    });
  }

  it('refuses an unknown method or the wrong number of points', () => {
    expect(circles.circleFromDefinition('ellipse', [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 0, z: 1 }])).toBeNull();
    expect(circles.circleFromDefinition('three_point', [{ x: 0, z: 0 }, { x: 1, z: 0 }])).toBeNull();
    expect(circles.circleFromDefinition('center_radius', [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }])).toBeNull();
  });
});

describe('collinear overlap versus a single on-ray vertex (§15.5)', () => {
  const X = { x: 1, z: 0 };
  const C = { x: 0, z: 0 };

  it('a forward multi-vertex run is an overlap with its t range and endpoints, never a crossing or touch', () => {
    const ring = [{ x: -50, z: -50 }, { x: 50, z: -50 }, { x: 50, z: 50 }, { x: 30, z: 50 }, { x: 30, z: 0 }, { x: 20, z: 0 }, { x: 20, z: 50 }, { x: -50, z: 50 }];
    const r = rayRingContacts(C, X, ring);
    expect(r.overlaps).toEqual([{ t_min: 20, t_max: 30, from: { x: 20, z: 0 }, to: { x: 30, z: 0 } }]);
    expect(r.touches).toEqual([]);
    expect(r.crossings.map(h => h.point)).toEqual([{ x: 50, z: 0 }]);
  });

  it('overlap is reported whatever the neighbouring sides (a run both of whose neighbours lie on opposite sides)', () => {
    // The run (20,0)-(30,0) is entered from below and left above: still an overlap, not a crossing.
    const ring = [{ x: -50, z: -50 }, { x: 20, z: -50 }, { x: 20, z: 0 }, { x: 30, z: 0 }, { x: 30, z: 50 }, { x: -50, z: 50 }];
    const r = rayRingContacts(C, X, ring);
    expect(r.overlaps).toHaveLength(1);
    expect(r.crossings).toEqual([]);
    const report = computeRadial({ center: C, inner: ring, outer: [{ x: -200, z: -200 }, { x: 200, z: -200 }, { x: 200, z: 200 }, { x: -200, z: 200 }], count: 1, offset_deg: 0 });
    expect(report.spokes[0]).toMatchObject({ status: 'invalid', error: { code: 'collinear_overlap', ring: 'inner', t_range: [20, 30] } });
  });

  it('a single on-ray vertex is a crossing when its neighbours are on opposite sides, a touch when on the same side', () => {
    const crossing = rayRingContacts(C, X, [{ x: -10, z: -10 }, { x: 20, z: -10 }, { x: 20, z: 0 }, { x: 25, z: 10 }, { x: -10, z: 10 }]);
    expect(crossing.crossings).toEqual([{ t: 20, point: { x: 20, z: 0 } }]);
    expect(crossing.overlaps).toEqual([]);
    const touch = rayRingContacts(C, X, [{ x: -10, z: -10 }, { x: 40, z: -10 }, { x: 40, z: 10 }, { x: 30, z: 10 }, { x: 25, z: 0 }, { x: 20, z: 10 }, { x: -10, z: 10 }]);
    expect(touch.touches).toEqual([{ t: 25, point: { x: 25, z: 0 } }]);
    expect(touch.overlaps).toEqual([]);
  });

  it('a vertex within one grid step of the ray counts as on it; two grid steps does not', () => {
    const ring = (z) => [{ x: -10, z: -10 }, { x: 40, z: -10 }, { x: 40, z: 10 }, { x: 30, z: 10 }, { x: 20, z }, { x: 10, z: 10 }, { x: -10, z: 10 }];
    const near = rayRingContacts(C, X, ring(0.001));
    expect(near.touches.map(h => h.point)).toEqual([{ x: 20, z: 0.001 }]);
    const far = rayRingContacts(C, X, ring(0.002));
    expect(far.touches).toEqual([]);
    expect(far.crossings.map(h => h.point)).toEqual([{ x: 40, z: 0 }]);
  });
});

describe('boundary ring extraction (§15.3.1)', () => {
  it('uses a polygon outer ring and ignores holes', () => {
    const outer = [{ x: -10, z: -10 }, { x: 10, z: -10 }, { x: 10, z: 10 }, { x: -10, z: 10 }];
    const hole = [{ x: -1, z: -1 }, { x: -1, z: 1 }, { x: 1, z: 1 }, { x: 1, z: -1 }];
    expect(boundaryRing('polygon', { outer, holes: [hole] })).toEqual({ ok: true, ring: outer });
    // The center may sit in a hole: holes are not boundaries.
    const report = computeRadial({ center: { x: 0, z: 0 }, inner: outer, outer: outer.map(p => ({ x: p.x * 10, z: p.z * 10 })), count: 1, offset_deg: 0 });
    expect(report.ok).toBe(true);
  });

  it('uses a closed linestring without its repeated closing vertex', () => {
    const line = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 0 }];
    expect(boundaryRing('linestring', line)).toEqual({ ok: true, ring: line.slice(0, -1) });
  });

  it('rejects an open linestring and a point', () => {
    expect(boundaryRing('linestring', [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }])).toMatchObject({ ok: false, reason: expect.stringMatching(/open linestring/) });
    expect(boundaryRing('point', { x: 0, z: 0 })).toMatchObject({ ok: false });
  });
});

describe('parameters and angles (§15.3.3, §15.4)', () => {
  it('normalizes offsets exactly as specified', () => {
    for (const [raw, want] of doc.parameters.offsets) {
      const got = normalizeOffset(num(raw));
      expect(Object.is(got, want) || (want === 0 && got === 0), `${raw} → ${got}`).toBe(true);
      expect(Object.is(got, -0), `${raw} must not normalize to -0`).toBe(false);
    }
  });

  it('rejects malformed counts, offsets and omissions, never rounding them', () => {
    for (const p of doc.parameters.rejected) {
      const res = normalizeParams({ ...p, offset_deg: typeof p.offset_deg === 'string' && !/^-?\d/.test(p.offset_deg) ? num(p.offset_deg) : p.offset_deg });
      expect(res.ok, JSON.stringify(p)).toBe(false);
    }
    // A numeric string offset is a string, not a number.
    expect(normalizeParams({ count: 4, offset_deg: '10' }).ok).toBe(false);
  });

  it('accepts valid parameters, normalizing only the offset', () => {
    for (const p of doc.parameters.accepted) {
      const res = normalizeParams(p);
      expect(res.ok, JSON.stringify(p)).toBe(true);
      expect(res.count).toBe(p.count);
      expect(res.omit_indices).toEqual(p.omit_indices ?? []);
    }
    expect(normalizeParams({ count: 360, offset_deg: -0.5 }).offset_deg).toBe(359.5);
  });

  it('computes θₙ = o + n·(360/N), wrapped once, with exact axis directions', () => {
    expect([0, 1, 2, 3].map(n => spokeAngle(90, n, 4))).toEqual([90, 180, 270, 0]);
    expect(spokeAngle(22.5, 7, 8)).toBe(337.5);
    expect(direction(0)).toEqual({ x: 1, z: 0 });
    expect(direction(90)).toEqual({ x: 0, z: 1 });
    expect(direction(180)).toEqual({ x: -1, z: 0 });
    expect(direction(270)).toEqual({ x: 0, z: -1 });
  });

  it('angles run from +X toward +Z: 90° points along +Z (image-down on an unrotated layer)', () => {
    const sq = (h) => [{ x: -h, z: -h }, { x: h, z: -h }, { x: h, z: h }, { x: -h, z: h }];
    const r = computeRadial({ center: { x: 0, z: 0 }, inner: sq(10), outer: sq(100), count: 1, offset_deg: 90 });
    expect(r.spokes[0].geometry).toEqual([{ x: 0, z: 10 }, { x: 0, z: 100 }]);
  });
});

describe('determinism and rotation (§15.4, case 10)', () => {
  const regular = (r, k) => Array.from({ length: k }, (_, i) => ({
    x: Math.round(r * Math.cos((2 * Math.PI * i) / k) * 1000) / 1000, z: Math.round(r * Math.sin((2 * Math.PI * i) / k) * 1000) / 1000,
  }));
  const inner = regular(100, 64);
  const outer = regular(300, 64);
  const base = { center: { x: 3.25, z: -7.5 }, inner, outer };

  it('identical inputs give byte-identical reports', () => {
    const a = computeRadial({ ...base, count: 7, offset_deg: 12.345 });
    const b = computeRadial({ ...base, count: 7, offset_deg: 12.345 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  for (const N of [3, 8]) {
    it(`θ₀ + 360/N gives the same lines with indices shifted by one (N=${N})`, () => {
      const a = computeRadial({ ...base, count: N, offset_deg: 10 });
      const b = computeRadial({ ...base, count: N, offset_deg: 10 + 360 / N });
      for (let n = 0; n < N; n++) {
        expect(b.spokes[n].geometry).toEqual(a.spokes[(n + 1) % N].geometry);
        expect(b.spokes[n].angle_deg).toBe(a.spokes[(n + 1) % N].angle_deg);
      }
    });
  }

  it('changing θ₀ moves every spoke, and reverting restores the identical report', () => {
    const a = computeRadial({ ...base, count: 8, offset_deg: 10 });
    const b = computeRadial({ ...base, count: 8, offset_deg: 15 });
    for (let n = 0; n < 8; n++) {
      expect(b.spokes[n].angle_deg).toBe(a.spokes[n].angle_deg + 5);
      expect(b.spokes[n].geometry).not.toEqual(a.spokes[n].geometry);
    }
    expect(JSON.stringify(computeRadial({ ...base, count: 8, offset_deg: 10 }))).toBe(JSON.stringify(a));
  });

  it('never modifies its input rings', () => {
    const before = JSON.stringify(base);
    computeRadial({ ...base, count: 360, offset_deg: 0.5 });
    expect(JSON.stringify(base)).toBe(before);
  });
});

describe('performance bound (§15.5)', () => {
  it('N = 360 against two 20,000-vertex rings stays linear (well under a second)', () => {
    const regular = (r, k) => Array.from({ length: k }, (_, i) => ({
      x: Math.round(r * Math.cos((2 * Math.PI * i) / k) * 1000) / 1000, z: Math.round(r * Math.sin((2 * Math.PI * i) / k) * 1000) / 1000,
    }));
    const inner = regular(1000, 20000);
    const outer = regular(3000, 20000);
    const t0 = performance.now();
    const r = computeRadial({ center: { x: 0.5, z: 0.25 }, inner, outer, count: 360, offset_deg: 0.123 });
    const ms = performance.now() - t0;
    expect(r.spokes.filter(s => s.status === 'valid')).toHaveLength(360);
    expect(ms).toBeLessThan(2000);
  });
});
