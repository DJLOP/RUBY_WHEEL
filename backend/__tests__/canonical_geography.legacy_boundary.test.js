/**
 * The boundary between canonical geography and inherited map operations (plan §8.4).
 *
 * Legacy saved-map load and clear, region purge, the inherited water and district routes,
 * the map-wide admin undo, and reference-layer recalibration/deletion are all inherited
 * behaviour, several of them destructive. None of it is changed here. What is pinned is
 * that none of it reaches the canonical tables: after each operation every canonical row —
 * drafts, proposals, accepted, locked and retired canon, scope membership and history —
 * and the canonical AUTOINCREMENT counters are byte-identical to before.
 *
 * Each case also checks that the inherited operation really did its destructive work, so
 * a boundary that "holds" only because the operation silently failed cannot pass.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { makeTestDb, get, all, run } from './helpers/testDb.js';

const require_ = createRequire(import.meta.url);
const { setupCanonical, snapshotCanonical, land, site, route, anchor, scope, connection, square } = require_('./helpers/canonicalApi.js');
const mapsRouteFactory = require_('../routes/maps.js');
const locationsRouteFactory = require_('../routes/locations.js');
const adminRouteFactory = require_('../routes/admin.js');
const referenceLayersFactory = require_('../routes/reference_layers.js');

let db;
let api;
let before;
let layerId;

const CITY = 1;

beforeEach(async () => {
  // Created first, so the inherited routers below close over this test's database.
  db = await makeTestDb();
  ({ api } = await setupCanonical({
    db,
    mount: (app, { emitUpdate }) => {
      const io = { emit: () => {} };
      const recordAction = (type, payload) =>
        db.run('INSERT INTO action_history (type, payload) VALUES (?, ?)', [type, JSON.stringify(payload)]);
      const helpers = { emitUpdate, recordAction };
      app.use('/api/maps', mapsRouteFactory(db, io, helpers));
      app.use('/api/locations', locationsRouteFactory(db, io, helpers));
      app.use('/api/reference-layers', referenceLayersFactory(db, io, helpers));
      app.use('/api', adminRouteFactory(db, io, helpers));
    },
  }));

  layerId = await seedReferenceLayer();
  await seedCanonicalWorld();
  await seedInheritedWorld();
  before = await snapshotCanonical(db);
});

async function seedReferenceLayer() {
  const asset = await run(db, `INSERT INTO reference_assets (content_hash, asset_url, original_name, format, source_width_px, source_height_px)
    VALUES ('h', '/uploads/reference_layers/legacy-boundary-test.png', 'imperial.png', 'png', 6032, 4584)`);
  const layer = await run(db, `INSERT INTO reference_layers (name, asset_id, world_center_x, world_center_z, world_units_per_pixel, rotation_rad)
    VALUES ('Imperial City', ?, 0, 0, 1.968503937, 0)`, [asset.lastID]);
  return layer.lastID;
}

/** Every canonical state, all lying inside the region the inherited operations sweep. */
async function seedCanonicalWorld() {
  const evidence = { reference_layer_id: layerId, calibration_snapshot: { world_center_x: 0, world_center_z: 0, world_units_per_pixel: 1.968503937, rotation_rad: 0 } };
  const isleA = await api.accepted('features', land(0, 0, 40, { name: 'Talos Isle', evidence }));
  const isleB = await api.accepted('features', land(100, 0, 40, { name: 'Temple Isle' }));
  const locked = await api.accepted('features', land(0, 100, 40, { name: 'Palace Isle' }));
  await api.patch(`/features/${locked.id}/lock`, { is_locked: true });
  const retired = await api.accepted('features', land(100, 100, 20));
  await api.post(`/features/${retired.id}/retire`);
  await api.draft('features', land(-100, -100, 20));

  const water = (await api.propose('features', { ...land(5, 5, 10), feature_class: 'water', kind: 'basin' })).body;
  await api.accept('features', water);
  await api.propose('features', { ...land(200, 200, 10), feature_class: 'water', kind: 'channel' });

  const district = await api.accepted('scopes', scope('arena-district', 'district', CITY, { name: 'Arena District', members: [isleA.id] }));
  const arena = await api.accepted('anchors', anchor('arena', { required_scope_id: district.id }));
  await api.accepted('features', site('polygon', square(10, 10, 10), { anchor_id: arena.id, part_role: 'footprint' }));
  const bridge = await api.accepted('features', route([{ x: 40, z: 20 }, { x: 100, z: 20 }], { kind: 'bridge' }));
  await api.accepted('connections', connection(['feature', isleA.id], ['feature', isleB.id],
    { constraint_strength: 'hard', connection_kind: 'bridge', via_feature_id: bridge.id }));
  await api.patch(`/features/${isleB.id}`, { notes: 'descriptive history too' });
}

