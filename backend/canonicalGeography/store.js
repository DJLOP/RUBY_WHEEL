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

const {
  ENTITIES, LIFECYCLE_STATES, EDITOR_PROVENANCE, REPLACEMENT_STATES, DESCRIPTIVE_FIELDS,
  serialize, toInput, refuseUnknown, normalizeProposal, text, NAME_MAX, isPlainObject,
} = require('./entities');
const { validateAccept, validateRetire, findDependents } = require('./validation');
const { invalid, notFound, conflict } = require('./errors');
const { openTransactionConnection } = require('./connection');
const { runQuery } = require('./query');

const OPEN_STATES = ['draft', 'proposed'];

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
    query,
  };
}

module.exports = { createStore };
