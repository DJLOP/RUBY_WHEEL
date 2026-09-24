/**
 * Explicit-water crossing means interior traversal (final WP3 remediation).
 *
 * `crosses_water` is true for explicit water only when a positive-length stretch of the
 * route lies in the open interior of an accepted water polygon. Running along its edge (a
 * quay), touching it at one point or one corner, or passing through one of its holes is
 * not a crossing. Decided exactly by `linestringPieces`: the route is cut at every contact
 * with the water boundary, and each positive-length piece is located at an exact interior
 * point — 'inside' counts, 'boundary' and 'outside' do not.
 *
 * The water body: a 100 × 100 basin at x 100–200, z 0–100, with a 40 × 40 hole (an islet
 * cut out of the water) at x 130–170, z 30–70. No land is accepted and the query is an
 * ad-hoc bbox under the partial-coverage city, so nothing but explicit water can make
 * crosses_water true.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const { setupCanonical, route } = require_('./helpers/canonicalApi.js');
const { linestringPieces } = require_('../canonicalGeography/geometry.js');

const P = (x, z) => ({ x, z });
const ring = (x0, z0, x1, z1) => [P(x0, z0), P(x1, z0), P(x1, z1), P(x0, z1)];
const BASIN = { outer: ring(100, 0, 200, 100), holes: [ring(130, 30, 170, 70).reverse()] };

const CASES = {
  shoreline: [P(50, 0), P(250, 0)], // overlaps the basin's bottom edge for 100 wu
  tangent: [P(120, -20), P(150, 0), P(180, -20)], // touches the bottom edge at (150, 0) only
  corner: [P(80, 20), P(120, -20)], // passes through the corner (100, 0) only
  crossing: [P(50, 15), P(250, 15)],
  boundaryToInterior: [P(100, 15), P(120, 15)],
  interiorToBoundary: [P(120, 15), P(200, 15)],
  withinHole: [P(140, 50), P(160, 50)],
  acrossHole: [P(130, 50), P(170, 50)], // from hole edge to hole edge, through the hole
  throughRingAndHole: [P(110, 50), P(190, 50)], // water, then the hole, then water
};

const EXPECTED = {
  shoreline: false,
  tangent: false,
  corner: false,
  crossing: true,
  boundaryToInterior: true,
  interiorToBoundary: true,
  withinHole: false,
  acrossHole: false,
  throughRingAndHole: true,
};

describe('linestringPieces reports interior separately from the closed region', () => {
  it.each(Object.keys(CASES))('%s', (name) => {
    const pieces = linestringPieces(CASES[name], [BASIN]);
    expect(pieces.some(p => p.interior.length > 0)).toBe(EXPECTED[name]);
    // Every piece has positive length; a point contact is only a cut.
    for (const p of pieces) expect(p.to).toBeGreaterThan(p.from);
  });

  it('keeps a shoreline piece within the closed region but out of the interior', () => {
    const along = linestringPieces(CASES.shoreline, [BASIN]).find(p => p.from === 0.25);
    expect(along).toMatchObject({ to: 0.75, within: [0], interior: [] });
  });
});

describe('crosses_water in the bundle', () => {
  let routes;

  beforeAll(async () => {
    const { api } = await setupCanonical();
    await api.accepted('features', {
      feature_class: 'water', kind: 'basin', geometry_type: 'polygon', geometry: BASIN, constraint_strength: 'hard',
    });
    const ids = {};
    for (const [name, line] of Object.entries(CASES)) {
      ids[name] = (await api.accepted('features', route(line, { kind: name === 'shoreline' ? 'quay_edge' : 'road' }))).id;
    }
    const bundle = (await api.anon.post('/query', { bbox: { min_x: 0, min_z: -50, max_x: 300, max_z: 150 } })).body;
    routes = Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, bundle.routes.find(r => r.id === id)]));
  });

  it.each([
    ['A: a quay running along the water edge', 'shoreline'],
    ['B: a route tangent to the edge at one point', 'tangent'],
    ['C: a route touching only a corner', 'corner'],
    ['G: a route wholly inside the hole', 'withinHole'],
    ['G: a route across the hole from edge to edge', 'acrossHole'],
  ])('%s does not cross water', (_label, name) => {
    expect(routes[name].crosses_water).toBe(false);
  });

  it.each([
    ['D: a route through the water', 'crossing'],
    ['E: a route from the edge into the interior', 'boundaryToInterior'],
    ['F: a route from the interior to the edge', 'interiorToBoundary'],
    ['G: a route through water on both sides of the hole', 'throughRingAndHole'],
  ])('%s crosses water', (_label, name) => {
    expect(routes[name].crosses_water).toBe(true);
  });
});
