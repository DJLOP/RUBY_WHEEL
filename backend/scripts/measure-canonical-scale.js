/**
 * WP3 synthetic-scale measurement for the canonical-geography query (plan §10, WP3 gate).
 *
 * Not a test: run by hand, and its numbers go in the WP report.
 *
 *   node scripts/measure-canonical-scale.js [outDir]
 *
 * Builds a throwaway file database with the full schema, fills it with a synthetic
 * archipelago sized to the Bible's "hundreds of islands" — 500 islands × 400 vertices,
 * 200 anchors with 600 parts, 500 routes, 300 connections (plus 50 explicit water bodies
 * and a district / island-group hierarchy) — all as accepted canon, then times the query
 * at city, district, island-group and single-island scope. Rows are inserted directly in
 * one transaction (the lifecycle path is not what is being measured); geometry still goes
 * through `normalizeGeometry`, so it is exactly what the store would hold.
 *
 * If `outDir` is given, the city and island bundles are written there for the frontend
 * adapter/render-preparation measurement (CANONICAL_SCALE_DIR=<outDir> in the frontend).
 *
 * Targets (plan §10): island query < 100 ms, city query < 1 s.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { makeTestDb, run, get } = require('../__tests__/helpers/testDb');
const { createStore } = require('../canonicalGeography/store');
const { normalizeGeometry, computeBBox } = require('../canonicalGeography/geometry');

const ISLANDS_X = 25;
const ISLANDS_Z = 20; // 500 islands
const CELL = 177; // ~4,425 wu / 25: the canonical wall span
const VERTICES = 400;
const ANCHORS = 200;
const PLACED_ANCHORS = 180; // 60 × 4 parts + 120 × 3 parts = 600 parts; 20 left unplaced
const ROUTES = 500;
const CONNECTIONS = 300;
const WATER = 50;
const DISTRICTS = 8;
const GROUPS = 40;
const RUNS = 15;

const outDir = process.argv[2] || null;

const islandCenter = (i) => ({ x: (i % ISLANDS_X) * CELL, z: Math.floor(i / ISLANDS_X) * CELL });

/** A wobbly, star-shaped, simple polygon: radius stays positive, so it never self-intersects. */
function islandPolygon(i) {
  const c = islandCenter(i);
  const outer = [];
  for (let k = 0; k < VERTICES; k++) {
    const t = (2 * Math.PI * k) / VERTICES;
    const r = 62 + 9 * Math.sin(5 * t + i) + 4 * Math.sin(13 * t + 2 * i);
    outer.push({ x: c.x + r * Math.cos(t), z: c.z + r * Math.sin(t) });
  }
  return normalizeGeometry('polygon', { outer, holes: [] });
}

const rect = (x, z, w, d) => ({ outer: [{ x, z }, { x: x + w, z }, { x: x + w, z: z + d }, { x, z: z + d }], holes: [] });

