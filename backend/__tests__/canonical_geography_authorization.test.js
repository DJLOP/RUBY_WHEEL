/**
 * Who may touch canonical geography, and what the realtime channel says about it
 * (plan §5.2, §8.1, §10).
 *
 * Every mutation and every non-accepted read goes through `requireWorldEditor`: 401 with
 * no token, 403 for a player and for a temporarily elevated admin. Accepted canon is a
 * public read, and never contains anything else. Each successful mutation emits exactly
 * one `dataUpdated`; a refused one emits nothing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const { setupCanonical, snapshotCanonical, land, anchor, square, PROPOSAL } = require_('./helpers/canonicalApi.js');
const { elevatedUsers } = require_('../middleware/auth.js');

let db;
let api;
let emits;

beforeEach(async () => {
  ({ db, api, emits } = await setupCanonical());
  // Elevated, so `authenticate` admits the temporary admin and the refusal under test is
  // the world-editor check itself rather than a revoked session.
  elevatedUsers.add('guest_admin');
});

afterEach(() => {
  elevatedUsers.delete('guest_admin');
});

/** One of every canonical state, so each route has a real target. */
async function seed() {
  const accepted = await api.accepted('features', land(0, 0));
  const draft = await api.draft('features', land(100, 0));
  const retired = await api.accepted('features', land(200, 0));
  await api.post(`/features/${retired.id}/retire`);
  const proposal = (await api.propose('features', land(300, 0))).body;
  emits.length = 0;
  return { accepted, draft, retired, proposal };
}

const mutations = ({ accepted, draft, retired }) => [
  ['post', '/features', land(500, 0)],
  ['post', '/proposals', { entity: 'features', provenance: 'generated', proposal: PROPOSAL, ...land(600, 0) }],
  ['patch', `/features/${draft.id}`, { name: 'x' }],
  ['patch', `/features/${accepted.id}`, { name: 'x' }],
  ['delete', `/features/${draft.id}`],
  ['post', `/features/${accepted.id}/revise`, {}],
  ['post', `/features/${draft.id}/accept`, { expected_draft_version: 1 }],
  ['post', `/features/${accepted.id}/retire`, {}],
  ['post', `/features/${retired.id}/restore`, {}],
  ['patch', `/features/${accepted.id}/lock`, { is_locked: true }],
  ['patch', `/features/${accepted.id}/replacement`, { replacement_state: 'replaceable' }],
  ['post', `/features/${accepted.id}/revisions/1/draft`, {}],
];

const protectedReads = ({ draft, retired, proposal, accepted }) => [
  '/features?states=draft',
  '/features?states=proposed',
  '/features?states=retired',
  '/features?states=accepted,draft',
  `/features/${draft.id}`,
  `/features/${proposal.id}`,
  `/features/${retired.id}`,
  `/features/${accepted.id}/revisions`,
];

const call = (client, [method, path, body]) =>
  method === 'delete' ? client.del(path) : method === 'get' ? client.get(path) : client[method](path, body);

describe.each([
  ['no token', 'anon', 401],
  ['a player', 'player', 403],
  ['a temporary admin', 'tempAdmin', 403],
])('%s', (label, client, status) => {
  it(`is refused every mutation with ${status}, changing nothing and emitting nothing`, async () => {
    const s = await seed();
    const before = await snapshotCanonical(db);
    for (const m of mutations(s)) {
      const res = await call(api[client], m);
      expect(res.status, `${m[0]} ${m[1]}`).toBe(status);
    }
    expect(await snapshotCanonical(db)).toEqual(before);
    expect(emits).toHaveLength(0);
  });

  it(`is refused drafts, proposals, retired rows and history with ${status}`, async () => {
    const s = await seed();
    for (const path of protectedReads(s)) {
      expect((await api[client].get(path)).status, path).toBe(status);
    }
  });

  it('can read accepted canon, and only accepted canon', async () => {
    const s = await seed();
    const list = await api[client].get('/features');
    expect(list.status).toBe(200);
    expect(list.body.map(r => r.id)).toEqual([s.accepted.id]);
    expect(list.body.every(r => r.lifecycle_state === 'accepted')).toBe(true);
    expect((await api[client].get(`/features/${s.accepted.id}`)).status).toBe(200);
    expect((await api[client].get('/scopes')).body.map(r => r.scope_key)).toEqual(['city']);
  });
});

