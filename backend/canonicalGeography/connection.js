/**
 * The dedicated SQLite connection canonical-geography transactions run on.
 *
 * The application shares one connection across every inherited route and socket handler,
 * and SQLite transactions belong to a connection, not to a caller. A canonical
 * `BEGIN … COMMIT` on that shared connection would therefore capture any inherited
 * statement that happened to run in between — committing it with canonical work, or
 * rolling it back with a failed canonical request — and an inherited `COMMIT`/`ROLLBACK`
 * would end the canonical transaction early. A second connection to the same database
 * file makes the two transactions independent; SQLite's own locking then orders their
 * writes, and the busy timeout makes a contended write wait instead of failing at once.
 */

const sqlite3 = require('sqlite3');

/** How long either connection waits on the other's write lock before SQLITE_BUSY. */
const BUSY_TIMEOUT_MS = 5000;

/**
 * A second connection to the same database file as `appDb`, or `null` when that database
 * cannot have one — an anonymous in-memory database is private to its connection, so a
 * "second connection" to `:memory:` would be a different, empty database.
 */
function openTransactionConnection(appDb) {
  const filename = appDb && appDb.filename;
  if (!filename || filename === ':memory:') return null;
  const conn = new sqlite3.Database(filename);
  conn.configure('busyTimeout', BUSY_TIMEOUT_MS);
  return conn;
}

module.exports = { openTransactionConnection, BUSY_TIMEOUT_MS };
