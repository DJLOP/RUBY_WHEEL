/**
 * An ordered, recorded schema migration seam.
 *
 * The inherited startup DDL in `db.js` is a pile of `CREATE TABLE IF NOT EXISTS` and
 * `ALTER TABLE ... ` calls whose errors are swallowed, fired at the connection with no
 * record of what ran. It works, and converting it is not this slice's job — but new
 * schema should not join it, because "did this already run?" there is only answerable by
 * inspecting the tables and guessing.
 *
 * So: a ledger table, a list in order, each migration applied once inside a transaction,
 * and a promise the server can wait on. Nothing here rewrites inherited DDL.
 */

/** The migrations, in the order they must be applied. Append; never reorder or edit. */
const MIGRATIONS = [
  require('./001-reference-layers'),
  require('./002-canonical-geography'),
];

/** Promisified `db.run` bound to one connection, so a migration reads as a script. */
const runner = (db) => (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err); else resolve(this);
    });
  });

const allRows = (db, sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });

/**
 * Apply one migration and record it, or leave the schema exactly as it was.
 *
 * SQLite runs DDL inside transactions, so a migration that fails halfway does not leave
 * half a table behind — and, more importantly, does not leave a ledger row claiming it
 * finished, which would make the failure permanent and silent on the next start.
 */
async function applyMigration(db, migration) {
  const run = runner(db);
  await run('BEGIN');
  try {
    await migration.up({ run, db });
    await run('INSERT INTO schema_migrations (name) VALUES (?)', [migration.name]);
    await run('COMMIT');
  } catch (err) {
    try { await run('ROLLBACK'); } catch { /* the failure below is the one that matters */ }
    throw err;
  }
}

/**
 * Bring `db` up to date, returning the names actually applied by this call.
 *
 * Idempotent by the ledger rather than by `IF NOT EXISTS` alone: a second startup reads
 * the recorded names and applies nothing, so the result is an empty list rather than a
 * set of no-op statements nobody can distinguish from real work.
 */
async function runMigrations(db, migrations = MIGRATIONS) {
  const run = runner(db);
  await run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  const recorded = new Set((await allRows(db, 'SELECT name FROM schema_migrations')).map(r => r.name));
  const applied = [];
  for (const migration of migrations) {
    if (recorded.has(migration.name)) continue;
    await applyMigration(db, migration);
    applied.push(migration.name);
  }
  return applied;
}

module.exports = { MIGRATIONS, runMigrations };
