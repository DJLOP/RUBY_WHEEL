/**
 * The generator-facing query (plan §5.3, §6, WP3): request validation, accepted-canon-only
 * content, inside/boundary/context classification with halo, the scope chain, land/water
 * semantics, routes, anchors and unplaced obligations, readiness, connection tagging,
 * immutable ids and metrics.
 *
 * Most assertions read one archipelago built once for the file and queried through the
 * store directly (the query only reads). HTTP shape, authorization and emit behaviour are
 * checked through the router; anything that changes canon builds its own archipelago.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const { setupCanonical, route, square } = require_('./helpers/canonicalApi.js');
const { buildArchipelago, CITY } = require_('./helpers/canonicalArchipelago.js');
const { createStore } = require_('../canonicalGeography/store.js');
const { run } = require_('./helpers/testDb.js');

let shared; // { db, ids, store }

beforeAll(async () => {
  const { db, api } = await setupCanonical();
  const ids = await buildArchipelago(api);
  shared = { db, ids, store: createStore(db) };
});

const query = (body) => shared.store.query(body);
const idsOf = (list) => (list || []).map(e => e.id);
const relations = (list) => Object.fromEntries((list || []).map(e => [e.id, e.relation]));

async function rejection(body) {
  try {
    await query(body);
  } catch (err) {
    return err;
  }
  throw new Error(`expected ${JSON.stringify(body)} to be refused`);
}

describe('request validation', () => {
  it.each([
    ['no target', {}],
    ['two targets', { scope_id: 1, feature_id: 1 }],
    ['an unknown field', { scope_id: 1, states: 'draft' }],
    ['a non-integer scope id', { scope_id: '1' }],
    ['an inverted bbox', { bbox: { min_x: 10, min_z: 0, max_x: 0, max_z: 10 } }],
    ['a bbox with a non-finite corner', { bbox: { min_x: 0, min_z: 0, max_x: Infinity, max_z: 10 } }],
    ['a bbox with an extra key', { bbox: { min_x: 0, min_z: 0, max_x: 1, max_z: 1, y: 0 } }],
    ['a bbox beyond the world limit', { bbox: { min_x: 0, min_z: 0, max_x: 30000, max_z: 10 } }],
    ['a self-intersecting polygon', { polygon: { outer: [{ x: 0, z: 0 }, { x: 10, z: 10 }, { x: 10, z: 0 }, { x: 0, z: 10 }] } }],
    ['a negative halo', { scope_id: 1, halo_wu: -1 }],
    ['an unknown include', { scope_id: 1, include: ['land', 'buildings'] }],
  ])('refuses %s with 400', async (_label, body) => {
    expect((await rejection(body)).status).toBe(400);
  });

  it('answers 404 for scopes and features that are not accepted canon', async () => {
    const { ids } = shared;
    for (const body of [
      { scope_id: 999 }, { scope_id: ids.draftScope },
      { feature_id: 999 }, { feature_id: ids.draftIsland }, { feature_id: ids.proposedWater }, { feature_id: ids.retiredIsland },
    ]) {
      expect((await rejection(body)).status).toBe(404);
    }
  });

  it('refuses a feature extent that is not a polygon', async () => {
    const err = await rejection({ feature_id: shared.ids.bridge });
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/polygon/);
  });
});

describe('over HTTP', () => {
  let api;
  let emits;
  beforeEach(async () => { ({ api, emits } = await setupCanonical()); });

  it('is a public read that never emits and never creates a row', async () => {
    const res = await api.anon.post('/query', { scope_id: CITY });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ bundle_version: 1, scope: { ref: { type: 'scope', id: CITY }, kind: 'city' } });
    expect((await api.player.post('/query', { scope_id: CITY })).status).toBe(200);
    expect(emits).toEqual([]);
    expect((await api.get('/features?states=draft,proposed,accepted,retired')).body).toEqual([]);
  });

  it('reports a refused query as JSON with its status', async () => {
    const res = await api.anon.post('/query', { scope_id: 1, bbox: { min_x: 0, min_z: 0, max_x: 1, max_z: 1 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exactly one/);
  });
});

describe('only accepted canon enters a bundle', () => {
  it('never carries a draft, proposal or retired row, in any section', async () => {
    const { ids } = shared;
    const b = await query({ bbox: { min_x: -1000, min_z: -1000, max_x: 1000, max_z: 1000 }, halo_wu: 500 });
    const featureIds = [...b.land, ...b.water, ...b.routes, ...b.protected, ...b.sites].map(f => f.id);
    for (const noise of [ids.draftIsland, ids.proposedWater, ids.retiredIsland]) expect(featureIds).not.toContain(noise);
    expect(b.anchors.map(a => a.id)).not.toContain(ids.draftAnchor);
    expect(b.immutable).not.toContainEqual({ entity_type: 'scope', id: ids.draftScope });

    const city = await query({ scope_id: CITY });
    expect(city.scope.descendant_scope_ids).toEqual([ids.west, ids.westPair, ids.east, ids.artisan].sort((a, b2) => a - b2));
    expect(city.readiness.unplaced_must_exist).not.toContain(ids.draftAnchor);
  });
});

describe('extent classification and halo', () => {
  it('classifies member islands as inside a district, and features crossing its edge as boundary', async () => {
    const { ids } = shared;
    const b = await query({ scope_id: ids.west });
    expect(relations(b.land)).toEqual({ [ids.islandA]: 'inside', [ids.islandB]: 'inside' });
    expect(relations(b.water)).toEqual({ [ids.canal]: 'boundary' }); // the basin lies between the islands, outside both
    expect(relations(b.routes)).toEqual({ [ids.bridge]: 'boundary' });
    expect(b.scope.extent).toHaveLength(2);
    expect(b.scope.extent_feature_ids).toEqual([ids.islandA, ids.islandB]);
  });

  it('shows neighbours only as context, and only within the halo', async () => {
    const { ids } = shared;
    const bare = await query({ feature_id: ids.islandA });
    expect(idsOf(bare.land)).toEqual([ids.islandA]);
    expect(relations(bare.land)[ids.islandA]).toBe('inside'); // the extent's own island

    const haloed = await query({ feature_id: ids.islandA, halo_wu: 60 });
    expect(relations(haloed.land)).toEqual({ [ids.islandA]: 'inside', [ids.islandB]: 'context' });
    expect(relations(haloed.water)).toEqual({ [ids.canal]: 'boundary', [ids.basin]: 'context' });
    expect(relations(haloed.protected)).toEqual({ [ids.noBuild]: 'context' });
    expect(idsOf(haloed.land)).not.toContain(ids.islandC);
  });

  it('marks a feature that covers the whole extent as boundary, and one within it as inside', async () => {
    const { ids } = shared;
    const b = await query({ bbox: { min_x: 10, min_z: 10, max_x: 30, max_z: 30 } });
    expect(relations(b.land)).toEqual({ [ids.islandA]: 'boundary' });
    expect(relations(b.sites)).toEqual({ [ids.nodeA]: 'inside' });
  });

  it('treats a polygon extent exactly like the equivalent bbox, apart from its ref', async () => {
    const bbox = await query({ bbox: { min_x: -20, min_z: -20, max_x: 110, max_z: 110 } });
    const poly = await query({ polygon: square(-20, -20, 130) });
    expect(relations(poly.land)).toEqual(relations(bbox.land));
    expect(relations(poly.water)).toEqual(relations(bbox.water));
    expect(poly.scope.kind).toBe('polygon');
    expect(bbox.scope.ref).toEqual({ type: 'bbox', bbox: { min_x: -20, min_z: -20, max_x: 110, max_z: 110 } });
  });

  it('returns no geometry for a scope with no extent yet, but still its obligations', async () => {
    const { ids } = shared;
    const b = await query({ scope_id: ids.artisan, halo_wu: 100 });
    expect(b.scope.extent).toEqual([]);
    expect([...b.land, ...b.water, ...b.routes, ...b.sites, ...b.protected]).toEqual([]);
    // guild-office is placed (with an unverified part), so it is not an unplaced obligation.
    expect(b.anchors).toEqual([]);
  });
});

describe('scope hierarchy', () => {
  it('gives an island query its full ancestor chain', async () => {
    const { ids } = shared;
    const b = await query({ feature_id: ids.islandA });
    expect(b.scope.kind).toBe('island');
    expect(b.scope.chain.map(s => [s.id, s.scope_kind])).toEqual([[CITY, 'city'], [ids.west, 'district'], [ids.westPair, 'island_group']]);
  });

  it('keeps island groups usable as generation scopes, under their district', async () => {
    const { ids } = shared;
    const b = await query({ scope_id: ids.westPair });
    expect(b.scope).toMatchObject({ kind: 'island_group', scope_key: 'west-pair', revision: 1 });
    expect(b.scope.chain.map(s => s.id)).toEqual([CITY, ids.west]);
    expect(b.scope.descendant_scope_ids).toEqual([]);
  });

  it('takes an island chain from explicit membership only, never from geometry', async () => {
    const { ids } = shared;
    // Isle C lies inside east's boundary but is not listed as a member of it.
    const b = await query({ feature_id: ids.islandC });
    expect(b.scope.chain.map(s => s.id)).toEqual([CITY]);
  });
});

describe('land and water', () => {
  it('reports explicit water with navigability, defaulting to unknown', async () => {
    const { ids } = shared;
    const b = await query({ scope_id: CITY });
    const water = Object.fromEntries(b.water.map(w => [w.id, w]));
    expect(water[ids.canal]).toMatchObject({ kind: 'channel', navigable: 'yes' });
    expect(water[ids.basin]).toMatchObject({ kind: 'basin', navigable: 'unknown' });
  });

  it('applies water-by-complement only under complete coverage', async () => {
    const { ids } = shared;
    const west = await query({ scope_id: ids.west });
    expect(west.scope.land_coverage).toBe('partial');
    expect(west.water_complement).toEqual({ rule: 'partial', coverage_scope_id: null, extent: [] });

    const east = await query({ scope_id: ids.east });
    expect(east.scope.land_coverage).toBe('complete');
    expect(east.water_complement.rule).toBe('complete');
    expect(east.water_complement.coverage_scope_id).toBe(ids.east);
    expect(east.water_complement.extent).toEqual(east.scope.extent);
  });
});

describe('routes', () => {
  it('flags a route that crosses the extent edge and leaves land', async () => {
    const { ids } = shared;
    const [bridge] = (await query({ scope_id: ids.west })).routes;
    expect(bridge).toMatchObject({ id: ids.bridge, kind: 'bridge', crosses_extent_boundary: true, leaves_land: true });
    // West's coverage is partial: off-land is unknown, not water.
    expect(bridge.crosses_water).toBe(false);
  });

  it('derives crosses_water from explicit water and from complete-coverage complement', async () => {
    const { api } = await setupCanonical();
    const ids = await buildArchipelago(api);
    const overBasin = (await api.accepted('features', route([{ x: 105, z: 50 }, { x: 145, z: 50 }], { kind: 'causeway' }))).id;
    const offC = (await api.accepted('features', route([{ x: 480, z: 50 }, { x: 540, z: 50 }], { kind: 'road' }))).id;
    const city = (await api.anon.post('/query', { scope_id: CITY })).body;
    expect(city.routes.find(r => r.id === overBasin)).toMatchObject({ crosses_water: true, leaves_land: true });
    // In the city (partial) the stretch east of Isle C is unknown ground ...
    expect(city.routes.find(r => r.id === offC)).toMatchObject({ crosses_water: false, leaves_land: true });
    // ... but inside the east district, whose coverage is complete, it is water.
    const east = (await api.anon.post('/query', { scope_id: ids.east })).body;
    expect(east.routes.find(r => r.id === offC)).toMatchObject({ crosses_water: true, leaves_land: true });
  });
});

describe('anchors, obligations and readiness', () => {
  it('lists a placed anchor with every part and where each part lies', async () => {
    const { ids } = shared;
    const b = await query({ feature_id: ids.islandA, halo_wu: 60 });
    const arboretum = b.anchors.find(a => a.id === ids.arboretum);
    expect(arboretum).toMatchObject({ anchor_key: 'arboretum', placed: true, relation: 'boundary', must_exist: true });
    expect(arboretum.parts.map(p => [p.feature_id, p.relation])).toEqual([[ids.nodeA, 'inside'], [ids.nodeB, 'outside']]);

    const wide = await query({ feature_id: ids.islandA, halo_wu: 150 });
    expect(wide.anchors.find(a => a.id === ids.arboretum).parts.map(p => p.relation)).toEqual(['inside', 'context']);
  });

  it('reports an unplaced must-exist anchor to its district, the district\'s island groups, its islands and the city', async () => {
    const { ids } = shared;
    for (const body of [{ scope_id: ids.west }, { scope_id: ids.westPair }, { scope_id: CITY }, { feature_id: ids.islandA }]) {
      expect((await query(body)).readiness.unplaced_must_exist).toEqual([ids.arena]);
    }
    expect((await query({ scope_id: ids.east })).readiness.unplaced_must_exist).toEqual([]);
    expect((await query({ feature_id: ids.islandC })).readiness.unplaced_must_exist).toEqual([]);
  });

  it('lists unplaced anchors as obligations only in their required scope and above it', async () => {
    const { ids } = shared;
    const obligations = async (body) => (await query(body)).anchors.filter(a => !a.placed).map(a => a.anchor_key);
    expect(await obligations({ scope_id: ids.west })).toEqual(['arena']);
    expect(await obligations({ scope_id: CITY })).toEqual(['arena', 'lighthouse']);
    expect(await obligations({ scope_id: ids.westPair })).toEqual([]);
    // Not must-exist: an obligation, but not a readiness item.
    expect(await obligations({ scope_id: ids.east })).toEqual(['lighthouse']);
    expect((await query({ scope_id: ids.east })).anchors[0]).toMatchObject({ relation: 'unplaced', parts: [], must_exist: false });
  });

  it('marks parts whose required scope has no extent yet as unverified', async () => {
    const { ids } = shared;
    const b = await query({ scope_id: CITY });
    expect(b.readiness).toEqual({ unplaced_must_exist: [ids.arena], required_scope_unverified: [ids.guildHint], enforced: false });
    expect((await query({ feature_id: ids.islandA })).readiness.required_scope_unverified).toEqual([]);
  });
});

describe('connections', () => {
  const tags = (b) => Object.fromEntries(b.connections.map(c => [c.id, c.tag]));

  it('tags each connection internal, crossing or external_obligation relative to the extent', async () => {
    const { ids } = shared;
    expect(tags(await query({ scope_id: CITY }))).toEqual({ [ids.bridgeLink]: 'internal', [ids.utility]: 'internal', [ids.ferry]: 'internal' });
    expect(tags(await query({ scope_id: ids.west }))).toEqual({ [ids.bridgeLink]: 'internal', [ids.utility]: 'internal', [ids.ferry]: 'crossing' });
    expect(tags(await query({ scope_id: ids.westPair }))).toEqual({ [ids.bridgeLink]: 'internal', [ids.utility]: 'internal', [ids.ferry]: 'external_obligation' });
    expect(tags(await query({ scope_id: ids.east }))).toEqual({ [ids.ferry]: 'crossing' });
  });

  it('shows an island its cross-boundary obligations, with the far end as context when in the halo', async () => {
    const { ids } = shared;
    const b = await query({ feature_id: ids.islandA, halo_wu: 60 });
    expect(tags(b)).toEqual({ [ids.bridgeLink]: 'crossing', [ids.utility]: 'crossing', [ids.ferry]: 'external_obligation' });
    const link = b.connections.find(c => c.id === ids.bridgeLink);
    expect(link).toMatchObject({
      connection_kind: 'bridge', via_feature_id: ids.bridge,
      from: { ref_type: 'feature', ref_id: ids.islandA, position: 'in' },
      to: { ref_type: 'feature', ref_id: ids.islandB, position: 'context' },
    });
    const ferry = b.connections.find(c => c.id === ids.ferry);
    expect(ferry.from).toEqual({ ref_type: 'scope', ref_id: ids.west, hint: { x: 240, z: 50 }, position: 'enclosing' });
    expect(ferry.connection_kind).toBe('ferry');
  });

  it('omits connections with no bearing on the extent', async () => {
    const { ids } = shared;
    expect((await query({ feature_id: ids.islandC })).connections).toEqual([]);
  });
});

describe('immutable ids', () => {
  it('lists every included accepted entity that is non-replaceable or locked, and nothing replaceable and unlocked', async () => {
    const { api } = await setupCanonical();
    const ids = await buildArchipelago(api);
    await api.expectStatus(await api.patch(`/features/${ids.islandB}/replacement`, { replacement_state: 'replaceable' }), 200, 'replaceable');
    let b = (await api.anon.post('/query', { scope_id: ids.west })).body;
    expect(b.immutable).toContainEqual({ entity_type: 'feature', id: ids.islandA });
    expect(b.immutable).not.toContainEqual({ entity_type: 'feature', id: ids.islandB });
    expect(b.immutable).toContainEqual({ entity_type: 'scope', id: ids.west });
    expect(b.immutable).toContainEqual({ entity_type: 'anchor', id: ids.arena });
    expect(b.land.find(l => l.id === ids.islandB)).toMatchObject({ replacement_state: 'replaceable', is_locked: false });

    await api.expectStatus(await api.patch(`/features/${ids.islandB}/lock`, { is_locked: true }), 200, 'lock');
    b = (await api.anon.post('/query', { scope_id: ids.west })).body;
    expect(b.immutable).toContainEqual({ entity_type: 'feature', id: ids.islandB });
  });
});

describe('metrics', () => {
  it('reports areas and lengths in metres through the physical scale, overlap-naive', async () => {
    const b = await query({ scope_id: CITY });
    // Three 100 × 100 wu islands: 30,000 wu² × 1.524² m²/wu².
    expect(b.metrics.semantics).toBe('overlap_naive');
    expect(b.metrics.land.count).toBe(3);
    expect(b.metrics.land.area_m2).toBeCloseTo(30000 * 1.524 * 1.524, 6);
    expect(b.metrics.land.area_ha).toBeCloseTo(30000 * 1.524 * 1.524 / 10000, 9);
    expect(b.metrics.land.shoreline_m).toBeCloseTo(1200 * 1.524, 6);
    // Canal (10 × 120) + basin (30 × 60), counted whole even where the canal leaves land.
    expect(b.metrics.water.explicit_area_m2).toBeCloseTo((1200 + 1800) * 1.524 * 1.524, 6);
    expect(b.metrics.routes).toEqual({ count: 1, length_m: expect.closeTo(50 * 1.524, 6) });
    expect(b.metrics.anchors).toEqual({ placed: 2, context: 0, unplaced_obligations: 2, unplaced_must_exist: 1 });
  });

  it('counts a boundary island whole rather than clipping it', async () => {
    const b = await query({ bbox: { min_x: 10, min_z: 10, max_x: 30, max_z: 30 } });
    expect(b.metrics.land.area_m2).toBeCloseTo(10000 * 1.524 * 1.524, 6);
    expect(b.metrics.extent.area_m2).toBeCloseTo(400 * 1.524 * 1.524, 6);
  });

  it('does not change when the inherited map-scale setting does', async () => {
    const before = await query({ scope_id: CITY });
    await run(shared.db, `INSERT OR REPLACE INTO global_settings (key, value) VALUES ('map_scale_multiplier', '37')`);
    const after = await query({ scope_id: CITY });
    expect(after.metrics).toEqual(before.metrics);
    expect(after.digest).toBe(before.digest);
  });
});

describe('include', () => {
  it('trims the emitted sections without changing the digest, readiness or metrics', async () => {
    const full = await query({ scope_id: shared.ids.west });
    const landOnly = await query({ scope_id: shared.ids.west, include: ['land'] });
    expect(Object.keys(landOnly)).not.toContain('water');
    expect(Object.keys(landOnly)).not.toContain('connections');
    expect(landOnly.land).toEqual(full.land);
    expect(landOnly.digest).toBe(full.digest);
    expect(landOnly.readiness).toEqual(full.readiness);
    expect(landOnly.metrics).toEqual(full.metrics);
  });
});
