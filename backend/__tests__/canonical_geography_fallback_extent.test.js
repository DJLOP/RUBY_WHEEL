/**
 * The root city's fallback extent (plan §3.5): with no boundary and no members, the city's
 * extent is the bbox of all accepted land. Any change to accepted land can therefore move
 * it, whether or not that land is referenced explicitly — so accepting a land revision and
 * retiring land both re-check the parts of anchors that must lie inside the city, against
 * the extent as it *would* be afterwards (new geometry for the changed land, nothing for
 * retired land, every other accepted land unchanged), before anything is written.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const { setupCanonical, snapshotCanonical, land, site, boundary, anchor, scope, square } = require_('./helpers/canonicalApi.js');

let db;
let api;
let emits;

beforeEach(async () => {
  ({ db, api, emits } = await setupCanonical());
});

const CITY = 1;

/** An anchor that must lie in the root city, with one accepted point part at (x, z). */
async function cityPart(x, z) {
  const a = await api.accepted('anchors', anchor('treatment-works', { required_scope_id: CITY }));
  const res = await api.post('/features', site('point', { x, z }, { anchor_id: a.id, part_role: 'node' }));
  const accepted = await api.accept('features', res.body);
  expect(accepted.status).toBe(200);
  expect(accepted.body.warnings).toEqual([]); // verified inside the fallback extent, not unverified
  return { anchor: a, part: accepted.body.record };
}

/** Revise accepted land to a new square; returns the accept response. */
async function reviseLand(id, geometry) {
  const r = (await api.post(`/features/${id}/revise`)).body;
  const edited = (await api.patch(`/features/${r.id}`, { geometry })).body;
  return { res: await api.accept('features', edited), draft: edited };
}

/** Assert a refused change left canon as it was: same rows, same history, no event. */
async function expectRefusedWithoutEffect(attempt) {
  const before = await snapshotCanonical(db);
  const emitted = emits.length;
  const res = await attempt();
  expect(res.status).toBe(409);
  expect(res.body.violations.map(v => v.code)).toEqual(['required_scope_violation']);
  const after = await snapshotCanonical(db);
  // A refused accept leaves its draft in place; everything canonical is untouched.
  expect(after.canonical_revisions).toEqual(before.canonical_revisions);
  expect(after.canonical_features.filter(f => f.lifecycle_state !== 'draft'))
    .toEqual(before.canonical_features.filter(f => f.lifecycle_state !== 'draft'));
  expect(after.canonical_anchors).toEqual(before.canonical_anchors);
  expect(emits.length).toBe(emitted);
  return res;
}

describe('A: a land revision that would move the fallback extent off an accepted part', () => {
  it('is refused, leaving the old land canonical and the part valid', async () => {
    const isle = await api.accepted('features', land(0, 0, 100));
    const { part } = await cityPart(50, 50);

    const r = (await api.post(`/features/${isle.id}/revise`)).body;
    const moved = (await api.patch(`/features/${r.id}`, { geometry: square(1000, 1000, 100) })).body;
    const res = await expectRefusedWithoutEffect(() => api.accept('features', moved));
    expect(res.body.violations[0].ref).toEqual({ entity_type: 'feature', id: part.id });

    expect((await api.get(`/features/${isle.id}`)).body).toMatchObject({ revision: 1, bbox: { min_x: 0, max_x: 100 } });
    expect((await api.get(`/features/${part.id}`)).body.lifecycle_state).toBe('accepted');
  });

  it('is refused when the revision reclassifies the only land as something else', async () => {
    const isle = await api.accepted('features', land(0, 0, 100));
    await api.accepted('features', land(200, 200, 10));
    await cityPart(50, 50);
    const r = (await api.post(`/features/${isle.id}/revise`)).body;
    const water = (await api.patch(`/features/${r.id}`, { feature_class: 'water' })).body;
    await expectRefusedWithoutEffect(() => api.accept('features', water));
  });
});

