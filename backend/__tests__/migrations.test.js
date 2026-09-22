import { describe, it, expect, beforeEach } from 'vitest';
import sqlite3pkg from 'sqlite3';
import { createRequire } from 'module';
import { makeTestDb, get, all, run } from './helpers/testDb.js';

const require_ = createRequire(import.meta.url);
const { runMigrations, MIGRATIONS } = require_('../migrations/index.js');

const sqlite3 = sqlite3pkg.verbose();

/** A database with nothing in it at all — not even the inherited CITY_NET tables. */
const emptyDb = () => new Promise((resolve, reject) => {
  const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
});

const tableNames = (db) =>
  all(db, `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).then(rows => rows.map(r => r.name));

describe('ordered migrations on an empty database', () => {
  let db;
  beforeEach(async () => { db = await emptyDb(); });

  it('creates the ledger and both reference tables', async () => {
    const applied = await runMigrations(db);
    expect(applied).toEqual(['001-reference-layers']);

    const names = await tableNames(db);
    expect(names).toContain('schema_migrations');
    expect(names).toContain('reference_assets');
    expect(names).toContain('reference_layers');

    expect(await get(db, 'SELECT COUNT(*) AS c FROM reference_layers')).toEqual({ c: 0 });
    expect(await get(db, 'SELECT COUNT(*) AS c FROM reference_assets')).toEqual({ c: 0 });
  });

  it('records each applied migration once and applies nothing on a second startup', async () => {
    await runMigrations(db);
    const second = await runMigrations(db);
    expect(second).toEqual([]);

    const ledger = await all(db, 'SELECT name FROM schema_migrations ORDER BY name');
    expect(ledger.map(r => r.name)).toEqual(MIGRATIONS.map(m => m.name));
  });

  it('leaves no ledger row and no half-built schema when a migration fails', async () => {
    const broken = { name: 'test-broken', up: ({ run: r }) => r('CREATE TABLE broken_marker (id INTEGER)').then(() => r('THIS IS NOT SQL')) };
    await expect(runMigrations(db, [broken])).rejects.toThrow();

    expect(await tableNames(db)).not.toContain('broken_marker');
    expect(await all(db, 'SELECT name FROM schema_migrations')).toEqual([]);
  });
});

describe('migration against a representative pre-feature database', () => {
  let db;

  // `makeTestDb` already runs the migration list, which is the realistic case: an
  // inherited CITY_NET schema plus rows, brought forward.
  beforeEach(async () => {
    db = await makeTestDb();
  });

  it('preserves existing inherited rows', async () => {
    await run(db, `INSERT INTO locations (name, x, y, z) VALUES (?, ?, ?, ?)`, ['Tower', 1, 2, 3]);
    await run(db, `INSERT INTO roads (x1, z1, x2, z2, width) VALUES (0, 0, 10, 10, 4)`);
    await run(db, `INSERT INTO water_bodies (points_json) VALUES ('[]')`);
    await run(db, `INSERT INTO districts (name, color) VALUES ('Talos', '#fff')`);

    const applied = await runMigrations(db);
    expect(applied).toEqual([]);

    expect((await get(db, 'SELECT COUNT(*) AS c FROM locations')).c).toBe(1);
    expect((await get(db, 'SELECT COUNT(*) AS c FROM roads')).c).toBe(1);
    expect((await get(db, 'SELECT COUNT(*) AS c FROM water_bodies')).c).toBe(1);
    expect((await get(db, 'SELECT COUNT(*) AS c FROM districts')).c).toBe(1);
  });

  it('infers no reference layers from inherited content', async () => {
    await run(db, `INSERT INTO locations (name, x, y, z) VALUES ('Arena', 0, 0, 0)`);
    await run(db, `INSERT INTO signs (text, x, y, z, image_url) VALUES ('WELCOME', 0, 0, 0, '/uploads/signs/a.png')`);
    expect((await get(db, 'SELECT COUNT(*) AS c FROM reference_layers')).c).toBe(0);
    expect((await get(db, 'SELECT COUNT(*) AS c FROM reference_assets')).c).toBe(0);
  });
});

describe('reference-layer schema constraints', () => {
  let db;
  const seedAsset = () => run(db, `INSERT INTO reference_assets
    (content_hash, asset_url, original_name, format, source_width_px, source_height_px)
    VALUES ('abc', '/uploads/reference_layers/abc.png', 'city.png', 'png', 6032, 4584)`);

  beforeEach(async () => { db = await makeTestDb(); });

  it('enforces a unique content hash', async () => {
    await seedAsset();
    await expect(seedAsset()).rejects.toThrow(/UNIQUE/i);
  });

  it('rejects a format outside the png/jpeg vocabulary', async () => {
    await expect(run(db, `INSERT INTO reference_assets
      (content_hash, asset_url, format, source_width_px, source_height_px)
      VALUES ('d', '/uploads/reference_layers/d.tif', 'tiff', 10, 10)`)).rejects.toThrow(/CHECK/i);
  });

  it('rejects non-positive source dimensions', async () => {
    await expect(run(db, `INSERT INTO reference_assets
      (content_hash, asset_url, format, source_width_px, source_height_px)
      VALUES ('e', '/uploads/reference_layers/e.png', 'png', 0, 10)`)).rejects.toThrow(/CHECK/i);
  });

  it('rejects out-of-range opacity and non-positive scale', async () => {
    await seedAsset();
    await expect(run(db, `INSERT INTO reference_layers (name, asset_id, world_units_per_pixel, opacity)
      VALUES ('L', 1, 1, 1.5)`)).rejects.toThrow(/CHECK/i);
    await expect(run(db, `INSERT INTO reference_layers (name, asset_id, world_units_per_pixel)
      VALUES ('L', 1, 0)`)).rejects.toThrow(/CHECK/i);
  });

  it('defaults a new layer to visible, unlocked, imported and non-replaceable', async () => {
    await seedAsset();
    await run(db, `INSERT INTO reference_layers (name, asset_id, world_units_per_pixel) VALUES ('Imperial City', 1, 0.5)`);
    const row = await get(db, 'SELECT * FROM reference_layers WHERE id = 1');
    expect(row).toMatchObject({
      name: 'Imperial City',
      asset_id: 1,
      world_center_x: 0,
      world_center_z: 0,
      world_units_per_pixel: 0.5,
      rotation_rad: 0,
      opacity: 1,
      is_visible: 1,
      is_locked: 0,
      provenance: 'imported',
      replacement_state: 'non_replaceable',
    });
  });
});
