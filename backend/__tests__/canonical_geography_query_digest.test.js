/**
 * The canonical-input digest (plan §5.3; R-022 "equivalent canonical inputs").
 *
 * It must change exactly when something a generator is bound by changes: an accepted
 * constraint revision, what may be overwritten (replacement state, lock), or which
 * accepted entities the extent contains. It must not change for descriptive edits, for
 * drafts or proposals, for canon outside the extent and halo, or for the order SQLite
 * happens to return rows in.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const { setupCanonical, land, square } = require_('./helpers/canonicalApi.js');
const { buildArchipelago, CITY } = require_('./helpers/canonicalArchipelago.js');
const { runQuery } = require_('../canonicalGeography/query.js');
const { get, all } = require_('./helpers/testDb.js');

let api;
let ids;
let db;

beforeEach(async () => {
  ({ api, db } = await setupCanonical());
  ids = await buildArchipelago(api);
});

const bundle = async (body) => api.expectStatus(await api.anon.post('/query', body), 200, `query ${JSON.stringify(body)}`);
const digest = async (body) => (await bundle(body)).digest;
const ISLAND = () => ({ feature_id: ids.islandA, halo_wu: 60 });
const WEST = () => ({ scope_id: ids.west });

describe('digest stability', () => {
  it('is a sha256 hex string, identical for identical queries', async () => {
    const a = await digest(WEST());
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await digest(WEST())).toBe(a);
  });

  it('does not depend on the order rows come back from the database', async () => {
    const straight = { get: (sql, p) => get(db, sql, p), all: (sql, p) => all(db, sql, p) };
    const reversed = { get: straight.get, all: async (sql, p) => (await all(db, sql, p)).reverse() };
    for (const body of [{ scope_id: CITY }, WEST(), ISLAND(), { scope_id: ids.east, halo_wu: 25 }]) {
      const a = await runQuery(straight, body);
      const b = await runQuery(reversed, body);
      expect(b.digest).toBe(a.digest);
      expect(b).toEqual(a); // the whole bundle, not just the digest
    }
  });

  it('is unchanged by descriptive edits to included features, anchors, scopes and connections', async () => {
    const before = await bundle(ISLAND());
    for (const [entity, id] of [['features', ids.islandA], ['anchors', ids.arboretum], ['scopes', ids.west], ['connections', ids.bridgeLink]]) {
      const res = await api.patch(`/${entity}/${id}`, { name: `Renamed ${entity}`, description: 'typo fix', notes: 'n' });
      api.expectStatus(res, 200, `rename ${entity}`);
      expect(res.body.revision).toBe(1);
    }
    const after = await bundle(ISLAND());
    expect(after.digest).toBe(before.digest);
    expect(after.land.find(l => l.id === ids.islandA).name).toBe('Renamed features'); // the content did change
  });

  it('is unchanged by drafts, proposals and pending revisions', async () => {
    const before = await digest(ISLAND());
    await api.draft('features', land(5, 105, 10));
    await api.propose('features', land(20, 105, 5));
    await api.expectStatus(await api.post(`/features/${ids.islandA}/revise`), 201, 'revise');
    expect(await digest(ISLAND())).toBe(before);
  });

  it('is unchanged by accepted canon outside the extent and halo', async () => {
    const before = await digest(ISLAND());
    await api.accepted('features', land(1000, 1000, 10));
    expect(await digest(ISLAND())).toBe(before);
  });

  it('depends on the query target and halo', async () => {
    expect(await digest({ feature_id: ids.islandA })).not.toBe(await digest(ISLAND()));
    expect(await digest({ scope_id: ids.westPair })).not.toBe(await digest(WEST()));
  });
});

describe('digest sensitivity to constraint changes', () => {
  it('changes when an included feature is revised and accepted', async () => {
    const before = await digest(ISLAND());
    const r = (await api.post(`/features/${ids.islandA}/revise`)).body;
    const edited = (await api.patch(`/features/${r.id}`, { geometry: square(0, 0, 90) })).body;
    api.expectStatus(await api.accept('features', edited), 200, 'accept revision');
    const after = await bundle(ISLAND());
    expect(after.land.find(l => l.id === ids.islandA).revision).toBe(2);
    expect(after.digest).not.toBe(before);
  });

  it('changes when new canon is accepted inside the extent, and when included canon is retired', async () => {
    const d0 = await digest(ISLAND());
    const pond = await api.accepted('features', {
      feature_class: 'water', kind: 'basin', geometry_type: 'polygon', geometry: square(70, 70, 10), constraint_strength: 'soft',
    });
    const d1 = await digest(ISLAND());
    expect(d1).not.toBe(d0);
    await api.expectStatus(await api.post(`/features/${pond.id}/retire`), 200, 'retire');
    // Retiring it restores the earlier canonical inputs, so the earlier digest returns.
    expect(await digest(ISLAND())).toBe(d0);
  });

  it('changes when lock or replacement state changes, and returns when they are undone', async () => {
    const d0 = await digest(ISLAND());
    await api.expectStatus(await api.patch(`/features/${ids.islandA}/lock`, { is_locked: true }), 200, 'lock');
    const locked = await digest(ISLAND());
    expect(locked).not.toBe(d0);
    await api.expectStatus(await api.patch(`/features/${ids.islandA}/lock`, { is_locked: false }), 200, 'unlock');
    expect(await digest(ISLAND())).toBe(d0);

    await api.expectStatus(await api.patch(`/features/${ids.islandB}/replacement`, { replacement_state: 'replaceable' }), 200, 'replaceable');
    expect(await digest(ISLAND())).not.toBe(d0);
  });

  it('changes when an enclosing scope\'s constraints are revised', async () => {
    const before = await digest(ISLAND());
    const r = (await api.post(`/scopes/${ids.west}/revise`)).body;
    const edited = (await api.patch(`/scopes/${r.id}`, { land_coverage: 'complete' })).body;
    api.expectStatus(await api.accept('scopes', edited), 200, 'accept scope revision');
    expect(await digest(ISLAND())).not.toBe(before);
  });

  it('changes when a must-exist obligation is placed', async () => {
    const before = await bundle(WEST());
    expect(before.readiness.unplaced_must_exist).toEqual([ids.arena]);
    await api.accepted('features', { feature_class: 'site', geometry_type: 'polygon', geometry: square(60, 60, 20),
      constraint_strength: 'hard', anchor_id: ids.arena, part_role: 'footprint' });
    const after = await bundle(WEST());
    expect(after.readiness.unplaced_must_exist).toEqual([]);
    expect(after.anchors.find(a => a.id === ids.arena)).toMatchObject({ placed: true, relation: 'inside' });
    expect(after.digest).not.toBe(before.digest);
  });

  it('changes when a connection bearing on the extent is accepted', async () => {
    const before = await digest(ISLAND());
    await api.accepted('connections', {
      from_ref_type: 'feature', from_ref_id: ids.islandA, to_ref_type: 'feature', to_ref_id: ids.islandC,
      connection_kind: 'ferry', constraint_strength: 'soft',
    });
    expect(await digest(ISLAND())).not.toBe(before);
  });
});