async function main() {
  const file = path.join(os.tmpdir(), `canonical-scale-${process.pid}.db`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  const db = await makeTestDb({ filename: file });
  const dbBytes = async () => {
    const { page_count: pages } = await get(db, 'PRAGMA page_count');
    const { page_size: size } = await get(db, 'PRAGMA page_size');
    return pages * size;
  };
  const sizeBefore = await dbBytes();

  const insertFeature = async (cls, type, geometry, extra = {}) => {
    const g = normalizeGeometry(type, geometry);
    const b = computeBBox(type, g);
    const res = await new Promise((resolve, reject) => db.run(
      `INSERT INTO canonical_features (feature_class, kind, geometry_type, geometry_json, min_x, min_z, max_x, max_z,
         attributes_json, anchor_id, part_role, name, constraint_strength, lifecycle_state, provenance, revision, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', 'authored', 1, CURRENT_TIMESTAMP)`,
      [cls, extra.kind || null, type, JSON.stringify(g), b.min_x, b.min_z, b.max_x, b.max_z,
        extra.attributes ? JSON.stringify(extra.attributes) : null, extra.anchor_id || null, extra.part_role || null,
        extra.name || null, extra.strength || 'hard'],
      function (err) { err ? reject(err) : resolve(this.lastID); }));
    return res;
  };

  const t0 = Date.now();
  await run(db, 'BEGIN');
  const islands = [];
  for (let i = 0; i < ISLANDS_X * ISLANDS_Z; i++) islands.push(await insertFeature('land', 'polygon', islandPolygon(i), { name: `Isle ${i}` }));

  for (let w = 0; w < WATER; w++) {
    const i = (w * 9) % (ISLANDS_X * ISLANDS_Z);
    const c = islandCenter(i);
    await insertFeature('water', 'polygon', rect(c.x + 74, c.z - 20, 26, 40), { kind: 'basin', attributes: { navigable: 'yes' } });
  }

  // Scopes: 8 districts of whole island columns, 40 island groups within them.
  const cityId = (await get(db, `SELECT id FROM geo_scopes WHERE scope_key = 'city'`)).id;
  const scopeInsert = (key, kind, parent) => new Promise((resolve, reject) => db.run(
    `INSERT INTO geo_scopes (scope_key, scope_kind, parent_scope_id, name, lifecycle_state, provenance, revision, accepted_at)
     VALUES (?, ?, ?, ?, 'accepted', 'authored', 1, CURRENT_TIMESTAMP)`, [key, kind, parent, key],
    function (err) { err ? reject(err) : resolve(this.lastID); }));
  const districts = [];
  const groups = [];
  const districtOfIsland = (i) => Math.min(DISTRICTS - 1, Math.floor(((i % ISLANDS_X) / ISLANDS_X) * DISTRICTS));
  for (let d = 0; d < DISTRICTS; d++) districts.push(await scopeInsert(`district-${d}`, 'district', cityId));
  for (let g = 0; g < GROUPS; g++) groups.push(await scopeInsert(`group-${g}`, 'island_group', districts[g % DISTRICTS]));
  const groupMembers = new Map(groups.map(g => [g, []]));
  for (let i = 0; i < islands.length; i++) {
    const d = districtOfIsland(i);
    await run(db, 'INSERT INTO geo_scope_members (scope_id, feature_id, scope_kind, is_canonical) VALUES (?, ?, ?, 1)',
      [districts[d], islands[i], 'district']);
    // Island groups: consecutive islands of one district, up to ~12 each.
    const candidates = groups.filter((g, k) => k % DISTRICTS === d);
    const g = candidates[Math.floor(i / ISLANDS_X) % candidates.length];
    if (groupMembers.get(g).length < 12) {
      groupMembers.get(g).push(islands[i]);
      await run(db, 'INSERT INTO geo_scope_members (scope_id, feature_id, scope_kind, is_canonical) VALUES (?, ?, ?, 1)',
        [g, islands[i], 'island_group']);
    }
  }

  // Anchors and parts.
  let parts = 0;
  const partIds = [];
  for (let a = 0; a < ANCHORS; a++) {
    const island = (a * 7) % islands.length;
    const anchorId = await new Promise((resolve, reject) => db.run(
      `INSERT INTO canonical_anchors (anchor_key, name, category, must_exist, required_scope_id, constraint_strength,
         lifecycle_state, provenance, revision, accepted_at)
       VALUES (?, ?, 'landmark', ?, ?, 'hard', 'accepted', 'authored', 1, CURRENT_TIMESTAMP)`,
      [`anchor-${a}`, `Anchor ${a}`, a % 2, districts[districtOfIsland(island)]],
      function (err) { err ? reject(err) : resolve(this.lastID); }));
    if (a >= PLACED_ANCHORS) continue;
    const c = islandCenter(island);
    const n = a < 60 ? 4 : 3;
    const shapes = [
      () => ['polygon', rect(c.x - 15, c.z - 15, 20, 20), 'footprint'],
      () => ['point', { x: c.x + 20, z: c.z + 20 }, 'access'],
      () => ['linestring', [{ x: c.x - 30, z: c.z + 30 }, { x: c.x - 10, z: c.z + 35 }, { x: c.x + 10, z: c.z + 30 }], 'link'],
      () => ['point', { x: c.x - 25, z: c.z - 25 }, 'node'],
    ];
    for (let k = 0; k < n; k++) {
      const [type, geometry, role] = shapes[k]();
      partIds.push(await insertFeature('site', type, geometry, { anchor_id: anchorId, part_role: role, strength: k % 2 ? 'soft' : 'hard' }));
      parts++;
    }
  }

  // Routes: bridges to the east neighbour (and north for the last column), 8 vertices each.
  const routeIds = [];
  for (let r = 0; r < ROUTES; r++) {
    const i = r % islands.length;
    const c = islandCenter(i);
    const east = (i % ISLANDS_X) < ISLANDS_X - 1;
    const pts = [];
    for (let k = 0; k < 8; k++) {
      const t = k / 7;
      pts.push(east ? { x: c.x + 40 + t * (CELL - 80), z: c.z + 10 * Math.sin(t * Math.PI) + (r >= islands.length ? 30 : 0) }
        : { x: c.x + 10 * Math.sin(t * Math.PI), z: c.z + 40 + t * (CELL - 80) });
    }
    routeIds.push(await insertFeature('route', 'linestring', pts, { kind: 'bridge', attributes: { width_wu: 4 } }));
  }

  // Connections between neighbouring islands.
  for (let k = 0; k < CONNECTIONS; k++) {
    const i = (k * 3) % (islands.length - 1);
    await run(db, `INSERT INTO canonical_connections (connection_kind, from_ref_type, from_ref_id, to_ref_type, to_ref_id,
        constraint_strength, lifecycle_state, provenance, revision, accepted_at)
      VALUES (?, 'feature', ?, 'feature', ?, 'soft', 'accepted', 'authored', 1, CURRENT_TIMESTAMP)`,
    [[null, 'bridge', 'ferry'][k % 3], islands[i], islands[i + 1]]);
  }
  await run(db, 'COMMIT');
  const buildMs = Date.now() - t0;
  const sizeAfter = await dbBytes();

  const store = createStore(db);
  const measure = async (label, body) => {
    await store.query(body); // warm-up
    const times = [];
    let bundle;
    for (let k = 0; k < RUNS; k++) {
      const s = process.hrtime.bigint();
      bundle = await store.query(body);
      times.push(Number(process.hrtime.bigint() - s) / 1e6);
    }
    const s = process.hrtime.bigint();
    const json = JSON.stringify(bundle);
    const serializeMs = Number(process.hrtime.bigint() - s) / 1e6;
    times.sort((a, b) => a - b);
    const bytes = Buffer.byteLength(json);
    const gz = zlib.gzipSync(json).length;
    return {
      label,
      median_ms: +times[Math.floor(times.length / 2)].toFixed(1),
      p90_ms: +times[Math.floor(times.length * 0.9)].toFixed(1),
      max_ms: +times[times.length - 1].toFixed(1),
      serialize_ms: +serializeMs.toFixed(1),
      bytes,
      gzip_bytes: gz,
      counts: {
        land: bundle.land.length, water: bundle.water.length, sites: bundle.sites.length, routes: bundle.routes.length,
        anchors: bundle.anchors.length, connections: bundle.connections.length,
      },
      bundle,
    };
  };

  const midIsland = islands[Math.floor(islands.length / 2) + 12];
  const results = [
    await measure('city scope', { scope_id: cityId }),
    await measure('district scope', { scope_id: districts[3] }),
    await measure('island group scope', { scope_id: groups[5] }),
    await measure('single island (halo 0)', { feature_id: midIsland }),
    await measure('single island (halo 120 wu)', { feature_id: midIsland, halo_wu: 120 }),
    await measure('bbox 600 × 600 wu', { bbox: { min_x: 1500, min_z: 1200, max_x: 2100, max_z: 1800 } }),
  ];

  const summary = {
    node: process.version,
    dataset: {
      islands: islands.length, vertices_per_island: VERTICES, water: WATER, anchors: ANCHORS, placed_anchors: PLACED_ANCHORS,
      parts, routes: routeIds.length, connections: CONNECTIONS, districts: DISTRICTS, island_groups: GROUPS,
    },
    build_ms: buildMs,
    db_bytes_before: sizeBefore,
    db_bytes_after: sizeAfter,
    db_delta_bytes: sizeAfter - sizeBefore,
    queries: results.map(({ bundle, ...r }) => r),
    targets: {
      island_under_100ms: results.filter(r => r.label.startsWith('single island')).every(r => r.p90_ms < 100),
      city_under_1s: results[0].p90_ms < 1000,
    },
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'city.json'), JSON.stringify(results[0].bundle));
    fs.writeFileSync(path.join(outDir, 'island.json'), JSON.stringify(results[4].bundle));
  }

  await store.close();
  await new Promise((resolve) => db.close(resolve));
  fs.unlinkSync(file);
}

main().catch((err) => { process.stderr.write(`${err.stack}\n`); process.exit(1); });
