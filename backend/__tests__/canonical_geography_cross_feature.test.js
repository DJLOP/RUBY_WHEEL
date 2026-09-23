/**
 * Accept-time cross-feature validation (plan §4.1, §3.3–§3.5, §3.7).
 *
 * Each rule is enforced at accept and restore only: every case below first proves the
 * offending record can be *saved* as a draft, then that it cannot become canon. Land
 * contact uses the WP1 exact-grid topology, so the fixtures include the cases floating
 * point gets wrong (a partially shared sloped edge at 0.1-multiples) and the case a naive
 * bbox test gets wrong (an island inside a lake inside an island).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { get, run } from './helpers/testDb.js';

const require_ = createRequire(import.meta.url);
const { setupCanonical, land, site, route, boundary, anchor, scope, connection, square } = require_('./helpers/canonicalApi.js');

let db;
let api;

beforeEach(async () => {
  ({ db, api } = await setupCanonical());
});

const CITY = 1;
const codes = (res) => (res.body.violations || []).map(v => v.code);

/** Save a draft (must succeed), then try to accept it; returns the accept response. */
const tryAccept = async (entity, body) => api.accept(entity, await api.draft(entity, body));

const polygon = (points, holes = []) => ({ outer: points.map(([x, z]) => ({ x, z })), holes });

describe('land contact', () => {
  it('refuses overlapping land and names the land it overlaps', async () => {
    const a = await api.accepted('features', land(0, 0, 10));
    const res = await tryAccept('features', land(5, 5, 10));
    expect(res.status).toBe(409);
    expect(res.body.violations).toEqual([expect.objectContaining({ code: 'land_contact', ref: { entity_type: 'feature', id: a.id } })]);
  });

  it('refuses land that only touches along a shared edge: touching land is one island', async () => {
    await api.accepted('features', land(0, 0, 10));
    expect(codes(await tryAccept('features', land(10, 0, 10)))).toEqual(['land_contact']);
  });

  it('refuses land that touches at a single vertex', async () => {
    await api.accepted('features', land(0, 0, 10));
    expect(codes(await tryAccept('features', land(10, 10, 10)))).toEqual(['land_contact']);
  });

  it('refuses a partially shared sloped edge at 0.1-multiple coordinates (exact grid, no epsilon)', async () => {
    await api.accepted('features', { ...land(0, 0), geometry: polygon([[0, 0], [3.3, 0], [0, 3.3]]) });
    const b = { ...land(0, 0), geometry: polygon([[3.3, 0], [3.3, 3.3], [1.1, 2.2]]) };
    expect(codes(await tryAccept('features', b))).toEqual(['land_contact']);
  });

  it('accepts land separated by the smallest representable gap', async () => {
    await api.accepted('features', land(0, 0, 10));
    expect((await tryAccept('features', land(10.001, 0, 10))).status).toBe(200);
  });

  it('accepts an island inside a lake inside an island (the hole is not land)', async () => {
    await api.accepted('features', { ...land(0, 0), geometry: polygon([[0, 0], [100, 0], [100, 100], [0, 100]], [[[20, 20], [20, 80], [80, 80], [80, 20]].map(([x, z]) => ({ x, z }))]) });
    expect((await tryAccept('features', land(40, 40, 20))).status).toBe(200);
    // …but not one that reaches the lake shore.
    expect(codes(await tryAccept('features', land(70, 30, 10)))).toEqual(['land_contact']);
  });

  it('does not count a land revision as touching its own canonical row', async () => {
    const a = await api.accepted('features', land(0, 0, 10));
    const r = (await api.post(`/features/${a.id}/revise`)).body;
    const edited = (await api.patch(`/features/${r.id}`, { geometry: square(2, 2, 10) })).body;
    expect((await api.accept('features', edited)).status).toBe(200);
  });

  it('refuses a revision that would make accepted land touch its neighbour', async () => {
    const a = await api.accepted('features', land(0, 0, 10));
    await api.accepted('features', land(20, 0, 10));
    const r = (await api.post(`/features/${a.id}/revise`)).body;
    const edited = (await api.patch(`/features/${r.id}`, { geometry: square(0, 0, 20) })).body;
    const res = await api.accept('features', edited);
    expect(codes(res)).toEqual(['land_contact']);
    expect((await api.get(`/features/${a.id}`)).body).toMatchObject({ revision: 1, bbox: { max_x: 10 } });
  });

  it('ignores draft, proposed and retired land', async () => {
    await api.draft('features', land(0, 0, 10));
    const retired = await api.accepted('features', land(100, 0, 10));
    await api.post(`/features/${retired.id}/retire`);
    expect((await tryAccept('features', land(5, 0, 10))).status).toBe(200);
    expect((await tryAccept('features', land(105, 0, 10))).status).toBe(200);
  });

  it('lets water, routes and sites overlap land freely', async () => {
    await api.accepted('features', land(0, 0, 10));
    expect((await tryAccept('features', { ...land(2, 2, 3), feature_class: 'water', kind: 'basin' })).status).toBe(200);
    expect((await tryAccept('features', route([{ x: -5, z: 5 }, { x: 15, z: 5 }], { kind: 'bridge' }))).status).toBe(200);
  });
});