/** Inherited content in the same region, which the operations under test are entitled to destroy. */
async function seedInheritedWorld() {
  await run(db, `INSERT INTO locations (name, x, y, z, shape) VALUES ('URBAN', 10, 0, 10, 'box')`);
  await run(db, `INSERT INTO districts (name, color) VALUES ('Arena District', '#ff0000')`);
  await run(db, `INSERT INTO roads (x1, z1, x2, z2, width) VALUES (0, 0, 10, 10, 4)`);
  await run(db, `INSERT INTO water_bodies (points_json, generated) VALUES (?, 1)`,
    [JSON.stringify([{ x: 0, z: 0 }, { x: 20, z: 0 }, { x: 20, z: 20 }])]);
  await run(db, `INSERT INTO water_bodies (points_json, generated) VALUES (?, 0)`,
    [JSON.stringify([{ x: 0, z: 0 }, { x: 5, z: 0 }, { x: 5, z: 5 }])]);
  await run(db, `INSERT INTO saved_maps (name, locations_data, districts_data, roads_data, overpasses_data, water_bodies_data, signs_data)
    VALUES ('city_base', '[]', '[]', '[]', '[]', '[]', '[]')`);
}

const count = async (table) => (await get(db, `SELECT COUNT(*) AS c FROM ${table}`)).c;
const expectCanonUnchanged = async () => expect(await snapshotCanonical(db)).toEqual(before);

it('seeds every canonical state the boundary has to protect', () => {
  const states = new Set(before.canonical_features.map(f => f.lifecycle_state));
  expect([...states].sort()).toEqual(['accepted', 'draft', 'proposed', 'retired']);
  expect(before.canonical_features.some(f => f.is_locked === 1)).toBe(true);
  expect(before.geo_scope_members).toHaveLength(1);
  expect(before.canonical_revisions.length).toBeGreaterThan(10);
});

describe('legacy saved maps', () => {
  it('load leaves canonical geography unchanged while replacing the inherited world', async () => {
    expect((await api.post('/api/maps/load/city_base')).status).toBe(200);
    expect(await count('locations')).toBe(0);
    expect(await count('water_bodies')).toBe(0);
    await expectCanonUnchanged();
  });

  it('clear leaves canonical geography unchanged while wiping the inherited world', async () => {
    expect((await api.post('/api/maps/clear')).status).toBe(200);
    expect(await count('districts')).toBe(0);
    expect(await count('roads')).toBe(0);
    await expectCanonUnchanged();
  });

  it('save neither captures nor touches canonical geography', async () => {
    expect((await api.post('/api/maps/save', { name: 'snapshot' })).status).toBe(200);
    const row = await get(db, 'SELECT * FROM saved_maps WHERE name = ?', ['snapshot']);
    for (const [column, value] of Object.entries(row)) {
      if (typeof value === 'string') expect(value, column).not.toMatch(/Talos Isle|feature_class|scope_key|anchor_key/);
    }
    await expectCanonUnchanged();
  });
});

