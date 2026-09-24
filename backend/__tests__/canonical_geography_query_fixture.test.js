/**
 * The shared query fixture (plan §10: "the same JSON fixtures copied into each package's
 * tests").
 *
 * `fixtures/canonical_query_bundles.v1.json` holds real bundles for the synthetic
 * archipelago plus hand-derived probe expectations. This test pins the backend to it: the
 * live query must return exactly those bundles. The frontend keeps a byte-identical copy
 * and runs the same probes through its `CanonicalConstraints` adapter, so a change to the
 * wire format fails here until the fixture is regenerated and recopied.
 *
 * Regenerate deliberately with UPDATE_CANONICAL_FIXTURE=1, then copy the file to
 * frontend/src/modules/canonicalGeography/__tests__/fixtures/.
 */

import { it, expect } from 'vitest';
import { createRequire } from 'module';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const require_ = createRequire(import.meta.url);
const { setupCanonical } = require_('./helpers/canonicalApi.js');
const { buildArchipelago, CITY } = require_('./helpers/canonicalArchipelago.js');

const FIXTURE = join(__dirname, 'fixtures', 'canonical_query_bundles.v1.json');

// Expected answers under plan §4.2, stated by hand from the archipelago's layout.
const PROBES = {
  city: {
    classify: [
      { x: 10, z: 10, expect: 'land', why: 'Isle A, away from the canal' },
      { x: 50, z: 50, expect: 'water', why: 'the canal: explicit water wins over land' },
      { x: 125, z: 50, expect: 'water', why: 'the basin' },
      { x: 125, z: 95, expect: 'unknown', why: 'between islands; city coverage is partial' },
      { x: 450, z: 50, expect: 'land', why: 'Isle C' },
    ],
    protected: [
      { x: 170, z: 70, expect: true },
      { x: 10, z: 10, expect: false },
    ],
    footprints: [
      { rect: { x: 10, z: 80, width: 4, depth: 4 }, expect: [] },
      { rect: { x: 170, z: 70, width: 4, depth: 4 }, expect: ['protected'] },
      { rect: { x: 20, z: 20, width: 2, depth: 2 }, expect: ['anchor_part'] },
      { rect: { x: 125, z: 60, width: 2, depth: 2 }, expect: ['off_land', 'in_water'] },
      { rect: { x: 125, z: 91, width: 2, depth: 2 }, expect: ['off_land', 'unknown_ground', 'hard_route'] },
    ],
  },
  east: {
    classify: [
      { x: 450, z: 50, expect: 'land', why: 'Isle C' },
      { x: 520, z: 50, expect: 'water', why: 'inside east, off land: coverage is complete' },
      { x: 600, z: 50, expect: 'unknown', why: 'outside the east extent' },
    ],
  },
  islandA: {
    classify: [
      { x: 10, z: 10, expect: 'land' },
      { x: 50, z: 50, expect: 'water' },
      { x: 125, z: 50, expect: 'water', why: 'the basin, as halo context' },
      { x: 125, z: 95, expect: 'unknown' },
    ],
  },
};

it('the live query returns exactly the shared fixture bundles', async () => {
  const { api } = await setupCanonical();
  const ids = await buildArchipelago(api);
  const requests = {
    city: { scope_id: CITY },
    east: { scope_id: ids.east, halo_wu: 25 },
    islandA: { feature_id: ids.islandA, halo_wu: 60 },
  };
  const bundles = {};
  for (const [name, body] of Object.entries(requests)) {
    bundles[name] = api.expectStatus(await api.anon.post('/query', body), 200, name);
  }
  const current = { format: 'ruby_wheel.canonical_query_fixture', version: 1, ids, requests, bundles, probes: PROBES };

  if (process.env.UPDATE_CANONICAL_FIXTURE === '1') {
    writeFileSync(FIXTURE, `${JSON.stringify(current, null, 2)}\n`);
  }
  expect(JSON.parse(readFileSync(FIXTURE, 'utf8'))).toEqual(current);
});
