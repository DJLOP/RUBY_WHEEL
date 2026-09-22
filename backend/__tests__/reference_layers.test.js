/**
 * The reference-layer API.
 *
 * Two things are load-bearing here and both are tested by going around the UI rather than
 * through it: only the primary administrator may change the canonical world, and a locked
 * layer stays where it is. A disabled button proves neither — the request it would have
 * sent can still be sent by hand, which is exactly what these do.
 *
 * The third is that a file's format and dimensions come from its bytes. Every fixture is
 * genuinely the format it claims to be, so the "disguised file" cases are real.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { makeTestDb, get, all, run } from './helpers/testDb.js';
import referenceLayersFactory from '../routes/reference_layers.js';

const require_ = createRequire(import.meta.url);
const { makePng, makeJpeg, makeGif, makeGarbage } = require_('./helpers/rasterFixtures.js');
const { elevatedUsers } = require_('../middleware/auth.js');
const { LIMITS } = require_('../middleware/uploadConstraints.js');

process.env.JWT_SECRET = 'test-secret';

const uploadsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../uploads/reference_layers');
const tmpDir = path.join(uploadsDir, '.tmp');

const sign = (payload) => jwt.sign(payload, 'test-secret');
const ADMIN = sign({ id: 1, username: 'admin', role: 'admin', isTemporary: false });
const PLAYER = sign({ username: 'runner', role: 'player', isTemporary: false });
const TEMP_ADMIN = sign({ username: 'guest_admin', role: 'admin', isTemporary: true });

let db;
let app;
let emitUpdate;

const listDir = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
let filesBefore = [];

beforeEach(async () => {
  db = await makeTestDb();
  emitUpdate = vi.fn();
  app = express();
  app.use('/api/reference-layers', referenceLayersFactory(db, { emit: () => {} }, { emitUpdate }));
  filesBefore = listDir(uploadsDir);
});

// Uploads are real disk writes, as they are in the battle-map tests. Anything this run
// added is removed again; anything that was already there is left alone.
afterEach(() => {
  for (const name of listDir(uploadsDir)) {
    if (name === '.tmp' || filesBefore.includes(name)) continue;
    try { fs.unlinkSync(path.join(uploadsDir, name)); } catch { /* already gone */ }
  }
});

const asAdmin = (req) => req.set('Authorization', `Bearer ${ADMIN}`);

/** Upload a raster and create a layer from it, returning the response. */
const uploadLayer = (buffer, filename, fields = {}) => {
  let req = asAdmin(request(app).post('/api/reference-layers/upload'));
  for (const [k, v] of Object.entries({ name: 'Imperial City', ...fields })) req = req.field(k, String(v));
  return req.attach('image', buffer, filename);
};

/** Seed an asset row plus a layer without going through the upload path. */
const seedLayer = async (overrides = {}) => {
  const assetId = overrides.asset_id ?? (await run(db, `INSERT INTO reference_assets
    (content_hash, asset_url, original_name, format, source_width_px, source_height_px)
    VALUES (?, ?, ?, ?, ?, ?)`,
    [overrides.content_hash ?? 'seed-hash', overrides.asset_url ?? '/uploads/reference_layers/seed.png',
     'seed.png', 'png', 6032, 4584])).lastID;

  const res = await run(db, `INSERT INTO reference_layers
    (name, asset_id, world_center_x, world_center_z, world_units_per_pixel, rotation_rad, opacity, is_visible, is_locked, provenance, replacement_state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'imported', 'non_replaceable')`,
    [overrides.name ?? 'Seeded', assetId,
     overrides.world_center_x ?? 0, overrides.world_center_z ?? 0,
     overrides.world_units_per_pixel ?? 1, overrides.rotation_rad ?? 0,
     overrides.opacity ?? 1, overrides.is_visible ?? 1, overrides.is_locked ?? 0]);
  return { layerId: res.lastID, assetId };
};

// ─── GET / ───────────────────────────────────────────────────────────────────