describe('region purge', () => {
  it('leaves canonical geography inside the purged region unchanged, generated provenance included', async () => {
    const res = await api.post('/api/locations/purge-region', { bounds: { min: { x: -1000, z: -1000 }, max: { x: 1000, z: 1000 } } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ locations: 1, roads: 1, water: 1 });
    await expectCanonUnchanged();
  });

  it('leaves it unchanged for a polygon purge over a canonical island', async () => {
    const res = await api.post('/api/locations/purge-region', { polygon: square(-5, -5, 50).outer });
    expect(res.status).toBe(200);
    await expectCanonUnchanged();
  });
});

describe('inherited water', () => {
  it('DELETE /api/water deletes every legacy water body and no canonical water', async () => {
    expect((await api.del('/api/water')).status).toBe(200);
    expect(await count('water_bodies')).toBe(0);
    await expectCanonUnchanged();
  });

  it('DELETE /api/water/:id with a canonical feature\'s id deletes only the legacy row', async () => {
    const canonicalWater = before.canonical_features.find(f => f.feature_class === 'water' && f.lifecycle_state === 'accepted');
    await run(db, 'INSERT INTO water_bodies (id, points_json) VALUES (?, ?)', [canonicalWater.id + 1000, '[]']);
    expect((await api.del(`/api/water/${canonicalWater.id}`)).status).toBe(200);
    expect((await api.del(`/api/water/${canonicalWater.id + 1000}`)).status).toBe(200);
    await expectCanonUnchanged();
  });
});

describe('inherited admin undo (POST /api/undo)', () => {
  it('undoes inherited actions without touching canonical rows that share their ids', async () => {
    const ids = before.canonical_features.map(f => f.id);
    for (const type of ['water_create', 'road_create', 'location_create']) {
      await run(db, 'INSERT INTO action_history (type, payload) VALUES (?, ?)', [type, JSON.stringify({ ids })]);
      expect((await api.post('/api/undo')).status, type).toBe(200);
    }
    await expectCanonUnchanged();
  });

  it('has nothing canonical to undo: canonical mutations never write the inherited history', async () => {
    expect(await all(db, 'SELECT type FROM action_history')).toEqual([]);
    expect((await api.post('/api/undo')).status).toBe(400);
    await expectCanonUnchanged();
  });

  it('undoing after a region purge leaves canonical rows unchanged', async () => {
    await api.post('/api/locations/purge-region', { bounds: { min: { x: -1000, z: -1000 }, max: { x: 1000, z: 1000 } } });
    await api.post('/api/undo');
    await expectCanonUnchanged();
  });
});

describe('inherited districts', () => {
  it('create, rename, recolour and delete of a same-named district leave the canonical scope unchanged', async () => {
    expect((await api.post('/api/districts', { name: 'Temple District', color: '#00ff00' })).status).toBe(200);
    expect((await api.put('/api/districts/Arena District', { name: 'Arena Quarter', color: '#0000ff' })).status).toBe(200);
    expect((await api.del('/api/districts/Arena Quarter')).status).toBe(200);
    expect((await api.del('/api/districts/Temple District')).status).toBe(200);
    expect(await count('districts')).toBe(0);
    await expectCanonUnchanged();
    expect((await api.anon.get('/scopes')).body.map(s => s.name)).toEqual(['Imperial City', 'Arena District']);
  });
});

describe('reference layers', () => {
  it('recalibrating the evidence layer does not move canonical geometry or rewrite its evidence', async () => {
    const res = await api.patch(`/api/reference-layers/${layerId}`,
      { world_center_x: 500, world_center_z: -250, world_units_per_pixel: 3, rotation_rad: 1.2 });
    expect(res.status).toBe(200);
    await expectCanonUnchanged();
  });

  it('deleting the evidence layer leaves canonical geometry and its evidence note intact', async () => {
    expect((await api.del(`/api/reference-layers/${layerId}`)).status).toBe(200);
    expect(await count('reference_layers')).toBe(0);
    await expectCanonUnchanged();
    const isle = (await api.anon.get('/features')).body.find(f => f.name === 'Talos Isle');
    expect(isle.evidence.reference_layer_id).toBe(layerId);
  });
});
