/**
 * Radial construction through the API (plan §15.6–§15.10, §15.14): authorization, input
 * eligibility and pinning, draft-only all-or-nothing persistence, the construction record,
 * the lifecycle after construction, and revision-mode construction-set integrity.
 *
 * What is load-bearing: construction only ever writes drafts; it never modifies an input;
 * any refusal writes nothing and emits nothing; and revision mode never rewrites, drops or
 * orphans an accepted sibling — a changed count or omission set is a new construction.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { all, run as runSql } from './helpers/testDb.js';

const require_ = createRequire(import.meta.url);
const { setupCanonical, snapshotCanonical, square, site, route, land, PROPOSAL } = require_('./helpers/canonicalApi.js');

let db;
let api;
let emits;

beforeEach(async () => {
  ({ db, api, emits } = await setupCanonical());
});

const ringLine = (h, cx = 0, cz = 0) => {
  const pts = [{ x: cx - h, z: cz - h }, { x: cx + h, z: cz - h }, { x: cx + h, z: cz + h }, { x: cx - h, z: cz + h }];
  return [...pts, pts[0]];
};

/** Accepted inner (site polygon, half-size 50) and outer (closed route/wall, half-size 200) around the origin. */
async function rings({ innerHalf = 50, outerHalf = 200 } = {}) {
  const inner = await api.accepted('features', site('polygon', square(-innerHalf, -innerHalf, innerHalf * 2), { name: 'inner ring' }));
  const outer = await api.accepted('features', route(ringLine(outerHalf), { kind: 'wall', name: 'outer ring' }));
  return { inner, outer };
}

const pin = (f) => ({ feature_id: f.id, expected_revision: f.revision });
const body = (inner, outer, extra = {}) => ({
  inner: pin(inner), outer: pin(outer), center: { x: 0, z: 0 }, count: 4, offset_deg: 0, output: {}, ...extra,
});
const construct = (b, as = api) => as.post('/constructions/radial', b);
const featureRows = (ids) => all(db, `SELECT * FROM canonical_features WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, ids);
const acceptAll = async (features) => {
  const out = [];
  for (const f of features) out.push(api.expectStatus(await api.accept('features', f), 200, `accept #${f.id}`).record);
  return out;
};
const revisesOf = (spokes) => spokes.map(s => ({ index: s.construction.index, feature_id: s.id, expected_revision: s.revision }));

/** Construct N spokes in new-drafts mode and accept them all; returns the accepted records by index. */
async function acceptedConstruction(inner, outer, extra = {}) {
  const res = construct(body(inner, outer, extra));
  const created = api.expectStatus(await res, 201, 'construct');
  return acceptAll(created.features);
}

/** Expect a refusal that wrote nothing and emitted nothing. */
async function expectRefusedUnchanged(request, status) {
  const before = await snapshotCanonical(db);
  const emitsBefore = emits.length;
  const res = await request();
  expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(status);
  expect(await snapshotCanonical(db)).toEqual(before);
  expect(emits.length).toBe(emitsBefore);
  return res.body;
}

describe('authorization (§15.10)', () => {
  it('401 without a token and 403 for player and temporary admin, dry run included; nothing written', async () => {
    const { elevatedUsers } = require_('../middleware/auth.js');
    const { inner, outer } = await rings();
    // A revoked temporary session is already 401; elevate it so the refusal is the world-editor check.
    elevatedUsers.add('guest_admin');
    try {
      for (const dry of [false, true]) {
        const b = body(inner, outer, { dry_run: dry });
        await expectRefusedUnchanged(() => construct(b, api.anon), 401);
        await expectRefusedUnchanged(() => construct(b, api.player), 403);
        await expectRefusedUnchanged(() => construct(b, api.tempAdmin), 403);
      }
    } finally {
      elevatedUsers.delete('guest_admin');
    }
  });
});

