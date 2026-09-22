/**
 * The boundary between legacy saved maps and canonical reference layers.
 *
 * A saved map is not a snapshot of the world. It captures six tables, loses fields on the
 * round trip, and its load and clear are destructive: they delete locations, districts,
 * roads, overpasses, water and signs outright. That behaviour is inherited and is not this
 * feature's to repair.
 *
 * What this pins is that reference layers are not in its path. They are canonical data
 * with their own storage and their own uploaded files, and a legacy load or clear must
 * leave them exactly as they were — someone restoring last week's road layout has not
 * asked to lose the drawing the whole city is being traced from, and the images are not in
 * the saved row to restore even if they had.
 *
 * The other half of the same boundary: a saved map must not *claim* them either. Putting
 * reference-layer rows into `saved_maps` would present an in-database save as a backup of
 * files that live outside the database entirely, which is the more expensive mistake —
 * it is only discovered when somebody needs the backup.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { makeTestDb, get, all, run } from './helpers/testDb.js';
import mapsRouteFactory from '../routes/maps.js';
import referenceLayersFactory from '../routes/reference_layers.js';

process.env.JWT_SECRET = 'test-secret';

const ADMIN_TOKEN = jwt.sign(
  { id: 1, username: 'testadmin', role: 'admin', isTemporary: false },
  'test-secret'
);

let db;
let app;
let emitUpdate;

beforeEach(async () => {
  db = await makeTestDb();
  emitUpdate = vi.fn();
  app = express();
  app.use(express.json());
  const io = { emit: () => {} };
  app.use('/api/maps', mapsRouteFactory(db, io, { emitUpdate, recordAction: () => {} }));
  app.use('/api/reference-layers', referenceLayersFactory(db, io, { emitUpdate }));
});

const asAdmin = (req) => req.set('Authorization', `Bearer ${ADMIN_TOKEN}`);

/** An asset row and a layer on it, without going through an upload. */
const seedLayer = async (over = {}) => {
  const asset = await run(db, `INSERT INTO reference_assets
    (content_hash, asset_url, original_name, format, source_width_px, source_height_px)
    VALUES (?, ?, ?, 'png', 6032, 4584)`,
    [over.content_hash ?? 'hash-a', over.asset_url ?? '/uploads/reference_layers/a.png', 'imperial.png']);

  const layer = await run(db, `INSERT INTO reference_layers
    (name, asset_id, world_center_x, world_center_z, world_units_per_pixel, rotation_rad, opacity, is_visible, is_locked, provenance, replacement_state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'imported', 'non_replaceable')`,
    [over.name ?? 'Imperial City', asset.lastID,
     over.world_center_x ?? -412.5, over.world_center_z ?? 963,
     over.world_units_per_pixel ?? 0.37, over.rotation_rad ?? 0.91,
     over.opacity ?? 0.65, over.is_visible ?? 1, over.is_locked ?? 0]);

  return { layerId: layer.lastID, assetId: asset.lastID };
};

/** The inherited world content that a legacy load or clear is entitled to destroy. */
const seedInheritedWorld = async () => {
  await run(db, `INSERT INTO locations (name, x, y, z, shape) VALUES ('Yakuza HQ', 1, 0, 2, 'box')`);
  await run(db, `INSERT INTO districts (name, color) VALUES ('Talos', '#ffffff')`);
  await run(db, `INSERT INTO roads (x1, z1, x2, z2, width) VALUES (0, 0, 10, 10, 4)`);
  await run(db, `INSERT INTO water_bodies (points_json) VALUES ('[]')`);
  await run(db, `INSERT INTO signs (text, x, y, z) VALUES ('DOCKS', 0, 0, 0)`);
};

const seedSavedMap = (name) => run(db,
  `INSERT INTO saved_maps (name, locations_data, districts_data, roads_data, overpasses_data, water_bodies_data, signs_data)
   VALUES (?, '[]', '[]', '[]', '[]', '[]', '[]')`, [name]);

const layerRows = () => all(db, 'SELECT * FROM reference_layers ORDER BY id');
const assetRows = () => all(db, 'SELECT * FROM reference_assets ORDER BY id');

// ─── load ────────────────────────────────────────────────────────────────────

