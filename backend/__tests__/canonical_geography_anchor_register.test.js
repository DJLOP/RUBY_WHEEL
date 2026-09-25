/**
 * GET /api/canonical-geography/anchors/register (plan §5.1, WP6): the must-exist checklist.
 *
 * Every accepted anchor, with placement derived — never stored — from its accepted parts.
 * Drafts (anchors or parts) never appear or count, the read is public, and it never emits.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const { setupCanonical, land, site, anchor, scope, square } = require_('./helpers/canonicalApi.js');

const CITY = 1;

let api;
let emits;

beforeEach(async () => {
  ({ api, emits } = await setupCanonical());
});

const register = async () => {
  const res = await api.anon.get('/anchors/register');
  expect(res.status).toBe(200);
  return res.body;
};

describe('anchor register', () => {
  it('is public, lists accepted anchors only, and never emits', async () => {
    await api.draft('anchors', anchor('draft-only'));
    const arena = await api.accepted('anchors', anchor('arena', { must_exist: true }));
    const before = emits.length;
    const body = await register();
    expect(body.anchors.map(a => a.anchor_key)).toEqual(['arena']);
    expect(body.anchors[0]).toMatchObject({
      id: arena.id, status: 'unplaced', placed: false, must_exist: true, constraint_strength: 'hard',
      replacement_state: 'non_replaceable', part_summary: { count: 0, by_role: {}, parts: [] },
    });
    expect(body.summary).toEqual({ total: 1, placed: 0, unplaced: 1, unplaced_must_exist: [arena.id] });
    expect(emits.length).toBe(before);
  });

  it('a hard must-exist anchor is accepted unplaced; a draft part does not place it; accepting the part does', async () => {
    const arena = await api.accepted('anchors', anchor('arena', { must_exist: true }));
    const part = await api.draft('features', site('polygon', square(0, 0, 20), { anchor_id: arena.id, part_role: 'footprint' }));
    expect((await register()).anchors[0].status).toBe('unplaced');

    expect((await api.accept('features', part)).status).toBe(200);
    const entry = (await register()).anchors[0];
    expect(entry.status).toBe('placed');
    expect(entry.part_summary).toMatchObject({ count: 1, by_role: { footprint: 1 } });
    expect(entry.part_summary.parts[0]).toMatchObject({ feature_id: part.id, feature_class: 'site', part_role: 'footprint' });
    expect((await register()).summary.unplaced_must_exist).toEqual([]);
  });

  it('names an accepted required scope, and marks an unaccepted one without naming it', async () => {
    const district = await api.accepted('scopes', scope('arena-district', 'district', CITY));
    const draftDistrict = await api.draft('scopes', scope('temple-district', 'district', CITY));
    await api.accepted('anchors', anchor('arena', { required_scope_id: district.id }));
    const d = await api.draft('anchors', anchor('temple', { required_scope_id: draftDistrict.id }));
    // Accepting an anchor whose required scope is still a draft is refused; the register shows neither.
    expect((await api.accept('anchors', d)).status).toBe(409);
    const [entry] = (await register()).anchors;
    expect(entry.required_scope).toEqual({ id: district.id, scope_key: 'arena-district', scope_kind: 'district', name: 'arena district', accepted: true });
  });

  it('is not shadowed by GET /anchors/:id', async () => {
    const res = await api.anon.get('/anchors/register');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('summary');
  });

  it('keeps land-only parts out of other anchors, and counts several parts by role', async () => {
    const net = await api.accepted('anchors', anchor('arboretum', { category: 'network', must_exist: true }));
    await api.accepted('anchors', anchor('arena', { must_exist: false }));
    await api.accepted('features', site('point', { x: 1, z: 1 }, { anchor_id: net.id, part_role: 'node' }));
    await api.accepted('features', site('point', { x: 50, z: 50 }, { anchor_id: net.id, part_role: 'node', constraint_strength: 'soft' }));
    await api.accepted('features', land(100, 100, 10));
    const { anchors, summary } = await register();
    expect(anchors.find(a => a.anchor_key === 'arboretum').part_summary.by_role).toEqual({ node: 2 });
    expect(anchors.find(a => a.anchor_key === 'arena').status).toBe('unplaced');
    expect(summary).toMatchObject({ total: 2, placed: 1, unplaced: 1, unplaced_must_exist: [] });
  });
});