describe('GET /api/reference-layers', () => {
  it('is readable without credentials and starts empty', async () => {
    const res = await request(app).get('/api/reference-layers');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns layers in id order with booleans and numbers as JSON types', async () => {
    await seedLayer({ name: 'First', opacity: 0.25, is_visible: 0, is_locked: 1, world_units_per_pixel: 0.5 });
    await seedLayer({ name: 'Second', content_hash: 'second', asset_url: '/uploads/reference_layers/second.jpg' });

    const res = await request(app).get('/api/reference-layers');
    expect(res.status).toBe(200);
    expect(res.body.map(l => l.name)).toEqual(['First', 'Second']);

    const first = res.body[0];
    expect(first.is_visible).toBe(false);
    expect(first.is_locked).toBe(true);
    expect(typeof first.opacity).toBe('number');
    expect(first.opacity).toBe(0.25);
    expect(first.world_units_per_pixel).toBe(0.5);
    expect(first.source_width_px).toBe(6032);
    expect(first.source_height_px).toBe(4584);
    expect(first.provenance).toBe('imported');
    expect(first.replacement_state).toBe('non_replaceable');
    expect(first.asset_url).toBe('/uploads/reference_layers/seed.png');
  });
});

// ─── authorization ───────────────────────────────────────────────────────────

describe('authorization on the world-editing surface', () => {
  const writes = (id) => [
    ['post', '/api/reference-layers'],
    ['post', '/api/reference-layers/upload'],
    ['patch', `/api/reference-layers/${id}`],
    ['delete', `/api/reference-layers/${id}`],
  ];

  it('refuses every write without a token', async () => {
    const { layerId } = await seedLayer();
    for (const [method, url] of writes(layerId)) {
      const res = await request(app)[method](url);
      expect(res.status, `${method} ${url}`).toBe(401);
    }
    expect(emitUpdate).not.toHaveBeenCalled();
  });

  it('refuses every write from a player', async () => {
    const { layerId } = await seedLayer();
    for (const [method, url] of writes(layerId)) {
      const res = await request(app)[method](url).set('Authorization', `Bearer ${PLAYER}`);
      expect(res.status, `${method} ${url}`).toBe(403);
    }
  });

  it('refuses every write from an elevated temporary admin', async () => {
    elevatedUsers.add('guest_admin');
    try {
      const { layerId } = await seedLayer();
      for (const [method, url] of writes(layerId)) {
        const res = await request(app)[method](url).set('Authorization', `Bearer ${TEMP_ADMIN}`);
        expect(res.status, `${method} ${url}`).toBe(403);
      }
    } finally {
      elevatedUsers.delete('guest_admin');
    }
  });

  it('keeps the asset inventory to the primary administrator', async () => {
    expect((await request(app).get('/api/reference-layers/assets')).status).toBe(401);
    expect((await request(app).get('/api/reference-layers/assets').set('Authorization', `Bearer ${PLAYER}`)).status).toBe(403);
    expect((await asAdmin(request(app).get('/api/reference-layers/assets'))).status).toBe(200);
  });

  it('leaves the database untouched when a write is refused', async () => {
    const { layerId } = await seedLayer({ name: 'Untouched' });
    await request(app).patch(`/api/reference-layers/${layerId}`).send({ name: 'Renamed' });
    const row = await get(db, 'SELECT name FROM reference_layers WHERE id = ?', [layerId]);
    expect(row.name).toBe('Untouched');
  });
});

// ─── POST /upload ────────────────────────────────────────────────────────────

