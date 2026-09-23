import { describe, it, expect, beforeEach } from 'vitest';
import sqlite3pkg from 'sqlite3';
import { createRequire } from 'module';
import { makeTestDb, get, all, run } from './helpers/testDb.js';

const require_ = createRequire(import.meta.url);
const { runMigrations, MIGRATIONS } = require_('../migrations/index.js');
const canonicalMigration = require_('../migrations/002-canonical-geography.js');

const sqlite3 = sqlite3pkg.verbose();

const CANONICAL_TABLES = [
  'canonical_features',
  'canonical_anchors',
  'canonical_connections',
  'geo_scopes',
  'geo_scope_members',
  'canonical_revisions',
];

const INHERITED_TABLES = ['locations', 'districts', 'roads', 'overpasses', 'water_bodies',
  'saved_maps', 'signs', 'global_settings', 'action_history', 'reference_assets', 'reference_layers'];

const emptyDb = () => new Promise((resolve, reject) => {
  const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
});

const tableNames = (db) =>
  all(db, `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).then(rows => rows.map(r => r.name));

const count = async (db, table) => (await get(db, `SELECT COUNT(*) AS c FROM ${table}`)).c;

const dump = async (db, tables) => {
  const out = {};
  for (const t of tables) out[t] = await all(db, `SELECT * FROM ${t} ORDER BY rowid`);
  return out;
};

const PRE_FEATURE = MIGRATIONS.filter(m => m.name < '002-canonical-geography');

// A minimal valid row for each entity table; tests override one column at a time.
const polygonJson = JSON.stringify({ outer: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }], holes: [] });
const insertFeature = (db, cols = {}) => {
  const row = {
    feature_class: 'land', geometry_type: 'polygon', geometry_json: polygonJson,
    min_x: 0, min_z: 0, max_x: 10, max_z: 10,
    constraint_strength: 'hard', provenance: 'authored', ...cols,
  };
  const keys = Object.keys(row);
  return run(db, `INSERT INTO canonical_features (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, keys.map(k => row[k]));
};
const insertAnchor = (db, cols = {}) => {
  const row = { anchor_key: 'arena', name: 'Arena', category: 'landmark', constraint_strength: 'hard', provenance: 'imported', ...cols };
  const keys = Object.keys(row);
  return run(db, `INSERT INTO canonical_anchors (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, keys.map(k => row[k]));
};
const insertScope = (db, cols = {}) => {
  const row = { scope_key: 'arena-district', scope_kind: 'district', name: 'Arena District', provenance: 'imported', ...cols };
  const keys = Object.keys(row);
  return run(db, `INSERT INTO geo_scopes (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, keys.map(k => row[k]));
};

describe('002-canonical-geography on an empty database', () => {
  let db;
  beforeEach(async () => { db = await emptyDb(); });

  it('is registered after the reference-layer migration', () => {
    expect(MIGRATIONS.map(m => m.name)).toEqual(['001-reference-layers', '002-canonical-geography']);
  });

  it('creates every canonical table and seeds exactly one root city scope', async () => {
    expect(await runMigrations(db)).toContain('002-canonical-geography');
    const names = await tableNames(db);
    for (const t of CANONICAL_TABLES) expect(names).toContain(t);

    const scopes = await all(db, 'SELECT * FROM geo_scopes');
    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toMatchObject({
      scope_key: 'city',
      scope_kind: 'city',
      name: 'Imperial City',
      parent_scope_id: null,
      boundary_feature_id: null,
      land_coverage: 'partial',
      lifecycle_state: 'accepted',
      provenance: 'authored',
      replacement_state: 'non_replaceable',
      is_locked: 0,
      revision: 1,
      revises_id: null,
    });
    expect(scopes[0].accepted_at).not.toBeNull();
  });

  it('records the root acceptance in history and seeds nothing else', async () => {
    await runMigrations(db);
    const root = await get(db, `SELECT id FROM geo_scopes WHERE scope_key = 'city'`);
    const history = await all(db, 'SELECT * FROM canonical_revisions');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ entity_type: 'scope', entity_id: root.id, revision: 1, change_kind: 'accept' });
    expect(JSON.parse(history[0].snapshot_json)).toMatchObject({ scope_key: 'city', scope_kind: 'city', name: 'Imperial City' });

    // No campaign data: no districts, islands, anchors, connections or memberships.
    expect(await count(db, 'canonical_features')).toBe(0);
    expect(await count(db, 'canonical_anchors')).toBe(0);
    expect(await count(db, 'canonical_connections')).toBe(0);
    expect(await count(db, 'geo_scope_members')).toBe(0);
  });

  it('applies nothing on a second startup', async () => {
    await runMigrations(db);
    expect(await runMigrations(db)).toEqual([]);
    expect(await count(db, 'geo_scopes')).toBe(1);
    expect(await count(db, 'canonical_revisions')).toBe(1);
  });

  it('does not duplicate the root or its history if replayed without a ledger row', async () => {
    await runMigrations(db);
    await run(db, `DELETE FROM schema_migrations WHERE name = '002-canonical-geography'`);
    expect(await runMigrations(db)).toEqual(['002-canonical-geography']);
    expect(await count(db, 'geo_scopes')).toBe(1);
    expect(await count(db, 'canonical_revisions')).toBe(1);
  });

  it('stores no inherited map-scale column on any canonical table', async () => {
    await runMigrations(db);
    for (const t of CANONICAL_TABLES) {
      const cols = (await all(db, `PRAGMA table_info(${t})`)).map(c => c.name);
      expect(cols).not.toContain('map_scale_multiplier');
    }
  });
});