describe('anchor parts and required scope', () => {
  it('refuses a part before its anchor is accepted, then accepts it once the anchor is', async () => {
    const a = await api.draft('anchors', anchor('arena'));
    const part = await api.draft('features', site('point', { x: 1, z: 1 }, { anchor_id: a.id, part_role: 'core' }));
    const refused = await api.accept('features', part);
    expect(codes(refused)).toEqual(['part_anchor_not_accepted']);

    await api.accept('anchors', a);
    expect((await api.accept('features', part)).status).toBe(200);
  });

  it('accepts a part with a warning, not a refusal, while the required scope has no extent', async () => {
    const district = await api.accepted('scopes', scope('artisan', 'district', CITY));
    const a = await api.accepted('anchors', anchor('mages-guild-office', { category: 'facility', required_scope_id: district.id }));
    const res = await tryAccept('features', site('point', { x: 1, z: 1 }, { anchor_id: a.id, part_role: 'core', constraint_strength: 'soft' }));
    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual([expect.objectContaining({ code: 'required_scope_unverified' })]);
  });

  it('refuses a part outside its required scope\'s boundary and accepts one inside', async () => {
    const d = await api.draft('scopes', scope('artisan', 'district', CITY));
    const b = await api.draft('features', boundary(0, 0, 100));
    await api.patch(`/scopes/${d.id}`, { boundary_feature_id: b.id });
    await api.accept('features', b);
    await api.accept('scopes', (await api.get(`/scopes/${d.id}`)).body);

    const a = await api.accepted('anchors', anchor('mages-guild-office', { required_scope_id: d.id }));
    const outside = await tryAccept('features', site('point', { x: 150, z: 50 }, { anchor_id: a.id, part_role: 'core' }));
    expect(codes(outside)).toEqual(['required_scope_violation']);
    const inside = await tryAccept('features', site('polygon', square(90, 90, 20), { anchor_id: a.id, part_role: 'footprint' }));
    expect(inside.status).toBe(200);
    expect(inside.body.warnings).toEqual([]);
  });

  it('uses member land as the extent when a scope has no boundary', async () => {
    const isle = await api.accepted('features', land(0, 0, 50));
    const d = await api.accepted('scopes', scope('arena', 'district', CITY, { members: [isle.id] }));
    const a = await api.accepted('anchors', anchor('arena', { required_scope_id: d.id }));
    expect(codes(await tryAccept('features', site('point', { x: 60, z: 60 }, { anchor_id: a.id })))).toEqual(['required_scope_violation']);
    expect((await tryAccept('features', site('point', { x: 50, z: 50 }, { anchor_id: a.id }))).status).toBe(200);
  });

  it('refuses an anchor whose required scope is not accepted', async () => {
    const d = await api.draft('scopes', scope('arena', 'district', CITY));
    expect(codes(await tryAccept('anchors', anchor('arena', { required_scope_id: d.id })))).toEqual(['required_scope_not_accepted']);
  });

  it('accepts a hard anchor whose only part is soft', async () => {
    const a = await api.accepted('anchors', anchor('arena', { constraint_strength: 'hard' }));
    const res = await tryAccept('features', site('point', { x: 0, z: 0 }, { anchor_id: a.id, part_role: 'core', constraint_strength: 'soft' }));
    expect(res.status).toBe(200);
    expect(res.body.record.constraint_strength).toBe('soft');
  });

  it('refuses a revision that moves a required scope\'s boundary away from an accepted part', async () => {
    const d = await api.draft('scopes', scope('artisan', 'district', CITY));
    const b = await api.draft('features', boundary(0, 0, 100));
    await api.patch(`/scopes/${d.id}`, { boundary_feature_id: b.id });
    await api.accept('features', b);
    await api.accept('scopes', (await api.get(`/scopes/${d.id}`)).body);
    const a = await api.accepted('anchors', anchor('mages-guild-office', { required_scope_id: d.id }));
    await api.accepted('features', site('point', { x: 10, z: 10 }, { anchor_id: a.id }));

    const r = (await api.post(`/features/${b.id}/revise`)).body;
    const moved = (await api.patch(`/features/${r.id}`, { geometry: square(500, 500, 100) })).body;
    expect(codes(await api.accept('features', moved))).toEqual(['required_scope_violation']);
  });

  it('refuses an anchor revision whose new required scope excludes its accepted parts', async () => {
    const isleA = await api.accepted('features', land(0, 0, 10));
    const isleB = await api.accepted('features', land(100, 0, 10));
    const dA = await api.accepted('scopes', scope('a', 'district', CITY, { members: [isleA.id] }));
    const dB = await api.accepted('scopes', scope('b', 'district', CITY, { members: [isleB.id] }));
    const a = await api.accepted('anchors', anchor('arena', { required_scope_id: dA.id }));
    await api.accepted('features', site('point', { x: 5, z: 5 }, { anchor_id: a.id }));

    const r = (await api.post(`/anchors/${a.id}/revise`)).body;
    const edited = (await api.patch(`/anchors/${r.id}`, { required_scope_id: dB.id })).body;
    expect(codes(await api.accept('anchors', edited))).toEqual(['required_scope_violation']);
  });
});

