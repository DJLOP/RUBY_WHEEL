/**
 * The canonical-geography lifecycle (plan §3.7, §5.2): draft → accept, revise → accept,
 * descriptive edits, retire/restore, draft deletion, and drafts from history.
 *
 * What is load-bearing: nothing becomes canon except through accept; an accepted record
 * keeps its id across revisions; a constraint change always bumps the revision and writes
 * history, and a descriptive edit never bumps it.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { get, all } from './helpers/testDb.js';

const require_ = createRequire(import.meta.url);
const { setupCanonical, land, anchor, scope, square } = require_('./helpers/canonicalApi.js');

let db;
let api;
let emits;

beforeEach(async () => {
  ({ db, api, emits } = await setupCanonical());
});

const CITY = 1;
const history = async (entity, id) => (await api.get(`/${entity}/${id}/revisions`)).body;

describe('drafts', () => {
  it('creates a draft that is not canon: revision 0, draft_version 1, authored by default', async () => {
    const res = await api.post('/features', land(0, 0));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      entity_type: 'feature', lifecycle_state: 'draft', provenance: 'authored', revision: 0, draft_version: 1,
      replacement_state: 'non_replaceable', is_locked: false, revises_id: null, accepted_at: null,
    });
    expect(res.body.bbox).toEqual({ min_x: 0, min_z: 0, max_x: 10, max_z: 10 });
  });

  it('stores normalized geometry (open ring, counter-clockwise outer, 0.001-wu rounding)', async () => {
    const clockwise = { outer: [{ x: 0, z: 0 }, { x: 0, z: 10.00049 }, { x: 10, z: 10 }, { x: 10, z: 0 }, { x: 0, z: 0 }] };
    const rec = await api.draft('features', { ...land(0, 0), geometry: clockwise });
    expect(rec.geometry.outer).toEqual([{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }]);
    expect(rec.geometry.holes).toEqual([]);
  });

  it('accepts imported provenance and records evidence as documentation', async () => {
    const rec = await api.draft('features', {
      ...land(0, 0), provenance: 'imported',
      evidence: { reference_layer_id: 4, calibration_snapshot: { world_center_x: 1, world_units_per_pixel: 1.968503937 }, note: 'sheet 3' },
    });
    expect(rec.provenance).toBe('imported');
    expect(rec.evidence).toEqual({ reference_layer_id: 4, calibration_snapshot: { world_center_x: 1, world_units_per_pixel: 1.968503937 }, note: 'sheet 3' });
  });

  it('refuses a create body that tries to set lifecycle or protection state, writing nothing', async () => {
    for (const field of [
      { lifecycle_state: 'accepted' }, { revision: 3 }, { is_locked: true }, { replacement_state: 'replaceable' },
      { revises_id: 1 }, { draft_version: 9 }, { accepted_at: '2020-01-01' },
    ]) {
      const res = await api.post('/features', { ...land(0, 0), ...field });
      expect(res.status, JSON.stringify(field)).toBe(400);
    }
    expect((await get(db, 'SELECT COUNT(*) AS c FROM canonical_features')).c).toBe(0);
    expect(emits).toHaveLength(0);
  });

  it('refuses invalid single-record input with 400', async () => {
    const bowTie = { outer: [{ x: 0, z: 0 }, { x: 10, z: 10 }, { x: 10, z: 0 }, { x: 0, z: 10 }] };
    const cases = [
      { ...land(0, 0), geometry: bowTie },
      { ...land(0, 0), feature_class: 'lake' },
      { ...land(0, 0), geometry_type: 'linestring' },
      { ...land(0, 0), kind: 'channel' },
      { ...land(0, 0), constraint_strength: undefined },
      { ...land(0, 0), part_role: 'core' },
      { ...land(0, 0), attributes: { navigable: 'yes' } },
      { ...land(0, 0), geometry: square(25000, 0) },
      { ...land(0, 0), unknown_field: 1 },
    ];
    for (const body of cases) {
      const res = await api.post('/features', body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
  });

  it('lists drafts only for the world editor, never in the public accepted list', async () => {
    await api.draft('features', land(0, 0));
    expect((await api.anon.get('/features')).body).toEqual([]);
    const drafts = await api.get('/features?states=draft');
    expect(drafts.status).toBe(200);
    expect(drafts.body).toHaveLength(1);
  });

  it('edits a draft freely, re-validating the whole record and bumping draft_version', async () => {
    const d = await api.draft('features', land(0, 0));
    const res = await api.patch(`/features/${d.id}`, { geometry: square(5, 5, 20), name: 'Isle' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ draft_version: 2, name: 'Isle', bbox: { min_x: 5, min_z: 5, max_x: 25, max_z: 25 } });

    const bad = await api.patch(`/features/${d.id}`, { geometry_type: 'point' });
    expect(bad.status).toBe(400);
    expect((await api.get(`/features/${d.id}`)).body.draft_version).toBe(2);
  });

  it('refuses a draft edit against a stale expected_draft_version', async () => {
    const d = await api.draft('features', land(0, 0));
    await api.patch(`/features/${d.id}`, { name: 'A' });
    const res = await api.patch(`/features/${d.id}`, { name: 'B', expected_draft_version: 1 });
    expect(res.status).toBe(409);
    expect(res.body.draft_version).toBe(2);
  });

  it('hard-deletes drafts and proposals, which are not canon', async () => {
    const d = await api.draft('features', land(0, 0));
    expect((await api.del(`/features/${d.id}`)).status).toBe(200);
    expect(await get(db, 'SELECT * FROM canonical_features WHERE id = ?', [d.id])).toBeUndefined();

    const s = await api.draft('scopes', scope('arena', 'district', CITY));
    expect((await api.del(`/scopes/${s.id}`)).status).toBe(200);
    expect(await all(db, 'SELECT * FROM geo_scope_members WHERE scope_id = ?', [s.id])).toEqual([]);
  });

  it('answers 404 for an unknown entity or id', async () => {
    expect((await api.get('/islands')).status).toBe(404);
    expect((await api.post('/islands', {})).status).toBe(404);
    expect((await api.get('/features/999')).status).toBe(404);
    expect((await api.get('/features/abc')).status).toBe(404);
    expect((await api.post('/features/999/accept', { expected_draft_version: 1 })).status).toBe(404);
  });
});

describe('accept', () => {
  it('turns a draft into canon at revision 1, keeping its id, and records history', async () => {
    const d = await api.draft('features', land(0, 0, 10, { name: 'First Isle' }));
    const res = await api.accept('features', d);
    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual([]);
    expect(res.body.record).toMatchObject({ id: d.id, lifecycle_state: 'accepted', revision: 1, provenance: 'authored' });
    expect(res.body.record.accepted_at).toBeTruthy();

    const h = await history('features', d.id);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ change_kind: 'accept', revision: 1 });
    expect(h[0].snapshot).toMatchObject({ id: d.id, name: 'First Isle', revision: 1, accepted_from: { draft_id: d.id, provenance: 'authored' } });

    expect((await api.anon.get('/features')).body.map(f => f.id)).toEqual([d.id]);
  });

  it('requires expected_draft_version and refuses a stale one', async () => {
    const d = await api.draft('features', land(0, 0));
    expect((await api.post(`/features/${d.id}/accept`, {})).status).toBe(400);
    await api.patch(`/features/${d.id}`, { name: 'changed after review' });
    const stale = await api.post(`/features/${d.id}/accept`, { expected_draft_version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.draft_version).toBe(2);
    expect((await get(db, 'SELECT lifecycle_state FROM canonical_features WHERE id = ?', [d.id])).lifecycle_state).toBe('draft');
  });

  it('refuses accept of something already accepted or retired', async () => {
    const f = await api.accepted('features', land(0, 0));
    expect((await api.post(`/features/${f.id}/accept`, { expected_draft_version: f.draft_version })).status).toBe(409);
    await api.post(`/features/${f.id}/retire`);
    expect((await api.post(`/features/${f.id}/accept`, { expected_draft_version: f.draft_version })).status).toBe(409);
  });

  it('refuses extra fields on accept, so nothing else rides along with canonization', async () => {
    const d = await api.draft('features', land(0, 0));
    const res = await api.post(`/features/${d.id}/accept`, { expected_draft_version: 1, is_locked: true });
    expect(res.status).toBe(400);
  });
});

describe('revise → accept', () => {
  it('keeps the id, increments the revision, deletes the draft, and writes history', async () => {
    const f = await api.accepted('features', land(0, 0, 10, { name: 'Isle' }));
    const rev = await api.post(`/features/${f.id}/revise`);
    expect(rev.status).toBe(201);
    expect(rev.body).toMatchObject({ lifecycle_state: 'draft', revises_id: f.id, revision: 0, name: 'Isle' });
    expect(rev.body.id).not.toBe(f.id);

    await api.patch(`/features/${rev.body.id}`, { geometry: square(0, 0, 20) });
    const d = (await api.get(`/features/${rev.body.id}`)).body;
    const res = await api.accept('features', d);
    expect(res.status).toBe(200);
    expect(res.body.record).toMatchObject({ id: f.id, revision: 2, lifecycle_state: 'accepted', bbox: { max_x: 20 } });

    expect(await get(db, 'SELECT * FROM canonical_features WHERE id = ?', [rev.body.id])).toBeUndefined();
    const h = await history('features', f.id);
    expect(h.map(x => [x.change_kind, x.revision])).toEqual([['accept', 1], ['accept', 2]]);
    expect(h[1].snapshot.accepted_from.draft_id).toBe(rev.body.id);
  });

  it('refuses a second open editor revision of the same row', async () => {
    const f = await api.accepted('features', land(0, 0));
    expect((await api.post(`/features/${f.id}/revise`)).status).toBe(201);
    const again = await api.post(`/features/${f.id}/revise`);
    expect(again.status).toBe(409);
    expect(again.body.open_revision_id).toBeTruthy();
  });

  it('refuses to revise a draft or a retired row', async () => {
    const d = await api.draft('features', land(0, 0));
    expect((await api.post(`/features/${d.id}/revise`)).status).toBe(409);
    const f = await api.accepted('features', land(50, 0));
    await api.post(`/features/${f.id}/retire`);
    expect((await api.post(`/features/${f.id}/revise`)).status).toBe(409);
  });

  it('keeps an anchor or scope key fixed across a revision', async () => {
    const a = await api.accepted('anchors', anchor('arena'));
    const r = (await api.post(`/anchors/${a.id}/revise`)).body;
    expect(r.anchor_key).toBe('arena');
    expect((await api.patch(`/anchors/${r.id}`, { anchor_key: 'colosseum' })).status).toBe(400);
    expect((await api.patch(`/anchors/${r.id}`, { category: 'precinct' })).status).toBe(200);
  });

  it('refuses a new draft whose key is already used by another record', async () => {
    await api.accepted('anchors', anchor('arena'));
    expect((await api.post('/anchors', anchor('arena'))).status).toBe(409);
    expect((await api.post('/scopes', scope('city', 'district', CITY))).status).toBe(409);
  });

  it('transfers scope membership: draft members are non-canonical until accept, then replace the old set', async () => {
    const a = await api.accepted('features', land(0, 0));
    const b = await api.accepted('features', land(50, 0));
    const d = await api.draft('scopes', scope('arena', 'district', CITY, { members: [a.id] }));
    expect(await all(db, 'SELECT scope_id, feature_id, is_canonical FROM geo_scope_members')).toEqual([
      { scope_id: d.id, feature_id: a.id, is_canonical: 0 },
    ]);

    const accepted = (await api.accept('scopes', d)).body.record;
    expect(accepted.members).toEqual([a.id]);
    expect(await all(db, 'SELECT scope_id, feature_id, is_canonical FROM geo_scope_members')).toEqual([
      { scope_id: d.id, feature_id: a.id, is_canonical: 1 },
    ]);

    const r = (await api.post(`/scopes/${d.id}/revise`)).body;
    expect(r.members).toEqual([a.id]);
    const edited = (await api.patch(`/scopes/${r.id}`, { members: [b.id] })).body;
    const res = await api.accept('scopes', edited);
    expect(res.status).toBe(200);
    expect(res.body.record).toMatchObject({ id: d.id, revision: 2, members: [b.id] });
    expect(await all(db, 'SELECT scope_id, feature_id, is_canonical FROM geo_scope_members ORDER BY scope_id')).toEqual([
      { scope_id: d.id, feature_id: b.id, is_canonical: 1 },
    ]);
  });
});

describe('accepted records in place', () => {
  it('allows a descriptive edit without bumping the revision, and records it as history', async () => {
    const f = await api.accepted('features', land(0, 0, 10, { name: 'Isle' }));
    const res = await api.patch(`/features/${f.id}`, { name: 'Isle of Tears', notes: 'typo fix' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Isle of Tears', notes: 'typo fix', revision: 1, draft_version: f.draft_version });

    const h = await history('features', f.id);
    expect(h.map(x => [x.change_kind, x.revision])).toEqual([['accept', 1], ['descriptive_edit', 1]]);
    expect(h[1].snapshot.name).toBe('Isle of Tears');
  });

  it('refuses every constraint field in place with 409 and a pointer to revise', async () => {
    const f = await api.accepted('features', land(0, 0));
    const before = await get(db, 'SELECT * FROM canonical_features WHERE id = ?', [f.id]);
    for (const body of [{ geometry: square(1, 1) }, { constraint_strength: 'soft' }, { feature_class: 'water' },
      { anchor_id: 1 }, { name: 'ok', geometry: square(1, 1) }, { evidence: { note: 'x' } }]) {
      const res = await api.patch(`/features/${f.id}`, body);
      expect(res.status, JSON.stringify(body)).toBe(409);
      expect(res.body.error).toMatch(/revise/);
    }
    expect(await get(db, 'SELECT * FROM canonical_features WHERE id = ?', [f.id])).toEqual(before);
    expect(await history('features', f.id)).toHaveLength(1);
  });

  it('refuses to blank a required name in place', async () => {
    const a = await api.accepted('anchors', anchor('arena'));
    expect((await api.patch(`/anchors/${a.id}`, { name: '  ' })).status).toBe(400);
  });

  it('never hard-deletes accepted or retired canon', async () => {
    const f = await api.accepted('features', land(0, 0));
    expect((await api.del(`/features/${f.id}`)).status).toBe(409);
    await api.post(`/features/${f.id}/retire`);
    expect((await api.del(`/features/${f.id}`)).status).toBe(409);
    expect((await api.del(`/scopes/${CITY}`)).status).toBe(409);
    expect(await get(db, 'SELECT id FROM canonical_features WHERE id = ?', [f.id])).toBeTruthy();
  });
});

describe('retire / restore', () => {
  it('retires accepted canon out of the public list and restores it, recording both', async () => {
    const f = await api.accepted('features', land(0, 0));
    const r = await api.post(`/features/${f.id}/retire`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ lifecycle_state: 'retired', revision: 1 });
    expect((await api.anon.get('/features')).body).toEqual([]);
    expect((await api.get('/features?states=retired')).body.map(x => x.id)).toEqual([f.id]);

    expect((await api.patch(`/features/${f.id}`, { name: 'x' })).status).toBe(409);

    const s = await api.post(`/features/${f.id}/restore`);
    expect(s.status).toBe(200);
    expect(s.body.record).toMatchObject({ lifecycle_state: 'accepted', revision: 1 });
    expect((await history('features', f.id)).map(x => x.change_kind)).toEqual(['accept', 'retire', 'restore']);
  });

  it('refuses to restore anything that is not retired, or retire anything not accepted', async () => {
    const d = await api.draft('features', land(0, 0));
    expect((await api.post(`/features/${d.id}/retire`)).status).toBe(409);
    expect((await api.post(`/features/${d.id}/restore`)).status).toBe(409);
    const f = await api.accepted('features', land(50, 0));
    expect((await api.post(`/features/${f.id}/restore`)).status).toBe(409);
  });

  it('releases a retired scope\'s membership, and takes it back on restore', async () => {
    const a = await api.accepted('features', land(0, 0));
    const s = await api.accepted('scopes', scope('arena', 'district', CITY, { members: [a.id] }));
    await api.post(`/scopes/${s.id}/retire`);
    expect((await get(db, 'SELECT is_canonical FROM geo_scope_members WHERE scope_id = ?', [s.id])).is_canonical).toBe(0);
    await api.post(`/scopes/${s.id}/restore`);
    expect((await get(db, 'SELECT is_canonical FROM geo_scope_members WHERE scope_id = ?', [s.id])).is_canonical).toBe(1);
  });
});

describe('history and drafts from history', () => {
  it('drafts a revision from an older accepted snapshot, which becomes canon only through accept', async () => {
    const f = await api.accepted('features', land(0, 0, 10));
    const r = (await api.post(`/features/${f.id}/revise`)).body;
    const edited = (await api.patch(`/features/${r.id}`, { geometry: square(0, 0, 30) })).body;
    await api.accept('features', edited);

    const res = await api.post(`/features/${f.id}/revisions/1/draft`);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ lifecycle_state: 'draft', revises_id: f.id, bbox: { max_x: 10 } });
    // Still revision 2 until accepted.
    expect((await api.get(`/features/${f.id}`)).body).toMatchObject({ revision: 2, bbox: { max_x: 30 } });

    const acc = await api.accept('features', res.body);
    expect(acc.body.record).toMatchObject({ id: f.id, revision: 3, bbox: { max_x: 10 } });
  });

  it('works for the migration-seeded root scope\'s history too', async () => {
    const res = await api.post(`/scopes/${CITY}/revisions/1/draft`);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ scope_key: 'city', scope_kind: 'city', revises_id: CITY, lifecycle_state: 'draft' });
  });

  it('answers 404 for a revision that was never accepted', async () => {
    const f = await api.accepted('features', land(0, 0));
    expect((await api.post(`/features/${f.id}/revisions/7/draft`)).status).toBe(404);
    expect((await api.post(`/features/${f.id}/revisions/0/draft`)).status).toBe(404);
  });

  it('refuses a draft from history of a retired row until it is restored', async () => {
    const f = await api.accepted('features', land(0, 0));
    await api.post(`/features/${f.id}/retire`);
    expect((await api.post(`/features/${f.id}/revisions/1/draft`)).status).toBe(409);
  });

  it('keeps the history table append-only at the SQL level', async () => {
    await api.accepted('features', land(0, 0));
    await expect(new Promise((res, rej) => db.run('DELETE FROM canonical_revisions', (e) => (e ? rej(e) : res()))))
      .rejects.toThrow(/append-only/);
  });
});
