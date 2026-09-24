/**
 * Exact route classification (WP3 remediation, finding 1).
 *
 * `crosses_water` and `leaves_land` used to be decided by sampling route vertices and
 * segment midpoints, which misses a narrow channel between samples, a brief exit through a
 * concave shoreline, and anything the route crosses beyond the query's extent and halo.
 * They are now exact: explicit water by linestring/polygon intersection against water
 * loaded from the route's own bbox; land coverage by cutting each segment at every land
 * boundary it meets (`linestringPieces`) and locating each piece exactly.
 *
 * Every geometry below is chosen so the vertices and midpoints all say "no" — the old
 * sampler's answer — while the exact answer is "yes", or the reverse for the near misses.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const { setupCanonical, route, square, boundary, scope } = require_('./helpers/canonicalApi.js');
const { linestringPieces } = require_('../canonicalGeography/geometry.js');

const CITY = 1;
const P = (x, z) => ({ x, z });
const poly = (...pts) => ({ outer: pts.map(([x, z]) => P(x, z)), holes: [] });
const rect = (x0, z0, x1, z1) => poly([x0, z0], [x1, z0], [x1, z1], [x0, z1]);

/** A U: a 300 × 100 block with a notch x 60–90 cut down from the top to z = 40. */
const U = poly([0, 0], [300, 0], [300, 100], [90, 100], [90, 40], [60, 40], [60, 100], [0, 100]);

describe('linestringPieces (exact segment coverage)', () => {
  const covered = (line, polygons) => linestringPieces(line, polygons).every(pc => pc.within.length > 0);

  it('treats a segment wholly inside land as covered', () => {
    expect(covered([P(20, 20), P(280, 20)], [U])).toBe(true);
  });

  it('treats a segment running along a land boundary as covered', () => {
    expect(covered([P(0, 0), P(300, 0)], [U])).toBe(true);
    expect(covered([P(60, 40), P(90, 40)], [U])).toBe(true); // the notch floor
  });

  it('finds the exit through a concavity even when endpoints and midpoint are on land', () => {
    const pieces = linestringPieces([P(20, 70), P(280, 70)], [U]);
    expect(pieces.map(p => [p.from, p.to, p.within.length > 0])).toEqual([
      [0, 40 / 260, true], [40 / 260, 70 / 260, false], [70 / 260, 1, true],
    ]);
  });

  it('finds a true gap between two land polygons', () => {
    const pieces = linestringPieces([P(50, 50), P(170, 50)], [rect(0, 0, 100, 100), rect(110, 0, 210, 100)]);
    expect(pieces.map(p => p.within)).toEqual([[0], [], [1]]);
  });

  it('treats a segment wholly outside land as uncovered', () => {
    expect(linestringPieces([P(400, 0), P(500, 10)], [U]).map(p => p.within)).toEqual([[]]);
  });

  it('is exact at a notch corner: grazing it stays covered, passing into the notch does not', () => {
    // (40,60)→(80,20) touches the notch corner (60,40) and only that point: left prong, then base.
    expect(covered([P(40, 60), P(80, 20)], [U])).toBe(true);
    // (40,20)→(80,60) passes through the same corner into the notch.
    expect(linestringPieces([P(40, 20), P(80, 60)], [U]).map(p => [p.from, p.within.length > 0])).toEqual([[0, true], [0.5, false]]);
  });
});

