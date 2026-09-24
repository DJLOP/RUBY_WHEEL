/**
 * The generator seam (plan §6.1) against the shared backend fixture.
 *
 * `fixtures/canonical_query_bundles.v1.json` is a byte-identical copy of the backend's
 * fixture, whose bundles the backend test proves are exactly what the live query returns.
 * The probe expectations in it are plan §4.2 stated by hand; here the adapter must agree.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { createCanonicalConstraints, pointInCanonicalPolygon, FOOTPRINT_CONFLICT_ORDER } from '../constraints';
import type { CanonicalQueryBundle, CanonicalPolygon } from '../types';

const LOCAL = resolve(__dirname, 'fixtures', 'canonical_query_bundles.v1.json');
const BACKEND = resolve(__dirname, '../../../../../backend/__tests__/fixtures/canonical_query_bundles.v1.json');

interface Probe { x: number; z: number; expect: string }
interface Fixture {
  ids: Record<string, number>;
  bundles: Record<'city' | 'east' | 'islandA', CanonicalQueryBundle>;
  probes: Record<string, {
    classify: Probe[];
    protected?: { x: number; z: number; expect: boolean }[];
    footprints?: { rect: { x: number; z: number; width: number; depth: number }; expect: string[] }[];
  }>;
}

const fixture: Fixture = JSON.parse(readFileSync(LOCAL, 'utf8'));
const { ids, bundles } = fixture;
const constraintsFor = (name: keyof Fixture['bundles']) => createCanonicalConstraints(bundles[name]);

const square = (x: number, z: number, s: number) => [{ x, z }, { x: x + s, z }, { x: x + s, z: z + s }, { x, z: z + s }];

describe('shared fixture', () => {
  it.runIf(existsSync(BACKEND))('is byte-identical to the backend copy', () => {
    expect(readFileSync(LOCAL, 'utf8').replace(/\r\n/g, '\n')).toBe(readFileSync(BACKEND, 'utf8').replace(/\r\n/g, '\n'));
  });
});

describe('classifyPoint (plan §4.2)', () => {
  for (const name of ['city', 'east', 'islandA'] as const) {
    it.each(fixture.probes[name].classify)(`${name}: (%s) is as the fixture says`, (probe) => {
      expect(constraintsFor(name).classifyPoint(probe.x, probe.z)).toBe(probe.expect);
    });
  }

  it('treats a hole in land as unknown under partial coverage and as water under complete', () => {
    const holed: CanonicalPolygon = { outer: square(0, 0, 100), holes: [square(40, 40, 20).reverse()] };
    const base = structuredClone(bundles.islandA);
    base.land = [{ ...base.land![0], geometry: holed }];
    base.water = [];
    expect(createCanonicalConstraints(base).classifyPoint(50, 50)).toBe('unknown');
    expect(createCanonicalConstraints(base).classifyPoint(10, 10)).toBe('land');

    const complete = structuredClone(base);
    complete.water_complement = { rule: 'complete', coverage_scope_id: 1, extent: [{ outer: square(-10, -10, 120), holes: [] }] };
    expect(createCanonicalConstraints(complete).classifyPoint(50, 50)).toBe('water');
    expect(createCanonicalConstraints(complete).classifyPoint(200, 200)).toBe('unknown'); // outside the complete extent
  });
});

describe('isProtected and footprintConflicts', () => {
  const city = constraintsFor('city');

  it.each(fixture.probes.city.protected!)('protected at (%s)', (probe) => {
    expect(city.isProtected(probe.x, probe.z)).toBe(probe.expect);
  });

  it.each(fixture.probes.city.footprints!)('footprint %# reports the fixture reasons', (probe) => {
    expect(city.footprintConflicts(probe.rect)).toEqual(probe.expect);
  });

  it('reports reasons in one fixed order', () => {
    expect(FOOTPRINT_CONFLICT_ORDER).toEqual(['off_land', 'in_water', 'unknown_ground', 'protected', 'anchor_part', 'hard_route']);
  });

  it('widens a hard route by its width, and ignores soft routes', () => {
    // The bridge is hard, 4 wu wide, along z = 90: a footprint 1.5 wu clear of its centreline still hits it.
    expect(city.footprintConflicts({ x: 125, z: 92.5, width: 1, depth: 1 })).toContain('hard_route');
    expect(city.footprintConflicts({ x: 125, z: 94, width: 1, depth: 1 })).not.toContain('hard_route');
    const soft = structuredClone(bundles.city);
    soft.routes = soft.routes!.map(r => ({ ...r, constraint_strength: 'soft' as const }));
    expect(createCanonicalConstraints(soft).footprintConflicts({ x: 125, z: 91, width: 2, depth: 2 })).not.toContain('hard_route');
  });
});

describe('anchors, extent, obligations and immutability', () => {
  it('finds anchor parts at a point, with a tolerance for points and lines', () => {
    const city = constraintsFor('city');
    expect(city.anchorPartsAt(20, 20)).toEqual([{ anchor_id: ids.arboretum, feature_id: ids.nodeA, part_role: 'node' }]);
    expect(city.anchorPartsAt(20.5, 20)).toEqual([]);
    expect(city.anchorPartsAt(20.5, 20, 1).map(h => h.feature_id)).toEqual([ids.nodeA]);
  });

  it('tells the extent from its halo', () => {
    const island = constraintsFor('islandA');
    expect(island.inExtent(10, 10)).toBe(true);
    expect(island.inExtent(125, 50)).toBe(false); // the basin: context only
    expect(island.classifyPoint(125, 50)).toBe('water');
  });

  it('returns the cross-boundary obligations an island must honour', () => {
    const island = constraintsFor('islandA');
    expect(island.boundaryObligations().map(c => [c.id, c.tag])).toEqual([
      [ids.bridgeLink, 'crossing'], [ids.utility, 'crossing'], [ids.ferry, 'external_obligation'],
    ]);
    expect(constraintsFor('city').boundaryObligations()).toEqual([]);
  });

  it('answers immutability from the bundle, by entity type and id', () => {
    const city = constraintsFor('city');
    expect(city.isImmutable({ entity_type: 'feature', id: ids.islandA })).toBe(true);
    expect(city.isImmutable({ entity_type: 'anchor', id: ids.arena })).toBe(true);
    expect(city.isImmutable({ entity_type: 'feature', id: 9999 })).toBe(false);
  });

  it('surfaces hard protected regions and hard site polygons as SpatialGrid-compatible obstacles', () => {
    // The fixture's only hard polygon obstacle is the 20 × 20 no-build zone at (160, 60).
    expect(constraintsFor('city').obstacles()).toEqual([{ x: 170, z: 70, width: 20, depth: 20 }]);
  });

  it('carries the digest and readiness through untouched', () => {
    const city = constraintsFor('city');
    expect(city.digest).toBe(bundles.city.digest);
    expect(city.bundle.readiness.unplaced_must_exist).toEqual([ids.arena]);
  });
});

describe('pointInCanonicalPolygon', () => {
  const p: CanonicalPolygon = { outer: square(0, 0, 10), holes: [square(4, 4, 2).reverse()] };
  it.each([
    [5, 1, true], [0, 5, true], [5, 5, false], [4, 5, true], [11, 5, false],
  ])('(%s, %s) → %s', (x, z, expected) => {
    expect(pointInCanonicalPolygon(x, z, p)).toBe(expected);
  });
});
