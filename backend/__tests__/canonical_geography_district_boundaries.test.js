/**
 * Districts are drawn spatial regions (WP6 remediation): a district boundary may cross
 * accepted land, and one island may be split between two districts, with no whole-island
 * membership in either. This pins that the existing validation and query already allow
 * it — no backend change was needed — and records the current query behaviour a later
 * planning/generation slice must build on: an island's own scope chain comes only from
 * explicit membership, so a split island's chain is just the city.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const { setupCanonical, land, boundary, scope, site, anchor, square } = require_('./helpers/canonicalApi.js');

const CITY = 1;
let api;

beforeEach(async () => {
  ({ api } = await setupCanonical());
});

/** District draft → boundary draft linked to it → accept boundary → accept district (the UI order). */
async function district(key, x, z, size) {
  const b = await api.draft('features', boundary(x, z, size));
  const d = await api.draft('scopes', scope(key, 'district', CITY, { boundary_feature_id: b.id }));
  api.expectStatus(await api.accept('features', b), 200, 'accept boundary');
  return api.expectStatus(await api.accept('scopes', d), 200, 'accept district').record;
}

describe('district boundaries crossing land', () => {
  it('accepts a district with a boundary and no land members, even when the boundary cuts an island', async () => {
    const isle = await api.accepted('features', land(0, 0, 100));
    const west = await district('west', -50, -50, 100); // covers x -50..50: half the island
    expect(west.members).toEqual([]);
    const q = await api.anon.post('/query', { scope_id: west.id });
    expect(q.status).toBe(200);
    expect(q.body.land.map(l => [l.id, l.relation])).toEqual([[isle.id, 'boundary']]);
  });

  it('an island split between two districts needs no membership in either; both districts see it', async () => {
    const isle = await api.accepted('features', land(0, 0, 100));
    const west = await district('west', -50, -50, 100);
    const east = await district('east', 50, -50, 100);
    for (const d of [west, east]) {
      const q = await api.anon.post('/query', { scope_id: d.id });
      expect(q.body.land.map(l => l.id)).toEqual([isle.id]);
    }
    // Current contract (unchanged here): an island's own chain comes from explicit membership only.
    const own = await api.anon.post('/query', { feature_id: isle.id });
    expect(own.body.scope.chain.map(s => s.scope_kind)).toEqual(['city']);
  });

  it('optional whole-island membership still works alongside a boundary', async () => {
    const isle = await api.accepted('features', land(200, 200, 10));
    const b = await api.draft('features', boundary(-50, -50, 100));
    const d = await api.draft('scopes', scope('west', 'district', CITY, { boundary_feature_id: b.id, members: [isle.id] }));
    expect((await api.accept('features', b)).status).toBe(200);
    expect((await api.accept('scopes', d)).status).toBe(200);
    const own = await api.anon.post('/query', { feature_id: isle.id });
    expect(own.body.scope.chain.map(s => s.scope_kind)).toEqual(['city', 'district']);
  });

  it('a required-scope anchor part is checked against the drawn boundary, not island membership', async () => {
    await api.accepted('features', land(0, 0, 100));
    const west = await district('west', -50, -50, 100);
    const a = await api.accepted('anchors', anchor('arena-test', { required_scope_id: west.id }));
    const inside = await api.draft('features', site('polygon', square(10, 10, 5), { anchor_id: a.id, part_role: 'footprint' }));
    expect((await api.accept('features', inside)).status).toBe(200);
    const outside = await api.draft('features', site('polygon', square(70, 10, 5), { anchor_id: a.id, part_role: 'footprint' }));
    const res = await api.accept('features', outside);
    expect(res.status).toBe(409);
    expect(res.body.violations.map(v => v.code)).toContain('required_scope_violation');
  });

  it('a boundary draft cannot be accepted before a scope references it (the UI links it on save)', async () => {
    const b = await api.draft('features', boundary(0, 0, 10));
    const res = await api.accept('features', b);
    expect(res.status).toBe(409);
    expect(res.body.violations.map(v => v.code)).toContain('scope_boundary_unreferenced');
  });
});