describe('002-canonical-geography against a representative pre-feature database', () => {
  let db;
  beforeEach(async () => {
    db = await makeTestDb({ migrations: PRE_FEATURE });
    await run(db, `INSERT INTO locations (name, x, y, z, district_name) VALUES ('Arena', 1, 2, 3, 'Arena District')`);
    await run(db, `INSERT INTO districts (name, color) VALUES ('Arena District', '#c33')`);
    await run(db, `INSERT INTO roads (x1, z1, x2, z2, width) VALUES (0, 0, 10, 10, 4)`);
    await run(db, `INSERT INTO overpasses (points, height, width, ramp_length) VALUES ('[]', 5, 4, 10)`);
    await run(db, `INSERT INTO water_bodies (points_json, generated) VALUES ('[{"x":0,"z":0},{"x":5,"z":0},{"x":5,"z":5}]', 0)`);
    await run(db, `INSERT INTO global_settings (key, value) VALUES ('map_scale_multiplier', '5')`);
    await run(db, `INSERT INTO action_history (type, payload) VALUES ('create', '{}')`);
    await run(db, `INSERT INTO reference_assets (content_hash, asset_url, format, source_width_px, source_height_px)
                   VALUES ('h', '/uploads/reference_layers/h.png', 'png', 6032, 4584)`);
    await run(db, `INSERT INTO reference_layers (name, asset_id, world_units_per_pixel) VALUES ('Imperial City', 1, 1.968503937)`);
  });

  it('starts without canonical tables', async () => {
    const names = await tableNames(db);
    for (const t of CANONICAL_TABLES) expect(names).not.toContain(t);
  });

  it('applies only 002 and leaves every inherited and reference row byte-identical', async () => {
    const before = await dump(db, INHERITED_TABLES);
    expect(await runMigrations(db)).toEqual(['002-canonical-geography']);
    expect(await dump(db, INHERITED_TABLES)).toEqual(before);
  });

  it('infers no canonical content from inherited districts, water, roads or locations', async () => {
    await runMigrations(db);
    expect(await count(db, 'canonical_features')).toBe(0);
    expect(await count(db, 'canonical_anchors')).toBe(0);
    expect(await count(db, 'canonical_connections')).toBe(0);
    expect(await all(db, 'SELECT scope_key FROM geo_scopes')).toEqual([{ scope_key: 'city' }]);
  });
});

