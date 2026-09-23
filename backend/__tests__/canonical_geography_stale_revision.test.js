/**
 * Optimistic concurrency on canonical revisions (migration 003).
 *
 * An editor draft and a software proposal may revise the same accepted row at once. Each
 * records the target's revision when it is created (`base_revision`); accept refuses one
 * whose base no longer matches, so accepting the first makes the second stale rather than
 * letting it silently replace newer canon. The stale one is kept, not deleted or rebased.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { makeTestDb, get, all, run } from './helpers/testDb.js';

const require_ = createRequire(import.meta.url);
const { setupCanonical, snapshotCanonical, land, square } = require_('./helpers/canonicalApi.js');
const { runMigrations, MIGRATIONS } = require_('../migrations/index.js');

let db;
let api;
let emits;

beforeEach(async () => {
  ({ db, api, emits } = await setupCanonical());
});

const canonical = (id) => get(db, 'SELECT * FROM canonical_features WHERE id = ?', [id]);

/** An accepted island plus an editor draft and a proposal, both built against revision 1. */
async function competing() {
  const f = await api.accepted('features', land(0, 0, 10));
  const draft = (await api.patch(`/features/${(await api.post(`/features/${f.id}/revise`)).body.id}`,
    { geometry: square(0, 0, 20) })).body;
  const proposal = (await api.propose('features', { geometry: square(0, 0, 30) }, { revises_id: f.id })).body;
  return { f, draft, proposal };
}

describe('base_revision is recorded when a revision is created', () => {
  it('A: an editor revise records the current canonical revision', async () => {
    const f = await api.accepted('features', land(0, 0));
    const r = await api.post(`/features/${f.id}/revise`);
    expect(r.body).toMatchObject({ revises_id: f.id, base_revision: 1 });
  });

  it('B: a proposal against accepted canon records the current canonical revision', async () => {
    const f = await api.accepted('features', land(0, 0));
    const p = await api.propose('features', {}, { revises_id: f.id });
    expect(p.body).toMatchObject({ revises_id: f.id, base_revision: 1 });
  });

  it('leaves drafts and proposals that revise nothing without a base, and refuses a caller-supplied one', async () => {
    expect((await api.draft('features', land(0, 0))).base_revision).toBeNull();
    expect((await api.propose('features', land(50, 0))).body.base_revision).toBeNull();
    expect((await api.post('/features', { ...land(100, 0), base_revision: 1 })).status).toBe(400);
    const f = await api.accepted('features', land(200, 0));
    const r = (await api.post(`/features/${f.id}/revise`)).body;
    expect((await api.patch(`/features/${r.id}`, { base_revision: 9 })).status).toBe(400);
  });

  it('G: a draft from history takes historical content but the current revision as its base', async () => {
    const f = await api.accepted('features', land(0, 0, 10));
    for (const size of [20, 30]) {
      const r = (await api.post(`/features/${f.id}/revise`)).body;
      await api.accept('features', (await api.patch(`/features/${r.id}`, { geometry: square(0, 0, size) })).body);
    }
    expect((await canonical(f.id)).revision).toBe(3);

    const d = await api.post(`/features/${f.id}/revisions/1/draft`);
    expect(d.status).toBe(201);
    expect(d.body).toMatchObject({ base_revision: 3, bbox: { max_x: 10 } });
    const acc = await api.accept('features', d.body);
    expect(acc.status).toBe(200);
    expect(acc.body.record).toMatchObject({ revision: 4, bbox: { max_x: 10 } });
  });
});