describe('B: retiring land whose removal would shrink the fallback extent off an accepted part', () => {
  it('is refused and leaves canon unchanged', async () => {
    const west = await api.accepted('features', land(0, 0, 10));
    await api.accepted('features', land(100, 0, 10));
    await cityPart(5, 5);

    await expectRefusedWithoutEffect(() => api.post(`/features/${west.id}/retire`));
    expect((await api.get(`/features/${west.id}`)).body.lifecycle_state).toBe('accepted');
  });

  it('is allowed when the part stays inside the extent without it', async () => {
    await api.accepted('features', land(0, 0, 10));
    const east = await api.accepted('features', land(100, 0, 10));
    await cityPart(5, 5);
    expect((await api.post(`/features/${east.id}/retire`)).status).toBe(200);
  });
});

describe('C: a land revision that keeps the part inside the fallback extent', () => {
  it('is accepted', async () => {
    const isle = await api.accepted('features', land(0, 0, 100));
    await cityPart(50, 50);
    const { res } = await reviseLand(isle.id, square(0, 0, 60));
    expect(res.status).toBe(200);
    expect(res.body.record).toMatchObject({ revision: 2, bbox: { max_x: 60 } });
  });
});

describe('D: the candidate extent combines the revised land with every other accepted land', () => {
  // West isle 0–10, east isle 100–110: the fallback extent spans x 0–110; the part is at x 50.
  let west;
  let east;
  beforeEach(async () => {
    west = await api.accepted('features', land(0, 0, 10));
    east = await api.accepted('features', land(100, 0, 10));
    await cityPart(50, 5);
  });

  it('uses the revised geometry, not the old one: moving west past the part is refused', async () => {
    // Old geometry would still give 0–110 (part inside); the candidate gives 100–210.
    const { res } = await reviseLand(west.id, square(200, 0, 10));
    expect(res.status).toBe(409);
    expect(res.body.violations.map(v => v.code)).toEqual(['required_scope_violation']);
  });

  it('keeps unchanged land in the extent: a revision that alone would exclude the part is fine with its neighbour', async () => {
    // The revised west isle alone (20–30) excludes x 50; with the unchanged east isle, 20–110 includes it.
    const { res } = await reviseLand(west.id, square(20, 0, 10));
    expect(res.status).toBe(200);
  });

  it('accepts a far move of one isle when the other still spans the part', async () => {
    const { res } = await reviseLand(east.id, square(300, 0, 10));
    expect(res.status).toBe(200);
  });
});

describe('E: explicit extents are unaffected by the fallback rule', () => {
  it('a district with an accepted boundary keeps its own semantics while distant land moves', async () => {
    const d = await api.draft('scopes', scope('arboretum', 'district', CITY));
    const b = await api.draft('features', boundary(0, 0, 100));
    await api.patch(`/scopes/${d.id}`, { boundary_feature_id: b.id });
    await api.accept('features', b);
    await api.accept('scopes', (await api.get(`/scopes/${d.id}`)).body);
    const a = await api.accepted('anchors', anchor('treatment-works', { required_scope_id: d.id }));
    await api.accepted('features', site('point', { x: 50, z: 50 }, { anchor_id: a.id }));

    const far = await api.accepted('features', land(5000, 5000, 10));
    expect((await reviseLand(far.id, square(9000, 9000, 10))).res.status).toBe(200);
    expect((await api.post(`/features/${far.id}/retire`)).status).toBe(200);
  });

  it('a city with explicit members uses them, not all accepted land', async () => {
    const member = await api.accepted('features', land(0, 0, 100));
    const other = await api.accepted('features', land(500, 500, 10));
    const r = (await api.post(`/scopes/${CITY}/revise`)).body;
    const withMembers = (await api.patch(`/scopes/${r.id}`, { members: [member.id] })).body;
    expect((await api.accept('scopes', withMembers)).status).toBe(200);
    await cityPart(50, 50);

    // Not a member: moving or retiring it cannot change the city's extent.
    expect((await reviseLand(other.id, square(9000, 9000, 10))).res.status).toBe(200);
    expect((await api.post(`/features/${other.id}/retire`)).status).toBe(200);
    // The member itself is an explicit dependent, as before.
    expect((await api.post(`/features/${member.id}/retire`)).body.dependents).toEqual([
      { entity_type: 'scope', id: CITY, relation: 'member' },
    ]);
  });
});