describe('connections', () => {
  const twoIslands = async () => [await api.accepted('features', land(0, 0)), await api.accepted('features', land(100, 0))];

  it('accepts a soft connection with no mode, and a soft ferry', async () => {
    const [a, b] = await twoIslands();
    const unspecified = await tryAccept('connections', connection(['feature', a.id], ['feature', b.id]));
    expect(unspecified.status).toBe(200);
    expect(unspecified.body.record.connection_kind).toBeNull();
    expect((await tryAccept('connections', connection(['feature', a.id], ['feature', b.id], { connection_kind: 'ferry' }))).status).toBe(200);
  });

  it('refuses a hard connection without a via route: an unfixed alignment stays soft', async () => {
    const [a, b] = await twoIslands();
    expect(codes(await tryAccept('connections', connection(['feature', a.id], ['feature', b.id], { constraint_strength: 'hard', connection_kind: 'bridge' }))))
      .toEqual(['hard_connection_requires_via']);
  });

  it('accepts a hard connection via an accepted route, and refuses one via anything else', async () => {
    const [a, b] = await twoIslands();
    const bridge = await api.accepted('features', route([{ x: 10, z: 5 }, { x: 100, z: 5 }], { kind: 'bridge' }));
    const hard = connection(['feature', a.id], ['feature', b.id], { constraint_strength: 'hard', connection_kind: 'bridge' });
    expect((await tryAccept('connections', { ...hard, via_feature_id: bridge.id })).status).toBe(200);
    expect(codes(await tryAccept('connections', { ...hard, via_feature_id: a.id }))).toEqual(['via_not_accepted_route']);
    const draftRoute = await api.draft('features', route([{ x: 10, z: 6 }, { x: 100, z: 6 }]));
    expect(codes(await tryAccept('connections', { ...hard, via_feature_id: draftRoute.id }))).toEqual(['via_not_accepted_route']);
  });

  it('refuses endpoints that are not accepted, reporting every violation at once', async () => {
    const draftIsle = await api.draft('features', land(0, 0));
    const draftAnchor = await api.draft('anchors', anchor('arena'));
    const res = await tryAccept('connections', connection(['feature', draftIsle.id], ['anchor', draftAnchor.id], { constraint_strength: 'hard' }));
    expect(res.status).toBe(409);
    expect(codes(res).sort()).toEqual(['endpoint_not_accepted', 'endpoint_not_accepted', 'hard_connection_requires_via']);
  });

  it('refuses a connection from an entity to itself, and accepts anchor and scope endpoints', async () => {
    const [a] = await twoIslands();
    expect(codes(await tryAccept('connections', connection(['feature', a.id], ['feature', a.id])))).toEqual(['connection_self']);
    const anc = await api.accepted('anchors', anchor('prison'));
    expect((await tryAccept('connections', connection(['anchor', anc.id], ['scope', CITY], { connection_kind: 'water_route' }))).status).toBe(200);
  });
});

