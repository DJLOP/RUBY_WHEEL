/**
 * The query never reads raster evidence (plan §5.3, §6.7; A-015).
 *
 * Reference layers are calibrated evidence. Generators see canonical geography only as the
 * accepted, normalized bundle — so no canonical-geography module may read reference-layer
 * tables, assets or pixels, and a bundle must be identical whether or not any reference
 * layer (or its table) exists.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const require_ = createRequire(import.meta.url);
const { setupCanonical } = require_('./helpers/canonicalApi.js');
const { buildArchipelago, CITY } = require_('./helpers/canonicalArchipelago.js');
const { run } = require_('./helpers/testDb.js');

const MODULE_DIR = join(__dirname, '..', 'canonicalGeography');

describe('canonical geography does not depend on raster evidence', () => {
  const sources = readdirSync(MODULE_DIR).filter(f => f.endsWith('.js'))
    .map(f => [f, readFileSync(join(MODULE_DIR, f), 'utf8')]);

  it('has the query module among the sources checked', () => {
    expect(sources.map(([f]) => f)).toContain('query.js');
  });

  it.each(sources.map(([f]) => f))('%s names no reference-layer table and loads no raster module', (file) => {
    const src = sources.find(([f]) => f === file)[1];
    expect(src).not.toMatch(/\b(FROM|JOIN|INTO|UPDATE|TABLE)\s+reference_/i);
    expect(src).not.toMatch(/require\([^)]*(reference|uploads|image-size)[^)]*\)/i);
    expect(src).not.toMatch(/require\(['"](fs|path)['"]\)/);
  });

  it('answers identically with the reference-layer tables gone', async () => {
    const { api, db } = await setupCanonical();
    const ids = await buildArchipelago(api);
    const bodies = [{ scope_id: CITY }, { feature_id: ids.islandA, halo_wu: 60 }];
    const before = [];
    for (const b of bodies) before.push((await api.anon.post('/query', b)).body);
    await run(db, 'DROP TABLE reference_layers');
    await run(db, 'DROP TABLE reference_assets');
    for (let i = 0; i < bodies.length; i++) {
      const res = await api.anon.post('/query', bodies[i]);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(before[i]);
    }
  });
});
