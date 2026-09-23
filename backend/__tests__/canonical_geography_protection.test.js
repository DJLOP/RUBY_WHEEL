/**
 * Lock and replacement protection (plan §3.1, §8.2), tested by direct API call — a
 * disabled button protects nothing, so every refusal here is the server's.
 *
 * A locked accepted row refuses revise, retire, replacement change, constraint edits,
 * descriptive edits and drafts from its history, and a revision drafted before the lock
 * cannot be accepted while it holds. Unlocking is always its own request.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { get, run } from './helpers/testDb.js';

const require_ = createRequire(import.meta.url);
const { setupCanonical, land, anchor, square } = require_('./helpers/canonicalApi.js');

let db;
let api;
let emits;

beforeEach(async () => {
  ({ db, api, emits } = await setupCanonical());
});

const row = (id) => get(db, 'SELECT * FROM canonical_features WHERE id = ?', [id]);
const lock = (entity, id) => api.patch(`/${entity}/${id}/lock`, { is_locked: true });
const unlock = (entity, id) => api.patch(`/${entity}/${id}/lock`, { is_locked: false });

describe('a locked accepted row', () => {
  it('refuses every destructive or constraint-changing request with 409 and stays unchanged', async () => {
    const f = await api.accepted('features', land(0, 0));
    expect((await lock('features', f.id)).status).toBe(200);
    const before = await row(f.id);
    const emitted = emits.length;

    const attempts = [
      ['revise', () => api.post(`/features/${f.id}/revise`)],
      ['retire', () => api.post(`/features/${f.id}/retire`)],
      ['replacement', () => api.patch(`/features/${f.id}/replacement`, { replacement_state: 'replaceable' })],
      ['constraint patch', () => api.patch(`/features/${f.id}`, { geometry: square(1, 1) })],
      ['descriptive patch', () => api.patch(`/features/${f.id}`, { name: 'renamed' })],
      ['draft from history', () => api.post(`/features/${f.id}/revisions/1/draft`)],
    ];
    for (const [what, attempt] of attempts) {
      const res = await attempt();
      expect(res.status, what).toBe(409);
      expect(res.body.error, what).toMatch(/locked/);
    }
    expect(await row(f.id)).toEqual(before);
    expect(emits.length).toBe(emitted);
    expect((await get(db, `SELECT COUNT(*) AS c FROM canonical_features WHERE revises_id = ?`, [f.id])).c).toBe(0);
  });

  it('cannot accept a revision drafted before the lock until it is unlocked', async () => {
    const f = await api.accepted('features', land(0, 0));
    const r = (await api.post(`/features/${f.id}/revise`)).body;
    const edited = (await api.patch(`/features/${r.id}`, { geometry: square(0, 0, 20) })).body;
    await lock('features', f.id);

    const refused = await api.accept('features', edited);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/locked/);
    expect((await row(f.id)).revision).toBe(1);

    await unlock('features', f.id);
    const accepted = await api.accept('features', edited);
    expect(accepted.status).toBe(200);
    expect(accepted.body.record.revision).toBe(2);
  });

  it('keeps revision history of lock and unlock without changing the revision', async () => {
    const f = await api.accepted('features', land(0, 0));
    await lock('features', f.id);
    await unlock('features', f.id);
    const h = (await api.get(`/features/${f.id}/revisions`)).body;
    expect(h.map(x => [x.change_kind, x.revision])).toEqual([['accept', 1], ['lock', 1], ['unlock', 1]]);
    expect(h[1].snapshot.is_locked).toBe(true);
  });
});

describe('unlock is a separate request', () => {
  it('refuses a lock request carrying any other field, leaving the row locked', async () => {
    const f = await api.accepted('features', land(0, 0));
    await lock('features', f.id);
    for (const body of [{ is_locked: false, name: 'x' }, { is_locked: false, geometry: square(1, 1) },
      { is_locked: false, replacement_state: 'replaceable' }]) {
      expect((await api.patch(`/features/${f.id}/lock`, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await row(f.id)).is_locked).toBe(1);
  });

  it('refuses lock state in an ordinary edit', async () => {
    const f = await api.accepted('features', land(0, 0));
    await lock('features', f.id);
    const res = await api.patch(`/features/${f.id}`, { is_locked: false, name: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lock/);
    expect((await row(f.id))).toMatchObject({ is_locked: 1, name: null });
  });

  it('refuses a non-boolean, a no-op, and locking anything but accepted canon', async () => {
    const f = await api.accepted('features', land(0, 0));
    expect((await api.patch(`/features/${f.id}/lock`, { is_locked: 1 })).status).toBe(400);
    expect((await unlock('features', f.id)).status).toBe(409);
    const d = await api.draft('features', land(50, 0));
    expect((await lock('features', d.id)).status).toBe(409);
  });
});

describe('replacement state', () => {
  it('changes only through its own request, recorded in history without a revision bump', async () => {
    const f = await api.accepted('features', land(0, 0));
    expect((await api.patch(`/features/${f.id}`, { replacement_state: 'replaceable' })).status).toBe(400);
    expect((await api.post('/features', { ...land(50, 0), replacement_state: 'replaceable' })).status).toBe(400);

    const res = await api.patch(`/features/${f.id}/replacement`, { replacement_state: 'replaceable' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ replacement_state: 'replaceable', revision: 1 });
    const h = (await api.get(`/features/${f.id}/revisions`)).body;
    expect(h.at(-1)).toMatchObject({ change_kind: 'replacement_change', revision: 1 });
  });

  it('refuses extra fields, invalid values, no-ops, and non-accepted rows', async () => {
    const f = await api.accepted('features', land(0, 0));
    expect((await api.patch(`/features/${f.id}/replacement`, { replacement_state: 'replaceable', name: 'x' })).status).toBe(400);
    expect((await api.patch(`/features/${f.id}/replacement`, { replacement_state: 'disposable' })).status).toBe(400);
    expect((await api.patch(`/features/${f.id}/replacement`, { replacement_state: 'non_replaceable' })).status).toBe(409);
    const d = await api.draft('features', land(50, 0));
    expect((await api.patch(`/features/${d.id}/replacement`, { replacement_state: 'replaceable' })).status).toBe(409);
  });

  it('is never replaceable for a must_exist anchor — by route or by SQL', async () => {
    const a = await api.accepted('anchors', anchor('arena'));
    expect(a.must_exist).toBe(true);
    const res = await api.patch(`/anchors/${a.id}/replacement`, { replacement_state: 'replaceable' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/must_exist/);
    await expect(run(db, `UPDATE canonical_anchors SET replacement_state = 'replaceable' WHERE id = ?`, [a.id]))
      .rejects.toThrow(/CHECK/);
  });

  it('allows an optional anchor to be replaceable, but not a revision that makes it must_exist while it is', async () => {
    const a = await api.accepted('anchors', anchor('shrine', { must_exist: false }));
    expect((await api.patch(`/anchors/${a.id}/replacement`, { replacement_state: 'replaceable' })).status).toBe(200);
    const r = (await api.post(`/anchors/${a.id}/revise`)).body;
    const edited = (await api.patch(`/anchors/${r.id}`, { must_exist: true })).body;
    const res = await api.accept('anchors', edited);
    expect(res.status).toBe(409);
    expect(res.body.violations.map(v => v.code)).toEqual(['must_exist_replaceable']);
  });

  it('is kept by a revise → accept: acceptance does not reset governance', async () => {
    const f = await api.accepted('features', land(0, 0));
    await api.patch(`/features/${f.id}/replacement`, { replacement_state: 'replaceable' });
    const r = (await api.post(`/features/${f.id}/revise`)).body;
    expect(r.replacement_state).toBe('non_replaceable');
    const accepted = (await api.accept('features', r)).body.record;
    expect(accepted).toMatchObject({ replacement_state: 'replaceable', is_locked: false, revision: 2 });
  });
});
