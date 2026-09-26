/**
 * The canonical-geography lifecycle: one generic implementation for features, anchors,
 * connections and scopes (plan §3.7, §5.2).
 *
 * The invariants this module exists to hold:
 *
 * - Drafts and proposals are not canon. Nothing creates `accepted` except `accept`, and
 *   `accept` runs full cross-feature validation first.
 * - Accepted constraint fields are never edited in place. `revise` copies an accepted row
 *   into a draft; accepting that draft writes its fields onto the same id with
 *   `revision + 1`, records history, and deletes the draft. Descriptive fields (name,
 *   description, notes) may change in place on an unlocked accepted row, recorded as
 *   history without a revision bump.
 * - A locked row refuses revise-accept, retire, replacement change and every in-place
 *   edit. Unlocking is its own request.
 * - Accepted and retired rows are never hard-deleted. Drafts and proposals may be.
 * - Every change to a canonical row writes `canonical_revisions` in the same transaction.
 *   Canonical operations never touch the inherited `action_history` / undo.
 *
 * Transactions: every read-check-write runs inside `BEGIN IMMEDIATE` on a dedicated
 * connection to the same database (connection.js), never on the application connection
 * the inherited routes share — so a canonical COMMIT or ROLLBACK can only ever commit or
 * undo canonical statements, and an inherited COMMIT or ROLLBACK cannot end a canonical
 * transaction. Store operations are queued so they are serialized with each other on that
 * connection. Any failure inside a transaction rolls it back.
 */

const crypto = require('crypto');
const {
  ENTITIES, LIFECYCLE_STATES, EDITOR_PROVENANCE, REPLACEMENT_STATES, DESCRIPTIVE_FIELDS, STRENGTHS, FEATURE_KINDS,
  serialize, toInput, refuseUnknown, normalizeProposal, text, NAME_MAX, isPlainObject, isRadialSpoke,
} = require('./entities');
const { validateAccept, validateRetire, findDependents } = require('./validation');
const { CanonicalError, invalid, notFound, conflict } = require('./errors');
const { openTransactionConnection } = require('./connection');
const { runQuery } = require('./query');
const { validateGeometry, WORLD_LIMIT } = require('./geometry');
const radial = require('./radialConstruction');
const circles = require('./circleConstruction');

const OPEN_STATES = ['draft', 'proposed'];

const RADIAL_ONLY = 'a radial_spoke construction record is written only by POST /constructions/radial';
const RADIAL_EDIT = 'clear the construction record when editing constructed geometry (send construction: null with the new geometry)';

/** JSON text compared by value, independent of key order. */
const sameJson = (a, b) => {
  const stable = (v) => (Array.isArray(v) ? v.map(stable)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v);
  const norm = (s) => (s === null || s === undefined ? null : JSON.stringify(stable(JSON.parse(s))));
  return norm(a) === norm(b);
};

/**
 * A `radial_spoke` record describes exactly the geometry the constructor produced (plan
 * §15.8). A normalized feature may carry one only if both the record and the geometry are
 * the ones already stored on `reference` (an echoed draft, or a revision copied from
 * canon). A client-supplied record, or a kept record over changed geometry, is refused.
 */
function guardRadialRecord(columns, reference) {
  if (!isRadialSpoke(columns.construction_json ? JSON.parse(columns.construction_json) : null)) return;
  if (!reference) throw invalid(RADIAL_ONLY);
  if (!sameJson(columns.construction_json, reference.construction_json)) throw invalid(RADIAL_ONLY);
  if (!sameJson(columns.geometry_json, reference.geometry_json)) throw invalid(RADIAL_EDIT);
}

// ── the radial construct request (plan §15.11) ────────────────────────────────

const RADIAL_REQUEST_KEYS = ['inner', 'outer', 'center', 'center_source', 'count', 'offset_deg', 'omit_indices', 'output', 'revises', 'dry_run'];
const RADIAL_OUTPUT_CLASSES = ['route', 'site'];
const NAME_PREFIX_MAX = NAME_MAX - 5; // room for " #359"
const INPUT_WORDS = { inner: 'Inner boundary', outer: 'Outer boundary', center: 'Center feature' };

const positiveInt = (v) => Number.isInteger(v) && v > 0;

function parseInputRef(value, field) {
  if (!isPlainObject(value)) throw invalid(`${field} must be {feature_id, expected_revision}`);
  for (const k of Object.keys(value)) {
    if (k !== 'feature_id' && k !== 'expected_revision') throw invalid(`${field}.${k} is not recognised (allowed: feature_id, expected_revision)`);
  }
  if (!positiveInt(value.feature_id)) throw invalid(`${field}.feature_id must be a positive integer id`);
  if (!positiveInt(value.expected_revision)) throw invalid(`${field}.expected_revision must be a positive integer (accepted inputs start at revision 1)`);
  return { feature_id: value.feature_id, expected_revision: value.expected_revision };
}

/**
 * One boundary source (plan §15.3.1): an accepted feature pinned at a revision, or an inline
 * circle definition — the shape creator's circle method and its defining clicks. The server
 * recomputes the circle itself from the definition; no client geometry is accepted.
 */
/**
 * An inline circle materialized as an ordinary canonical feature draft (plan §15.3.1): the
 * same server-resolved ring and the shape creator's own `circle` construction record, as a
 * polygon — how the shape creator saves a circle — or, for a `route`, a closed linestring
 * (a wall ring, §4.4). Validated by the ordinary feature normalization, so vocabularies and
 * geometry rules are exactly those of any other draft.
 */
const MATERIALIZE_KEYS = ['feature_class', 'kind', 'constraint_strength', 'name', 'width_wu'];
function parseMaterialize(value, field, built) {
  if (!isPlainObject(value)) throw invalid(`${field}.materialize must be {feature_class, kind?, constraint_strength?, name?, width_wu?}`);
  for (const k of Object.keys(value)) {
    if (!MATERIALIZE_KEYS.includes(k)) throw invalid(`${field}.materialize.${k} is not recognised (allowed: ${MATERIALIZE_KEYS.join(', ')}); a boundary draft is always an authored, unaccepted draft`);
  }
  const featureClass = value.feature_class;
  const linestring = featureClass === 'route';
  const input = {
    feature_class: featureClass,
    kind: value.kind ?? null,
    geometry_type: linestring ? 'linestring' : 'polygon',
    geometry: linestring ? [...built.ring, built.ring[0]] : { outer: built.ring, holes: [] },
    construction: built.construction,
    constraint_strength: value.constraint_strength ?? 'hard',
    name: value.name ?? null,
    // The ordinary route attribute: optional, positive, full width in world units. Any other
    // class refuses it through the same attribute validation as every draft.
    attributes: value.width_wu === undefined || value.width_wu === null ? null : { width_wu: value.width_wu },
  };
  let normalized;
  try {
    normalized = ENTITIES.features.normalize(input);
  } catch (err) {
    if (err instanceof CanonicalError) throw invalid(`${field}.materialize: ${err.message}`, err.details);
    throw err;
  }
  return normalized;
}