describe('POST /api/reference-layers/upload', () => {
  it('accepts a PNG and takes its dimensions from the bytes', async () => {
    const res = await uploadLayer(makePng(64, 32), 'city.png', { world_units_per_pixel: 0.5 });
    expect(res.status).toBe(201);
    expect(res.body.format).toBe('png');
    expect(res.body.source_width_px).toBe(64);
    expect(res.body.source_height_px).toBe(32);
    expect(res.body.asset_url).toMatch(/^\/uploads\/reference_layers\/[0-9a-f]{64}\.png$/);
    expect(res.body.world_units_per_pixel).toBe(0.5);
    expect(fs.existsSync(path.join(uploadsDir, path.basename(res.body.asset_url)))).toBe(true);
    expect(emitUpdate).toHaveBeenCalledTimes(1);
  });

  it('accepts a JPEG and stores it under the canonical .jpg extension', async () => {
    const res = await uploadLayer(makeJpeg(200, 100), 'plan.jpeg');
    expect(res.status).toBe(201);
    expect(res.body.format).toBe('jpeg');
    expect(res.body.asset_url).toMatch(/\.jpg$/);
    expect(res.body.source_width_px).toBe(200);
  });

  // The uploader controls the filename, so it cannot be allowed to control the stored
  // type: a JPEG written as `.png` would be served with the wrong content type.
  it('believes the bytes over the filename for a disguised raster', async () => {
    const res = await uploadLayer(makeJpeg(40, 20), 'actually_a_jpeg.png');
    expect(res.status).toBe(201);
    expect(res.body.format).toBe('jpeg');
    expect(res.body.asset_url).toMatch(/\.jpg$/);
  });

  it('rejects a real raster in an unsupported format however it is named', async () => {
    const res = await uploadLayer(makeGif(10, 10), 'looks_fine.png');
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('UNSUPPORTED_FORMAT');
    expect(await all(db, 'SELECT * FROM reference_assets')).toEqual([]);
    expect(emitUpdate).not.toHaveBeenCalled();
  });

  it('rejects corrupt bytes', async () => {
    const res = await uploadLayer(makeGarbage(), 'broken.png');
    expect(res.status).toBe(400);
    expect(await all(db, 'SELECT * FROM reference_layers')).toEqual([]);
  });

  it('leaves no temporary file behind when an upload is rejected', async () => {
    const before = listDir(tmpDir).length;
    await uploadLayer(makeGarbage(), 'broken.png');
    await uploadLayer(makePng(8, 8), 'ok.png', { name: '' });
    expect(listDir(tmpDir).length).toBe(before);
  });

  it('leaves no temporary file behind when an upload succeeds', async () => {
    const before = listDir(tmpDir).length;
    const res = await uploadLayer(makePng(8, 8), 'ok.png');
    expect(res.status).toBe(201);
    expect(listDir(tmpDir).length).toBe(before);
  });

  it('deduplicates identical bytes to one asset and one file', async () => {
    const bytes = makePng(48, 24);
    const first = await uploadLayer(bytes, 'a.png', { name: 'North sheet' });
    const second = await uploadLayer(bytes, 'b.png', { name: 'South sheet' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.asset_id).toBe(first.body.asset_id);
    expect(second.body.id).not.toBe(first.body.id);
    expect((await all(db, 'SELECT * FROM reference_assets')).length).toBe(1);
  });

  it('keeps the first upload\'s verified metadata authoritative for a duplicate', async () => {
    const bytes = makePng(48, 24);
    await uploadLayer(bytes, 'a.png');
    const second = await uploadLayer(bytes, 'b.png', { source_width_px: 9999 });
    // The claim is refused outright rather than quietly ignored.
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/cannot be changed/i);
  });

  it('validates calibration before storing anything', async () => {
    const cases = [
      { world_units_per_pixel: 0, match: /greater than zero/i },
      { world_units_per_pixel: 'NaN', match: /finite/i },
      { world_center_x: 'Infinity', match: /finite/i },
      { opacity: 1.5, match: /between 0 and 1/i },
      { name: '   ', match: /name is required/i },
      { name: 'x'.repeat(121), match: /120 characters/i },
    ];
    for (const { match, ...fields } of cases) {
      const res = await uploadLayer(makePng(8, 8), 'x.png', fields);
      expect(res.status, JSON.stringify(fields)).toBe(400);
      expect(res.body.error).toMatch(match);
    }
    expect(await all(db, 'SELECT * FROM reference_assets')).toEqual([]);
  });

  it('applies documented defaults when only a name and source are given', async () => {
    const res = await uploadLayer(makePng(8, 8), 'x.png');
    expect(res.body).toMatchObject({
      world_center_x: 0, world_center_z: 0, world_units_per_pixel: 1, rotation_rad: 0,
      opacity: 1, is_visible: true, is_locked: false,
      provenance: 'imported', replacement_state: 'non_replaceable',
    });
  });

  it('requires a file', async () => {
    const res = await asAdmin(request(app).post('/api/reference-layers/upload')).field('name', 'No file');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/image file is required/i);
  });
});

describe('upload size limit', () => {
  it('names a ceiling clients can show', () => {
    expect(LIMITS.reference_layer).toBe(250 * 1024 * 1024);
  });
});