describe('accept refuses a stale revision', () => {
  it('C: after the editor draft is accepted, the proposal built on revision 1 is refused with 409', async () => {
    const { f, draft, proposal } = await competing();
    expect((await api.accept('features', draft)).body.record).toMatchObject({ id: f.id, revision: 2, bbox: { max_x: 20 } });

    const res = await api.accept('features', proposal);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'stale_revision', base_revision: 1, current_revision: 2 });
    expect(await canonical(f.id)).toMatchObject({ revision: 2, max_x: 20 });
  });

  it('D: after the proposal is accepted, the editor draft built on revision 1 cannot overwrite it', async () => {
    const { f, draft, proposal } = await competing();
    expect((await api.accept('features', proposal)).body.record).toMatchObject({ revision: 2, bbox: { max_x: 30 } });

    const res = await api.accept('features', draft);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('stale_revision');
    expect(await canonical(f.id)).toMatchObject({ revision: 2, max_x: 30 });
  });

  it('E/F: keeps the stale revision, writes no history, changes nothing and emits nothing', async () => {
    const { draft, proposal } = await competing();
    await api.accept('features', draft);
    const before = await snapshotCanonical(db);
    const emitted = emits.length;

    expect((await api.accept('features', proposal)).status).toBe(409);

    expect(await snapshotCanonical(db)).toEqual(before);
    expect(emits.length).toBe(emitted);
    expect(await get(db, 'SELECT lifecycle_state, base_revision FROM canonical_features WHERE id = ?', [proposal.id]))
      .toEqual({ lifecycle_state: 'proposed', base_revision: 1 });
    // Still there to inspect, and still deletable as a non-canonical row.
    expect((await api.get(`/features/${proposal.id}`)).body.base_revision).toBe(1);
    expect((await api.del(`/features/${proposal.id}`)).status).toBe(200);
  });

  it('refuses a stale revision even after edits to it: editing does not rebase it', async () => {
    const { draft, proposal } = await competing();
    await api.accept('features', proposal);
    const edited = (await api.patch(`/features/${draft.id}`, { name: 'still stale' })).body;
    expect(edited.base_revision).toBe(1);
    expect((await api.accept('features', edited)).body.code).toBe('stale_revision');
  });

  it('H: a revise → accept with nothing in between still succeeds', async () => {
    const f = await api.accepted('features', land(0, 0, 10));
    const r = (await api.post(`/features/${f.id}/revise`)).body;
    const res = await api.accept('features', (await api.patch(`/features/${r.id}`, { geometry: square(0, 0, 15) })).body);
    expect(res.status).toBe(200);
    expect(res.body.record).toMatchObject({ revision: 2, bbox: { max_x: 15 } });
  });

  it('applies to scopes and anchors through the same path', async () => {
    const s = await api.accepted('scopes', { scope_key: 'arena', scope_kind: 'district', parent_scope_id: 1, name: 'Arena' });
    const draft = (await api.post(`/scopes/${s.id}/revise`)).body;
    const proposal = (await api.propose('scopes', { land_coverage: 'complete' }, { revises_id: s.id })).body;
    expect((await api.accept('scopes', proposal)).status).toBe(200);
    expect((await api.accept('scopes', draft)).body.code).toBe('stale_revision');
  });
});

describe('I: migration 003 on a database that already has 002', () => {
  const THROUGH_002 = MIGRATIONS.filter(m => m.name <= '002-canonical-geography');
  const TABLES = ['canonical_features', 'canonical_anchors', 'canonical_connections', 'geo_scopes'];

  it('adds a nullable base_revision everywhere, keeping every existing row and legacy table intact', async () => {
    const old = await makeTestDb({ migrations: THROUGH_002 });
    const polygon = JSON.stringify(square(0, 0, 10));
    await run(old, `INSERT INTO canonical_features (feature_class, geometry_type, geometry_json, min_x, min_z, max_x, max_z,
      constraint_strength, provenance, lifecycle_state, revision) VALUES ('land', 'polygon', ?, 0, 0, 10, 10, 'hard', 'authored', 'accepted', 1)`, [polygon]);
    await run(old, `INSERT INTO canonical_features (feature_class, geometry_type, geometry_json, min_x, min_z, max_x, max_z,
      constraint_strength, provenance, lifecycle_state, revises_id) VALUES ('land', 'polygon', ?, 0, 0, 10, 10, 'hard', 'authored', 'draft', 1)`, [polygon]);
    await run(old, `INSERT INTO canonical_anchors (anchor_key, name, category, constraint_strength, provenance) VALUES ('arena', 'Arena', 'landmark', 'hard', 'imported')`);
    await run(old, `INSERT INTO locations (name, x, y, z) VALUES ('Arena', 1, 2, 3)`);
    await run(old, `INSERT INTO water_bodies (points_json) VALUES ('[]')`);

    const dump = async (tables) => {
      const out = {};
      for (const t of tables) out[t] = await all(old, `SELECT * FROM ${t} ORDER BY rowid`);
      return out;
    };
    const kept = ['geo_scope_members', 'canonical_revisions', 'locations', 'water_bodies', 'districts', 'reference_layers'];
    const before = { ...(await dump(TABLES)), ...(await dump(kept)) };

    expect(await runMigrations(old)).toEqual(['003-canonical-base-revision']);
    expect(await runMigrations(old)).toEqual([]);

    const after = await dump([...TABLES, ...kept]);
    for (const t of kept) expect(after[t], t).toEqual(before[t]);
    for (const t of TABLES) {
      expect(after[t].map(({ base_revision, ...rest }) => rest), t).toEqual(before[t]);
      expect(after[t].every(r => r.base_revision === null), t).toBe(true);
    }
    await expect(run(old, 'UPDATE canonical_features SET base_revision = 0 WHERE id = 2')).rejects.toThrow(/CHECK/);

    // A revision drafted before 003 has no provable base, so it cannot be accepted blind.
    const { api: oldApi } = await setupCanonical({ db: old });
    const res = await oldApi.post('/features/2/accept', { expected_draft_version: 1 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'stale_revision', base_revision: null, current_revision: 1 });
    expect((await get(old, 'SELECT revision FROM canonical_features WHERE id = 1')).revision).toBe(1);
  });
});
