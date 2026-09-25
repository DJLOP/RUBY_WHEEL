/**
 * The WP6 bulk-membership path, end to end through the API the scope panel uses: stage a
 * multi-island assignment on a draft revision (revise → PATCH members), then accept.
 *
 * Memberships persist as ordinary explicit rows. A boundary is never a membership rule:
 * land inside it that was not assigned is not a member, and moving the boundary later
 * reassigns nothing.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const { setupCanonical, land, boundary, scope, square } = require_('./helpers/canonicalApi.js');

const CITY = 1;
let api;

beforeEach(async () => {
  ({ api } = await setupCanonical());
});

const chainOf = async (featureId) =>
  (await api.anon.post('/query', { feature_id: featureId })).body.scope.chain.map(s => s.scope_kind);

async function stageMembers(scopeId, members) {
  const rev = api.expectStatus(await api.post(`/scopes/${scopeId}/revise`), 201, 'revise');
  return api.expectStatus(await api.patch(`/scopes/${rev.id}`, { members, expected_draft_version: rev.draft_version }), 200, 'patch');
}

describe('bulk explicit membership', () => {
  it('assigns several islands in one revision, persisting explicit members only', async () => {
    const a = await api.accepted('features', land(0, 0, 10));
    const b = await api.accepted('features', land(20, 0, 10));
    const c = await api.accepted('features', land(40, 0, 10));
    const d = await api.accepted('scopes', scope('temp-district', 'district', CITY));

    const staged = await stageMembers(d.id, [a.id, b.id, c.id]);
    // Staged is not canon: the accepted scope and the query are unchanged.
    expect((await api.anon.get(`/scopes/${d.id}`)).body.members).toEqual([]);
    expect(await chainOf(a.id)).toEqual(['city']);

    expect((await api.accept('scopes', staged)).status).toBe(200);
    expect((await api.anon.get(`/scopes/${d.id}`)).body.members).toEqual([a.id, b.id, c.id]);
    expect(await chainOf(b.id)).toEqual(['city', 'district']);
  });

  it('an island group under the district takes some islands; the others need no group', async () => {
    const a = await api.accepted('features', land(0, 0, 10));
    const b = await api.accepted('features', land(20, 0, 10));
    const c = await api.accepted('features', land(40, 0, 10));
    const d = await api.accepted('scopes', scope('temp-district', 'district', CITY, { members: [a.id, b.id, c.id] }));
    await api.accepted('scopes', scope('temp-chain', 'island_group', d.id, { members: [a.id, b.id] }));
    expect(await chainOf(a.id)).toEqual(['city', 'district', 'island_group']);
    expect(await chainOf(c.id)).toEqual(['city', 'district']);
  });

  it('a boundary is not a rule: unassigned land inside it is not a member, and moving it reassigns nothing', async () => {
    const inside = await api.accepted('features', land(0, 0, 10));
    const alsoInside = await api.accepted('features', land(20, 0, 10));
    const bDraft = await api.draft('features', boundary(-5, -5, 40));
    const d = await api.draft('scopes', scope('temp-district', 'district', CITY, { boundary_feature_id: bDraft.id, members: [inside.id] }));
    expect((await api.accept('features', bDraft)).status).toBe(200);
    expect((await api.accept('scopes', d)).status).toBe(200);

    expect((await api.anon.get(`/scopes/${d.id}`)).body.members).toEqual([inside.id]);
    expect(await chainOf(alsoInside.id)).toEqual(['city']);

    // Move the boundary far away: the explicit member stays, nothing else changes.
    const rev = api.expectStatus(await api.post(`/features/${bDraft.id}/revise`), 201, 'revise boundary');
    const moved = api.expectStatus(await api.patch(`/features/${rev.id}`, { geometry: square(500, 500, 40), expected_draft_version: rev.draft_version }), 200, 'move');
    expect((await api.accept('features', moved)).status).toBe(200);
    expect((await api.anon.get(`/scopes/${d.id}`)).body.members).toEqual([inside.id]);
    expect(await chainOf(inside.id)).toEqual(['city', 'district']);
    expect(await chainOf(alsoInside.id)).toEqual(['city']);
  });

  it('a contradictory bulk assignment is refused and the staged draft keeps its members', async () => {
    const a = await api.accepted('features', land(0, 0, 10));
    await api.accepted('scopes', scope('district-a', 'district', CITY, { members: [a.id] }));
    const other = await api.accepted('scopes', scope('district-b', 'district', CITY));
    const staged = await stageMembers(other.id, [a.id]);
    const res = await api.accept('scopes', staged);
    expect(res.status).toBe(409);
    expect(res.body.violations.map(v => v.code)).toContain('scope_member_conflict');
    expect((await api.get(`/scopes/${staged.id}`)).body).toMatchObject({ lifecycle_state: 'draft', members: [a.id] });
  });
});
