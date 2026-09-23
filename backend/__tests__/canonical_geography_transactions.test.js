/**
 * Canonical transactions are isolated from the application connection.
 *
 * Canonical work runs on its own SQLite connection to the same database file, so a
 * canonical COMMIT or ROLLBACK can only affect canonical statements, and an inherited
 * BEGIN/COMMIT/ROLLBACK on the application connection cannot end a canonical transaction.
 *
 * These tests use a temporary *file*: two connections to `:memory:` would be two different
 * databases and would look isolated for the wrong reason, so the first thing checked is
 * that both connections really see one database. Interleaving is driven by the store's
 * `afterBegin` / `beforeCommit` hooks and by SQLite's own write lock — never by sleeping.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { makeTestDb } from './helpers/testDb.js';

const require_ = createRequire(import.meta.url);
const { createStore } = require_('../canonicalGeography/store.js');
const { BUSY_TIMEOUT_MS } = require_('../canonicalGeography/connection.js');
const canonicalGeographyFactory = require_('../routes/canonical_geography.js');
const { land } = require_('./helpers/canonicalApi.js');

let template;
let file;
let appDb;
let store;
let hooks;
let seq = 0;

const on = (db) => ({
  run: (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); })),
  get: (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, r) => (e ? rej(e) : res(r)))),
});
let app;

const roads = async () => (await app.get('SELECT COUNT(*) AS c FROM roads')).c;
const features = async () => (await app.get('SELECT COUNT(*) AS c FROM canonical_features')).c;

const closeDb = (db) => new Promise((res) => db.close(() => res()));
const tmpName = (tag) => path.join(os.tmpdir(), `ruby-wheel-canon-tx-${process.pid}-${Date.now()}-${tag}.db`);
const openFile = (filename) => new Promise((res, rej) => {
  const db = new (require_('sqlite3').Database)(filename, (e) => (e ? rej(e) : res(db)));
});

// The full schema is built into a file once; each test gets its own byte copy of it, so
// no test pays for ~40 durable DDL commits and no test sees another's rows.
beforeAll(async () => {
  template = tmpName('template');
  await closeDb(await makeTestDb({ filename: template }));
});

afterAll(() => { try { fs.unlinkSync(template); } catch { /* already gone */ } });

beforeEach(async () => {
  file = tmpName(seq++);
  fs.copyFileSync(template, file);
  appDb = await openFile(file);
  // As db.js configures the real application connection.
  appDb.configure('busyTimeout', BUSY_TIMEOUT_MS);
  app = on(appDb);
  hooks = {};
  store = createStore(appDb, { hooks });
});

afterEach(async () => {
  await store.close();
  await closeDb(appDb);
  for (const f of [file, `${file}-journal`]) { try { fs.unlinkSync(f); } catch { /* not created */ } }
});

describe('the dedicated connection', () => {
  it('is a different connection to the same database file', async () => {
    expect(store.dedicated).toBe(true);
    expect(store.connection).not.toBe(appDb);
    expect(store.connection.filename).toBe(appDb.filename);

    // Same database, both ways round — not two private databases that merely look separate.
    await app.run(`INSERT INTO roads (x1, z1, x2, z2, width) VALUES (0, 0, 1, 1, 4)`);
    expect((await on(store.connection).get('SELECT COUNT(*) AS c FROM roads')).c).toBe(1);
    const rec = await store.createDraft('features', land(0, 0));
    expect((await app.get('SELECT id FROM canonical_features')).id).toBe(rec.id);
  });

  it('is what the router uses for a file database, and cannot exist for a private in-memory one', async () => {
    const router = canonicalGeographyFactory(appDb, {}, { emitUpdate: () => {} });
    expect(router.canonicalStore.dedicated).toBe(true);
    expect(router.canonicalStore.connection.filename).toBe(file);
    await router.canonicalStore.close();

    const memory = await makeTestDb();
    expect(createStore(memory).dedicated).toBe(false);
    await new Promise((res) => memory.close(() => res()));
  });
});

describe('A: a successful canonical transaction with an interleaved inherited write', () => {
  it('commits each on its own connection; the canonical COMMIT does not carry the inherited write', async () => {
    const events = [];
    let inherited;
    hooks.afterBegin = async () => {
      // Issued mid-transaction on the application connection. It needs the write lock the
      // canonical transaction holds, so SQLite makes it wait instead of joining it.
      inherited = app.run(`INSERT INTO roads (x1, z1, x2, z2, width) VALUES (0, 0, 1, 1, 4)`)
        .then(() => events.push('inherited write committed'));
    };
    hooks.beforeCommit = async (tx) => {
      // Inside the canonical transaction, the inherited write is not part of it.
      expect((await tx.get('SELECT COUNT(*) AS c FROM roads')).c).toBe(0);
      events.push('canonical commit');
    };

    const rec = await store.createDraft('features', land(0, 0));
    await inherited;

    expect(events).toEqual(['canonical commit', 'inherited write committed']);
    expect(await roads()).toBe(1);
    expect(await features()).toBe(1);
    expect((await app.get('SELECT lifecycle_state FROM canonical_features WHERE id = ?', [rec.id])).lifecycle_state).toBe('draft');
  });
});