describe('route classification in the bundle', () => {
  let api;
  beforeEach(async () => { ({ api } = await setupCanonical()); });

  const water = (geometry) => api.accepted('features', {
    feature_class: 'water', kind: 'channel', geometry_type: 'polygon', geometry, constraint_strength: 'hard',
  });
  const landPolygon = (geometry) => api.accepted('features', {
    feature_class: 'land', geometry_type: 'polygon', geometry, constraint_strength: 'hard',
  });
  const routeIn = async (body, id) => (await api.anon.post('/query', body)).body.routes.find(r => r.id === id);

  it('A: detects a narrow explicit water crossing between a sloped segment\'s samples', async () => {
    // Route (0,0)→(300,90); at x = 70–72 it is at z = 21–21.6, inside the strip. Endpoints
    // and the midpoint (150,45) are all dry.
    await water(rect(70, 0, 72, 40));
    const r = await api.accepted('features', route([P(0, 0), P(300, 90)]));
    expect(await routeIn({ bbox: { min_x: -10, min_z: -10, max_x: 310, max_z: 100 } }, r.id)).toMatchObject({ crosses_water: true });
  });

  it('B: does not claim a crossing for a narrow channel that just misses the route', async () => {
    await water(rect(70, 25, 72, 40)); // the route is at z ≤ 21.6 there
    const r = await api.accepted('features', route([P(0, 0), P(300, 90)]));
    expect(await routeIn({ bbox: { min_x: -10, min_z: -10, max_x: 310, max_z: 100 } }, r.id)).toMatchObject({ crosses_water: false });
  });

  it('C: detects a route leaving a concave island between on-land samples', async () => {
    await landPolygon(U);
    const r = await api.accepted('features', route([P(20, 70), P(280, 70)])); // midpoint (150,70) is on land
    expect(await routeIn({ scope_id: CITY }, r.id)).toMatchObject({ leaves_land: true });
  });

  it('D: keeps a route that stays on the same island, or along its shore, on land', async () => {
    await landPolygon(U);
    const across = await api.accepted('features', route([P(20, 20), P(280, 20)]));
    const shore = await api.accepted('features', route([P(0, 0), P(300, 0), P(300, 100)], { kind: 'quay_edge' }));
    const city = (await api.anon.post('/query', { scope_id: CITY })).body;
    expect(city.routes.find(r => r.id === across.id)).toMatchObject({ leaves_land: false, crosses_water: false });
    expect(city.routes.find(r => r.id === shore.id)).toMatchObject({ leaves_land: false, crosses_water: false });
  });

  describe('complete versus partial coverage', () => {
    let districtId;
    let routeId;
    beforeEach(async () => {
      await landPolygon(U);
      const b = await api.draft('features', boundary(-50, -50, 450));
      const d = await api.draft('scopes', scope('harbour', 'district', CITY, { boundary_feature_id: b.id, land_coverage: 'complete' }));
      api.expectStatus(await api.accept('features', b), 200, 'accept boundary');
      districtId = api.expectStatus(await api.accept('scopes', d), 200, 'accept district').record.id;
      routeId = (await api.accepted('features', route([P(20, 70), P(280, 70)]))).id;
    });

    it('E: counts the off-land stretch inside a complete-coverage extent as water', async () => {
      expect(await routeIn({ scope_id: districtId }, routeId)).toMatchObject({ crosses_water: true, leaves_land: true });
    });

    it('F: leaves the same stretch unknown, not water, under partial coverage', async () => {
      // The city is partial: off-land there is unknown ground.
      expect(await routeIn({ scope_id: CITY }, routeId)).toMatchObject({ crosses_water: false, leaves_land: true });
    });
  });

  it('G: classifies a route against water and land beyond the query extent and halo', async () => {
    const start = await landPolygon(rect(0, 0, 100, 40));
    const strip = await water(rect(800, 0, 802, 40));
    await landPolygon(rect(850, 0, 950, 40));
    const r = await api.accepted('features', route([P(20, 20), P(900, 20)]));

    const b = (await api.anon.post('/query', { bbox: { min_x: 0, min_z: 0, max_x: 40, max_z: 40 } })).body;
    // The channel and the far island are not in this bundle ...
    expect(b.water.map(w => w.id)).not.toContain(strip.id);
    expect(b.land.map(l => l.id)).toEqual([start.id]);
    // ... but the route that runs over them is, and says so.
    expect(b.routes.find(x => x.id === r.id)).toMatchObject({ relation: 'boundary', crosses_water: true, leaves_land: true });

    // What lies beyond the halo shapes the route's classification, so it is a digest input:
    // revising the far channel changes the digest of this small bbox.
    const before = b.digest;
    const rev = (await api.post(`/features/${strip.id}/revise`)).body;
    const edited = (await api.patch(`/features/${rev.id}`, { geometry: square(860, 0, 5) })).body;
    api.expectStatus(await api.accept('features', edited), 200, 'accept channel revision');
    const after = (await api.anon.post('/query', { bbox: { min_x: 0, min_z: 0, max_x: 40, max_z: 40 } })).body;
    expect(after.digest).not.toBe(before);
  });
});
