/**
 * Canonical geography: the governed, versioned spatial constraints generators must respect.
 *
 * Deliberately separate from the inherited `water_bodies`, `districts`, `roads` and
 * `overpasses` tables. Those have no lifecycle, provenance, lock or revision, and the
 * inherited legacy map load/clear and region purge delete them wholesale — storing canon
 * there would make it silently overwritable (R-002 / A-002). Nothing here reads, rewrites
 * or reinterprets an inherited row; promotion of legacy content is a later, explicit,
 * per-row draft import.
 *
 * Geometry is stored only in canonical world X/Z units (1 wu = 1.524 m, A-014). No column
 * here is, or is derived from, the inherited `map_scale_multiplier`.
 *
 * The governance axes — lifecycle, provenance, constraint strength, replacement, lock —
 * are five independent columns, each with its own vocabulary, because inferring one from
 * another is how "accepted", "hand-made" and "protected" quietly become one flag.
 *
 * The only row seeded is the structural root `city` scope (A-001: one canonical world).
 * No district, island or anchor data is seeded; that arrives as drafts for GM acceptance.
 *
 * See docs/CANONICAL_GEOGRAPHY_PLAN.md §3.
 */

// Shared column block for every entity table. `constraint_strength` is not here because
// scopes do not carry it. Vocabularies are written out literally rather than imported:
// a migration is frozen once shipped, and must not change meaning when a constant elsewhere
// is edited later.
const GOVERNANCE_COLUMNS = `
      lifecycle_state TEXT NOT NULL DEFAULT 'draft'
        CHECK (lifecycle_state IN ('draft', 'proposed', 'accepted', 'retired')),
      provenance TEXT NOT NULL
        CHECK (provenance IN ('authored', 'imported', 'generated')),
      replacement_state TEXT NOT NULL DEFAULT 'non_replaceable'
        CHECK (replacement_state IN ('non_replaceable', 'replaceable')),
      is_locked INTEGER NOT NULL DEFAULT 0 CHECK (is_locked IN (0, 1)),
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      draft_version INTEGER NOT NULL DEFAULT 1 CHECK (draft_version >= 1),
      revises_id INTEGER,
      evidence_json TEXT,
      proposal_json TEXT,
      description TEXT CHECK (description IS NULL OR length(description) <= 4000),
      notes TEXT CHECK (notes IS NULL OR length(notes) <= 4000),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      accepted_at DATETIME,
      -- A software proposal must say where it came from.
      CHECK (provenance <> 'generated' OR proposal_json IS NOT NULL),
      -- Revision 0 means "never accepted"; anything canonical, now or formerly, has one.
      CHECK (lifecycle_state NOT IN ('accepted', 'retired') OR revision >= 1),
      -- Only a draft or proposal can be a pending replacement for a canonical row.
      CHECK (revises_id IS NULL OR lifecycle_state IN ('draft', 'proposed'))`;

const CONSTRAINT_STRENGTH_COLUMN = `
      constraint_strength TEXT NOT NULL CHECK (constraint_strength IN ('hard', 'soft')),`;

const NAME_COLUMN = (nullable) => `
      name TEXT ${nullable ? '' : 'NOT NULL '}CHECK (${nullable ? 'name IS NULL OR ' : ''}(length(name) > 0 AND length(name) <= 120)),`;

