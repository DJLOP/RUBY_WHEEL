import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { makeTestDb, get, run } from './helpers/testDb.js';

const require_ = createRequire(import.meta.url);
const scale = require_('../canonicalGeography/physicalScale.js');
const geo = require_('../canonicalGeography/geometry.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleDir = path.join(here, '..', 'canonicalGeography');

const P = (x, z) => ({ x, z });
const square = (s) => ({ outer: [P(0, 0), P(s, 0), P(s, s), P(0, s)], holes: [] });

/** The metrics a caller would report for a known square, via the geometry and scale modules only. */
const squareMetrics = (side) => {
  const g = geo.normalizeGeometry('polygon', square(side));
  return {
    sideMeters: scale.worldUnitsToMeters(geo.linestringLength([g.outer[0], g.outer[1]])),
    perimeterMeters: scale.worldUnitsToMeters(geo.polygonPerimeter(g)),
    areaSquareMeters: scale.squareWorldUnitsToSquareMeters(geo.polygonArea(g)),
    areaHectares: scale.squareWorldUnitsToHectares(geo.polygonArea(g)),
  };
};

describe('canonical physical scale contract', () => {
  it('is 1 world unit = 1.524 metres (5 feet)', () => {
    expect(scale.METERS_PER_WORLD_UNIT).toBe(1.524);
    expect(scale.worldUnitsToMeters(1)).toBe(1.524);
    expect(scale.metersToWorldUnits(1.524)).toBeCloseTo(1, 12);
  });

  it('measures a 1,000 wu square as 1,524 m a side, 232.2576 ha', () => {
    const m = squareMetrics(1000);
    expect(m.sideMeters).toBeCloseTo(1524, 9);
    expect(m.perimeterMeters).toBeCloseTo(6096, 9);
    expect(m.areaSquareMeters).toBeCloseTo(2322576, 6);
    expect(m.areaHectares).toBeCloseTo(232.2576, 9);
  });

  it('matches the canonical exterior-wall span: 6,744 m ≈ 4,425.20 wu', () => {
    expect(scale.metersToWorldUnits(6744)).toBeCloseTo(4425.197, 3);
    expect(scale.worldUnitsToKilometers(scale.metersToWorldUnits(6744))).toBeCloseTo(6.744, 12);
  });

  it('rejects non-finite input rather than reporting NaN metres', () => {
    expect(() => scale.worldUnitsToMeters(NaN)).toThrow(TypeError);
    expect(() => scale.squareWorldUnitsToHectares('100')).toThrow(TypeError);
  });
});

describe('independence from the inherited GLOBAL MAP SCALE setting', () => {
  let db;
  beforeEach(async () => { db = await makeTestDb(); });

  it('reports identical metrics after global_settings.map_scale_multiplier changes', async () => {
    await run(db, `INSERT INTO global_settings (key, value) VALUES ('map_scale_multiplier', '5')`);
    const before = squareMetrics(1000);

    await run(db, `UPDATE global_settings SET value = '37' WHERE key = 'map_scale_multiplier'`);
    expect((await get(db, `SELECT value FROM global_settings WHERE key = 'map_scale_multiplier'`)).value).toBe('37');

    expect(squareMetrics(1000)).toEqual(before);
    expect(scale.METERS_PER_WORLD_UNIT).toBe(1.524);
  });

  it('neither module references the map-scale setting, the database or global settings', () => {
    for (const file of ['physicalScale.js', 'geometry.js']) {
      const src = fs.readFileSync(path.join(moduleDir, file), 'utf8');
      // Comments may name the setting to explain why it is ignored; code must not use it.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/map_scale|mapScale|global_settings|require\(/);
    }
  });
});