describe('new-drafts construction', () => {
  it('creates one draft per spoke: authored, non_replaceable, unlocked, with the exact construction record', async () => {
    const { inner, outer } = await rings();
    const emitsBefore = emits.length;
    const res = await construct(body(inner, outer, { output: { kind: 'wall', width_wu: 4, name_prefix: 'Radial wall' } }));
    expect(res.status).toBe(201);
    expect(emits.length - emitsBefore).toBe(1);
    expect(res.body).toMatchObject({ ok: true, mode: 'new_drafts', errors: [] });
    const cid = res.body.construction_id;
    expect(cid).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.features).toHaveLength(4);
    const expected = [
      [{ x: 50, z: 0 }, { x: 200, z: 0 }], [{ x: 0, z: 50 }, { x: 0, z: 200 }],
      [{ x: -50, z: 0 }, { x: -200, z: 0 }], [{ x: 0, z: -50 }, { x: 0, z: -200 }],
    ];
    res.body.features.forEach((f, n) => {
      expect(f).toMatchObject({
        lifecycle_state: 'draft', provenance: 'authored', replacement_state: 'non_replaceable', is_locked: false,
        revision: 0, draft_version: 1, revises_id: null, feature_class: 'route', kind: 'wall', geometry_type: 'linestring',
        constraint_strength: 'hard', attributes: { width_wu: 4 }, name: `Radial wall #${n}`, evidence: null, anchor_id: null,
      });
      expect(f.geometry).toEqual(expected[n]);
      expect(f.construction).toEqual({
        type: 'radial_spoke', version: 1, construction_id: cid, center: { x: 0, z: 0 }, center_source: { kind: 'coordinate' },
        inner: { feature_id: inner.id, revision: 1 }, outer: { feature_id: outer.id, revision: 1 },
        count: 4, offset_deg: 0, omit_indices: [], index: n, angle_deg: n * 90, angle_convention: 'deg_from_+x_toward_+z',
      });
    });
    // Stored as reported, and the report is also returned per spoke.
    expect(res.body.spokes.map(s => s.status)).toEqual(['valid', 'valid', 'valid', 'valid']);
    expect(res.body.spokes[0]).toMatchObject({ length_wu: 150, length_m: 150 * 1.524 });
  });

  it('defaults to route, no kind, hard, name "Spoke #n", and never sets a kind by itself', async () => {
    const { inner, outer } = await rings();
    const created = api.expectStatus(await construct(body(inner, outer, { count: 1 })), 201, 'construct');
    expect(created.features[0]).toMatchObject({ feature_class: 'route', kind: null, constraint_strength: 'hard', name: 'Spoke #0', attributes: null });
  });

  it('can output site linestrings with soft strength', async () => {
    const { inner, outer } = await rings();
    const created = api.expectStatus(await construct(body(inner, outer, { count: 2, output: { feature_class: 'site', constraint_strength: 'soft' } })), 201, 'construct');
    expect(created.features.map(f => [f.feature_class, f.constraint_strength])).toEqual([['site', 'soft'], ['site', 'soft']]);
  });

  it('accepts a polygon of any class or a closed linestring as a boundary', async () => {
    const inner = await api.accepted('features', land(-50, -50, 100));
    const outer = await api.accepted('features', { ...site('polygon', square(-200, -200, 400)) });
    expect((await construct(body(inner, outer))).status).toBe(201);
  });

  it('records an explicit omission on every sibling and persists no spoke for it', async () => {
    const { inner, outer } = await rings();
    const created = api.expectStatus(await construct(body(inner, outer, { omit_indices: [1] })), 201, 'construct');
    expect(created.features.map(f => f.construction.index)).toEqual([0, 2, 3]);
    expect(created.features.every(f => JSON.stringify(f.construction.omit_indices) === '[1]')).toBe(true);
    expect(created.spokes[1].status).toBe('omitted');
  });

  it('outputs are absent from the generator query until accepted; accepting one gives revision 1 and changes the digest', async () => {
    const { inner, outer } = await rings();
    const q = { bbox: { min_x: -500, min_z: -500, max_x: 500, max_z: 500 } };
    const before = (await api.anon.post('/query', q)).body;
    const created = api.expectStatus(await construct(body(inner, outer)), 201, 'construct');
    const afterCreate = (await api.anon.post('/query', q)).body;
    expect(afterCreate.digest).toBe(before.digest);
    expect(afterCreate.routes.map(r => r.id)).toEqual([outer.id]);

    const res = await api.accept('features', created.features[2]);
    expect(res.status).toBe(200);
    expect(res.body.record).toMatchObject({ id: created.features[2].id, lifecycle_state: 'accepted', revision: 1 });
    const afterAccept = (await api.anon.post('/query', q)).body;
    expect(afterAccept.digest).not.toBe(before.digest);
    expect(afterAccept.routes.map(r => r.id).sort((a, b) => a - b)).toEqual([outer.id, created.features[2].id]);
  });

  it('never modifies an input: the input rows are byte-identical afterwards', async () => {
    const { inner, outer } = await rings();
    const point = await api.accepted('features', site('point', { x: 0, z: 0 }));
    const before = await featureRows([inner.id, outer.id, point.id]);
    api.expectStatus(await construct(body(inner, outer, {
      center: undefined, center_source: { kind: 'feature_point', ...pin(point) }, count: 16, offset_deg: 7.5,
    })), 201, 'construct');
    await construct(body(inner, outer, { dry_run: true }));
    expect(await featureRows([inner.id, outer.id, point.id])).toEqual(before);
    const revisions = await all(db, `SELECT entity_id FROM canonical_revisions WHERE entity_type = 'feature' AND entity_id IN (?, ?, ?)`,
      [inner.id, outer.id, point.id]);
    expect(revisions).toHaveLength(3); // their own accepts, nothing more
  });

  it('dry run answers the report with 200, writes nothing and emits nothing', async () => {
    const { inner, outer } = await rings();
    const before = await snapshotCanonical(db);
    const emitsBefore = emits.length;
    const res = await construct(body(inner, outer, { dry_run: true, offset_deg: -30 }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, dry_run: true, normalized: { offset_deg: 330, count: 4 } });
    expect(res.body.spokes).toHaveLength(4);
    expect(await snapshotCanonical(db)).toEqual(before);
    expect(emits.length).toBe(emitsBefore);
  });

  it('dry run reports per-spoke and construction errors with 200 instead of refusing', async () => {
    const inner = await api.accepted('features', site('polygon', { outer: [{ x: -150, z: -30 }, { x: 150, z: -30 }, { x: 150, z: 30 }, { x: -150, z: 30 }] }));
    const outer = await api.accepted('features', site('polygon', { outer: [{ x: -100, z: -200 }, { x: 100, z: -200 }, { x: 100, z: 200 }, { x: -100, z: 200 }] }));
    const res = await construct(body(inner, outer, { dry_run: true }));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.spokes.map(s => s.error?.code ?? s.status)).toEqual(['invalid_radial_order', 'valid', 'invalid_radial_order', 'valid']);
    const off = await construct(body(inner, outer, { dry_run: true, center: { x: 140, z: 0 } }));
    expect(off.status).toBe(200);
    expect(off.body.errors.map(e => [e.code, e.ring])).toEqual([['center_not_inside', 'outer']]);
  });
});