// ─── POST / (from an existing asset) ─────────────────────────────────────────

describe('POST /api/reference-layers', () => {
  it('creates a second layer from an asset already uploaded', async () => {
    const first = await uploadLayer(makePng(30, 15), 'a.png', { name: 'Sheet A' });
    const res = await asAdmin(request(app).post('/api/reference-layers'))
      .send({ name: 'Sheet B', asset_id: first.body.asset_id, world_center_x: 12, rotation_rad: 1 });

    expect(res.status).toBe(201);
    expect(res.body.asset_id).toBe(first.body.asset_id);
    expect(res.body.source_width_px).toBe(30);
    expect(res.body.world_center_x).toBe(12);
    expect(res.body.rotation_rad).toBe(1);
  });

  it('refuses an unknown asset id', async () => {
    const res = await asAdmin(request(app).post('/api/reference-layers')).send({ name: 'Ghost', asset_id: 4242 });
    expect(res.status).toBe(404);
    expect(await all(db, 'SELECT * FROM reference_layers')).toEqual([]);
    expect(emitUpdate).not.toHaveBeenCalled();
  });

  it('requires an asset id', async () => {
    const res = await asAdmin(request(app).post('/api/reference-layers')).send({ name: 'Nowhere' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/asset_id is required/i);
  });

  it('refuses source metadata supplied by the client', async () => {
    const first = await uploadLayer(makePng(30, 15), 'a.png');
    const res = await asAdmin(request(app).post('/api/reference-layers'))
      .send({ name: 'Liar', asset_id: first.body.asset_id, source_width_px: 1 });
    expect(res.status).toBe(400);
  });
});

// ─── GET /assets ─────────────────────────────────────────────────────────────

describe('GET /api/reference-layers/assets', () => {
  it('lists asset rows with their server-verified metadata', async () => {
    await uploadLayer(makePng(64, 32), 'a.png');
    const res = await asAdmin(request(app).get('/api/reference-layers/assets'));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ format: 'png', source_width_px: 64, source_height_px: 32 });
  });

  // The table is the record of what exists. A file with no row is an orphan, and offering
  // it would turn a leftover from a failed run into something a person can build on.
  it('ignores files on disk that have no asset row', async () => {
    const strayName = `stray_${Date.now()}.png`;
    fs.writeFileSync(path.join(uploadsDir, strayName), makePng(4, 4));
    try {
      const res = await asAdmin(request(app).get('/api/reference-layers/assets'));
      expect(res.body).toEqual([]);
    } finally {
      try { fs.unlinkSync(path.join(uploadsDir, strayName)); } catch { /* already gone */ }
    }
  });
});

// ─── PATCH ───────────────────────────────────────────────────────────────────