describe('POST /api/maps/load/:name', () => {
  it('leaves reference layers and their assets exactly as they were', async () => {
    await seedLayer();
    await seedInheritedWorld();
    await seedSavedMap('city_base');

    const before = { layers: await layerRows(), assets: await assetRows() };

    const res = await asAdmin(request(app).post('/api/maps/load/city_base'));
    expect(res.status).toBe(200);

    expect(await layerRows()).toEqual(before.layers);
    expect(await assetRows()).toEqual(before.assets);
  });

  it('preserves every calibration and display field, not merely the row', async () => {
    const { layerId } = await seedLayer({
      name: 'Traced Sheet', world_center_x: -412.5, world_center_z: 963,
      world_units_per_pixel: 0.37, rotation_rad: 0.91, opacity: 0.65,
      is_visible: 0, is_locked: 1,
    });
    await seedSavedMap('city_base');

    await asAdmin(request(app).post('/api/maps/load/city_base'));

    expect(await get(db, 'SELECT * FROM reference_layers WHERE id = ?', [layerId])).toMatchObject({
      name: 'Traced Sheet',
      world_center_x: -412.5,
      world_center_z: 963,
      world_units_per_pixel: 0.37,
      rotation_rad: 0.91,
      opacity: 0.65,
      is_visible: 0,
      is_locked: 1,
      provenance: 'imported',
      replacement_state: 'non_replaceable',
    });
  });

  // The destructive half still has to work: this is a boundary, not a blanket exemption.
  it('still clears the inherited world content it is supposed to clear', async () => {
    await seedLayer();
    await seedInheritedWorld();
    await seedSavedMap('city_base');

    await asAdmin(request(app).post('/api/maps/load/city_base'));

    for (const table of ['locations', 'districts', 'roads', 'water_bodies', 'signs']) {
      expect((await all(db, `SELECT * FROM ${table}`)).length, table).toBe(0);
    }
    expect(await layerRows()).toHaveLength(1);
  });

  it('keeps the layers readable through their own API afterwards', async () => {
    await seedLayer({ name: 'Imperial City' });
    await seedSavedMap('city_base');

    await asAdmin(request(app).post('/api/maps/load/city_base'));

    const res = await request(app).get('/api/reference-layers');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ name: 'Imperial City', source_width_px: 6032, asset_url: '/uploads/reference_layers/a.png' });
  });

  it('leaves several layers sharing one asset intact', async () => {
    const { assetId } = await seedLayer({ name: 'North' });
    await run(db, `INSERT INTO reference_layers (name, asset_id, world_units_per_pixel) VALUES ('South', ?, 1)`, [assetId]);
    await seedSavedMap('city_base');

    await asAdmin(request(app).post('/api/maps/load/city_base'));

    expect((await layerRows()).map(r => r.name)).toEqual(['North', 'South']);
    expect(await assetRows()).toHaveLength(1);
  });
});

// ─── clear ───────────────────────────────────────────────────────────────────

describe('POST /api/maps/clear', () => {
  it('leaves reference layers and their assets exactly as they were', async () => {
    await seedLayer();
    await seedInheritedWorld();
    const before = { layers: await layerRows(), assets: await assetRows() };

    const res = await asAdmin(request(app).post('/api/maps/clear'));
    expect(res.status).toBe(200);

    expect(await layerRows()).toEqual(before.layers);
    expect(await assetRows()).toEqual(before.assets);
  });

  it('still wipes the inherited world content', async () => {
    await seedLayer();
    await seedInheritedWorld();

    await asAdmin(request(app).post('/api/maps/clear'));

    for (const table of ['locations', 'districts', 'roads', 'water_bodies', 'signs']) {
      expect((await all(db, `SELECT * FROM ${table}`)).length, table).toBe(0);
    }
    expect(await layerRows()).toHaveLength(1);
  });

  it('leaves a locked layer locked rather than treating the wipe as authorization', async () => {
    const { layerId } = await seedLayer({ is_locked: 1 });
    await asAdmin(request(app).post('/api/maps/clear'));
    expect((await get(db, 'SELECT is_locked FROM reference_layers WHERE id = ?', [layerId])).is_locked).toBe(1);
  });
});

// ─── save ────────────────────────────────────────────────────────────────────

describe('POST /api/maps/save', () => {
  // A saved row is in the database; the rasters are files on disk beside it. Writing
  // layer metadata in here would make an in-database save look like a backup of files it
  // cannot restore, which is only discovered when somebody needs the backup.
  it('does not capture reference layers into the saved row', async () => {
    await seedLayer();
    await seedInheritedWorld();

    const res = await asAdmin(request(app).post('/api/maps/save')).send({ name: 'snapshot' });
    expect(res.status).toBe(200);

    const row = await get(db, 'SELECT * FROM saved_maps WHERE name = ?', ['snapshot']);
    expect(row).toBeTruthy();
    for (const [column, value] of Object.entries(row)) {
      if (typeof value !== 'string') continue;
      expect(value, column).not.toMatch(/reference_layer|Imperial City|imperial\.png/i);
    }
    expect(Object.keys(row)).not.toContain('reference_layers_data');
  });

  it('leaves the layers untouched while saving', async () => {
    await seedLayer();
    const before = await layerRows();
    await asAdmin(request(app).post('/api/maps/save')).send({ name: 'snapshot' });
    expect(await layerRows()).toEqual(before);
  });
});