describe('canonical-geography schema constraints', () => {
  let db;
  beforeEach(async () => { db = await makeTestDb(); });

  it('accepts a minimal valid feature, anchor, connection and scope', async () => {
    await insertFeature(db);
    await insertAnchor(db);
    await insertScope(db, { parent_scope_id: 1 });
    await run(db, `INSERT INTO canonical_connections (from_ref_type, from_ref_id, to_ref_type, to_ref_id, constraint_strength, provenance)
                   VALUES ('feature', 1, 'anchor', 1, 'soft', 'authored')`);
    const f = await get(db, 'SELECT * FROM canonical_features WHERE id = 1');
    expect(f).toMatchObject({ lifecycle_state: 'draft', replacement_state: 'non_replaceable', is_locked: 0, revision: 0, draft_version: 1 });
    const a = await get(db, 'SELECT must_exist, replacement_state FROM canonical_anchors WHERE id = 1');
    expect(a).toEqual({ must_exist: 1, replacement_state: 'non_replaceable' });
    const c = await get(db, 'SELECT connection_kind FROM canonical_connections WHERE id = 1');
    expect(c.connection_kind).toBeNull();
  });

  it.each([
    ['lifecycle_state', 'canonical'],
    ['provenance', 'traced'],
    ['constraint_strength', 'firm'],
    ['replacement_state', 'auto'],
    ['is_locked', 2],
    ['feature_class', 'island'],
    ['geometry_type', 'multipolygon'],
    ['part_role', 'gatehouse'],
  ])('rejects feature %s = %j at the SQL level', async (col, value) => {
    const extra = col === 'part_role' ? { anchor_id: 1 } : {};
    await expect(insertFeature(db, { [col]: value, ...extra })).rejects.toThrow(/CHECK/i);
  });

  it('enforces the per-class kind vocabulary', async () => {
    await insertFeature(db, { feature_class: 'water', kind: 'wetland' });
    await insertFeature(db, { feature_class: 'protected_region', kind: 'no_build' });
    await insertFeature(db, { feature_class: 'route', kind: 'bridge', geometry_type: 'linestring', geometry_json: '[{"x":0,"z":0},{"x":1,"z":0}]' });
    await expect(insertFeature(db, { feature_class: 'water', kind: 'bridge' })).rejects.toThrow(/CHECK/i);
    await expect(insertFeature(db, { feature_class: 'land', kind: 'open_water' })).rejects.toThrow(/CHECK/i);
    await expect(insertFeature(db, { feature_class: 'site', kind: 'road', geometry_type: 'point' })).rejects.toThrow(/CHECK/i);
  });

  it('enforces class/geometry compatibility', async () => {
    await insertFeature(db, { feature_class: 'site', geometry_type: 'point' });
    await expect(insertFeature(db, { feature_class: 'land', geometry_type: 'linestring' })).rejects.toThrow(/CHECK/i);
    await expect(insertFeature(db, { feature_class: 'route', geometry_type: 'polygon' })).rejects.toThrow(/CHECK/i);
    await expect(insertFeature(db, { feature_class: 'scope_boundary', geometry_type: 'point' })).rejects.toThrow(/CHECK/i);
  });

  it('requires an anchor for a part role and an ordered bbox', async () => {
    await expect(insertFeature(db, { part_role: 'core' })).rejects.toThrow(/CHECK/i);
    await expect(insertFeature(db, { min_x: 11 })).rejects.toThrow(/CHECK/i);
  });

  it('requires proposal metadata on generated rows', async () => {
    await expect(insertFeature(db, { provenance: 'generated', lifecycle_state: 'proposed' })).rejects.toThrow(/CHECK/i);
    await insertFeature(db, { provenance: 'generated', lifecycle_state: 'proposed', proposal_json: '{"source":"test"}' });
  });

  it('never has an accepted or retired row at revision 0', async () => {
    await expect(insertFeature(db, { lifecycle_state: 'accepted' })).rejects.toThrow(/CHECK/i);
    await expect(insertScope(db, { lifecycle_state: 'retired' })).rejects.toThrow(/CHECK/i);
    await insertFeature(db, { lifecycle_state: 'accepted', revision: 1 });
  });

  it('allows revises_id only on drafts and proposals, one open revision of each per row', async () => {
    await insertFeature(db, { lifecycle_state: 'accepted', revision: 1 });
    await expect(insertFeature(db, { lifecycle_state: 'accepted', revision: 1, revises_id: 1 })).rejects.toThrow(/CHECK/i);
    await insertFeature(db, { revises_id: 1 });
    await expect(insertFeature(db, { revises_id: 1 })).rejects.toThrow(/UNIQUE/i);
    await insertFeature(db, { lifecycle_state: 'proposed', provenance: 'generated', proposal_json: '{}', revises_id: 1 });
  });

  it('never lets a must-exist anchor be replaceable', async () => {
    await expect(insertAnchor(db, { replacement_state: 'replaceable' })).rejects.toThrow(/CHECK/i);
    await insertAnchor(db);
    await expect(run(db, `UPDATE canonical_anchors SET replacement_state = 'replaceable' WHERE id = 1`)).rejects.toThrow(/CHECK/i);
    await insertAnchor(db, { anchor_key: 'optional', must_exist: 0, replacement_state: 'replaceable' });
  });

  it('rejects an invalid anchor category and keeps anchor keys unique outside revisions', async () => {
    await expect(insertAnchor(db, { category: 'temple' })).rejects.toThrow(/CHECK/i);
    await insertAnchor(db, { lifecycle_state: 'accepted', revision: 1 });
    await expect(insertAnchor(db)).rejects.toThrow(/UNIQUE/i);
    await insertAnchor(db, { revises_id: 1 }); // a pending revision carries its row's key
  });

  it('keeps scope keys unique and rejects a second city root by key', async () => {
    await expect(insertScope(db, { scope_key: 'city', scope_kind: 'city' })).rejects.toThrow(/UNIQUE/i);
    await expect(insertScope(db, { scope_kind: 'ward' })).rejects.toThrow(/CHECK/i);
    await expect(insertScope(db, { land_coverage: 'most' })).rejects.toThrow(/CHECK/i);
  });

  it('rejects an invalid connection vocabulary', async () => {
    const ins = (kind, fromType) => run(db, `INSERT INTO canonical_connections
      (connection_kind, from_ref_type, from_ref_id, to_ref_type, to_ref_id, constraint_strength, provenance)
      VALUES (?, ?, 1, 'feature', 2, 'soft', 'authored')`, [kind, fromType]);
    await ins('ferry', 'feature');
    await expect(ins('teleport', 'feature')).rejects.toThrow(/CHECK/i);
    await expect(ins(null, 'location')).rejects.toThrow(/CHECK/i);
  });

  it('lets an island be a canonical member of at most one scope per kind', async () => {
    await run(db, `INSERT INTO geo_scope_members (scope_id, feature_id, scope_kind, is_canonical) VALUES (2, 7, 'district', 1)`);
    await run(db, `INSERT INTO geo_scope_members (scope_id, feature_id, scope_kind, is_canonical) VALUES (3, 7, 'island_group', 1)`);
    await run(db, `INSERT INTO geo_scope_members (scope_id, feature_id, scope_kind, is_canonical) VALUES (4, 7, 'district', 0)`);
    await expect(run(db, `INSERT INTO geo_scope_members (scope_id, feature_id, scope_kind, is_canonical) VALUES (5, 7, 'district', 1)`))
      .rejects.toThrow(/UNIQUE/i);
  });

  it('keeps revision history append-only', async () => {
    await expect(run(db, `UPDATE canonical_revisions SET change_kind = 'retire'`)).rejects.toThrow(/append-only/);
    await expect(run(db, `DELETE FROM canonical_revisions`)).rejects.toThrow(/append-only/);
    await expect(run(db, `INSERT INTO canonical_revisions (entity_type, entity_id, revision, change_kind, snapshot_json)
                          VALUES ('feature', 1, 1, 'overwrite', '{}')`)).rejects.toThrow(/CHECK/i);
    expect(await count(db, 'canonical_revisions')).toBe(1);
  });
});