describe('PATCH /api/reference-layers/:id', () => {
  it('updates only the fields supplied', async () => {
    const { layerId } = await seedLayer({ name: 'Before', world_center_x: 5, opacity: 1 });
    const res = await asAdmin(request(app).patch(`/api/reference-layers/${layerId}`))
      .send({ name: 'After', opacity: 0.4 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'After', opacity: 0.4, world_center_x: 5 });
    expect(emitUpdate).toHaveBeenCalledTimes(1);
  });

  it('accepts a full calibration change', async () => {
    const { layerId } = await seedLayer();
    const res = await asAdmin(request(app).patch(`/api/reference-layers/${layerId}`))
      .send({ world_center_x: -120.5, world_center_z: 88, world_units_per_pixel: 0.25, rotation_rad: Math.PI / 2 });
    expect(res.status).toBe(200);
    expect(res.body.world_center_x).toBe(-120.5);
    expect(res.body.world_units_per_pixel).toBe(0.25);
    expect(res.body.rotation_rad).toBeCloseTo(Math.PI / 2, 10);
  });

  it('rejects invalid values without writing', async () => {
    const { layerId } = await seedLayer({ opacity: 0.8 });
    const res = await asAdmin(request(app).patch(`/api/reference-layers/${layerId}`)).send({ opacity: 2 });
    expect(res.status).toBe(400);
    expect((await get(db, 'SELECT opacity FROM reference_layers WHERE id = ?', [layerId])).opacity).toBe(0.8);
    expect(emitUpdate).not.toHaveBeenCalled();
  });

  it('rejects a body with nothing editable in it', async () => {
    const { layerId } = await seedLayer();
    const res = await asAdmin(request(app).patch(`/api/reference-layers/${layerId}`)).send({ nonsense: 1 });
    expect(res.status).toBe(400);
  });

  it('refuses to repoint a layer at another source', async () => {
    const { layerId } = await seedLayer();
    const res = await asAdmin(request(app).patch(`/api/reference-layers/${layerId}`)).send({ asset_id: 2 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/create a new layer/i);
  });

  it('refuses to rewrite source dimensions', async () => {
    const { layerId } = await seedLayer();
    const res = await asAdmin(request(app).patch(`/api/reference-layers/${layerId}`)).send({ source_width_px: 10 });
    expect(res.status).toBe(400);
  });

  it('404s for a layer that does not exist', async () => {
    const res = await asAdmin(request(app).patch('/api/reference-layers/9999')).send({ opacity: 0.5 });
    expect(res.status).toBe(404);
    expect(emitUpdate).not.toHaveBeenCalled();
  });
});

// ─── locking ─────────────────────────────────────────────────────────────────

describe('lock semantics, enforced without the browser', () => {
  it('refuses calibration and name changes on a locked layer', async () => {
    const { layerId } = await seedLayer({ is_locked: 1, world_center_x: 7, name: 'Locked' });
    for (const body of [{ name: 'Nope' }, { world_center_x: 1 }, { world_units_per_pixel: 2 }, { rotation_rad: 1 }, { world_center_z: 3 }]) {
      const res = await asAdmin(request(app).patch(`/api/reference-layers/${layerId}`)).send(body);
      expect(res.status, JSON.stringify(body)).toBe(409);
      expect(res.body.error).toMatch(/locked/i);
    }
    const row = await get(db, 'SELECT name, world_center_x FROM reference_layers WHERE id = ?', [layerId]);
    expect(row).toEqual({ name: 'Locked', world_center_x: 7 });
    expect(emitUpdate).not.toHaveBeenCalled();
  });

  it('still allows visibility and opacity on a locked layer', async () => {
    const { layerId } = await seedLayer({ is_locked: 1 });
    const res = await asAdmin(request(app).patch(`/api/reference-layers/${layerId}`))
      .send({ is_visible: false, opacity: 0.2 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ is_visible: false, opacity: 0.2, is_locked: true });
  });

  it('refuses deletion of a locked layer', async () => {
    const { layerId } = await seedLayer({ is_locked: 1 });
    const res = await asAdmin(request(app).delete(`/api/reference-layers/${layerId}`));
    expect(res.status).toBe(409);
    expect(await get(db, 'SELECT id FROM reference_layers WHERE id = ?', [layerId])).toBeTruthy();
  });

  // Otherwise the lock is a formality: one request would still move the layer.
  it('refuses to unlock and recalibrate in the same request', async () => {
    const { layerId } = await seedLayer({ is_locked: 1, world_center_x: 7 });
    const res = await asAdmin(request(app).patch(`/api/reference-layers/${layerId}`))
      .send({ is_locked: false, world_center_x: 999 });
    expect(res.status).toBe(409);
    const row = await get(db, 'SELECT is_locked, world_center_x FROM reference_layers WHERE id = ?', [layerId]);
    expect(row).toEqual({ is_locked: 1, world_center_x: 7 });
  });

  it('allows unlock as its own request, then the edit, then relock', async () => {
    const { layerId } = await seedLayer({ is_locked: 1 });

    const unlock = await asAdmin(request(app).patch(`/api/reference-layers/${layerId}`)).send({ is_locked: false });
    expect(unlock.status).toBe(200);
    expect(unlock.body.is_locked).toBe(false);

    const edit = await asAdmin(request(app).patch(`/api/reference-layers/${layerId}`)).send({ world_center_x: 42 });
    expect(edit.status).toBe(200);
    expect(edit.body.world_center_x).toBe(42);

    const relock = await asAdmin(request(app).patch(`/api/reference-layers/${layerId}`)).send({ is_locked: true });
    expect(relock.status).toBe(200);
    expect(relock.body).toMatchObject({ is_locked: true, world_center_x: 42 });
  });
});

// ─── DELETE ──────────────────────────────────────────────────────────────────

describe('DELETE /api/reference-layers/:id', () => {
  it('removes the layer, its asset row and its file when nothing else uses it', async () => {
    const created = await uploadLayer(makePng(16, 8), 'only.png');
    const filePath = path.join(uploadsDir, path.basename(created.body.asset_url));
    expect(fs.existsSync(filePath)).toBe(true);

    const res = await asAdmin(request(app).delete(`/api/reference-layers/${created.body.id}`));
    expect(res.status).toBe(200);
    expect(await all(db, 'SELECT * FROM reference_layers')).toEqual([]);
    expect(await all(db, 'SELECT * FROM reference_assets')).toEqual([]);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('keeps a shared asset and its file while another layer still uses it', async () => {
    const bytes = makePng(16, 8);
    const first = await uploadLayer(bytes, 'a.png', { name: 'A' });
    const second = await uploadLayer(bytes, 'b.png', { name: 'B' });
    const filePath = path.join(uploadsDir, path.basename(first.body.asset_url));

    const res = await asAdmin(request(app).delete(`/api/reference-layers/${first.body.id}`));
    expect(res.status).toBe(200);
    expect(fs.existsSync(filePath)).toBe(true);
    expect((await all(db, 'SELECT * FROM reference_assets')).length).toBe(1);

    const remaining = await request(app).get('/api/reference-layers');
    expect(remaining.body.map(l => l.id)).toEqual([second.body.id]);
    expect(remaining.body[0].asset_url).toBe(first.body.asset_url);
  });

  // A rollback here would resurrect a layer the person deleted, which is worse than one
  // unreferenced file that nothing lists.
  it('completes the deletion even when the file cannot be removed', async () => {
    const created = await uploadLayer(makePng(16, 8), 'gone.png');
    fs.unlinkSync(path.join(uploadsDir, path.basename(created.body.asset_url)));

    const res = await asAdmin(request(app).delete(`/api/reference-layers/${created.body.id}`));
    expect(res.status).toBe(200);
    expect(await all(db, 'SELECT * FROM reference_layers')).toEqual([]);
    expect(await all(db, 'SELECT * FROM reference_assets')).toEqual([]);
  });

  it('404s for a layer that does not exist', async () => {
    const res = await asAdmin(request(app).delete('/api/reference-layers/9999'));
    expect(res.status).toBe(404);
    expect(emitUpdate).not.toHaveBeenCalled();
  });
});

// ─── realtime and world isolation ────────────────────────────────────────────

describe('update emission', () => {
  it('emits exactly once per successful mutation and never for a rejected one', async () => {
    const created = await uploadLayer(makePng(8, 8), 'a.png');
    expect(emitUpdate).toHaveBeenCalledTimes(1);

    await asAdmin(request(app).patch(`/api/reference-layers/${created.body.id}`)).send({ opacity: 0.5 });
    expect(emitUpdate).toHaveBeenCalledTimes(2);

    await asAdmin(request(app).patch(`/api/reference-layers/${created.body.id}`)).send({ opacity: 5 });
    await request(app).patch(`/api/reference-layers/${created.body.id}`).send({ opacity: 0.1 });
    expect(emitUpdate).toHaveBeenCalledTimes(2);

    await asAdmin(request(app).delete(`/api/reference-layers/${created.body.id}`));
    expect(emitUpdate).toHaveBeenCalledTimes(3);
  });
});

describe('world isolation', () => {
  // Reference imagery is an underlay, not geometry. Nothing here may become a building, a
  // road, a water polygon or an obstacle the generator has to route around.
  it('writes to no other world table', async () => {
    const created = await uploadLayer(makePng(8, 8), 'a.png');
    await asAdmin(request(app).patch(`/api/reference-layers/${created.body.id}`)).send({ world_center_x: 3 });
    await asAdmin(request(app).delete(`/api/reference-layers/${created.body.id}`));

    for (const table of ['locations', 'roads', 'water_bodies', 'districts', 'signs', 'overpasses', 'saved_maps']) {
      expect((await all(db, `SELECT * FROM ${table}`)).length, table).toBe(0);
    }
  });
});