function parseBoundary(value, field) {
  if (isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, 'circle')) {
    if (Object.keys(value).some(k => k !== 'circle' && k !== 'materialize')) {
      throw invalid(`${field} takes either {feature_id, expected_revision} or {circle, materialize?}, not both`);
    }
    const c = value.circle;
    if (!isPlainObject(c)) throw invalid(`${field}.circle must be {method, points}`);
    for (const k of Object.keys(c)) {
      if (k !== 'method' && k !== 'points') throw invalid(`${field}.circle.${k} is not recognised (allowed: method, points); the server derives the circle itself`);
    }
    if (!circles.CIRCLE_METHODS.includes(c.method)) throw invalid(`${field}.circle.method must be one of ${circles.CIRCLE_METHODS.join(', ')}`);
    const want = circles.CIRCLE_METHOD_POINTS[c.method];
    if (!Array.isArray(c.points) || c.points.length !== want) {
      throw invalid(`${field}.circle.points must be ${want} points for ${c.method} (${c.method === 'three_point' ? 'three rim points' : 'the centre, then a rim point'})`);
    }
    c.points.forEach((p, i) => {
      if (!isPlainObject(p) || Object.keys(p).some(k => k !== 'x' && k !== 'z')) throw invalid(`${field}.circle.points[${i}] must be {x, z}`);
      const g = validateGeometry('point', p);
      if (!g.ok) throw invalid(`${field}.circle.points[${i}] is not a valid point: ${g.issues.map(x => x.message).join('; ')}`);
    });
    const built = circles.circleFromDefinition(c.method, c.points);
    if (!built) {
      throw invalid(`${field}.circle does not define a circle: ${c.method === 'three_point' ? 'the three points are collinear or coincident' : 'the rim point is the centre'}`,
        { code: 'degenerate_circle' });
    }
    const ring = validateGeometry('polygon', { outer: built.ring });
    if (!ring.ok) {
      throw invalid(`${field}.circle is not a usable boundary: ${ring.issues.map(x => x.message).join('; ')}`, { code: 'degenerate_circle' });
    }
    const { center, radius, segments, max_chord_error_m: chord } = built.construction;
    const materialize = value.materialize === undefined || value.materialize === null ? null : parseMaterialize(value.materialize, field, built);
    return {
      kind: 'circle', ring: built.ring, materialize,
      record: { circle: { method: c.method, points: c.points.map(circles.roundPoint), center, radius, segments, max_chord_error_m: chord } },
    };
  }
  if (isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, 'materialize')) {
    throw invalid(`${field}.materialize applies only to a constructed circle; an existing canonical boundary is never duplicated`);
  }
  return { kind: 'feature', ...parseInputRef(value, field) };
}

function parseOutput(value) {
  if (!isPlainObject(value)) throw invalid('output must be an object of output feature settings');
  const allowed = ['feature_class', 'kind', 'constraint_strength', 'width_wu', 'name_prefix'];
  for (const k of Object.keys(value)) {
    if (!allowed.includes(k)) throw invalid(`output.${k} is not recognised (allowed: ${allowed.join(', ')})`);
  }
  const featureClass = value.feature_class ?? 'route';
  if (!RADIAL_OUTPUT_CLASSES.includes(featureClass)) throw invalid(`output.feature_class must be one of ${RADIAL_OUTPUT_CLASSES.join(', ')}`);
  let kind = null;
  if (value.kind !== undefined && value.kind !== null) {
    const kinds = FEATURE_KINDS[featureClass];
    if (!kinds) throw invalid(`${featureClass} features take no kind`);
    if (!kinds.includes(value.kind)) throw invalid(`output.kind must be one of ${kinds.join(', ')}`);
    kind = value.kind;
  }
  const strength = value.constraint_strength ?? 'hard';
  if (!STRENGTHS.includes(strength)) throw invalid(`output.constraint_strength must be one of ${STRENGTHS.join(', ')}`);
  let width = null;
  if (value.width_wu !== undefined && value.width_wu !== null) {
    if (featureClass !== 'route') throw invalid('output.width_wu applies to route output only');
    if (typeof value.width_wu !== 'number' || !Number.isFinite(value.width_wu) || value.width_wu <= 0 || value.width_wu > WORLD_LIMIT) {
      throw invalid('output.width_wu must be a positive number of world units');
    }
    width = value.width_wu;
  }
  const prefix = value.name_prefix === undefined || value.name_prefix === null
    ? 'Spoke' : text(value.name_prefix, 'output.name_prefix', { max: NAME_PREFIX_MAX }) || 'Spoke';
  return { feature_class: featureClass, kind, constraint_strength: strength, width_wu: width, name_prefix: prefix };
}

/** Shape-check a construct request; every malformed parameter is a 400 before any read. */
function parseRadialRequest(body) {
  if (!isPlainObject(body)) throw invalid('request body must be an object');
  for (const k of Object.keys(body)) {
    if (!RADIAL_REQUEST_KEYS.includes(k)) throw invalid(`${k} is not a field of a radial construction request`);
  }
  if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') throw invalid('dry_run must be true or false');
  const inner = parseBoundary(body.inner, 'inner');
  const outer = parseBoundary(body.outer, 'outer');

  const src = body.center_source ?? { kind: 'coordinate' };
  if (!isPlainObject(src)) throw invalid('center_source must be an object');
  let centerSource;
  if (src.kind === 'coordinate') {
    if (Object.keys(src).some(k => k !== 'kind')) throw invalid('a coordinate center_source takes only kind');
    centerSource = { kind: 'coordinate' };
  } else if (src.kind === 'feature_point' || src.kind === 'feature_construction_center') {
    const { kind, ...ref } = src;
    centerSource = { kind, ...parseInputRef(ref, 'center_source') };
  } else {
    throw invalid('center_source.kind must be one of coordinate, feature_point, feature_construction_center');
  }
  let center = null;
  const hasCenter = body.center !== undefined && body.center !== null;
  if (centerSource.kind === 'coordinate') {
    if (!hasCenter) throw invalid('center {x, z} is required when the center source is a coordinate');
    const g = validateGeometry('point', body.center);
    if (!g.ok) throw invalid(`center is not a valid point: ${g.issues.map(i => i.message).join('; ')}`);
    center = g.geometry;
  } else if (hasCenter) {
    throw invalid(`center must be absent when the center comes from a feature (${centerSource.kind}); the server derives it`);
  }

  const params = radial.normalizeParams({ count: body.count, offset_deg: body.offset_deg, omit_indices: body.omit_indices });
  if (!params.ok) throw invalid(params.issues.map(i => i.message).join('; '), { issues: params.issues });

  let revises = null;
  let output = null;
  if (body.revises !== undefined && body.revises !== null) {
    if (body.output !== undefined && body.output !== null) {
      throw invalid('output is forbidden in revision mode: revisions keep each spoke\'s class, kind, strength, width and name');
    }
    if (!Array.isArray(body.revises) || !body.revises.length) throw invalid('revises must be a non-empty array of {index, feature_id, expected_revision}');
    revises = body.revises.map((r, i) => {
      if (!isPlainObject(r)) throw invalid(`revises[${i}] must be {index, feature_id, expected_revision}`);
      const { index, ...ref } = r;
      if (!Number.isInteger(index) || index < 0) throw invalid(`revises[${i}].index must be a spoke index`);
      return { index, ...parseInputRef(ref, `revises[${i}]`) };
    });
    if (new Set(revises.map(r => r.feature_id)).size !== revises.length) throw invalid('revises names a feature more than once');
  } else {
    if (body.output === undefined || body.output === null) throw invalid('output is required when creating new drafts');
    output = parseOutput(body.output);
  }
  return {
    inner, outer, center, centerSource, count: params.count, offset_deg: params.offset_deg, omit_indices: params.omit_indices,
    output, revises, dry_run: body.dry_run === true,
  };
}

/**
 * Timestamps come from SQLite, not this process, so they share one clock with the column
 * defaults. `updateRow` writes this sentinel as `CURRENT_TIMESTAMP` rather than a parameter.
 */
const NOW = Symbol('CURRENT_TIMESTAMP');

/**
 * `appDb` is the application connection. Canonical work runs on `options.connection`, or
 * on a dedicated connection opened to `appDb`'s database file. Only a database that cannot
 * have a second connection (anonymous `:memory:`, used by unit tests) falls back to
 * `appDb` itself; production always has a file.
 *
 * `options.hooks` exists for the transaction-isolation tests: `afterBegin(tx)` and
 * `beforeCommit(tx)` are awaited inside every transaction, so a test can interleave other
 * work at an exact point without sleeping.
 */