describe('scopes', () => {
  it('accepts the rank chain city < district < island_group < subregion', async () => {
    const d = await api.accepted('scopes', scope('arcane', 'district', CITY));
    const g = await api.accepted('scopes', scope('arcane-west', 'island_group', d.id));
    expect((await tryAccept('scopes', scope('quays', 'subregion', g.id))).status).toBe(200);
    expect((await tryAccept('scopes', scope('grain', 'subregion', d.id))).status).toBe(200);
  });

  it('refuses a parent of equal or higher rank', async () => {
    const d = await api.accepted('scopes', scope('arcane', 'district', CITY));
    const g = await api.accepted('scopes', scope('arcane-west', 'island_group', d.id));
    expect(codes(await tryAccept('scopes', scope('nibenese', 'district', d.id)))).toEqual(['scope_parent_rank']);
    expect(codes(await tryAccept('scopes', scope('upper', 'district', g.id)))).toEqual(['scope_parent_rank']);
  });

  it('refuses a non-city scope with no parent, or with a parent that is not accepted', async () => {
    expect(codes(await tryAccept('scopes', scope('orphan', 'district', null)))).toEqual(['scope_parent_required']);
    const draftParent = await api.draft('scopes', scope('draft-district', 'district', CITY));
    expect(codes(await tryAccept('scopes', scope('grp', 'island_group', draftParent.id)))).toEqual(['scope_parent_not_accepted']);
  });

  it('refuses a second city scope', async () => {
    expect(codes(await tryAccept('scopes', scope('other-city', 'city', null)))).toEqual(['second_city_scope']);
  });

  it('refuses a revision that would rank a scope at or above its accepted children', async () => {
    const d = await api.accepted('scopes', scope('arcane', 'district', CITY));
    await api.accepted('scopes', scope('arcane-west', 'island_group', d.id));
    const r = (await api.post(`/scopes/${d.id}/revise`)).body;
    const edited = (await api.patch(`/scopes/${r.id}`, { scope_kind: 'subregion' })).body;
    expect(codes(await api.accept('scopes', edited))).toEqual(['scope_child_rank']);
  });

  it('rejects a parent cycle even if rank were somehow bypassed', async () => {
    // Force a cycle that the rank rule would otherwise prevent, to prove the walk itself.
    const d = await api.accepted('scopes', scope('arcane', 'district', CITY));
    const g = await api.accepted('scopes', scope('grp', 'island_group', d.id));
    await run(db, 'UPDATE geo_scopes SET parent_scope_id = ? WHERE id = ?', [g.id, CITY]);
    const r = (await api.post(`/scopes/${d.id}/revise`)).body;
    expect(codes(await api.accept('scopes', r))).toContain('scope_cycle');
  });

  it('refuses members that are not accepted land', async () => {
    const draftIsle = await api.draft('features', land(0, 0));
    const water = await api.accepted('features', { ...land(50, 0), feature_class: 'water' });
    const res = await tryAccept('scopes', scope('arena', 'district', CITY, { members: [draftIsle.id, water.id] }));
    expect(codes(res)).toEqual(['scope_member_not_land', 'scope_member_not_land']);
  });

  it('lets an island belong to one district and one island group, but not two districts', async () => {
    const isle = await api.accepted('features', land(0, 0));
    const d1 = await api.accepted('scopes', scope('arena', 'district', CITY, { members: [isle.id] }));
    expect(codes(await tryAccept('scopes', scope('temple', 'district', CITY, { members: [isle.id] })))).toEqual(['scope_member_conflict']);
    expect((await tryAccept('scopes', scope('arena-isles', 'island_group', d1.id, { members: [isle.id] }))).status).toBe(200);
  });

  it('refuses a boundary that is not an accepted scope_boundary, and a scope_boundary no scope uses', async () => {
    const isle = await api.accepted('features', land(0, 0));
    expect(codes(await tryAccept('scopes', scope('arena', 'district', CITY, { boundary_feature_id: isle.id })))).toEqual(['boundary_not_accepted']);
    expect(codes(await tryAccept('features', boundary(0, 0, 50)))).toEqual(['scope_boundary_unreferenced']);
  });
});

describe('revisions that would break accepted dependents', () => {
  it('refuses turning a scope member into something other than land', async () => {
    const isle = await api.accepted('features', land(0, 0));
    await api.accepted('scopes', scope('arena', 'district', CITY, { members: [isle.id] }));
    const r = (await api.post(`/features/${isle.id}/revise`)).body;
    const edited = (await api.patch(`/features/${r.id}`, { feature_class: 'water' })).body;
    expect(codes(await api.accept('features', edited))).toEqual(['dependent_requires_land']);
  });

  it('refuses turning a via route into something other than a route', async () => {
    const [a, b] = [await api.accepted('features', land(0, 0)), await api.accepted('features', land(100, 0))];
    const bridge = await api.accepted('features', route([{ x: 10, z: 5 }, { x: 100, z: 5 }]));
    await api.accepted('connections', connection(['feature', a.id], ['feature', b.id], { constraint_strength: 'hard', via_feature_id: bridge.id }));
    const r = (await api.post(`/features/${bridge.id}/revise`)).body;
    const edited = (await api.patch(`/features/${r.id}`, { feature_class: 'site' })).body;
    expect(codes(await api.accept('features', edited))).toEqual(['dependent_requires_route']);
  });
});