describe('all-or-nothing refusals (§15.13)', () => {
  it('any per-spoke error writes zero rows and returns the full report with 409', async () => {
    const inner = await api.accepted('features', site('polygon', { outer: [{ x: -150, z: -30 }, { x: 150, z: -30 }, { x: 150, z: 30 }, { x: -150, z: 30 }] }));
    const outer = await api.accepted('features', site('polygon', { outer: [{ x: -100, z: -200 }, { x: 100, z: -200 }, { x: 100, z: 200 }, { x: -100, z: 200 }] }));
    const report = await expectRefusedUnchanged(() => construct(body(inner, outer)), 409);
    expect(report.ok).toBe(false);
    expect(report.spokes.filter(s => s.status === 'invalid').map(s => s.index)).toEqual([0, 2]);
    expect(report.spokes[0].error.message).toMatch(/^Spoke 0 \(0\.000°\): outer boundary reached .* rings cross here\. Omit this spoke/);
    // Omitting the invalid indices explicitly is the recoverable path.
    const ok = await construct(body(inner, outer, { omit_indices: [0, 2] }));
    expect(ok.status).toBe(201);
    expect(ok.body.features.map(f => f.construction.index)).toEqual([1, 3]);
  });

  it('a forward collinear overlap blocks the spoke (collinear_overlap), writes nothing, and can only be omitted', async () => {
    const slot = [{ x: -50, z: -50 }, { x: 50, z: -50 }, { x: 50, z: 50 }, { x: 30, z: 50 }, { x: 30, z: 0 }, { x: 20, z: 0 }, { x: 20, z: 50 }, { x: -50, z: 50 }];
    const inner = await api.accepted('features', site('polygon', { outer: slot }));
    const { outer } = await rings();
    const report = await expectRefusedUnchanged(() => construct(body(inner, outer)), 409);
    expect(report.spokes[0]).toMatchObject({ status: 'invalid', error: { code: 'collinear_overlap', ring: 'inner', t_range: [20, 30] } });
    expect(report.spokes.slice(1).every(s => s.status === 'valid')).toBe(true);
    expect((await construct(body(inner, outer, { omit_indices: [0] }))).status).toBe(201);
  });

  it('center outside a ring is a construction error: 409, no spokes, nothing written', async () => {
    const { inner, outer } = await rings();
    const report = await expectRefusedUnchanged(() => construct(body(inner, outer, { center: { x: 60, z: 0 } })), 409);
    expect(report.errors).toEqual([expect.objectContaining({ code: 'center_not_inside', ring: 'inner', where: 'outside' })]);
    expect(report.errors[0].message).toMatch(/inner boundary \(feature #\d+\)/);
    expect(report.spokes).toEqual([]);
  });
});

describe('input eligibility and pinning (§15.3)', () => {
  it('refuses draft, proposed and retired inputs (409), writing nothing', async () => {
    const { inner, outer } = await rings();
    const draft = await api.draft('features', site('polygon', square(-60, -60, 120)));
    const proposed = api.expectStatus(await api.propose('features', site('polygon', square(-60, -60, 120))), 201, 'propose');
    const retiredRow = await api.accepted('features', site('polygon', square(-70, -70, 140)));
    api.expectStatus(await api.post(`/features/${retiredRow.id}/retire`), 200, 'retire');

    for (const f of [draft, proposed]) {
      const r = await expectRefusedUnchanged(() => construct(body(f, outer, { inner: { feature_id: f.id, expected_revision: 1 } })), 409);
      expect(r.errors[0]).toMatchObject({ code: 'not_accepted', input: 'inner' });
    }
    const r = await expectRefusedUnchanged(() => construct(body(retiredRow, outer, { inner: { feature_id: retiredRow.id, expected_revision: 1 } })), 409);
    expect(r.errors[0]).toMatchObject({ code: 'not_accepted', lifecycle_state: 'retired' });
    expect(inner.id).toBeTruthy();
  });

  it('refuses point and open-linestring boundaries as ineligible, and the same feature twice', async () => {
    const { inner, outer } = await rings();
    const point = await api.accepted('features', site('point', { x: 0, z: 0 }));
    const open = await api.accepted('features', route([{ x: -300, z: 0 }, { x: 300, z: 0 }, { x: 300, z: 300 }]));
    let r = await expectRefusedUnchanged(() => construct(body(point, outer)), 409);
    expect(r.errors[0]).toMatchObject({ code: 'ineligible_input', input: 'inner' });
    r = await expectRefusedUnchanged(() => construct(body(inner, open)), 409);
    expect(r.errors[0]).toMatchObject({ code: 'ineligible_input', input: 'outer' });
    expect(r.errors[0].message).toMatch(/open linestring/);
    r = await expectRefusedUnchanged(() => construct(body(inner, inner)), 409);
    expect(r.errors.map(e => e.code)).toContain('same_input');
  });

  it('refuses a stale pinned revision with 409 stale_input naming both revisions', async () => {
    const { inner, outer } = await rings();
    const rev = api.expectStatus(await api.post(`/features/${outer.id}/revise`), 201, 'revise');
    api.expectStatus(await api.patch(`/features/${rev.id}`, { geometry: ringLine(210) }), 200, 'patch');
    api.expectStatus(await api.post(`/features/${rev.id}/accept`, { expected_draft_version: 2 }), 200, 'accept');
    const r = await expectRefusedUnchanged(() => construct(body(inner, outer)), 409);
    expect(r.errors[0]).toMatchObject({ code: 'stale_input', input: 'outer', expected_revision: 1, current_revision: 2 });
    expect(r.errors[0].message).toMatch(/changed from revision 1 to 2 since preview/);
    expect((await construct(body(inner, { ...outer, revision: 2 }))).status).toBe(201);
  });

  it('answers 404 for a missing input', async () => {
    const { inner } = await rings();
    const r = await expectRefusedUnchanged(() => construct(body(inner, { id: 999, revision: 1 })), 404);
    expect(r.errors[0]).toMatchObject({ code: 'not_found', input: 'outer', feature_id: 999 });
  });

  it('refuses malformed parameters with 400 before reading anything', async () => {
    const { inner, outer } = await rings();
    const cases = [
      { count: 2.5 }, { count: 0 }, { count: 361 }, { count: '4' }, { offset_deg: null }, { offset_deg: '10' },
      { omit_indices: [4] }, { omit_indices: [2, 1] }, { omit_indices: [0, 1, 2, 3] }, { output: undefined },
      { output: { feature_class: 'land' } }, { output: { feature_class: 'site', kind: 'wall' } }, { output: { kind: 'canal' } },
      { output: { feature_class: 'site', width_wu: 3 } }, { output: { width_wu: -1 } }, { output: { lifecycle_state: 'accepted' } },
      { output: { provenance: 'generated' } }, { center: { x: 'a', z: 0 } }, { center: undefined }, { center: { x: 30000, z: 0 } },
      { inner: { feature_id: inner.id } }, { inner: { feature_id: inner.id, expected_revision: 1, extra: 1 } },
      { dry_run: 'yes' }, { lifecycle_state: 'accepted' }, { is_locked: true },
      { center_source: { kind: 'feature_point', feature_id: inner.id, expected_revision: 1 } },
      { center_source: { kind: 'somewhere' } },
      { revises: [] }, { revises: [{ index: 0, feature_id: 1, expected_revision: 1 }] },
    ];
    for (const extra of cases) {
      await expectRefusedUnchanged(() => construct(body(inner, outer, extra)), 400);
    }
  });
});

describe('feature-derived centers (§15.3.2)', () => {
  it('takes the center from an accepted point feature at its pinned revision', async () => {
    const { inner, outer } = await rings();
    const point = await api.accepted('features', site('point', { x: 5, z: -5 }));
    const created = api.expectStatus(await construct(body(inner, outer, {
      center: undefined, center_source: { kind: 'feature_point', ...pin(point) }, count: 1,
    })), 201, 'construct');
    expect(created.features[0].construction).toMatchObject({
      center: { x: 5, z: -5 }, center_source: { kind: 'feature_point', feature_id: point.id, revision: 1 },
    });
    expect(created.features[0].geometry[0].z).toBe(-5);
  });

  it('takes the center from an accepted circle construction, and refuses a feature without one', async () => {
    const circleInner = await api.accepted('features', site('polygon', square(-50, -50, 100), {
      construction: { type: 'circle', center: { x: 0.25, z: 0.75 }, radius: 50, method: 'center_radius', segments: 4, max_chord_error_m: 0.25 },
    }));
    const outer = await api.accepted('features', route(ringLine(200), { kind: 'wall' }));
    const created = api.expectStatus(await construct(body(circleInner, outer, {
      center: undefined, center_source: { kind: 'feature_construction_center', ...pin(circleInner) }, count: 1,
    })), 201, 'construct');
    expect(created.features[0].construction.center).toEqual({ x: 0.25, z: 0.75 });
    expect(created.features[0].construction.center_source).toEqual({ kind: 'feature_construction_center', feature_id: circleInner.id, revision: 1 });

    const r = await expectRefusedUnchanged(() => construct(body(circleInner, outer, {
      center: undefined, center_source: { kind: 'feature_construction_center', ...pin(outer) },
    })), 409);
    expect(r.errors[0]).toMatchObject({ code: 'ineligible_input', input: 'center' });
  });

  it('refuses a submitted center alongside a feature-derived one (400)', async () => {
    const { inner, outer } = await rings();
    const point = await api.accepted('features', site('point', { x: 0, z: 0 }));
    await expectRefusedUnchanged(() => construct(body(inner, outer, { center_source: { kind: 'feature_point', ...pin(point) } })), 400);
    await expectRefusedUnchanged(() => construct(body(inner, outer, {
      center_source: { kind: 'feature_construction_center', ...pin(inner) },
    })), 400);
  });

  it('refuses a draft or stale center feature', async () => {
    const { inner, outer } = await rings();
    const draftPoint = await api.draft('features', site('point', { x: 0, z: 0 }));
    const r = await expectRefusedUnchanged(() => construct(body(inner, outer, {
      center: undefined, center_source: { kind: 'feature_point', feature_id: draftPoint.id, expected_revision: 1 },
    })), 409);
    expect(r.errors[0]).toMatchObject({ code: 'not_accepted', input: 'center' });
  });
});

describe('the construction record is the constructor\'s alone (§15.8)', () => {
  const record = (extra = {}) => ({
    type: 'radial_spoke', version: 1, construction_id: 'forged', center: { x: 0, z: 0 }, center_source: { kind: 'coordinate' },
    inner: { feature_id: 1, revision: 1 }, outer: { feature_id: 2, revision: 1 }, count: 1, offset_deg: 0, omit_indices: [],
    index: 0, angle_deg: 0, angle_convention: 'deg_from_+x_toward_+z', ...extra,
  });

  it('POST /features and POST /proposals refuse a client-supplied radial_spoke record with 400', async () => {
    const line = [{ x: 50, z: 0 }, { x: 200, z: 0 }];
    await expectRefusedUnchanged(() => api.post('/features', route(line, { construction: record() })), 400);
    await expectRefusedUnchanged(() => api.propose('features', route(line, { construction: record() })), 400);
  });

  it('PATCH keeps the record only with unchanged geometry; clearing it allows a geometry edit', async () => {
    const { inner, outer } = await rings();
    const created = api.expectStatus(await construct(body(inner, outer, { count: 1 })), 201, 'construct');
    const d = created.features[0];

    // Echoing the record with a descriptive change is fine.
    const renamed = await api.patch(`/features/${d.id}`, { name: 'Renamed', construction: d.construction, geometry: d.geometry });
    expect(renamed.status).toBe(200);
    expect(renamed.body.construction).toEqual(d.construction);

    // Changing geometry while keeping the record (inherited or echoed) is refused.
    const moved = [{ x: 60, z: 0 }, { x: 200, z: 0 }];
    await expectRefusedUnchanged(() => api.patch(`/features/${d.id}`, { geometry: moved }), 400);
    const kept = await api.patch(`/features/${d.id}`, { geometry: moved, construction: d.construction });
    expect(kept.status).toBe(400);
    expect(kept.body.error).toMatch(/clear the construction record/);
    // A forged record (different from the stored one) is refused even over the same geometry.
    await expectRefusedUnchanged(() => api.patch(`/features/${d.id}`, { construction: { ...d.construction, index: 0, angle_deg: 1 } }), 400);

    const cleared = await api.patch(`/features/${d.id}`, { geometry: moved, construction: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ construction: null, geometry: moved });
  });

  it('a proposal revising a spoke may not keep the record over new geometry', async () => {
    const { inner, outer } = await rings();
    const [spoke] = await acceptedConstruction(inner, outer, { count: 1 });
    const res = await api.propose('features', { geometry: [{ x: 60, z: 0 }, { x: 200, z: 0 }] }, { revises_id: spoke.id });
    expect(res.status).toBe(400);
    const ok = await api.propose('features', { geometry: [{ x: 60, z: 0 }, { x: 200, z: 0 }], construction: null }, { revises_id: spoke.id });
    expect(ok.status).toBe(201);
    expect(PROPOSAL.source).toBeTruthy();
  });

  it('revise and draft-from-history copy the record together with its geometry', async () => {
    const { inner, outer } = await rings();
    const [spoke] = await acceptedConstruction(inner, outer, { count: 1 });
    const rev = api.expectStatus(await api.post(`/features/${spoke.id}/revise`), 201, 'revise');
    expect(rev.construction).toEqual(spoke.construction);
    expect(rev.geometry).toEqual(spoke.geometry);
    api.expectStatus(await api.del(`/features/${rev.id}`), 200, 'delete');
    const hist = api.expectStatus(await api.post(`/features/${spoke.id}/revisions/1/draft`), 201, 'draft from history');
    expect(hist.construction).toEqual(spoke.construction);
    expect(hist.geometry).toEqual(spoke.geometry);
  });
});

describe('revision mode (§15.9)', () => {
  it('creates draft revisions of every spoke with a kept construction_id; accepting keeps each id at revision 2', async () => {
    const { inner, outer } = await rings();
    const spokes = await acceptedConstruction(inner, outer, { output: { kind: 'wall', name_prefix: 'Wall' } });
    const cid = spokes[0].construction.construction_id;
    // Name a spoke descriptively after acceptance; revision mode keeps canon's own fields.
    api.expectStatus(await api.patch(`/features/${spokes[1].id}`, { name: 'North wall' }), 200, 'rename');

    const emitsBefore = emits.length;
    const res = await construct(body(inner, outer, { offset_deg: 10, output: undefined, revises: revisesOf(spokes) }));
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(201);
    expect(emits.length - emitsBefore).toBe(1);
    expect(res.body).toMatchObject({ mode: 'revision', construction_id: cid });
    const drafts = res.body.features;
    expect(drafts.map(d => d.revises_id)).toEqual(spokes.map(s => s.id));
    expect(drafts.every(d => d.lifecycle_state === 'draft' && d.provenance === 'authored' && d.base_revision === 1)).toBe(true);
    expect(drafts.map(d => d.name)).toEqual(['Wall #0', 'North wall', 'Wall #2', 'Wall #3']);
    expect(drafts.every(d => d.kind === 'wall' && d.construction.construction_id === cid && d.construction.offset_deg === 10)).toBe(true);
    expect(drafts[0].geometry).not.toEqual(spokes[0].geometry);

    // Canon is untouched until each revision is explicitly accepted.
    expect((await api.get(`/features/${spokes[0].id}`)).body.geometry).toEqual(spokes[0].geometry);
    const accepted = await acceptAll(drafts);
    expect(accepted.map(a => [a.id, a.revision])).toEqual(spokes.map(s => [s.id, 2]));
    expect(accepted[0].construction.offset_deg).toBe(10);
  });

  it('may change the center, the offset and the pinned inputs', async () => {
    const { inner, outer } = await rings();
    const spokes = await acceptedConstruction(inner, outer);
    const bigger = await api.accepted('features', route(ringLine(300), { kind: 'wall' }));
    const res = await construct(body(inner, bigger, { center: { x: 1, z: 2 }, offset_deg: 5, output: undefined, revises: revisesOf(spokes) }));
    expect(res.status).toBe(201);
    expect(res.body.features[0].construction).toMatchObject({ center: { x: 1, z: 2 }, outer: { feature_id: bigger.id, revision: 1 } });
  });

  describe('refuses with 409, the full list, and zero rows written', () => {
    let inner; let outer; let spokes;
    beforeEach(async () => {
      ({ inner, outer } = await rings());
      spokes = await acceptedConstruction(inner, outer);
    });
    const revisionBody = (extra = {}) => body(inner, outer, { offset_deg: 10, output: undefined, revises: revisesOf(spokes), ...extra });
    const siblingsUnchanged = async (fn) => {
      const before = await featureRows(spokes.map(s => s.id));
      const report = await fn();
      expect(await featureRows(spokes.map(s => s.id))).toEqual(before);
      return report;
    };

    it('a locked target, naming the spoke', async () => {
      api.expectStatus(await api.patch(`/features/${spokes[2].id}/lock`, { is_locked: true }), 200, 'lock');
      const r = await expectRefusedUnchanged(() => construct(revisionBody()), 409);
      expect(r.errors).toEqual([expect.objectContaining({ code: 'revision_target_locked', index: 2, feature_id: spokes[2].id })]);
      expect(r.errors[0].message).toMatch(/^Spoke 2 \(feature #\d+\) is locked/);
    });

    it('a target with an open draft revision', async () => {
      api.expectStatus(await api.post(`/features/${spokes[1].id}/revise`), 201, 'revise');
      const r = await expectRefusedUnchanged(() => construct(revisionBody()), 409);
      expect(r.errors.map(e => e.code)).toEqual(['revision_open_revision']);
    });

    it('a stale target', async () => {
      const revises = revisesOf(spokes).map((x, k) => (k === 3 ? { ...x, expected_revision: 2 } : x));
      const r = await expectRefusedUnchanged(() => construct(revisionBody({ revises })), 409);
      expect(r.errors.map(e => e.code)).toEqual(['revision_target_stale']);
    });

    it('an index that does not match the record', async () => {
      const revises = revisesOf(spokes).map((x, k) => (k === 0 ? { ...x, index: 1 } : k === 1 ? { ...x, index: 0 } : x));
      const r = await expectRefusedUnchanged(() => construct(revisionBody({ revises })), 409);
      expect(r.errors.map(e => e.code)).toEqual(['revision_index_mismatch', 'revision_index_mismatch']);
    });

    it('targets from a different construction', async () => {
      const other = await acceptedConstruction(inner, outer, { count: 1, offset_deg: 45 });
      const revises = [...revisesOf(spokes).slice(0, 3), { index: 3, feature_id: other[0].id, expected_revision: 1 }];
      const r = await siblingsUnchanged(() => expectRefusedUnchanged(() => construct(revisionBody({ revises })), 409));
      const codes = r.errors.map(e => e.code);
      expect(codes).toContain('revision_construction_mismatch');
      expect(codes).toContain('revision_index_mismatch');
    });

    it('fewer spokes (count differs from the record)', async () => {
      const r = await siblingsUnchanged(() => expectRefusedUnchanged(() => construct(revisionBody({ count: 3, revises: revisesOf(spokes).slice(0, 3) })), 409));
      expect(r.errors.map(e => e.code)).toContain('revision_count_mismatch');
      expect(r.errors.map(e => e.code)).toContain('revision_missing_sibling');
    });

    it('more spokes (count differs from the record)', async () => {
      const r = await siblingsUnchanged(() => expectRefusedUnchanged(() => construct(revisionBody({ count: 5 })), 409));
      expect(r.errors.map(e => e.code)).toEqual(['revision_count_mismatch', 'revision_missing_index']);
    });

    it('an omission added', async () => {
      const r = await siblingsUnchanged(() => expectRefusedUnchanged(() => construct(revisionBody({
        omit_indices: [3], revises: revisesOf(spokes).slice(0, 3),
      })), 409));
      expect(r.errors.map(e => e.code)).toEqual(['revision_omit_mismatch', 'revision_missing_sibling']);
    });

    it('an omission added while still naming every sibling', async () => {
      const r = await siblingsUnchanged(() => expectRefusedUnchanged(() => construct(revisionBody({ omit_indices: [3] })), 409));
      expect(r.errors.map(e => e.code)).toEqual(['revision_omit_mismatch', 'revision_index_mismatch']);
    });

    it('an accepted sibling left out of revises', async () => {
      const r = await siblingsUnchanged(() => expectRefusedUnchanged(() => construct(revisionBody({ revises: revisesOf(spokes).slice(1) })), 409));
      expect(r.errors.map(e => e.code)).toEqual(['revision_missing_index', 'revision_missing_sibling']);
      expect(r.errors[1].feature_ids).toEqual([spokes[0].id]);
    });

    it('the targets\' records disagree on count or omissions', async () => {
      const rec = { ...spokes[3].construction, omit_indices: [], count: 5 };
      await runSql(db, 'UPDATE canonical_features SET construction_json = ? WHERE id = ?', [JSON.stringify(rec), spokes[3].id]);
      const r = await siblingsUnchanged(() => expectRefusedUnchanged(() => construct(revisionBody()), 409));
      expect(r.errors.map(e => e.code)).toEqual(['revision_records_disagree']);
    });

    it('per-spoke errors cannot be omitted away in revision mode', async () => {
      const r = await siblingsUnchanged(() => expectRefusedUnchanged(() => construct(revisionBody({ center: { x: 60, z: 0 } })), 409));
      expect(r.errors.map(e => e.code)).toEqual(['center_not_inside']);
    });
  });

  it('a count or omission change succeeds in new-drafts mode with a new construction_id; the old accepted spokes are untouched', async () => {
    const { inner, outer } = await rings();
    const spokes = await acceptedConstruction(inner, outer);
    const before = await featureRows(spokes.map(s => s.id));
    const more = api.expectStatus(await construct(body(inner, outer, { count: 6 })), 201, 'more');
    const fewer = api.expectStatus(await construct(body(inner, outer, { omit_indices: [3] })), 201, 'omit');
    expect(more.construction_id).not.toBe(spokes[0].construction.construction_id);
    expect(fewer.construction_id).not.toBe(spokes[0].construction.construction_id);
    expect(more.features).toHaveLength(6);
    expect(fewer.features).toHaveLength(3);
    expect(await featureRows(spokes.map(s => s.id))).toEqual(before);
  });
});

describe('inline circle boundary sources (§15.3.1)', () => {
  const threePt = (r) => ({ circle: { method: 'three_point', points: [{ x: r, z: 0 }, { x: 0, z: r }, { x: -r, z: 0 }] } });
  const centerRim = (r) => ({ circle: { method: 'center_radius', points: [{ x: 0, z: 0 }, { x: r, z: 0 }] } });
  const circleBody = (inner, outer, extra = {}) => ({ inner, outer, center: { x: 0, z: 0 }, count: 4, offset_deg: 0, output: {}, ...extra });
  const featureCount = async () => (await all(db, 'SELECT COUNT(*) AS c FROM canonical_features'))[0].c;

  it('dry run works with two inline circles and writes nothing', async () => {
    const before = await snapshotCanonical(db);
    const res = await construct(circleBody(threePt(100), centerRim(300), { dry_run: true, count: 16 }));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.spokes.every(s => s.status === 'valid')).toBe(true);
    expect(res.body.spokes[0].geometry).toEqual([{ x: 100, z: 0 }, { x: 300, z: 0 }]);
    expect(await snapshotCanonical(db)).toEqual(before);
  });

  it('persists only the spoke drafts, recording each circle as its normalized definition, with no standalone circle feature', async () => {
    const before = await featureCount();
    const res = await construct(circleBody({ circle: { method: 'three_point', points: [{ x: 100.0004, z: 0 }, { x: 0, z: 100 }, { x: -100, z: 0 }] } }, centerRim(300)));
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(201);
    expect(await featureCount()).toBe(before + 4);
    expect(res.body.features.every(f => f.lifecycle_state === 'draft' && f.feature_class === 'route')).toBe(true);
    const rec = res.body.features[0].construction;
    expect(rec.inner).toEqual({ circle: {
      method: 'three_point', points: [{ x: 100, z: 0 }, { x: 0, z: 100 }, { x: -100, z: 0 }],
      center: { x: 0, z: 0 }, radius: 100, segments: 55, max_chord_error_m: 0.25,
    } });
    expect(rec.outer.circle).toMatchObject({ method: 'center_radius', points: [{ x: 0, z: 0 }, { x: 300, z: 0 }], center: { x: 0, z: 0 }, radius: 300 });
    // Nothing but the spokes exists: no circle polygon was accepted or drafted along the way.
    const rows = await all(db, 'SELECT geometry_type, lifecycle_state FROM canonical_features');
    expect(rows.every(r => r.geometry_type === 'linestring' && r.lifecycle_state === 'draft')).toBe(true);
    // The recorded definition reproduces the circle exactly with the shape creator's semantics.
    const circles = require_('../canonicalGeography/circleConstruction.js');
    for (const side of [rec.inner, rec.outer]) {
      expect(circles.circleFromDefinition(side.circle.method, side.circle.points).construction)
        .toMatchObject({ center: side.circle.center, radius: side.circle.radius, segments: side.circle.segments });
    }
  });

  it('mixes sources: canonical inner with inline outer (and the reverse), leaving input rows untouched', async () => {
    const { inner, outer } = await rings();
    const beforeRows = await featureRows([inner.id, outer.id]);
    const res = await construct(circleBody(pin(inner), centerRim(300), { count: 8 }));
    expect(res.status).toBe(201);
    expect(res.body.features[0].construction.inner).toEqual({ feature_id: inner.id, revision: 1 });
    expect(res.body.features[0].construction.outer.circle.method).toBe('center_radius');
    expect(res.body.features[0].geometry).toEqual([{ x: 50, z: 0 }, { x: 300, z: 0 }]);
    const flip = await construct(circleBody(threePt(100), pin(outer)));
    expect(flip.status).toBe(201);
    expect(flip.body.features[0].geometry).toEqual([{ x: 100, z: 0 }, { x: 200, z: 0 }]);
    expect(flip.body.features[0].construction.outer).toEqual({ feature_id: outer.id, revision: 1 });
    expect(await featureRows([inner.id, outer.id])).toEqual(beforeRows);
  });

  it('recomputes the circle itself: a client-supplied center, radius, segments or ring is refused, never trusted', async () => {
    for (const extra of [{ center: { x: 5, z: 5 } }, { radius: 250 }, { ring: [{ x: 0, z: 0 }] }, { segments: 8 }]) {
      const c = centerRim(300);
      await expectRefusedUnchanged(() => construct(circleBody(threePt(100), { circle: { ...c.circle, ...extra } })), 400);
    }
  });

  it('rejects malformed or degenerate circle definitions clearly (400), writing nothing', async () => {
    const cases = [
      [{ circle: { method: 'three_point', points: [{ x: 0, z: 0 }, { x: 10, z: 10 }, { x: 20, z: 20 }] } }, /collinear or coincident/],
      [{ circle: { method: 'three_point', points: [{ x: 5, z: 5 }, { x: 5, z: 5 }, { x: 5, z: 5 }] } }, /collinear or coincident/],
      [{ circle: { method: 'center_radius', points: [{ x: 0, z: 0 }, { x: 0.0004, z: 0 }] } }, /rim point is the centre/],
      [{ circle: { method: 'center_radius', points: [{ x: 0, z: 0 }, { x: 0.3, z: 0 }] } }, /not a usable boundary/],
      [{ circle: { method: 'three_point', points: [{ x: 0, z: 0 }, { x: 1, z: 0 }] } }, /must be 3 points/],
      [{ circle: { method: 'ellipse', points: [] } }, /method must be one of/],
      [{ circle: { method: 'center_radius', points: [{ x: 0, z: 0 }, { x: 30000, z: 0 }] } }, /not a valid point/],
      [{ circle: { method: 'center_radius', points: [{ x: 0, z: 0 }, { x: 'a', z: 0 }] } }, /not a valid point/],
      [{ circle: { method: 'center_radius', points: [{ x: 0, z: 0 }, { x: 1, z: 0, y: 2 }] } }, /must be \{x, z\}/],
      [{ circle: centerRim(300).circle, feature_id: 1, expected_revision: 1 }, /either/],
      [{ circle: 'round' }, /must be \{method, points\}/],
    ];
    for (const [outer, message] of cases) {
      const body = await expectRefusedUnchanged(() => construct(circleBody(threePt(100), outer)), 400);
      expect(body.error, JSON.stringify(outer)).toMatch(message);
    }
  });

  it('reports a center outside a constructed circle like any boundary', async () => {
    const r = await construct(circleBody(threePt(100), centerRim(300), { dry_run: true, center: { x: 150, z: 0 } }));
    expect(r.body.errors).toEqual([expect.objectContaining({ code: 'center_not_inside', ring: 'inner' })]);
    expect(r.body.errors[0].message).toMatch(/inner boundary \(constructed circle\)/);
  });

  it('revision mode may change an inline circle definition, while count, omissions and the complete sibling set still hold', async () => {
    const created = api.expectStatus(await construct(circleBody(threePt(100), centerRim(300))), 201, 'create');
    const spokes = await acceptAll(created.features);
    const res = await construct(circleBody(threePt(100), centerRim(320), { output: undefined, revises: revisesOf(spokes) }));
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(201);
    expect(res.body.features.map(f => f.revises_id)).toEqual(spokes.map(s => s.id));
    expect(res.body.features[0].construction.outer.circle.radius).toBe(320);
    expect(res.body.features[0].geometry).toEqual([{ x: 100, z: 0 }, { x: 320, z: 0 }]);
    await api.del(`/features/${res.body.features[0].id}`);
    for (const f of res.body.features.slice(1)) await api.del(`/features/${f.id}`);
    await expectRefusedUnchanged(() => construct(circleBody(threePt(100), centerRim(320), { count: 5, output: undefined, revises: revisesOf(spokes) })), 409);
    await expectRefusedUnchanged(() => construct(circleBody(threePt(100), centerRim(320), { output: undefined, revises: revisesOf(spokes).slice(1) })), 409);
  });

  it('a stored record\'s circle must be exactly what its definition reproduces', () => {
    const { ENTITIES } = require_('../canonicalGeography/entities.js');
    const circle = { method: 'center_radius', points: [{ x: 0, z: 0 }, { x: 300, z: 0 }], center: { x: 0, z: 0 }, radius: 300, segments: 95, max_chord_error_m: 0.25 };
    const record = (outer) => ({
      type: 'radial_spoke', version: 1, construction_id: 'x', center: { x: 0, z: 0 }, center_source: { kind: 'coordinate' },
      inner: { feature_id: 1, revision: 1 }, outer, count: 1, offset_deg: 0, omit_indices: [], index: 0, angle_deg: 0,
      angle_convention: 'deg_from_+x_toward_+z',
    });
    const input = (outer) => ({ feature_class: 'route', geometry_type: 'linestring', geometry: [{ x: 50, z: 0 }, { x: 300, z: 0 }],
      constraint_strength: 'hard', construction: record(outer) });
    expect(() => ENTITIES.features.normalize(input({ circle }))).not.toThrow();
    expect(() => ENTITIES.features.normalize(input({ circle: { ...circle, radius: 299 } }))).toThrow(/does not match/);
    expect(() => ENTITIES.features.normalize(input({ circle: { ...circle, points: [{ x: 0, z: 0 }, { x: 300.0004, z: 0 }] } }))).toThrow(/does not match/);
    expect(() => ENTITIES.features.normalize(input({ circle: { ...circle, extra: 1 } }))).toThrow();
  });
});

describe('materializing a constructed boundary as a canonical draft (§15.3.1)', () => {
  const circles = require_('../canonicalGeography/circleConstruction.js');
  const threePt = (r, materialize) => ({ circle: { method: 'three_point', points: [{ x: r, z: 0 }, { x: 0, z: r }, { x: -r, z: 0 }] }, ...(materialize ? { materialize } : {}) });
  const centerRim = (r, materialize) => ({ circle: { method: 'center_radius', points: [{ x: 0, z: 0 }, { x: r, z: 0 }] }, ...(materialize ? { materialize } : {}) });
  const body = (inner, outer, extra = {}) => ({ inner, outer, center: { x: 0, z: 0 }, count: 8, offset_deg: 0, output: { kind: 'wall' }, ...extra });
  const rows = () => all(db, 'SELECT id, feature_class, geometry_type, lifecycle_state FROM canonical_features ORDER BY id');

  it('construction-only (the default) writes spoke drafts only', async () => {
    const res = api.expectStatus(await construct(body(threePt(100), centerRim(300))), 201, 'create');
    expect(res.boundary_features).toEqual([]);
    expect((await rows()).map(r => r.geometry_type)).toEqual(Array(8).fill('linestring'));
    expect(res.features[0].construction.outer).not.toHaveProperty('materialized_feature_id');
  });

  it('a materialized outer circle is one ordinary draft plus the spokes, from the same server-resolved circle', async () => {
    const emitsBefore = emits.length;
    const res = api.expectStatus(await construct(body(threePt(100),
      centerRim(300, { feature_class: 'route', kind: 'wall', name: 'Outer ring wall' }))), 201, 'create');
    expect(emits.length - emitsBefore).toBe(1);
    expect(res.boundary_features).toHaveLength(1);
    const [{ role, feature: ring }] = res.boundary_features;
    expect(role).toBe('outer');
    expect(ring).toMatchObject({
      lifecycle_state: 'draft', provenance: 'authored', revision: 0, is_locked: false, replacement_state: 'non_replaceable',
      feature_class: 'route', kind: 'wall', geometry_type: 'linestring', constraint_strength: 'hard', name: 'Outer ring wall', anchor_id: null,
    });
    const built = circles.circleFromDefinition('center_radius', [{ x: 0, z: 0 }, { x: 300, z: 0 }]);
    expect(ring.geometry).toEqual([...built.ring, built.ring[0]]); // the exact ring the spokes were cut against, closed
    expect(ring.construction).toEqual(built.construction); // the shape creator's own circle record
    expect(res.features).toHaveLength(8);
    expect(res.features.every(f => f.construction.outer.materialized_feature_id === ring.id)).toBe(true);
    expect(res.features.every(f => f.construction.outer.circle.radius === 300)).toBe(true);
    expect((await rows()).filter(r => r.lifecycle_state !== 'draft')).toEqual([]);
  });

  it('both circles materialized: two boundary drafts (polygon classes use the shape creator polygon form) plus the spokes', async () => {
    const res = api.expectStatus(await construct(body(threePt(100, { feature_class: 'site', name: 'Inner precinct' }),
      centerRim(300, { feature_class: 'land', constraint_strength: 'soft' }))), 201, 'create');
    expect(res.boundary_features.map(b => [b.role, b.feature.feature_class, b.feature.geometry_type, b.feature.constraint_strength]))
      .toEqual([['inner', 'site', 'polygon', 'hard'], ['outer', 'land', 'polygon', 'soft']]);
    const built = circles.circleFromDefinition('three_point', [{ x: 100, z: 0 }, { x: 0, z: 100 }, { x: -100, z: 0 }]);
    expect(res.boundary_features[0].feature.geometry).toEqual({ outer: built.ring, holes: [] });
    expect(await rows()).toHaveLength(10);
  });

  it('never duplicates an existing canonical boundary: materialize on a feature source is refused', async () => {
    const { inner } = await rings();
    const r = await expectRefusedUnchanged(() => construct(body({ ...pin(inner), materialize: { feature_class: 'site' } }, centerRim(300))), 400);
    expect(r.error).toMatch(/never duplicated|materialize applies only/);
    // Mixed: canonical inner untouched, only the inline outer becomes a draft.
    const res = api.expectStatus(await construct(body(pin(inner), centerRim(300, { feature_class: 'route' }))), 201, 'mixed');
    expect(res.boundary_features.map(b => b.role)).toEqual(['outer']);
  });

  it('malformed boundary-output semantics fail atomically with zero writes', async () => {
    const bad = [
      { feature_class: 'lake' }, { feature_class: 'route', kind: 'channel' }, { feature_class: 'site', kind: 'wall' },
      { feature_class: 'land', constraint_strength: 'firm' }, { feature_class: 'land', name: 'x'.repeat(200) },
      { feature_class: 'land', lifecycle_state: 'accepted' }, { feature_class: 'land', geometry: { outer: [] } },
      { feature_class: 'land', is_locked: true }, { feature_class: 'land', anchor_id: 1 }, 'yes',
    ];
    for (const materialize of bad) {
      await expectRefusedUnchanged(() => construct(body(threePt(100), centerRim(300, materialize))), 400);
    }
  });

  it('a spoke failure prevents the boundary draft too (all or nothing)', async () => {
    // Center outside the inner circle: construction error.
    await expectRefusedUnchanged(() => construct(body(threePt(100), centerRim(300, { feature_class: 'route' }), { center: { x: 150, z: 0 } })), 409);
    // A per-spoke error: an inner ring that crosses the outer circle.
    const wide = await api.accepted('features', site('polygon', { outer: [{ x: -400, z: -30 }, { x: 400, z: -30 }, { x: 400, z: 30 }, { x: -400, z: 30 }] }));
    const r = await expectRefusedUnchanged(() => construct(body(pin(wide), centerRim(300, { feature_class: 'route' }), { count: 4 })), 409);
    expect(r.spokes.filter(s => s.status === 'invalid').map(s => s.index)).toEqual([0, 2]);
  });

  it('dry run reports the boundary drafts it would create, writing nothing', async () => {
    const before = await snapshotCanonical(db);
    const r = await construct(body(threePt(100), centerRim(300, { feature_class: 'route' }), { dry_run: true }));
    expect(r.status).toBe(200);
    expect(r.body.boundary_drafts).toEqual([{ role: 'outer', feature_class: 'route', geometry_type: 'linestring' }]);
    expect(await snapshotCanonical(db)).toEqual(before);
  });

  it('the materialized draft is independent: editing or deleting it never changes the spokes or their record', async () => {
    const res = api.expectStatus(await construct(body(threePt(100), centerRim(300, { feature_class: 'land' }))), 201, 'create');
    const ringId = res.boundary_features[0].feature.id;
    const spokeIds = res.features.map(f => f.id);
    const before = await featureRows(spokeIds);
    // An ordinary draft: editable like any other (here: replace its geometry and clear its circle record).
    api.expectStatus(await api.patch(`/features/${ringId}`, { geometry: square(-250, -250, 500), construction: null }), 200, 'edit ring');
    expect(await featureRows(spokeIds)).toEqual(before);
    api.expectStatus(await api.del(`/features/${ringId}`), 200, 'delete ring');
    expect(await featureRows(spokeIds)).toEqual(before);
    // The spokes still accept, and revision mode still reconstructs from the stored circle definition.
    const spokes = await acceptAll(res.features);
    const rev = await construct(body(threePt(100), centerRim(300), { output: undefined, offset_deg: 5, revises: revisesOf(spokes) }));
    expect(rev.status, JSON.stringify(rev.body).slice(0, 200)).toBe(201);
  });

  it('reconstruction never creates another boundary draft unless it explicitly asks, and never revises the old one', async () => {
    const res = api.expectStatus(await construct(body(threePt(100), centerRim(300, { feature_class: 'route', kind: 'wall' }))), 201, 'create');
    const ringId = res.boundary_features[0].feature.id;
    await api.accept('features', res.boundary_features[0].feature);
    const acceptedRing = await featureRows([ringId]);
    const spokes = await acceptAll(res.features);
    const count = async () => (await rows()).length;
    const n = await count();
    // Reconstructing from the stored definition (no materialize): draft revisions only, no new boundary.
    const rev = api.expectStatus(await construct(body(threePt(100), centerRim(300), { output: undefined, offset_deg: 5, revises: revisesOf(spokes) })), 201, 'rev');
    expect(rev.boundary_features).toEqual([]);
    expect(await count()).toBe(n + 8);
    expect(rev.features[0].construction.outer).not.toHaveProperty('materialized_feature_id');
    expect(await featureRows([ringId])).toEqual(acceptedRing); // the accepted materialized ring is untouched
    for (const f of rev.features) await api.del(`/features/${f.id}`);
    // Asking explicitly creates one new, separate draft; the accepted ring is still untouched.
    const again = api.expectStatus(await construct(body(threePt(100), centerRim(300, { feature_class: 'route' }), { output: undefined, revises: revisesOf(spokes) })), 201, 'again');
    expect(again.boundary_features).toHaveLength(1);
    expect(again.boundary_features[0].feature.id).not.toBe(ringId);
    expect(again.boundary_features[0].feature.lifecycle_state).toBe('draft');
    expect(await featureRows([ringId])).toEqual(acceptedRing);
  });
});

describe('a materialized route boundary carries its own width (§15.3.1)', () => {
  const threePt = (r, materialize) => ({ circle: { method: 'three_point', points: [{ x: r, z: 0 }, { x: 0, z: r }, { x: -r, z: 0 }] }, ...(materialize ? { materialize } : {}) });
  const centerRim = (r, materialize) => ({ circle: { method: 'center_radius', points: [{ x: 0, z: 0 }, { x: r, z: 0 }] }, ...(materialize ? { materialize } : {}) });
  const body = (inner, outer, output = { kind: 'wall', width_wu: 5.25 }) => ({ inner, outer, center: { x: 0, z: 0 }, count: 4, offset_deg: 0, output });
  const wall = (width) => ({ feature_class: 'route', kind: 'wall', ...(width === undefined ? {} : { width_wu: width }) });

  it('persists the boundary width in the ordinary route attributes, independent of the spokes and of the other boundary', async () => {
    const res = api.expectStatus(await construct(body(threePt(100, wall(3.5)), centerRim(300, wall(7.87)))), 201, 'create');
    const byRole = Object.fromEntries(res.boundary_features.map(b => [b.role, b.feature]));
    expect(byRole.inner.attributes).toEqual({ width_wu: 3.5 });
    expect(byRole.outer.attributes).toEqual({ width_wu: 7.87 });
    expect(res.features.every(f => f.attributes.width_wu === 5.25)).toBe(true);
    const stored = await all(db, 'SELECT id, attributes_json FROM canonical_features WHERE id IN (?, ?)', [byRole.inner.id, byRole.outer.id]);
    expect(stored.map(r => JSON.parse(r.attributes_json))).toEqual([{ width_wu: 3.5 }, { width_wu: 7.87 }]);
  });

  it('boundary width is never taken from the spokes: omitted is valid and stays unset', async () => {
    const res = api.expectStatus(await construct(body(threePt(100), centerRim(300, wall()))), 201, 'create');
    expect(res.boundary_features[0].feature.attributes).toBeNull();
    expect(res.features[0].attributes).toEqual({ width_wu: 5.25 });
    const nulled = api.expectStatus(await construct(body(threePt(100), centerRim(300, wall(null)))), 201, 'null width');
    expect(nulled.boundary_features[0].feature.attributes).toBeNull();
  });

  it('spokes may have no width while the boundary has one', async () => {
    const res = api.expectStatus(await construct(body(threePt(100), centerRim(300, wall(7.87)), { kind: 'wall' })), 201, 'create');
    expect(res.boundary_features[0].feature.attributes).toEqual({ width_wu: 7.87 });
    expect(res.features.every(f => f.attributes === null)).toBe(true);
  });

  it('rejects an invalid width, or a width on a non-route boundary, and the whole create writes nothing', async () => {
    const bad = [
      wall(0), wall(-2), wall('7'), wall(30000),
      { feature_class: 'land', width_wu: 4 }, { feature_class: 'site', width_wu: 4 }, { feature_class: 'water', width_wu: 4 },
      { feature_class: 'protected_region', width_wu: 4 }, { feature_class: 'scope_boundary', width_wu: 4 },
    ];
    for (const materialize of bad) {
      const r = await expectRefusedUnchanged(() => construct(body(threePt(100), centerRim(300, materialize))), 400);
      expect(r.error, JSON.stringify(materialize)).toMatch(/outer\.materialize: .*(width_wu|take no attributes|not recognised)/);
    }
    // A bad width on INNER blocks OUTER's valid boundary and all spokes too.
    await expectRefusedUnchanged(() => construct(body(threePt(100, wall(-1)), centerRim(300, wall(7.87)))), 400);
  });

  it('spoke width behaviour is unchanged', async () => {
    const r = await expectRefusedUnchanged(() => construct(body(threePt(100), centerRim(300, wall(7.87)), { feature_class: 'site', width_wu: 3 })), 400);
    expect(r.error).toMatch(/output\.width_wu applies to route output only/);
    await expectRefusedUnchanged(() => construct(body(threePt(100), centerRim(300), { width_wu: 0 })), 400);
  });
});