// At most one open editor draft ('draft') and one open software proposal ('proposed')
// revision per canonical row. Lifecycle is the origin axis: editors create drafts, the
// proposal channel creates proposals.
const openRevisionIndex = (table) =>
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_open_revision
   ON ${table}(revises_id, lifecycle_state) WHERE revises_id IS NOT NULL`;

module.exports = {
  name: '002-canonical-geography',

  async up({ run }) {
    // All canonical geometry, one table. Semantics come from a closed `feature_class`
    // rather than one table per class, so "what is in this extent" is one indexed query.
    //
    // `geometry_json` is world X/Z only: point {x,z}; linestring [{x,z}…] (closed when
    // first equals last); polygon {outer, holes} with open rings. The bbox columns are
    // server-computed from it and map directly onto an R*Tree later if measurement asks.
    await run(`CREATE TABLE IF NOT EXISTS canonical_features (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_class TEXT NOT NULL CHECK (feature_class IN
        ('land', 'water', 'route', 'protected_region', 'site', 'scope_boundary')),
      kind TEXT CHECK (kind IS NULL
        OR (feature_class = 'water' AND kind IN ('open_water', 'channel', 'basin', 'wetland', 'other'))
        OR (feature_class = 'route' AND kind IN ('wall', 'bridge', 'causeway', 'road', 'quay_edge', 'conduit', 'other'))
        OR (feature_class = 'protected_region' AND kind IN ('no_build', 'preserve_existing', 'reserved'))),
      geometry_type TEXT NOT NULL CHECK (geometry_type IN ('point', 'linestring', 'polygon')),
      geometry_json TEXT NOT NULL,
      construction_json TEXT,
      min_x REAL NOT NULL,
      min_z REAL NOT NULL,
      max_x REAL NOT NULL,
      max_z REAL NOT NULL,
      attributes_json TEXT,
      anchor_id INTEGER,
      part_role TEXT CHECK (part_role IS NULL OR part_role IN
        ('core', 'footprint', 'precinct', 'node', 'link', 'access', 'extent')),
      ${NAME_COLUMN(true)}
      ${CONSTRAINT_STRENGTH_COLUMN}
      ${GOVERNANCE_COLUMNS},
      CHECK (
        (feature_class IN ('land', 'water', 'protected_region', 'scope_boundary') AND geometry_type = 'polygon')
        OR (feature_class = 'route' AND geometry_type = 'linestring')
        OR feature_class = 'site'
      ),
      CHECK (part_role IS NULL OR anchor_id IS NOT NULL),
      CHECK (min_x <= max_x AND min_z <= max_z)
    )`);

    await run(`CREATE INDEX IF NOT EXISTS idx_canonical_features_state_class
               ON canonical_features(lifecycle_state, feature_class)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_canonical_features_x
               ON canonical_features(min_x, max_x)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_canonical_features_z
               ON canonical_features(min_z, max_z)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_canonical_features_anchor
               ON canonical_features(anchor_id)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_canonical_features_revises
               ON canonical_features(revises_id)`);
    await run(openRevisionIndex('canonical_features'));

    // Semantic identity without geometry: an anchor owns zero or more parts in
    // `canonical_features`, so "the Arena must exist" can be canon before it is traced.
    // A must-exist anchor can never be marked replaceable (Bible §9).
    await run(`CREATE TABLE IF NOT EXISTS canonical_anchors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anchor_key TEXT NOT NULL CHECK (length(anchor_key) > 0 AND length(anchor_key) <= 80),
      ${NAME_COLUMN(false)}
      category TEXT NOT NULL CHECK (category IN
        ('landmark', 'precinct', 'compound', 'facility', 'network', 'other')),
      must_exist INTEGER NOT NULL DEFAULT 1 CHECK (must_exist IN (0, 1)),
      required_scope_id INTEGER,
      linked_location_id INTEGER,
      ${CONSTRAINT_STRENGTH_COLUMN}
      ${GOVERNANCE_COLUMNS},
      CHECK (must_exist = 0 OR replacement_state = 'non_replaceable')
    )`);

    // The key identifies the anchor, not a row: a pending revision carries its canonical
    // row's key, so uniqueness applies only to rows that are not revisions.
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_anchors_key
               ON canonical_anchors(anchor_key) WHERE revises_id IS NULL`);
    await run(openRevisionIndex('canonical_anchors'));

    // Canon that is a relationship rather than a shape. A null `connection_kind` means the
    // connection is required but its mode is not (ferry-only gaps are normal, Bible §1.3).
    await run(`CREATE TABLE IF NOT EXISTS canonical_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connection_kind TEXT CHECK (connection_kind IS NULL OR connection_kind IN
        ('road', 'bridge', 'ferry', 'water_route', 'utility', 'pedestrian', 'other')),
      from_ref_type TEXT NOT NULL CHECK (from_ref_type IN ('feature', 'anchor', 'scope')),
      from_ref_id INTEGER NOT NULL,
      to_ref_type TEXT NOT NULL CHECK (to_ref_type IN ('feature', 'anchor', 'scope')),
      to_ref_id INTEGER NOT NULL,
      from_hint_json TEXT,
      to_hint_json TEXT,
      via_feature_id INTEGER,
      ${NAME_COLUMN(true)}
      ${CONSTRAINT_STRENGTH_COLUMN}
      ${GOVERNANCE_COLUMNS}
    )`);

    await run(openRevisionIndex('canonical_connections'));

    // Spatial hierarchy: city < district < island_group < subregion. Scopes carry no
    // constraint strength and no generation profile, culture, crop or wealth data; those
    // attach to a scope by id in later slices.
    await run(`CREATE TABLE IF NOT EXISTS geo_scopes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_key TEXT NOT NULL CHECK (length(scope_key) > 0 AND length(scope_key) <= 80),
      scope_kind TEXT NOT NULL CHECK (scope_kind IN ('city', 'district', 'island_group', 'subregion')),
      parent_scope_id INTEGER,
      boundary_feature_id INTEGER,
      land_coverage TEXT NOT NULL DEFAULT 'partial' CHECK (land_coverage IN ('partial', 'complete')),
      ${NAME_COLUMN(false)}
      ${GOVERNANCE_COLUMNS}
    )`);

    await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_geo_scopes_key
               ON geo_scopes(scope_key) WHERE revises_id IS NULL`);
    await run(`CREATE INDEX IF NOT EXISTS idx_geo_scopes_parent
               ON geo_scopes(parent_scope_id)`);
    await run(openRevisionIndex('geo_scopes'));

    // Explicit land-feature membership. `scope_kind` is denormalized so the partial unique
    // index can say "an island belongs to at most one accepted district and one accepted
    // island group" at the SQL level.
    await run(`CREATE TABLE IF NOT EXISTS geo_scope_members (
      scope_id INTEGER NOT NULL,
      feature_id INTEGER NOT NULL,
      scope_kind TEXT NOT NULL CHECK (scope_kind IN ('city', 'district', 'island_group', 'subregion')),
      is_canonical INTEGER NOT NULL DEFAULT 0 CHECK (is_canonical IN (0, 1)),
      PRIMARY KEY (scope_id, feature_id)
    )`);

    await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_geo_scope_members_canonical
               ON geo_scope_members(feature_id, scope_kind) WHERE is_canonical = 1`);

    // Append-only history, written in the same transaction as the change it records.
    // Canonical operations never use the inherited map-wide `action_history` / undo.
    await run(`CREATE TABLE IF NOT EXISTS canonical_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('feature', 'anchor', 'connection', 'scope')),
      entity_id INTEGER NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      change_kind TEXT NOT NULL CHECK (change_kind IN
        ('accept', 'descriptive_edit', 'retire', 'restore', 'lock', 'unlock', 'replacement_change')),
      snapshot_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    await run(`CREATE INDEX IF NOT EXISTS idx_canonical_revisions_entity
               ON canonical_revisions(entity_type, entity_id, id)`);

    // "Append-only" is a property of the table, not a promise made by each route.
    await run(`CREATE TRIGGER IF NOT EXISTS trg_canonical_revisions_no_update
               BEFORE UPDATE ON canonical_revisions
               BEGIN SELECT RAISE(ABORT, 'canonical_revisions is append-only'); END`);
    await run(`CREATE TRIGGER IF NOT EXISTS trg_canonical_revisions_no_delete
               BEFORE DELETE ON canonical_revisions
               BEGIN SELECT RAISE(ABORT, 'canonical_revisions is append-only'); END`);

    // The structural root: one canonical world. Guarded so a replay (ledger lost, tables
    // kept) cannot create a second root.
    await run(`INSERT INTO geo_scopes
        (scope_key, scope_kind, name, lifecycle_state, provenance, replacement_state,
         is_locked, revision, accepted_at)
      SELECT 'city', 'city', 'Imperial City', 'accepted', 'authored', 'non_replaceable',
             0, 1, CURRENT_TIMESTAMP
      WHERE NOT EXISTS (SELECT 1 FROM geo_scopes WHERE scope_key = 'city')`);

    // Its acceptance is recorded like any other, so the root's history is not a special case.
    await run(`INSERT INTO canonical_revisions (entity_type, entity_id, revision, change_kind, snapshot_json)
      SELECT 'scope', s.id, 1, 'accept', json_object(
        'id', s.id, 'scope_key', s.scope_key, 'scope_kind', s.scope_kind,
        'parent_scope_id', s.parent_scope_id, 'boundary_feature_id', s.boundary_feature_id,
        'land_coverage', s.land_coverage, 'name', s.name, 'revision', s.revision)
      FROM geo_scopes s
      WHERE s.scope_key = 'city'
        AND NOT EXISTS (SELECT 1 FROM canonical_revisions r
                        WHERE r.entity_type = 'scope' AND r.entity_id = s.id)`);
  },
};