describe('retire is blocked by accepted dependents, and lists them', () => {
  it('lists scope membership and connection endpoints of a land feature', async () => {
    const [a, b] = [await api.accepted('features', land(0, 0)), await api.accepted('features', land(100, 0))];
    const s = await api.accepted('scopes', scope('arena', 'district', CITY, { members: [a.id] }));
    const c = await api.accepted('connections', connection(['feature', a.id], ['feature', b.id]));
    const res = await api.post(`/features/${a.id}/retire`);
    expect(res.status).toBe(409);
    expect(res.body.dependents).toEqual([
      { entity_type: 'scope', id: s.id, relation: 'member' },
      { entity_type: 'connection', id: c.id, relation: 'endpoint' },
    ]);
    expect((await get(db, 'SELECT lifecycle_state FROM canonical_features WHERE id = ?', [a.id])).lifecycle_state).toBe('accepted');
  });

  it('lists an anchor\'s accepted parts, a scope\'s children and requiring anchors, and a via route\'s connection', async () => {
    const d = await api.accepted('scopes', scope('arena-district', 'district', CITY));
    const child = await api.accepted('scopes', scope('arena-isles', 'island_group', d.id));
    const a = await api.accepted('anchors', anchor('arena', { required_scope_id: d.id }));
    const part = await api.accepted('features', site('point', { x: 0, z: 0 }, { anchor_id: a.id }));
    const [x, y] = [await api.accepted('features', land(200, 0)), await api.accepted('features', land(300, 0))];
    const bridge = await api.accepted('features', route([{ x: 210, z: 5 }, { x: 300, z: 5 }]));
    const c = await api.accepted('connections', connection(['feature', x.id], ['feature', y.id], { constraint_strength: 'hard', via_feature_id: bridge.id }));

    expect((await api.post(`/anchors/${a.id}/retire`)).body.dependents).toEqual([{ entity_type: 'feature', id: part.id, relation: 'part' }]);
    expect((await api.post(`/scopes/${d.id}/retire`)).body.dependents).toEqual([
      { entity_type: 'scope', id: child.id, relation: 'child' },
      { entity_type: 'anchor', id: a.id, relation: 'required_scope' },
    ]);
    expect((await api.post(`/features/${bridge.id}/retire`)).body.dependents).toEqual([{ entity_type: 'connection', id: c.id, relation: 'via' }]);
  });

  it('ignores dependents that are only drafts, and allows retiring an anchor part', async () => {
    const a = await api.accepted('anchors', anchor('arena'));
    const part = await api.accepted('features', site('point', { x: 0, z: 0 }, { anchor_id: a.id }));
    await api.draft('features', site('point', { x: 1, z: 1 }, { anchor_id: a.id }));
    expect((await api.post(`/features/${part.id}/retire`)).status).toBe(200);
    expect((await api.post(`/anchors/${a.id}/retire`)).status).toBe(200);
  });
});

describe('restore re-runs current validation', () => {
  it('refuses to restore land that now touches land accepted while it was retired', async () => {
    const a = await api.accepted('features', land(0, 0, 10));
    await api.post(`/features/${a.id}/retire`);
    await api.accepted('features', land(5, 5, 10));
    const res = await api.post(`/features/${a.id}/restore`);
    expect(codes(res)).toEqual(['land_contact']);
    expect((await get(db, 'SELECT lifecycle_state FROM canonical_features WHERE id = ?', [a.id])).lifecycle_state).toBe('retired');
  });

  it('refuses to restore a scope whose island was claimed while it was retired', async () => {
    const isle = await api.accepted('features', land(0, 0));
    const d1 = await api.accepted('scopes', scope('arena', 'district', CITY, { members: [isle.id] }));
    await api.post(`/scopes/${d1.id}/retire`);
    await api.accepted('scopes', scope('temple', 'district', CITY, { members: [isle.id] }));
    expect(codes(await api.post(`/scopes/${d1.id}/restore`))).toEqual(['scope_member_conflict']);
  });

  it('refuses to restore a part whose anchor has since been retired', async () => {
    const a = await api.accepted('anchors', anchor('arena'));
    const part = await api.accepted('features', site('point', { x: 0, z: 0 }, { anchor_id: a.id }));
    await api.post(`/features/${part.id}/retire`);
    await api.post(`/anchors/${a.id}/retire`);
    expect(codes(await api.post(`/features/${part.id}/restore`))).toEqual(['part_anchor_not_accepted']);
  });
});