describe('the primary world editor', () => {
  it('succeeds at every mutation route', async () => {
    const count = mutations(await seed()).length;
    // Each route against its own fresh seed, so no route's success depends on another's.
    for (let i = 0; i < count; i++) {
      ({ db, api, emits } = await setupCanonical());
      const m = mutations(await seed())[i];
      const res = await call(api, m);
      expect([200, 201], `${m[0]} ${m[1]} → ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`).toContain(res.status);
      expect(emits).toHaveLength(1);
      // Flagged, so clients refetch canonical geography on this broadcast and not on every
      // inherited one (WP4 realtime wiring).
      expect(emits[0]).toEqual({ canonicalGeography: true });
    }
  });

  it('reads every lifecycle state and history', async () => {
    const s = await seed();
    for (const path of protectedReads(s)) expect((await api.get(path)).status, path).toBe(200);
    expect((await api.get('/features?states=draft,proposed,retired,accepted')).body).toHaveLength(4);
  });

  it('gets 400 for an unknown lifecycle state in a list filter', async () => {
    expect((await api.get('/features?states=canon')).status).toBe(400);
  });
});

describe('realtime: one dataUpdated per successful mutation, none per refusal', () => {
  it('emits exactly once for each successful mutation', async () => {
    const step = async (label, promise, status) => {
      const before = emits.length;
      const res = await promise;
      expect(res.status, label).toBe(status);
      expect(emits.length - before, label).toBe(1);
      return res.body;
    };
    const d = await step('create', api.post('/features', land(0, 0)), 201);
    const d2 = await step('patch draft', api.patch(`/features/${d.id}`, { name: 'Isle' }), 200);
    const acc = (await step('accept', api.accept('features', d2), 200)).record;
    await step('descriptive edit', api.patch(`/features/${acc.id}`, { notes: 'n' }), 200);
    const r = await step('revise', api.post(`/features/${acc.id}/revise`), 201);
    await step('delete draft', api.del(`/features/${r.id}`), 200);
    await step('lock', api.patch(`/features/${acc.id}/lock`, { is_locked: true }), 200);
    await step('unlock', api.patch(`/features/${acc.id}/lock`, { is_locked: false }), 200);
    await step('replacement', api.patch(`/features/${acc.id}/replacement`, { replacement_state: 'replaceable' }), 200);
    await step('retire', api.post(`/features/${acc.id}/retire`), 200);
    await step('restore', api.post(`/features/${acc.id}/restore`), 200);
    await step('draft from history', api.post(`/features/${acc.id}/revisions/1/draft`), 201);
    await step('proposal', api.propose('features', land(100, 0)), 201);
  });

  it('emits nothing for any refused mutation', async () => {
    const f = await api.accepted('features', land(0, 0));
    const a = await api.accepted('anchors', anchor('arena'));
    const overlap = await api.draft('features', land(5, 5));
    emits.length = 0;

    const refusals = [
      api.post('/features', { ...land(50, 0), lifecycle_state: 'accepted' }),
      api.post('/features', { ...land(50, 0), provenance: 'generated' }),
      api.post('/proposals', { entity: 'features', ...land(50, 0) }),
      api.patch(`/features/${f.id}`, { geometry: square(1, 1) }),
      api.post(`/features/${f.id}/accept`, { expected_draft_version: f.draft_version }),
      api.accept('features', overlap),
      api.post(`/features/${overlap.id}/accept`, { expected_draft_version: 99 }),
      api.del(`/features/${f.id}`),
      api.post(`/features/${f.id}/restore`),
      api.patch(`/anchors/${a.id}/replacement`, { replacement_state: 'replaceable' }),
      api.patch(`/features/${f.id}/lock`, { is_locked: false }),
      api.post(`/features/${f.id}/revisions/9/draft`),
      api.post('/features/999/retire'),
    ];
    for (const r of refusals) expect((await r).status).toBeGreaterThanOrEqual(400);
    expect(emits).toHaveLength(0);
  });
});