describe('B: a failing canonical transaction with an interleaved inherited write', () => {
  it.each([
    ['an SQL error', (tx) => tx.run('INSERT INTO no_such_table VALUES (1)'), /no such table/],
    ['a runtime error', () => { throw new Error('forced canonical failure'); }, /forced canonical failure/],
  ])('rolls back only canonical work on %s; the inherited write survives', async (label, fail, message) => {
    let inherited;
    hooks.afterBegin = async () => {
      inherited = app.run(`INSERT INTO roads (x1, z1, x2, z2, width) VALUES (0, 0, 1, 1, 4)`);
    };
    hooks.beforeCommit = fail;

    await expect(store.createDraft('features', land(0, 0))).rejects.toThrow(message);
    await inherited;

    expect(await features()).toBe(0);
    expect(await roads()).toBe(1);
  });
});

describe('C: transaction control on one connection cannot end the other\'s transaction', () => {
  it('an inherited BEGIN/ROLLBACK and BEGIN/COMMIT mid-canonical-transaction leave it intact', async () => {
    hooks.beforeCommit = async () => {
      await app.run('BEGIN');
      // Canonical work is uncommitted, and on another connection: not visible here.
      expect(await features()).toBe(0);
      await app.run('ROLLBACK');
      await app.run('BEGIN');
      await app.run('COMMIT');
    };

    const rec = await store.createDraft('features', land(0, 0));
    expect(rec.lifecycle_state).toBe('draft');
    expect(await features()).toBe(1);
  });

  it('an inherited write transaction open as a canonical mutation starts, then rolled back, stays rolled back', async () => {
    await app.run('BEGIN');
    await app.run(`INSERT INTO roads (x1, z1, x2, z2, width) VALUES (0, 0, 1, 1, 4)`);

    // The inherited transaction holds the write lock; the canonical BEGIN IMMEDIATE waits
    // on it (busy timeout) rather than joining it, and commits only canonical work.
    const canonical = store.createDraft('features', land(0, 0));
    await app.run('ROLLBACK');

    expect((await canonical).lifecycle_state).toBe('draft');
    expect(await roads()).toBe(0);
    expect(await features()).toBe(1);
  });

  it('a failed canonical transaction does not roll back an inherited transaction committed around it', async () => {
    hooks.beforeCommit = async () => { throw new Error('forced'); };
    const canonical = store.createDraft('features', land(0, 0));
    await expect(canonical).rejects.toThrow('forced');

    await app.run('BEGIN');
    await app.run(`INSERT INTO roads (x1, z1, x2, z2, width) VALUES (0, 0, 1, 1, 4)`);
    await app.run('COMMIT');
    expect(await roads()).toBe(1);
    expect(await features()).toBe(0);
  });
});

describe('D: recovery after a canonical failure', () => {
  it('rolls back, then serves the next canonical mutation on the same dedicated connection', async () => {
    const connection = store.connection;
    let fail = true;
    hooks.beforeCommit = async (tx) => {
      if (fail) { fail = false; await tx.run('INSERT INTO no_such_table VALUES (1)'); }
    };

    await expect(store.createDraft('features', land(0, 0))).rejects.toThrow(/no such table/);
    expect(await features()).toBe(0);

    // A transaction left open would make this BEGIN IMMEDIATE fail.
    const rec = await store.createDraft('features', land(50, 0));
    const accepted = await store.accept('features', rec.id, { expected_draft_version: 1 });
    expect(accepted.record.lifecycle_state).toBe('accepted');
    expect(store.connection).toBe(connection);
    expect(await features()).toBe(1);
  });

  it('serializes canonical mutations with each other on that connection', async () => {
    const order = [];
    hooks.afterBegin = async () => { order.push('begin'); };
    hooks.beforeCommit = async () => { order.push('commit'); };
    await Promise.all([0, 50, 100].map(x => store.createDraft('features', land(x, 0))));
    expect(order).toEqual(['begin', 'commit', 'begin', 'commit', 'begin', 'commit']);
  });
});
