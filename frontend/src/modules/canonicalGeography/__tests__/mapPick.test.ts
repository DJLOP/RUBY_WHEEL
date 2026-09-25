/**
 * Hit testing a map click against canonical geometry (WP6 remediation) — no raycasting.
 */

import { describe, it, expect } from 'vitest';
import { createMapPickStore, featuresAt, requestPick } from '../mapPick';
import { boundaryFeature, land, routeFeature } from './wp6Fixtures';

const point = (id: number, x: number, z: number) => land(id, x, z, 0, {
  feature_class: 'site', geometry_type: 'point', geometry: { x, z }, bbox: { min_x: x, min_z: z, max_x: x, max_z: z }, name: `Point ${id}` });

describe('featuresAt', () => {
  const isle = land(1, 0, 0, 100);
  const footprint = land(2, 10, 10, 10, { feature_class: 'site', anchor_id: 7, part_role: 'footprint' });
  const road = routeFeature(3, { geometry: [{ x: 0, z: 50 }, { x: 100, z: 50 }], bbox: { min_x: 0, min_z: 50, max_x: 100, max_z: 50 } });
  const district = boundaryFeature(4, -50, -50, 100); // edge at x = 50 crosses the island
  const node = point(5, 80, 80);
  const all = [isle, footprint, road, district, node];

  it('selects the land polygon a click lands inside', () => {
    expect(featuresAt(all, { x: 70, z: 20 }, 1)).toEqual([1]);
  });

  it('orders overlaps most specific first: point, line, boundary edge, then smaller polygons', () => {
    expect(featuresAt(all, { x: 15, z: 15 }, 1)).toEqual([2, 1]);
    expect(featuresAt(all, { x: 50, z: 50.5 }, 1)).toEqual([3, 4, 1]);
    expect(featuresAt(all, { x: 80.5, z: 80 }, 1)).toEqual([5, 1]);
  });

  it('hits a scope boundary on its edge only, not across its whole interior', () => {
    expect(featuresAt(all, { x: 20, z: 30 }, 1)).toEqual([1]); // inside the district, away from its edge
    expect(featuresAt(all, { x: 50.4, z: 30 }, 1)).toEqual([4, 1]); // on the district edge
  });

  it('uses the tolerance for points and lines, and ignores retired rows', () => {
    expect(featuresAt([road], { x: 20, z: 53 }, 1)).toEqual([]);
    expect(featuresAt([road], { x: 20, z: 53 }, 5)).toEqual([3]);
    expect(featuresAt([{ ...isle, lifecycle_state: 'retired' }], { x: 5, z: 5 }, 1)).toEqual([]);
    expect(featuresAt(all, { x: 500, z: 500 }, 1)).toEqual([]);
  });

  it('numbers each click request, so identical results are still separate requests', () => {
    const store = createMapPickStore();
    store.update(s => requestPick(s, { x: 1, z: 1 }, [1]));
    store.update(s => requestPick(s, { x: 1, z: 1 }, [1]));
    expect(store.getState().request).toMatchObject({ nonce: 2, ids: [1] });
    expect(store.getState().inspecting).toBe(true);
  });
});
