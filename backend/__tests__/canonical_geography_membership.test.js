/**
 * Coherent explicit membership (WP3 remediation, finding 2).
 *
 * An accepted land feature's explicit scope memberships must lie on one ancestry chain
 * (city → district → island group → subregion): every shallower membership is an ancestor
 * of the deepest one. Island X in district A and in island group G whose parent is district
 * B is a contradiction the query could only resolve by dropping a district.
 *
 * Accept and restore refuse such a state (409 `scope_membership_incoherent`, nothing
 * written, nothing emitted). The island query refuses stored state that contradicts it
 * anyway, rather than picking a lineage. Membership stays explicit: lying inside a
 * district's boundary does not make an island a member of it.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const { setupCanonical, snapshotCanonical, land, boundary, scope } = require_('./helpers/canonicalApi.js');
const { run } = require_('./helpers/testDb.js');

const CITY = 1;

let api;
let db;
let emits;
let isle;

beforeEach(async () => {
  ({ api, db, emits } = await setupCanonical());
  isle = await api.accepted('features', land(0, 0, 100, { name: 'X' }));
});

const chainOf = async (featureId) => {
  const res = await api.anon.post('/query', { feature_id: featureId });
  return res.status === 200 ? res.body.scope.chain.map(s => [s.id, s.scope_kind]) : res;
};

/** Assert a refused change: 409 with the incoherence code, and canon, history and events untouched. */
async function expectIncoherentRefusal(attempt) {
  const before = await snapshotCanonical(db);
  const emitted = emits.length;
  const res = await attempt();
  expect(res.status).toBe(409);
  expect(res.body.violations.map(v => v.code)).toContain('scope_membership_incoherent');
  const v = res.body.violations.find(x => x.code === 'scope_membership_incoherent');
  expect(v.ref).toEqual({ entity_type: 'feature', id: isle.id });
  const after = await snapshotCanonical(db);
  expect(after.canonical_revisions).toEqual(before.canonical_revisions);
  expect(after.geo_scopes.filter(s => s.lifecycle_state === 'accepted')).toEqual(before.geo_scopes.filter(s => s.lifecycle_state === 'accepted'));
  expect(after.geo_scope_members.filter(m => m.is_canonical === 1)).toEqual(before.geo_scope_members.filter(m => m.is_canonical === 1));
  expect(emits.length).toBe(emitted);
  return res;
}

