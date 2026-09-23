/**
 * The software/AI proposal channel (plan §5.2, §8.1).
 *
 * The architectural control is that proposals have their own route, and that route
 * cannot canonize: it creates `proposed` rows with generated provenance and required
 * proposal metadata, and nothing but an explicit world-editor accept turns one into canon.
 * Conversely, the editor routes refuse generated content.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { get, all } from './helpers/testDb.js';

const require_ = createRequire(import.meta.url);
const { setupCanonical, land, anchor, scope, square, PROPOSAL } = require_('./helpers/canonicalApi.js');

let db;
let api;

beforeEach(async () => {
  ({ db, api } = await setupCanonical());
});

const CITY = 1;
const acceptedCount = async () => (await get(db, `SELECT COUNT(*) AS c FROM canonical_features WHERE lifecycle_state = 'accepted'`)).c;

describe('POST /proposals', () => {
  it('creates a proposed row with generated provenance and its metadata — not canon', async () => {
    const res = await api.propose('features', { ...land(0, 0), feature_class: 'water', kind: 'basin' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ lifecycle_state: 'proposed', provenance: 'generated', revision: 0, proposal: PROPOSAL });
    expect((await api.anon.get('/features')).body).toEqual([]);
    expect((await api.get('/features?states=proposed')).body.map(r => r.id)).toEqual([res.body.id]);
  });

  it('requires provenance "generated" and proposal metadata with a source and generator', async () => {
    const body = { entity: 'features', ...land(0, 0) };
    expect((await api.post('/proposals', { ...body, proposal: PROPOSAL })).status).toBe(400);
    expect((await api.post('/proposals', { ...body, provenance: 'authored', proposal: PROPOSAL })).status).toBe(400);
    expect((await api.post('/proposals', { ...body, provenance: 'generated' })).status).toBe(400);
    expect((await api.post('/proposals', { ...body, provenance: 'generated', proposal: { generator: 'g' } })).status).toBe(400);
    expect((await api.post('/proposals', { ...body, provenance: 'generated', proposal: { ...PROPOSAL, secret_flag: 1 } })).status).toBe(400);
    expect((await api.post('/proposals', { ...land(0, 0), provenance: 'generated', proposal: PROPOSAL })).status).toBe(400);
    expect(await all(db, 'SELECT id FROM canonical_features')).toEqual([]);
  });

  it('can never set lifecycle, lock or replacement state', async () => {
    for (const extra of [{ lifecycle_state: 'accepted' }, { is_locked: true }, { replacement_state: 'replaceable' },
      { revision: 1 }, { draft_version: 5 }]) {
      const res = await api.propose('features', land(0, 0), extra);
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    expect(await all(db, 'SELECT id FROM canonical_features')).toEqual([]);
  });

  it('becomes canon only through an explicit accept, which keeps its generated provenance', async () => {
    const p = (await api.propose('features', land(0, 0))).body;
    expect(await acceptedCount()).toBe(0);
    const res = await api.accept('features', p);
    expect(res.status).toBe(200);
    expect(res.body.record).toMatchObject({ id: p.id, lifecycle_state: 'accepted', provenance: 'generated', proposal: PROPOSAL });
  });

  it('proposes anchors and scopes too, with scope members held non-canonically', async () => {
    const isle = await api.accepted('features', land(0, 0));
    const a = await api.propose('anchors', anchor('treatment-works', { category: 'facility' }));
    expect(a.status).toBe(201);
    const s = await api.propose('scopes', scope('reed-beds', 'subregion', CITY, { members: [isle.id] }));
    expect(s.status).toBe(201);
    expect(await all(db, 'SELECT is_canonical FROM geo_scope_members WHERE scope_id = ?', [s.body.id])).toEqual([{ is_canonical: 0 }]);
  });
});

describe('editor routes refuse generated content', () => {
  it('rejects generated provenance or proposal metadata on POST /:entity', async () => {
    const generated = await api.post('/features', { ...land(0, 0), provenance: 'generated' });
    expect(generated.status).toBe(400);
    expect(generated.body.error).toMatch(/POST \/proposals/);
    expect((await api.post('/features', { ...land(0, 0), provenance: 'generated', proposal: PROPOSAL })).status).toBe(400);
    expect((await api.post('/features', { ...land(0, 0), proposal: PROPOSAL })).status).toBe(400);
    expect((await api.post('/features', { ...land(0, 0), proposal_json: '{}' })).status).toBe(400);
  });

  it('does not let a draft edit rewrite provenance or attach proposal metadata', async () => {
    const d = await api.draft('features', land(0, 0));
    expect((await api.patch(`/features/${d.id}`, { provenance: 'generated' })).status).toBe(400);
    expect((await api.patch(`/features/${d.id}`, { proposal: PROPOSAL })).status).toBe(400);
    const p = (await api.propose('features', land(50, 0))).body;
    expect((await api.patch(`/features/${p.id}`, { provenance: 'authored' })).status).toBe(400);
  });
});

describe('proposals against accepted canon', () => {
  it('overlays the proposal on the canonical row, and accept keeps the id and the canonical provenance', async () => {
    const f = await api.accepted('features', land(0, 0, 10, { name: 'Isle', provenance: 'imported' }));
    const p = await api.propose('features', { geometry: square(0, 0, 12) }, { revises_id: f.id });
    expect(p.status).toBe(201);
    expect(p.body).toMatchObject({ revises_id: f.id, lifecycle_state: 'proposed', provenance: 'generated', name: 'Isle', feature_class: 'land' });

    const res = await api.accept('features', p.body);
    expect(res.body.record).toMatchObject({ id: f.id, revision: 2, provenance: 'imported', bbox: { max_x: 12 } });
    const h = (await api.get(`/features/${f.id}/revisions`)).body;
    expect(h.at(-1).snapshot.accepted_from).toMatchObject({ lifecycle_state: 'proposed', provenance: 'generated', proposal: PROPOSAL });
  });

  it('is stored against a locked row but cannot be accepted until the row is unlocked', async () => {
    const f = await api.accepted('features', land(0, 0));
    await api.patch(`/features/${f.id}/lock`, { is_locked: true });
    const p = await api.propose('features', { geometry: square(0, 0, 12) }, { revises_id: f.id });
    expect(p.status).toBe(201);

    const refused = await api.accept('features', p.body);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/locked/);
    expect((await api.get(`/features/${f.id}`)).body.revision).toBe(1);

    await api.patch(`/features/${f.id}/lock`, { is_locked: false });
    expect((await api.accept('features', p.body)).status).toBe(200);
  });

  it('may coexist with one editor draft, but not with a second open proposal', async () => {
    const f = await api.accepted('features', land(0, 0));
    expect((await api.post(`/features/${f.id}/revise`)).status).toBe(201);
    expect((await api.propose('features', {}, { revises_id: f.id })).status).toBe(201);
    expect((await api.propose('features', {}, { revises_id: f.id })).status).toBe(409);
  });

  it('can only revise accepted canon', async () => {
    const d = await api.draft('features', land(0, 0));
    expect((await api.propose('features', {}, { revises_id: d.id })).status).toBe(409);
    const f = await api.accepted('features', land(50, 0));
    await api.post(`/features/${f.id}/retire`);
    expect((await api.propose('features', {}, { revises_id: f.id })).status).toBe(409);
    expect((await api.propose('features', {}, { revises_id: 999 })).status).toBe(404);
  });

  it('cannot change an anchor key through a revision proposal', async () => {
    const a = await api.accepted('anchors', anchor('arena'));
    expect((await api.propose('anchors', { anchor_key: 'other' }, { revises_id: a.id })).status).toBe(400);
  });
});

describe('no path yields accepted canon without accept', () => {
  it('leaves nothing accepted after every non-accept route has run', async () => {
    const d = await api.draft('features', land(0, 0));
    await api.patch(`/features/${d.id}`, { name: 'x' });
    await api.propose('features', land(100, 0));
    await api.post('/features', { ...land(200, 0), lifecycle_state: 'accepted' });
    await api.post(`/features/${d.id}/restore`);
    await api.patch(`/features/${d.id}/lock`, { is_locked: true });
    expect(await acceptedCount()).toBe(0);
    expect((await api.anon.get('/features')).body).toEqual([]);
  });
});
