/**
 * Shared harness for the canonical-geography API tests: an in-memory database, the router
 * mounted as server.js mounts it, tokens for each kind of caller, and small geometry
 * fixtures. Every test gets a fresh database; nothing here is shared between tests.
 *
 * These tests make many requests. `request(app)` would listen on a new port and open a new
 * connection for each one, which is slow and, run repeatedly on Windows, exhausts the
 * ephemeral port range. So each harness listens once and reuses one keep-alive connection;
 * everything opened is closed after each test.
 */

const http = require('http');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { makeTestDb, all } = require('./testDb');
const canonicalGeographyFactory = require('../../routes/canonical_geography');

const BASE = '/api/canonical-geography';
const SECRET = 'test-secret';
const sign = (payload) => jwt.sign(payload, SECRET);

const TOKENS = {
  admin: sign({ id: 1, username: 'admin', role: 'admin', isTemporary: false }),
  player: sign({ username: 'runner', role: 'player', isTemporary: false }),
  tempAdmin: sign({ username: 'guest_admin', role: 'admin', isTemporary: true }),
};

const CANONICAL_TABLES = ['canonical_features', 'canonical_anchors', 'canonical_connections',
  'geo_scopes', 'geo_scope_members', 'canonical_revisions'];

// ── geometry fixtures ────────────────────────────────────────────────────────

/** An axis-aligned square polygon with its lower-left corner at (x, z). */
const square = (x, z, size = 10) => ({
  outer: [{ x, z }, { x: x + size, z }, { x: x + size, z: z + size }, { x, z: z + size }],
  holes: [],
});

const land = (x, z, size = 10, extra = {}) => ({
  feature_class: 'land', geometry_type: 'polygon', geometry: square(x, z, size), constraint_strength: 'hard', ...extra,
});

const site = (geometryType, geometry, extra = {}) => ({
  feature_class: 'site', geometry_type: geometryType, geometry, constraint_strength: 'hard', ...extra,
});

const route = (points, extra = {}) => ({
  feature_class: 'route', geometry_type: 'linestring', geometry: points, constraint_strength: 'hard', ...extra,
});

const boundary = (x, z, size) => ({
  feature_class: 'scope_boundary', geometry_type: 'polygon', geometry: square(x, z, size), constraint_strength: 'hard',
});

const anchor = (key, extra = {}) => ({
  anchor_key: key, name: key.replace(/[-_]/g, ' '), category: 'landmark', constraint_strength: 'hard', ...extra,
});

const scope = (key, kind, parentId, extra = {}) => ({
  scope_key: key, scope_kind: kind, parent_scope_id: parentId, name: key.replace(/[-_]/g, ' '), ...extra,
});

const connection = (from, to, extra = {}) => ({
  from_ref_type: from[0], from_ref_id: from[1], to_ref_type: to[0], to_ref_id: to[1], constraint_strength: 'soft', ...extra,
});

const PROPOSAL = { source: 'test-suite', generator: 'unit-generator', generator_version: '1', seed: 7, rationale: 'fixture' };

// ── harness ──────────────────────────────────────────────────────────────────

const open = [];

async function closeAll() {
  while (open.length) {
    const { server, agent } = open.pop();
    agent.destroy();
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

// Registered at the root of whichever test file requires this helper.
if (typeof afterEach === 'function') afterEach(closeAll);

async function setupCanonical({ db, mount } = {}) {
  db = db || await makeTestDb();
  const emits = [];
  const emitUpdate = (payload) => emits.push(payload);
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(BASE, canonicalGeographyFactory(db, { emit: () => {} }, { emitUpdate }));
  if (mount) mount(app, { emitUpdate });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  open.push({ server, agent });

  const as = (token) => {
    const call = (method, path, body) => {
      let req = request(server)[method](path.startsWith('/api') ? path : BASE + path).agent(agent);
      if (token) req = req.set('Authorization', `Bearer ${token}`);
      return body === undefined ? req : req.send(body);
    };
    return {
      get: (p) => call('get', p),
      post: (p, b) => call('post', p, b),
      patch: (p, b) => call('patch', p, b),
      put: (p, b) => call('put', p, b),
      del: (p) => call('delete', p),
    };
  };

  const admin = as(TOKENS.admin);
  const expectStatus = (res, status, what) => {
    if (res.status !== status) {
      throw new Error(`${what}: expected ${status}, got ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body;
  };

  const api = {
    ...admin,
    as,
    anon: as(null),
    player: as(TOKENS.player),
    tempAdmin: as(TOKENS.tempAdmin),

    /** Create a draft, asserting success; returns the record. */
    draft: async (entity, body) => expectStatus(await admin.post(`/${entity}`, body), 201, `draft ${entity}`),

    /** Accept a record at its current draft_version; returns the raw response. */
    accept: (entity, rec) => admin.post(`/${entity}/${rec.id}/accept`, { expected_draft_version: rec.draft_version }),

    /** Draft then accept, asserting both; returns the accepted record. */
    accepted: async (entity, body) => {
      const d = await api.draft(entity, body);
      return expectStatus(await api.accept(entity, d), 200, `accept ${entity}`).record;
    },

    propose: (entity, body, extra = {}) =>
      admin.post('/proposals', { entity, provenance: 'generated', proposal: PROPOSAL, ...extra, ...body }),

    expectStatus,
  };

  return { db, app, emits, api };
}

/** Every canonical row, plus the canonical tables' AUTOINCREMENT counters, in a stable order. */
async function snapshotCanonical(db) {
  const out = {};
  for (const t of CANONICAL_TABLES) out[t] = await all(db, `SELECT * FROM ${t} ORDER BY rowid`);
  out.sqlite_sequence = await all(db,
    `SELECT name, seq FROM sqlite_sequence WHERE name IN (${CANONICAL_TABLES.map(() => '?').join(', ')}) ORDER BY name`,
    CANONICAL_TABLES);
  return out;
}

module.exports = {
  BASE, TOKENS, CANONICAL_TABLES, PROPOSAL,
  square, land, site, route, boundary, anchor, scope, connection,
  setupCanonical, snapshotCanonical, closeAll,
};