describe('accept-time validation', () => {
  it('A: accepts a district and an island group under that same district, and the chain follows them', async () => {
    const a = await api.accepted('scopes', scope('district-a', 'district', CITY, { members: [isle.id] }));
    const g = await api.accepted('scopes', scope('group-g', 'island_group', a.id, { members: [isle.id] }));
    expect(await chainOf(isle.id)).toEqual([[CITY, 'city'], [a.id, 'district'], [g.id, 'island_group']]);
  });

  it('B: refuses an island group under district B for an island that belongs to district A', async () => {
    await api.accepted('scopes', scope('district-a', 'district', CITY, { members: [isle.id] }));
    const b = await api.accepted('scopes', scope('district-b', 'district', CITY));
    const g = await api.draft('scopes', scope('group-g', 'island_group', b.id, { members: [isle.id] }));
    const res = await expectIncoherentRefusal(() => api.accept('scopes', g));
    expect(res.body.violations.find(v => v.code === 'scope_membership_incoherent').message)
      .toMatch(/district #\d+.*not on the lineage of its deepest membership island_group/);
    expect((await api.get(`/scopes/${g.id}`)).body.lifecycle_state).toBe('draft');
  });

  it('B: refuses the same contradiction reached the other way round', async () => {
    const b = await api.accepted('scopes', scope('district-b', 'district', CITY));
    await api.accepted('scopes', scope('group-g', 'island_group', b.id, { members: [isle.id] }));
    const a = await api.draft('scopes', scope('district-a', 'district', CITY, { members: [isle.id] }));
    await expectIncoherentRefusal(() => api.accept('scopes', a));
  });

  it('C: refuses moving an island group to another district when its island is a member of the old one', async () => {
    const a = await api.accepted('scopes', scope('district-a', 'district', CITY, { members: [isle.id] }));
    const b = await api.accepted('scopes', scope('district-b', 'district', CITY));
    const g = await api.accepted('scopes', scope('group-g', 'island_group', a.id, { members: [isle.id] }));
    const r = (await api.post(`/scopes/${g.id}/revise`)).body;
    const moved = (await api.patch(`/scopes/${r.id}`, { parent_scope_id: b.id })).body;
    await expectIncoherentRefusal(() => api.accept('scopes', moved));
    expect(await chainOf(isle.id)).toEqual([[CITY, 'city'], [a.id, 'district'], [g.id, 'island_group']]);
  });

  it('D: accepts a parent change that keeps every island\'s memberships on one chain', async () => {
    const a = await api.accepted('scopes', scope('district-a', 'district', CITY));
    const b = await api.accepted('scopes', scope('district-b', 'district', CITY));
    const g = await api.accepted('scopes', scope('group-g', 'island_group', a.id, { members: [isle.id] }));
    const r = (await api.post(`/scopes/${g.id}/revise`)).body;
    const moved = (await api.patch(`/scopes/${r.id}`, { parent_scope_id: b.id })).body;
    api.expectStatus(await api.accept('scopes', moved), 200, 'accept parent change');
    expect(await chainOf(isle.id)).toEqual([[CITY, 'city'], [b.id, 'district'], [g.id, 'island_group']]);
  });

  it('E: refuses to restore a scope that would bring back a contradictory membership', async () => {
    const a = await api.accepted('scopes', scope('district-a', 'district', CITY, { members: [isle.id] }));
    const g = await api.accepted('scopes', scope('group-g', 'island_group', a.id, { members: [isle.id] }));
    api.expectStatus(await api.post(`/scopes/${g.id}/retire`), 200, 'retire group');
    // While G is retired, X moves from district A to district B — coherent at every step.
    const ra = (await api.post(`/scopes/${a.id}/revise`)).body;
    const emptied = (await api.patch(`/scopes/${ra.id}`, { members: [] })).body;
    api.expectStatus(await api.accept('scopes', emptied), 200, 'drop X from A');
    await api.accepted('scopes', scope('district-b', 'district', CITY, { members: [isle.id] }));
    // Restoring G (under A, with X) would put X in district B and in a group under A.
    await expectIncoherentRefusal(() => api.post(`/scopes/${g.id}/restore`));
    expect((await api.get(`/scopes/${g.id}?states=retired`)).body.lifecycle_state).toBe('retired');
  });
});

describe('the query refuses contradictory stored state', () => {
  it('F: fails an island query with the invariant error instead of dropping a district', async () => {
    const a = await api.accepted('scopes', scope('district-a', 'district', CITY, { members: [isle.id] }));
    const b = await api.accepted('scopes', scope('district-b', 'district', CITY));
    const g = await api.accepted('scopes', scope('group-g', 'island_group', b.id));
    // Bypass the API, as historical or hand-edited data might.
    await run(db, `INSERT INTO geo_scope_members (scope_id, feature_id, scope_kind, is_canonical) VALUES (?, ?, 'island_group', 1)`,
      [g.id, isle.id]);
    const res = await api.anon.post('/query', { feature_id: isle.id });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'scope_membership_incoherent', feature_id: isle.id,
      memberships: [a.id, g.id], lineage: [CITY, b.id, g.id], stray: [a.id],
    });
    // Queries that do not build that island's chain are unaffected.
    expect((await api.anon.post('/query', { scope_id: CITY })).status).toBe(200);
  });
});

describe('membership stays explicit', () => {
  it('G: does not infer a district from its boundary', async () => {
    const bd = await api.draft('features', boundary(-50, -50, 300));
    const dd = await api.draft('scopes', scope('district-a', 'district', CITY, { boundary_feature_id: bd.id }));
    api.expectStatus(await api.accept('features', bd), 200, 'accept boundary');
    const a = api.expectStatus(await api.accept('scopes', dd), 200, 'accept district').record;
    // X lies wholly inside A's boundary but is not a member of anything.
    expect(await chainOf(isle.id)).toEqual([[CITY, 'city']]);
    // Explicit membership through a group under A is what places it there.
    const g = await api.accepted('scopes', scope('group-g', 'island_group', a.id, { members: [isle.id] }));
    expect(await chainOf(isle.id)).toEqual([[CITY, 'city'], [a.id, 'district'], [g.id, 'island_group']]);
  });
});