function createStore(appDb, { connection, hooks = {} } = {}) {
  const owned = connection ? null : openTransactionConnection(appDb);
  const db = connection || owned || appDb;

  const rawRun = (sql, params = []) => new Promise((resolve, reject) =>
    db.run(sql, params, function (err) { err ? reject(err) : resolve(this); }));
  const get = (sql, params = []) => new Promise((resolve, reject) =>
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
  const all = (sql, params = []) => new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));

  // One queue for every store operation, reads included, so canonical transactions are
  // serialized with each other and a read never lands inside one.
  let queue = Promise.resolve();
  const exclusive = (fn) => {
    const result = queue.then(fn, fn);
    queue = result.catch(() => {});
    return result;
  };

  const readOnly = (fn) => exclusive(() => fn({ get, all }));

  const transact = (body) => exclusive(async () => {
    const tx = { get, all, run: rawRun };
    await rawRun('BEGIN IMMEDIATE');
    try {
      if (hooks.afterBegin) await hooks.afterBegin(tx);
      const result = await body(tx);
      if (hooks.beforeCommit) await hooks.beforeCommit(tx);
      await rawRun('COMMIT');
      return result;
    } catch (err) {
      // On its own connection a rollback can only undo canonical statements. If SQLite
      // already ended the transaction itself, this fails harmlessly and the connection is
      // left idle and usable either way.
      try { await rawRun('ROLLBACK'); } catch { /* the original failure is the one to report */ }
      throw err;
    }
  });

  // ── row helpers ────────────────────────────────────────────────────────────

  const specFor = (entity) => {
    const spec = ENTITIES[entity];
    if (!spec) throw notFound(`unknown canonical entity "${entity}"`);
    return spec;
  };

  const parseId = (value, what = 'id') => {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0 || String(n) !== String(value)) throw notFound(`${what} not found`);
    return n;
  };

  const loadRow = (q, spec, id) => q.get(`SELECT * FROM ${spec.table} WHERE id = ?`, [id]);

  const requireRow = async (q, spec, id) => {
    const row = await loadRow(q, spec, id);
    if (!row) throw notFound(`${spec.type} #${id} not found`);
    return row;
  };

  const loadMembers = async (q, scopeId) =>
    (await q.all('SELECT feature_id FROM geo_scope_members WHERE scope_id = ? ORDER BY feature_id', [scopeId]))
      .map(r => r.feature_id);

  const record = async (q, spec, row) =>
    serialize(spec, row, spec.hasMembers ? await loadMembers(q, row.id) : undefined);

  const insertRow = async (tx, spec, columns) => {
    const keys = Object.keys(columns);
    const res = await tx.run(
      `INSERT INTO ${spec.table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
      keys.map(k => columns[k]));
    return res.lastID;
  };

  const updateRow = (tx, spec, id, columns) => {
    const keys = Object.keys(columns);
    const set = [...keys.map(k => (columns[k] === NOW ? `${k} = CURRENT_TIMESTAMP` : `${k} = ?`)), 'updated_at = CURRENT_TIMESTAMP'];
    const values = keys.filter(k => columns[k] !== NOW).map(k => columns[k]);
    return tx.run(`UPDATE ${spec.table} SET ${set.join(', ')} WHERE id = ?`, [...values, id]);
  };

  /** A draft/proposal scope's members are its own non-canonical rows until accept transfers them. */
  const writeMembers = async (tx, scopeId, members, scopeKind, isCanonical) => {
    await tx.run('DELETE FROM geo_scope_members WHERE scope_id = ?', [scopeId]);
    for (const fid of members) {
      await tx.run('INSERT INTO geo_scope_members (scope_id, feature_id, scope_kind, is_canonical) VALUES (?, ?, ?, ?)',
        [scopeId, fid, scopeKind, isCanonical ? 1 : 0]);
    }
  };

  const writeHistory = async (tx, spec, id, changeKind, extra = {}) => {
    const row = await loadRow(tx, spec, id);
    const snapshot = { ...(await record(tx, spec, row)), ...extra };
    await tx.run(
      `INSERT INTO canonical_revisions (entity_type, entity_id, revision, change_kind, snapshot_json) VALUES (?, ?, ?, ?, ?)`,
      [spec.type, id, row.revision, changeKind, JSON.stringify(snapshot)]);
  };

  /** A key identifies a canonical entity; only rows that are not revisions hold one. */
  const refuseTakenKey = async (q, spec, keyValue, exceptId = null) => {
    if (!spec.keyField) return;
    const taken = await q.get(
      `SELECT id FROM ${spec.table} WHERE ${spec.keyField} = ? AND revises_id IS NULL AND id IS NOT ?`, [keyValue, exceptId]);
    if (taken) throw conflict(`${spec.keyField} "${keyValue}" is already used by ${spec.type} #${taken.id}`);
  };

  const refuseOpenRevision = async (q, spec, canonicalId, state) => {
    const open = await q.get(
      `SELECT id FROM ${spec.table} WHERE revises_id = ? AND lifecycle_state = ?`, [canonicalId, state]);
    if (open) {
      throw conflict(`${spec.type} #${canonicalId} already has an open ${state} revision (#${open.id}); edit, accept or delete that one`,
        { open_revision_id: open.id });
    }
  };

  const lockedMessage = (spec, id, action) =>
    `${spec.type} #${id} is locked. Unlock it (PATCH …/lock with is_locked false) as its own request before ${action}.`;

  /**
   * Normalize `input` as a revision of `canon`: identity (the key) comes from the
   * canonical row and cannot be changed by the revision.
   */
  const normalizeRevision = (spec, canon, input) => {
    if (spec.keyField) {
      if (input[spec.keyField] !== undefined && input[spec.keyField] !== canon[spec.keyField]) {
        throw invalid(`${spec.keyField} identifies the canonical ${spec.type} and cannot change in a revision`);
      }
      input = { ...input, [spec.keyField]: canon[spec.keyField] };
    }
    return spec.normalize(input);
  };

  /**
   * Insert a draft/proposal revision of an accepted row; the caller has checked lock and
   * open revisions. Every revision-producing path comes through here, so every revision
   * records the target's revision *now* as its base — including a draft whose content
   * came from older history — and accept can refuse it once the target moves on.
   */
  const insertRevision = async (tx, spec, canon, normalized, { state, provenance, proposalJson = null }) => {
    const newId = await insertRow(tx, spec, {
      ...normalized.columns,
      lifecycle_state: state,
      provenance,
      proposal_json: proposalJson,
      revises_id: canon.id,
      base_revision: canon.revision,
    });
    if (spec.hasMembers) await writeMembers(tx, newId, normalized.members, normalized.columns.scope_kind, false);
    return newId;
  };

  // ── reads ──────────────────────────────────────────────────────────────────

  const parseStates = (raw) => {
    if (raw === undefined || raw === null || raw === '') return ['accepted'];
    const states = String(raw).split(',').map(s => s.trim()).filter(Boolean);
    for (const s of states) {
      if (!LIFECYCLE_STATES.includes(s)) throw invalid(`states must be a comma-separated subset of ${LIFECYCLE_STATES.join(', ')}`);
    }
    return states.length ? [...new Set(states)] : ['accepted'];
  };

  const list = (entity, states) => {
    const spec = specFor(entity);
    return readOnly(async (q) => {
      const rows = await q.all(
        `SELECT * FROM ${spec.table} WHERE lifecycle_state IN (${states.map(() => '?').join(', ')}) ORDER BY id`, states);
      const out = [];
      for (const row of rows) out.push(await record(q, spec, row));
      return out;
    });
  };

  const getOne = (entity, rawId) => {
    const spec = specFor(entity);
    const id = parseId(rawId);
    return readOnly(async (q) => record(q, spec, await requireRow(q, spec, id)));
  };

  const history = (entity, rawId) => {
    const spec = specFor(entity);
    const id = parseId(rawId);
    return readOnly(async (q) => {
      await requireRow(q, spec, id);
      const rows = await q.all(
        `SELECT * FROM canonical_revisions WHERE entity_type = ? AND entity_id = ? ORDER BY id`, [spec.type, id]);
      return rows.map(r => ({
        id: r.id,
        entity_type: r.entity_type,
        entity_id: r.entity_id,
        revision: r.revision,
        change_kind: r.change_kind,
        snapshot: JSON.parse(r.snapshot_json),
        created_at: r.created_at,
      }));
    });
  };

  /**
   * GET /anchors/register — the must-exist checklist (plan §5.1, §7.2): every accepted
   * anchor with its derived placement. Placement is never stored: an anchor is `placed`
   * exactly when at least one accepted part exists (plan §3.3). Accepted data only, like
   * every public read — draft parts do not place an anchor and are not listed here.
   */
  const anchorRegister = () => readOnly(async (q) => {
    const anchorRows = await q.all(`SELECT * FROM canonical_anchors WHERE lifecycle_state = 'accepted' ORDER BY id`);
    const parts = await q.all(
      `SELECT id, anchor_id, revision, feature_class, geometry_type, part_role, constraint_strength
         FROM canonical_features WHERE lifecycle_state = 'accepted' AND anchor_id IS NOT NULL ORDER BY id`);
    const scopeRows = await q.all(
      `SELECT id, scope_key, scope_kind, name FROM geo_scopes WHERE lifecycle_state = 'accepted'`);
    const scopesById = new Map(scopeRows.map(s => [s.id, s]));

    const anchorsOut = anchorRows.map((a) => {
      const own = parts.filter(p => p.anchor_id === a.id);
      const byRole = {};
      for (const p of own) {
        const role = p.part_role || 'unspecified';
        byRole[role] = (byRole[role] || 0) + 1;
      }
      const scope = a.required_scope_id ? scopesById.get(a.required_scope_id) : null;
      return {
        id: a.id,
        anchor_key: a.anchor_key,
        name: a.name,
        category: a.category,
        constraint_strength: a.constraint_strength,
        must_exist: !!a.must_exist,
        replacement_state: a.replacement_state,
        is_locked: !!a.is_locked,
        revision: a.revision,
        required_scope_id: a.required_scope_id,
        // Only accepted scopes are named on a public read; an unaccepted one is reported as such.
        required_scope: a.required_scope_id
          ? (scope ? { id: scope.id, scope_key: scope.scope_key, scope_kind: scope.scope_kind, name: scope.name, accepted: true }
            : { id: a.required_scope_id, accepted: false })
          : null,
        status: own.length ? 'placed' : 'unplaced',
        placed: own.length > 0,
        part_summary: {
          count: own.length,
          by_role: byRole,
          parts: own.map(p => ({
            feature_id: p.id, revision: p.revision, feature_class: p.feature_class, geometry_type: p.geometry_type,
            part_role: p.part_role, constraint_strength: p.constraint_strength,
          })),
        },
      };
    });
    const unplaced = anchorsOut.filter(a => !a.placed);
    return {
      anchors: anchorsOut,
      summary: {
        total: anchorsOut.length,
        placed: anchorsOut.length - unplaced.length,
        unplaced: unplaced.length,
        unplaced_must_exist: unplaced.filter(a => a.must_exist).map(a => a.id),
      },
    };
  });

  // ── creation: drafts (editor) and proposals (software) ────────────────────

  /** POST /:entity — a draft, never canon. Generated provenance belongs on /proposals. */
  const createDraft = (entity, body) => {
    const spec = specFor(entity);
    if (!isPlainObject(body)) throw invalid('request body must be an object');
    const { provenance = 'authored', ...fields } = body;
    if (provenance === 'generated') {
      throw invalid('generated content must be submitted through POST /proposals, not created as a draft');
    }
    if (!EDITOR_PROVENANCE.includes(provenance)) throw invalid(`provenance must be one of ${EDITOR_PROVENANCE.join(', ')}`);
    refuseUnknown(spec, fields);
    if (isRadialSpoke(fields.construction)) throw invalid(RADIAL_ONLY);
    const normalized = spec.normalize(fields);

    return transact(async (tx) => {
      if (spec.keyField) await refuseTakenKey(tx, spec, normalized.columns[spec.keyField]);
      const newId = await insertRow(tx, spec, { ...normalized.columns, lifecycle_state: 'draft', provenance });
      if (spec.hasMembers) await writeMembers(tx, newId, normalized.members, normalized.columns.scope_kind, false);
      return record(tx, spec, await loadRow(tx, spec, newId));
    });
  };

  /**
   * POST /proposals — the software/AI channel. Creates `proposed` rows with generated
   * provenance and required proposal metadata; with `revises_id` it proposes a revision
   * of accepted canon (its fields overlay the canonical row's). It can never accept, lock
   * or change replacement state. A proposal against a locked row is stored, but cannot be
   * accepted until the row is unlocked.
   */
  const createProposal = (body) => {
    if (!isPlainObject(body)) throw invalid('request body must be an object');
    const { entity, provenance, proposal, revises_id: revisesId, ...fields } = body;
    const spec = ENTITIES[entity];
    if (!spec) throw invalid(`entity must be one of ${Object.keys(ENTITIES).join(', ')}`);
    if (provenance !== 'generated') throw invalid('proposals must declare provenance "generated"');
    const proposalJson = normalizeProposal(proposal);
    refuseUnknown(spec, fields);
    if (isRadialSpoke(fields.construction)) throw invalid(RADIAL_ONLY);
    if (revisesId !== undefined && revisesId !== null && (!Number.isInteger(revisesId) || revisesId <= 0)) {
      throw invalid('revises_id must be a positive integer id');
    }

    return transact(async (tx) => {
      let newId;
      if (revisesId) {
        const canon = await loadRow(tx, spec, revisesId);
        if (!canon) throw notFound(`${spec.type} #${revisesId} not found`);
        if (canon.lifecycle_state !== 'accepted') {
          throw conflict(`a proposal can revise only accepted canon; ${spec.type} #${revisesId} is ${canon.lifecycle_state}`);
        }
        await refuseOpenRevision(tx, spec, canon.id, 'proposed');
        const base = toInput(spec, await record(tx, spec, canon));
        const normalized = normalizeRevision(spec, canon, { ...base, ...fields });
        // An inherited radial record may ride along only over the canonical geometry.
        if (spec.entity === 'features') guardRadialRecord(normalized.columns, canon);
        newId = await insertRevision(tx, spec, canon, normalized, { state: 'proposed', provenance: 'generated', proposalJson });
      } else {
        const normalized = spec.normalize(fields);
        if (spec.keyField) await refuseTakenKey(tx, spec, normalized.columns[spec.keyField]);
        newId = await insertRow(tx, spec, {
          ...normalized.columns, lifecycle_state: 'proposed', provenance: 'generated', proposal_json: proposalJson,
        });
        if (spec.hasMembers) await writeMembers(tx, newId, normalized.members, normalized.columns.scope_kind, false);
      }
      return record(tx, spec, await loadRow(tx, spec, newId));
    });
  };

  // ── editing ────────────────────────────────────────────────────────────────

  /**
   * PATCH /:entity/:id.
   *
   * Drafts and proposals: any entity field, re-validated as a whole, bumping draft_version.
   * Accepted: descriptive fields only, and only while unlocked; anything else is 409 with
   * a pointer to revise. Retired: nothing.
   */
  const patch = (entity, rawId, body) => {
    const spec = specFor(entity);
    const id = parseId(rawId);
    if (!isPlainObject(body)) throw invalid('request body must be an object');
    const { expected_draft_version: expected, ...fields } = body;
    refuseUnknown(spec, fields);
    if (!Object.keys(fields).length) throw invalid('No editable fields supplied');

    return transact(async (tx) => {
      const row = await requireRow(tx, spec, id);

      if (OPEN_STATES.includes(row.lifecycle_state)) {
        if (expected !== undefined && expected !== row.draft_version) {
          throw conflict(`draft_version is ${row.draft_version}, not ${expected}; reload before editing`,
            { draft_version: row.draft_version });
        }
        const merged = { ...toInput(spec, await record(tx, spec, row)), ...fields };
        let normalized;
        if (row.revises_id) {
          normalized = normalizeRevision(spec, await loadRow(tx, spec, row.revises_id) || row, merged);
        } else {
          normalized = spec.normalize(merged);
          if (spec.keyField) await refuseTakenKey(tx, spec, normalized.columns[spec.keyField], id);
        }
        // A radial record stays only while it still describes the stored geometry (plan §15.8).
        if (spec.entity === 'features') guardRadialRecord(normalized.columns, row);
        await updateRow(tx, spec, id, { ...normalized.columns, draft_version: row.draft_version + 1 });
        if (spec.hasMembers) await writeMembers(tx, id, normalized.members, normalized.columns.scope_kind, false);
        return record(tx, spec, await loadRow(tx, spec, id));
      }

      if (row.lifecycle_state === 'retired') {
        throw conflict(`${spec.type} #${id} is retired; restore it before editing`);
      }

      // Accepted: in place only for descriptive fields.
      const constraintTouched = Object.keys(fields).filter(f => !DESCRIPTIVE_FIELDS.includes(f));
      if (row.is_locked) throw conflict(lockedMessage(spec, id, 'editing it'));
      if (constraintTouched.length) {
        throw conflict(
          `${constraintTouched.join(', ')} cannot be edited in place on accepted canon; `
          + `create a revision (POST …/${id}/revise), edit it, and accept it`);
      }
      const nameRequired = spec.entity === 'anchors' || spec.entity === 'scopes';
      const updates = {};
      for (const f of Object.keys(fields)) {
        updates[f] = f === 'name'
          ? text(fields[f], 'name', { max: NAME_MAX, required: nameRequired })
          : text(fields[f], f);
      }
      await updateRow(tx, spec, id, updates);
      await writeHistory(tx, spec, id, 'descriptive_edit');
      return record(tx, spec, await loadRow(tx, spec, id));
    });
  };

  /** POST /:entity/:id/revise — a draft copy of accepted canon, carrying `revises_id`. */
  const revise = (entity, rawId) => {
    const spec = specFor(entity);
    const id = parseId(rawId);
    return transact(async (tx) => {
      const canon = await requireRow(tx, spec, id);
      if (canon.lifecycle_state !== 'accepted') {
        throw conflict(`only accepted canon can be revised; ${spec.type} #${id} is ${canon.lifecycle_state}`);
      }
      if (canon.is_locked) throw conflict(lockedMessage(spec, id, 'revising it'));
      await refuseOpenRevision(tx, spec, id, 'draft');
      const normalized = normalizeRevision(spec, canon, toInput(spec, await record(tx, spec, canon)));
      const newId = await insertRevision(tx, spec, canon, normalized, { state: 'draft', provenance: 'authored' });
      return record(tx, spec, await loadRow(tx, spec, newId));
    });
  };

  /**
   * POST /:entity/:id/revisions/:rev/draft — a draft revision from a historical accepted
   * snapshot. It is an ordinary draft: it becomes canon only through accept, with the same
   * validation, so history is never a way around it.
   */
  const draftFromHistory = (entity, rawId, rawRev) => {
    const spec = specFor(entity);
    const id = parseId(rawId);
    const rev = Number(rawRev);
    if (!Number.isInteger(rev) || rev < 1 || String(rev) !== String(rawRev)) throw notFound('revision not found');
    return transact(async (tx) => {
      const canon = await requireRow(tx, spec, id);
      if (canon.lifecycle_state !== 'accepted') {
        throw conflict(`${spec.type} #${id} is ${canon.lifecycle_state}; only accepted canon can take a draft from its history`
          + (canon.lifecycle_state === 'retired' ? ' (restore it first)' : ''));
      }
      if (canon.is_locked) throw conflict(lockedMessage(spec, id, 'drafting a revision of it'));
      const hist = await tx.get(
        `SELECT snapshot_json FROM canonical_revisions
          WHERE entity_type = ? AND entity_id = ? AND revision = ? AND change_kind = 'accept' ORDER BY id DESC LIMIT 1`,
        [spec.type, id, rev]);
      if (!hist) throw notFound(`${spec.type} #${id} has no accepted revision ${rev}`);
      await refuseOpenRevision(tx, spec, id, 'draft');
      const normalized = normalizeRevision(spec, canon, toInput(spec, JSON.parse(hist.snapshot_json)));
      const newId = await insertRevision(tx, spec, canon, normalized, { state: 'draft', provenance: 'authored' });
      return record(tx, spec, await loadRow(tx, spec, newId));
    });
  };

  /** DELETE /:entity/:id — drafts and proposals only; canon, current or retired, is never deleted. */
  const deleteDraft = (entity, rawId) => {
    const spec = specFor(entity);
    const id = parseId(rawId);
    return transact(async (tx) => {
      const row = await requireRow(tx, spec, id);
      if (!OPEN_STATES.includes(row.lifecycle_state)) {
        throw conflict(`${spec.type} #${id} is ${row.lifecycle_state}; canonical records are retired, never deleted`);
      }
      await tx.run(`DELETE FROM ${spec.table} WHERE id = ?`, [id]);
      if (spec.hasMembers) await tx.run('DELETE FROM geo_scope_members WHERE scope_id = ?', [id]);
      return { id, deleted: true };
    });
  };

  // ── canonization ───────────────────────────────────────────────────────────

  /**
   * POST /:entity/:id/accept — the only path to canon.
   *
   * The caller states the draft_version it reviewed, so what is accepted is what was shown.
   * A draft/proposal with `revises_id` rewrites the canonical row (same id, revision + 1)
   * and is then deleted; one without becomes accepted at revision 1. Provenance of the
   * canonical row is never rewritten; the accepted source is recorded in history.
   */
  const accept = (entity, rawId, body) => {
    const spec = specFor(entity);
    const id = parseId(rawId);
    const expected = isPlainObject(body) ? body.expected_draft_version : undefined;
    if (!Number.isInteger(expected)) throw invalid('expected_draft_version is required');
    if (isPlainObject(body)) {
      const extra = Object.keys(body).filter(k => k !== 'expected_draft_version');
      if (extra.length) throw invalid(`accept takes only expected_draft_version (got ${extra.join(', ')})`);
    }

    return transact(async (tx) => {
      const row = await requireRow(tx, spec, id);
      if (!OPEN_STATES.includes(row.lifecycle_state)) {
        throw conflict(`only drafts and proposals can be accepted; ${spec.type} #${id} is ${row.lifecycle_state}`);
      }
      if (row.draft_version !== expected) {
        throw conflict(`draft_version is ${row.draft_version}, not ${expected}; review the current draft before accepting`,
          { draft_version: row.draft_version });
      }
      const members = spec.hasMembers ? await loadMembers(tx, id) : [];

      let canon = null;
      if (row.revises_id) {
        canon = await loadRow(tx, spec, row.revises_id);
        if (!canon) throw conflict(`the canonical ${spec.type} #${row.revises_id} this revises no longer exists`);
        if (canon.lifecycle_state !== 'accepted') {
          throw conflict(`${spec.type} #${canon.id} is ${canon.lifecycle_state}; restore it before accepting a revision of it`);
        }
        if (canon.is_locked) throw conflict(lockedMessage(spec, canon.id, 'accepting a revision of it'));
        // Optimistic concurrency: a revision built against an older canonical revision
        // (or one whose base is unknown) must not replace newer canon. It is kept, not
        // deleted or rebased, so it can be inspected and redone from current canon.
        if (row.base_revision !== canon.revision) {
          throw conflict(
            `${spec.type} #${id} was built against revision ${row.base_revision ?? 'unknown'} of ${spec.type} #${canon.id}, `
            + `which is now at revision ${canon.revision}; create a new revision from current canon`,
            { code: 'stale_revision', base_revision: row.base_revision, current_revision: canon.revision });
        }
      }
      const canonicalId = canon ? canon.id : id;

      const { violations, warnings } = await validateAccept(tx, spec, row, canonicalId,
        { members, target: canon || row, isRevision: !!canon });
      if (violations.length) {
        throw conflict(`cannot accept ${spec.type} #${id}: ${violations.length} cross-feature violation(s)`,
          { violations, warnings });
      }

      const source = {
        draft_id: id,
        lifecycle_state: row.lifecycle_state,
        provenance: row.provenance,
        proposal: row.proposal_json ? JSON.parse(row.proposal_json) : null,
      };

      if (canon) {
        const columns = {};
        for (const c of spec.acceptedColumns) columns[c] = row[c];
        await updateRow(tx, spec, canon.id, { ...columns, revision: canon.revision + 1, accepted_at: NOW });
        if (spec.hasMembers) {
          await writeMembers(tx, canon.id, members, row.scope_kind, true);
          await tx.run('DELETE FROM geo_scope_members WHERE scope_id = ?', [id]);
        }
        await tx.run(`DELETE FROM ${spec.table} WHERE id = ?`, [id]);
      } else {
        await updateRow(tx, spec, id, { lifecycle_state: 'accepted', revision: 1, accepted_at: NOW });
        if (spec.hasMembers) {
          await tx.run('UPDATE geo_scope_members SET is_canonical = 1, scope_kind = ? WHERE scope_id = ?', [row.scope_kind, id]);
        }
      }
      await writeHistory(tx, spec, canonicalId, 'accept', { accepted_from: source });
      return { record: await record(tx, spec, await loadRow(tx, spec, canonicalId)), warnings };
    });
  };

  /** POST /:entity/:id/retire — accepted → retired; unlocked only, and never out from under accepted dependents. */
  const retire = (entity, rawId) => {
    const spec = specFor(entity);
    const id = parseId(rawId);
    return transact(async (tx) => {
      const row = await requireRow(tx, spec, id);
      if (row.lifecycle_state !== 'accepted') {
        throw conflict(`only accepted canon can be retired; ${spec.type} #${id} is ${row.lifecycle_state}`);
      }
      if (row.is_locked) throw conflict(lockedMessage(spec, id, 'retiring it'));
      const dependents = await findDependents(tx, spec, id);
      if (dependents.length) {
        throw conflict(`${spec.type} #${id} has ${dependents.length} accepted dependent(s); retire or revise them first`,
          { dependents });
      }
      const { violations } = await validateRetire(tx, spec, row);
      if (violations.length) {
        throw conflict(`cannot retire ${spec.type} #${id}: ${violations.length} accepted record(s) would become invalid`,
          { violations });
      }
      await updateRow(tx, spec, id, { lifecycle_state: 'retired' });
      // A retired scope no longer holds its islands: the membership-uniqueness index
      // counts canonical rows only.
      if (spec.hasMembers) await tx.run('UPDATE geo_scope_members SET is_canonical = 0 WHERE scope_id = ?', [id]);
      await writeHistory(tx, spec, id, 'retire');
      return record(tx, spec, await loadRow(tx, spec, id));
    });
  };

  /** POST /:entity/:id/restore — retired → accepted, only if it would pass accept validation today. */
  const restore = (entity, rawId) => {
    const spec = specFor(entity);
    const id = parseId(rawId);
    return transact(async (tx) => {
      const row = await requireRow(tx, spec, id);
      if (row.lifecycle_state !== 'retired') {
        throw conflict(`only retired canon can be restored; ${spec.type} #${id} is ${row.lifecycle_state}`);
      }
      const members = spec.hasMembers ? await loadMembers(tx, id) : [];
      const { violations, warnings } = await validateAccept(tx, spec, row, id, { members, target: row, isRevision: false });
      if (violations.length) {
        throw conflict(`cannot restore ${spec.type} #${id}: ${violations.length} cross-feature violation(s)`,
          { violations, warnings });
      }
      await updateRow(tx, spec, id, { lifecycle_state: 'accepted' });
      if (spec.hasMembers) await tx.run('UPDATE geo_scope_members SET is_canonical = 1 WHERE scope_id = ?', [id]);
      await writeHistory(tx, spec, id, 'restore');
      return { record: await record(tx, spec, await loadRow(tx, spec, id)), warnings };
    });
  };

  // ── protection and replacement ─────────────────────────────────────────────

  /** A dedicated request carries exactly one field, so it cannot smuggle another change in. */
  const soleField = (body, field) => {
    if (!isPlainObject(body)) throw invalid('request body must be an object');
    const keys = Object.keys(body);
    if (keys.length !== 1 || keys[0] !== field) {
      throw invalid(`this request takes only ${field}; any other change must be its own request`);
    }
    return body[field];
  };

  /** PATCH /:entity/:id/lock — its own request; unlocking is never combined with another change. */
  const setLock = (entity, rawId, body) => {
    const spec = specFor(entity);
    const id = parseId(rawId);
    const value = soleField(body, 'is_locked');
    if (typeof value !== 'boolean') throw invalid('is_locked must be true or false');
    return transact(async (tx) => {
      const row = await requireRow(tx, spec, id);
      if (row.lifecycle_state !== 'accepted') {
        throw conflict(`only accepted canon can be locked or unlocked; ${spec.type} #${id} is ${row.lifecycle_state}`);
      }
      if (!!row.is_locked === value) throw conflict(`${spec.type} #${id} is already ${value ? 'locked' : 'unlocked'}`);
      await updateRow(tx, spec, id, { is_locked: value ? 1 : 0 });
      await writeHistory(tx, spec, id, value ? 'lock' : 'unlock');
      return record(tx, spec, await loadRow(tx, spec, id));
    });
  };

  /** PATCH /:entity/:id/replacement — its own request; refused while locked and for must_exist anchors. */
  const setReplacement = (entity, rawId, body) => {
    const spec = specFor(entity);
    const id = parseId(rawId);
    const value = soleField(body, 'replacement_state');
    if (!REPLACEMENT_STATES.includes(value)) throw invalid(`replacement_state must be one of ${REPLACEMENT_STATES.join(', ')}`);
    return transact(async (tx) => {
      const row = await requireRow(tx, spec, id);
      if (row.lifecycle_state !== 'accepted') {
        throw conflict(`replacement state applies to accepted canon; ${spec.type} #${id} is ${row.lifecycle_state}`);
      }
      if (row.is_locked) throw conflict(lockedMessage(spec, id, 'changing its replacement state'));
      if (spec.entity === 'anchors' && row.must_exist && value === 'replaceable') {
        throw conflict(`anchor "${row.anchor_key}" is must_exist and can never be replaceable`);
      }
      if (row.replacement_state === value) throw conflict(`${spec.type} #${id} is already ${value}`);
      await updateRow(tx, spec, id, { replacement_state: value });
      await writeHistory(tx, spec, id, 'replacement_change');
      return record(tx, spec, await loadRow(tx, spec, id));
    });
  };

  // ── radial construction (plan §15) ─────────────────────────────────────────

  /**
   * POST /constructions/radial — exact radial spokes between two accepted closed
   * boundaries, persisted only as drafts, all or nothing.
   *
   * Inputs are only read: construction never modifies, locks, revises or retires one.
   * Every input is pinned to the revision the editor previewed; a moved input is `stale`.
   *
   * New-drafts mode inserts one `authored` draft per non-omitted spoke under a new
   * construction_id. Revision mode (`revises`) creates a draft revision of each accepted
   * spoke of one construction — replacing only geometry and construction — and only if
   * the request keeps that construction's count and omissions and names every accepted
   * sibling; otherwise it refuses with the full list and writes nothing. Nothing is ever
   * accepted here; acceptance stays the per-record accept route.
   *
   * `dry_run` runs the same reads and checks without writing and answers the report.
   */
  const constructRadial = (body) => {
    const req = parseRadialRequest(body);
    const spec = ENTITIES.features;

    const work = async (q) => {
      const errors = [];
      const input = async (role, ref) => {
        const label = `${INPUT_WORDS[role]} (feature #${ref.feature_id})`;
        const row = await loadRow(q, spec, ref.feature_id);
        if (!row) {
          errors.push({ code: 'not_found', input: role, feature_id: ref.feature_id, message: `${label} was not found.` });
          return null;
        }
        if (row.lifecycle_state !== 'accepted') {
          errors.push({ code: 'not_accepted', input: role, feature_id: row.id, lifecycle_state: row.lifecycle_state,
            message: `${label} is ${row.lifecycle_state}; construction reads accepted canon only. Accept it first.` });
          return null;
        }
        if (row.revision !== ref.expected_revision) {
          errors.push({ code: 'stale_input', input: role, feature_id: row.id, expected_revision: ref.expected_revision,
            current_revision: row.revision,
            message: `${label} changed from revision ${ref.expected_revision} to ${row.revision} since preview. Refresh the preview, review it and create again.` });
          return null;
        }
        return row;
      };
      const ringOf = (role, row) => {
        if (!row) return null;
        const r = radial.boundaryRing(row.geometry_type, JSON.parse(row.geometry_json));
        if (r.ok) return r.ring;
        errors.push({ code: 'ineligible_input', input: role, feature_id: row.id,
          message: `${INPUT_WORDS[role]} (feature #${row.id}) is not a closed boundary: ${r.reason}.` });
        return null;
      };

      if (req.inner.kind === 'feature' && req.outer.kind === 'feature' && req.inner.feature_id === req.outer.feature_id) {
        errors.push({ code: 'same_input', input: 'outer', feature_id: req.outer.feature_id,
          message: `The inner and outer boundary are the same feature (#${req.inner.feature_id}); choose two different boundaries.` });
      }
      // A feature boundary is read at its pinned revision; an inline circle was recomputed from its definition.
      const boundary = async (role, src) => {
        if (src.kind === 'circle') return { ring: src.ring, record: src.record, label: `${role} boundary (constructed circle)` };
        const row = await input(role, src);
        const ring = ringOf(role, row);
        return { ring, record: row ? { feature_id: row.id, revision: row.revision } : null, label: `${role} boundary (feature #${src.feature_id})` };
      };
      const innerSrc = await boundary('inner', req.inner);
      const outerSrc = await boundary('outer', req.outer);
      const innerRing = innerSrc.ring;
      const outerRing = outerSrc.ring;

      let center = req.center;
      let centerSource = { kind: 'coordinate' };
      if (req.centerSource.kind !== 'coordinate') {
        const row = await input('center', req.centerSource);
        if (row) {
          const geometry = JSON.parse(row.geometry_json);
          const construction = row.construction_json ? JSON.parse(row.construction_json) : null;
          if (req.centerSource.kind === 'feature_point') {
            if (row.geometry_type === 'point') center = geometry;
          } else if (construction && ['circle', 'ellipse'].includes(construction.type) && isPlainObject(construction.center)
            && Number.isFinite(construction.center.x) && Number.isFinite(construction.center.z)) {
            center = construction.center;
          }
          if (center) {
            center = radial.roundPoint(center);
            centerSource = { kind: req.centerSource.kind, feature_id: row.id, revision: row.revision };
          } else {
            errors.push({ code: 'ineligible_input', input: 'center', feature_id: row.id,
              message: req.centerSource.kind === 'feature_point'
                ? `Center feature #${row.id} is a ${row.geometry_type}, not a point.`
                : `Feature #${row.id} has no circle or ellipse construction to take a center from.` });
          }
        }
      }

      const normalized = { center: center || null, count: req.count, offset_deg: req.offset_deg, omit_indices: req.omit_indices };
      let report = { ok: false, normalized, errors, spokes: [] };
      if (!errors.length) {
        report = radial.computeRadial({
          center, inner: innerRing, outer: outerRing, count: req.count, offset_deg: req.offset_deg, omit_indices: req.omit_indices,
          labels: { inner: innerSrc.label, outer: outerSrc.label },
        });
      }

      let targets = [];
      let constructionId = null;
      if (req.revises) ({ targets, constructionId } = await checkRevisionTargets(q, req, report.errors));

      const mode = req.revises ? 'revision' : 'new_drafts';
      const refs = { center, centerSource, inner: innerSrc.record, outer: outerSrc.record };
      return { report, mode, targets, constructionId, refs };
    };

    if (req.dry_run) {
      return readOnly(async (q) => {
        const { report, mode } = await work(q);
        const boundaryDrafts = ['inner', 'outer'].filter(r => req[r].materialize)
          .map(role => ({ role, feature_class: req[role].materialize.columns.feature_class, geometry_type: req[role].materialize.columns.geometry_type }));
        return { ...report, ok: report.ok && !report.errors.length, mode, dry_run: true, boundary_drafts: boundaryDrafts };
      });
    }

    return transact(async (tx) => {
      const { report, mode, targets, constructionId: keptId, refs } = await work(tx);
      if (report.errors.length) {
        const status = report.errors.some(e => e.code === 'not_found') ? 404 : 409;
        throw new CanonicalError(status, `radial construction refused: ${report.errors.map(e => e.message).join(' ')}`,
          { ...report, ok: false, mode });
      }
      const invalidSpokes = report.spokes.filter(s => s.status === 'invalid');
      if (invalidSpokes.length) {
        throw conflict(`radial construction refused: ${invalidSpokes.length} spoke(s) invalid; nothing was written. `
          + (mode === 'revision' ? 'In revision mode an invalid spoke can be fixed only through the offset, the center or the boundaries.'
            : 'Omit them explicitly, change the offset or count, or revise a boundary.'),
        { ...report, ok: false, mode });
      }

      const constructionId = keptId || crypto.randomUUID();
      // Materialized boundaries: ordinary independent drafts, written in this same
      // transaction. The spokes record the circle definition, not a dependency on these rows;
      // the id is noted only as what this request created.
      const boundaryFeatures = [];
      const boundaryRef = { inner: refs.inner, outer: refs.outer };
      for (const role of ['inner', 'outer']) {
        const m = req[role].kind === 'circle' ? req[role].materialize : null;
        if (!m) continue;
        const id = await insertRow(tx, spec, { ...m.columns, lifecycle_state: 'draft', provenance: 'authored' });
        boundaryFeatures.push({ role, feature: await record(tx, spec, await loadRow(tx, spec, id)) });
        boundaryRef[role] = { ...refs[role], materialized_feature_id: id };
      }
      const recordFor = (spoke) => ({
        type: 'radial_spoke',
        version: 1,
        construction_id: constructionId,
        center: report.normalized.center,
        center_source: refs.centerSource,
        inner: boundaryRef.inner,
        outer: boundaryRef.outer,
        count: req.count,
        offset_deg: req.offset_deg,
        omit_indices: req.omit_indices,
        index: spoke.index,
        angle_deg: spoke.angle_deg,
        angle_convention: radial.ANGLE_CONVENTION,
      });
      const valid = report.spokes.filter(s => s.status === 'valid');
      const created = [];
      if (mode === 'revision') {
        const byIndex = new Map(valid.map(s => [s.index, s]));
        for (const canon of targets) {
          const spoke = byIndex.get(JSON.parse(canon.construction_json).index);
          const base = toInput(spec, await record(tx, spec, canon));
          const normalizedRev = normalizeRevision(spec, canon, { ...base, geometry: spoke.geometry, construction: recordFor(spoke) });
          const newId = await insertRevision(tx, spec, canon, normalizedRev, { state: 'draft', provenance: 'authored' });
          created.push(await record(tx, spec, await loadRow(tx, spec, newId)));
        }
      } else {
        const out = req.output;
        for (const spoke of valid) {
          const normalizedNew = spec.normalize({
            feature_class: out.feature_class,
            kind: out.kind,
            geometry_type: 'linestring',
            geometry: spoke.geometry,
            construction: recordFor(spoke),
            attributes: out.width_wu !== null ? { width_wu: out.width_wu } : null,
            constraint_strength: out.constraint_strength,
            name: `${out.name_prefix} #${spoke.index}`,
          });
          const newId = await insertRow(tx, spec, { ...normalizedNew.columns, lifecycle_state: 'draft', provenance: 'authored' });
          created.push(await record(tx, spec, await loadRow(tx, spec, newId)));
        }
      }
      return { ...report, ok: true, mode, construction_id: constructionId, features: created, boundary_features: boundaryFeatures };
    });
  };

  /**
   * Revision-mode integrity (plan §15.9), re-checked inside the construct transaction.
   * Every problem is pushed onto `errors`, so a refusal lists all of them at once.
   */
  const checkRevisionTargets = async (q, req, errors) => {
    const spec = ENTITIES.features;
    const push = (code, message, extra = {}) => errors.push({ code, message, ...extra });
    const targets = [];
    const records = [];
    for (const r of req.revises) {
      const row = await loadRow(q, spec, r.feature_id);
      const label = `Spoke ${r.index} (feature #${r.feature_id})`;
      if (!row) { push('revision_target_missing', `${label} was not found.`, { index: r.index, feature_id: r.feature_id }); continue; }
      if (row.lifecycle_state !== 'accepted') {
        push('revision_target_not_accepted', `${label} is ${row.lifecycle_state}; revision mode revises accepted spokes only. Edit or delete drafts directly.`,
          { index: r.index, feature_id: row.id });
        continue;
      }
      const rec = row.construction_json ? JSON.parse(row.construction_json) : null;
      if (!isRadialSpoke(rec)) {
        push('revision_not_radial', `${label} carries no radial construction record.`, { index: r.index, feature_id: row.id });
        continue;
      }
      if (row.revision !== r.expected_revision) {
        push('revision_target_stale', `${label} changed from revision ${r.expected_revision} to ${row.revision}; reload and reconstruct.`,
          { index: r.index, feature_id: row.id, expected_revision: r.expected_revision, current_revision: row.revision });
      }
      if (row.is_locked) {
        push('revision_target_locked', `${label} is locked. Unlock it (its own request) before reconstructing in revision mode.`,
          { index: r.index, feature_id: row.id });
      }
      const open = await q.get(`SELECT id FROM canonical_features WHERE revises_id = ? AND lifecycle_state = 'draft'`, [row.id]);
      if (open) {
        push('revision_open_revision', `${label} already has an open draft revision (#${open.id}); accept or delete it first.`,
          { index: r.index, feature_id: row.id, open_revision_id: open.id });
      }
      if (rec.index !== r.index) {
        push('revision_index_mismatch', `${label} is recorded as spoke ${rec.index}, not ${r.index}.`,
          { index: r.index, feature_id: row.id, recorded_index: rec.index });
      }
      targets.push(row);
      records.push(rec);
    }
    if (!records.length) return { targets, constructionId: null };

    const ids = [...new Set(records.map(r => r.construction_id))];
    if (ids.length > 1) {
      push('revision_construction_mismatch', `The targets belong to ${ids.length} different constructions; revision mode reconstructs one construction at a time.`,
        { construction_ids: ids });
    }
    const first = records[0];
    const sameSet = (r) => r.count === first.count && JSON.stringify(r.omit_indices) === JSON.stringify(first.omit_indices);
    if (!records.every(sameSet)) {
      push('revision_records_disagree', 'The targets\' construction records disagree on count or omitted indices; use new-drafts mode.');
    } else {
      if (req.count !== first.count) {
        push('revision_count_mismatch', `The construction has ${first.count} spokes; changing the count to ${req.count} is a different set of spokes. Use new-drafts mode.`,
          { recorded_count: first.count, requested_count: req.count });
      }
      if (JSON.stringify(req.omit_indices) !== JSON.stringify(first.omit_indices)) {
        push('revision_omit_mismatch', `The construction omits [${first.omit_indices.join(', ')}]; changing omissions to [${req.omit_indices.join(', ')}] is a different set of spokes. Use new-drafts mode.`,
          { recorded_omit_indices: first.omit_indices, requested_omit_indices: req.omit_indices });
      }
    }

    // Exactly one target per non-omitted index of the requested set.
    const omitted = new Set(req.omit_indices);
    const wanted = [];
    for (let n = 0; n < req.count; n++) if (!omitted.has(n)) wanted.push(n);
    const given = req.revises.map(r => r.index);
    const missing = wanted.filter(n => !given.includes(n));
    const extra = [...new Set(given.filter(n => !wanted.includes(n)))];
    const repeated = [...new Set(given.filter((n, k) => given.indexOf(n) !== k))];
    if (missing.length) push('revision_missing_index', `No target given for spoke index(es) ${missing.join(', ')}.`, { indices: missing });
    if (extra.length) push('revision_index_mismatch', `Spoke index(es) ${extra.join(', ')} are not part of this construction's spoke set.`, { indices: extra });
    if (repeated.length) push('revision_duplicate_index', `Spoke index(es) ${repeated.join(', ')} are named more than once.`, { indices: repeated });

    // Every accepted spoke of the construction must be in the set, so none is left behind.
    if (ids.length === 1) {
      const named = new Set(req.revises.map(r => r.feature_id));
      const rows = await q.all(
        `SELECT id, construction_json FROM canonical_features WHERE lifecycle_state = 'accepted' AND construction_json LIKE ? ORDER BY id`,
        ['%radial_spoke%']);
      const left = rows.filter(row => {
        const rec = JSON.parse(row.construction_json);
        return isRadialSpoke(rec) && rec.construction_id === ids[0] && !named.has(row.id);
      });
      if (left.length) {
        push('revision_missing_sibling',
          `Accepted spoke(s) ${left.map(row => `#${row.id} (spoke ${JSON.parse(row.construction_json).index})`).join(', ')} of this construction are missing from the revision; revision mode must include every accepted spoke of the construction.`,
          { feature_ids: left.map(row => row.id) });
      }
    }
    return { targets, constructionId: ids[0] };
  };

  // ── generator-facing query ─────────────────────────────────────────────────

  /**
   * POST /query — accepted canon only, read on the canonical connection inside the store
   * queue, so a bundle never observes half of a canonical write.
   */
  const query = (body) => readOnly((q) => runQuery(q, body));

  return {
    /** The connection canonical transactions run on, and whether it is separate from the app's. */
    connection: db,
    dedicated: db !== appDb,
    /** Close a connection this store opened; a supplied or shared one is left to its owner. */
    close: () => exclusive(() => new Promise((resolve, reject) => {
      if (!owned) return resolve();
      owned.close((err) => (err ? reject(err) : resolve()));
    })),
    parseStates,
    list,
    get: getOne,
    history,
    anchorRegister,
    createDraft,
    createProposal,
    patch,
    revise,
    draftFromHistory,
    deleteDraft,
    accept,
    retire,
    restore,
    setLock,
    setReplacement,
    constructRadial,
    query,
  };
}

module.exports = { createStore };
