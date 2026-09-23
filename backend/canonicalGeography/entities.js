/**
 * The four canonical entity types, described once so one lifecycle implementation can
 * serve all of them (plan §5).
 *
 * Each spec says which table holds the entity, which request fields it takes, how a
 * request is validated and normalized into columns, how a row is serialized, and which
 * columns are *constraint* fields (changed only through revise → accept) as opposed to
 * *descriptive* fields (name, description, notes — editable in place on an unlocked
 * accepted row, plan §3.7).
 *
 * Validation here is single-record only: shape, vocabulary, geometry. Whether a record is
 * consistent with the rest of accepted canon is decided at accept time (validation.js),
 * so an unfinished draft can always be saved.
 */

const { validateGeometry, isGeometryTypeAllowedForClass, WORLD_LIMIT } = require('./geometry');
const { invalid } = require('./errors');

// Vocabularies mirror the CHECK constraints in migrations/002-canonical-geography.js, so a
// caller gets a useful 400 rather than a bare SQL constraint failure.
const LIFECYCLE_STATES = ['draft', 'proposed', 'accepted', 'retired'];
const EDITOR_PROVENANCE = ['authored', 'imported'];
const STRENGTHS = ['hard', 'soft'];
const REPLACEMENT_STATES = ['non_replaceable', 'replaceable'];
const FEATURE_CLASSES = ['land', 'water', 'route', 'protected_region', 'site', 'scope_boundary'];
const FEATURE_KINDS = {
  water: ['open_water', 'channel', 'basin', 'wetland', 'other'],
  route: ['wall', 'bridge', 'causeway', 'road', 'quay_edge', 'conduit', 'other'],
  protected_region: ['no_build', 'preserve_existing', 'reserved'],
};
const PART_ROLES = ['core', 'footprint', 'precinct', 'node', 'link', 'access', 'extent'];
const ANCHOR_CATEGORIES = ['landmark', 'precinct', 'compound', 'facility', 'network', 'other'];
const CONNECTION_KINDS = ['road', 'bridge', 'ferry', 'water_route', 'utility', 'pedestrian', 'other'];
const REF_TYPES = ['feature', 'anchor', 'scope'];
const SCOPE_KINDS = ['city', 'district', 'island_group', 'subregion'];
/** city < district < island_group < subregion; a parent must rank strictly lower. */
const SCOPE_RANK = { city: 0, district: 1, island_group: 2, subregion: 3 };
const LAND_COVERAGE = ['partial', 'complete'];

const NAME_MAX = 120;
const TEXT_MAX = 4000;
const KEY_MAX = 80;
const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const JSON_BLOB_MAX = 16384;
const MAX_SCOPE_MEMBERS = 5000;

/** Editable in place on an unlocked accepted row; never a constraint (plan §3.7). */
const DESCRIPTIVE_FIELDS = ['name', 'description', 'notes'];

/**
 * Never writable through a create, patch or proposal body. Each has its own route, or is
 * set only by the store — naming the route in the message is the useful part.
 */
const GOVERNANCE_FIELDS = {
  lifecycle_state: 'lifecycle changes only through accept, retire or restore',
  is_locked: 'lock state changes only through PATCH …/lock, as its own request',
  replacement_state: 'replacement state changes only through PATCH …/replacement, as its own request',
  revision: 'the canonical revision is set only by accept',
  draft_version: 'the draft version is set only by the server',
  revises_id: 'a revision is created through POST …/revise (or /proposals with revises_id)',
  base_revision: 'the base revision is recorded by the server when a revision is created',
  accepted_at: 'set only by accept',
  created_at: 'set only by the server',
  updated_at: 'set only by the server',
  id: 'ids are assigned by the server',
  proposal: 'proposal metadata is accepted only through POST /proposals',
  proposal_json: 'proposal metadata is accepted only through POST /proposals',
};

// ── primitive validators ────────────────────────────────────────────────────

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const present = (v) => v !== undefined && v !== null;

function oneOf(value, list, field, { nullable = false } = {}) {
  if (!present(value)) {
    if (nullable) return null;
    throw invalid(`${field} is required (one of ${list.join(', ')})`);
  }
  if (!list.includes(value)) throw invalid(`${field} must be one of ${list.join(', ')}`);
  return value;
}

function text(value, field, { max = TEXT_MAX, required = false } = {}) {
  if (!present(value)) {
    if (required) throw invalid(`${field} is required`);
    return null;
  }
  if (typeof value !== 'string') throw invalid(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw invalid(`${field} is required`);
    return null;
  }
  if (trimmed.length > max) throw invalid(`${field} must be ${max} characters or fewer`);
  return trimmed;
}

function id(value, field) {
  if (!present(value)) return null;
  if (!Number.isInteger(value) || value <= 0) throw invalid(`${field} must be a positive integer id`);
  return value;
}

function key(value, field) {
  if (typeof value !== 'string' || !value) throw invalid(`${field} is required`);
  if (value.length > KEY_MAX || !KEY_PATTERN.test(value)) {
    throw invalid(`${field} must be a lowercase slug (a-z, 0-9, _ or -), ${KEY_MAX} characters or fewer`);
  }
  return value;
}

function bool01(value, field, fallback) {
  if (!present(value)) return fallback;
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  throw invalid(`${field} must be true or false`);
}

/** A JSON object blob: plain object, size-capped, returned as its stored text (or null). */
function blob(value, field, check) {
  if (!present(value)) return null;
  if (!isPlainObject(value)) throw invalid(`${field} must be an object`);
  if (check) check(value);
  const json = JSON.stringify(value);
  if (json.length > JSON_BLOB_MAX) throw invalid(`${field} is larger than ${JSON_BLOB_MAX} bytes`);
  return json;
}

function onlyKeys(obj, allowed, field) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw invalid(`${field}.${k} is not recognised (allowed: ${allowed.join(', ')})`);
  }
}

const finiteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/** Evidence is documentation of where geometry came from, never a dependency (plan §3.1). */
const checkEvidence = (ev) => {
  onlyKeys(ev, ['reference_layer_id', 'calibration_snapshot', 'note'], 'evidence');
  if (present(ev.reference_layer_id)) id(ev.reference_layer_id, 'evidence.reference_layer_id');
  if (present(ev.calibration_snapshot)) {
    const cal = ev.calibration_snapshot;
    const fields = ['world_center_x', 'world_center_z', 'world_units_per_pixel', 'rotation_rad'];
    if (!isPlainObject(cal)) throw invalid('evidence.calibration_snapshot must be an object');
    onlyKeys(cal, fields, 'evidence.calibration_snapshot');
    for (const f of fields) {
      if (present(cal[f]) && !finiteNumber(cal[f])) throw invalid(`evidence.calibration_snapshot.${f} must be a finite number`);
    }
  }
  if (present(ev.note)) text(ev.note, 'evidence.note', { max: TEXT_MAX });
};

const CONSTRUCTION_TYPES = ['circle', 'ellipse', 'rect'];
const checkConstruction = (c) => {
  oneOf(c.type, CONSTRUCTION_TYPES, 'construction.type');
};

const PROPOSAL_FIELDS = ['source', 'generator', 'generator_version', 'seed', 'input_digest', 'rationale'];
/** A software proposal must say where it came from (plan §3.1). */
const checkProposal = (p) => {
  onlyKeys(p, PROPOSAL_FIELDS, 'proposal');
  text(p.source, 'proposal.source', { max: NAME_MAX, required: true });
  text(p.generator, 'proposal.generator', { max: NAME_MAX, required: true });
  if (present(p.generator_version)) text(p.generator_version, 'proposal.generator_version', { max: NAME_MAX });
  if (present(p.seed) && typeof p.seed !== 'string' && !Number.isInteger(p.seed)) {
    throw invalid('proposal.seed must be a string or an integer');
  }
  if (present(p.input_digest)) text(p.input_digest, 'proposal.input_digest', { max: 256 });
  if (present(p.rationale)) text(p.rationale, 'proposal.rationale', { max: TEXT_MAX });
};

const normalizeProposal = (value) => {
  if (!present(value)) throw invalid('proposal metadata is required for a generated proposal');
  return blob(value, 'proposal', checkProposal);
};

/** An `{x, z}` endpoint hint, normalized like any point geometry. */
function hint(value, field) {
  if (!present(value)) return null;
  const result = validateGeometry('point', value);
  if (!result.ok) throw invalid(`${field} is not a valid point: ${result.issues.map(i => i.message).join('; ')}`, { issues: result.issues });
  return JSON.stringify(result.geometry);
}

const parse = (json) => (json === null || json === undefined ? null : JSON.parse(json));

// ── entity specs ────────────────────────────────────────────────────────────

const COMMON_INPUT = ['name', 'description', 'notes', 'evidence'];

/**
 * Fields that go with a draft onto the canonical row when it is accepted. Constraint
 * fields plus descriptive fields and evidence; never governance or identity.
 */
const acceptedColumns = (constraint) => [...constraint, 'name', 'description', 'notes', 'evidence_json'];

const features = {
  entity: 'features',
  type: 'feature',
  table: 'canonical_features',
  hasStrength: true,
  keyField: null,
  input: [...COMMON_INPUT, 'feature_class', 'kind', 'geometry_type', 'geometry', 'construction',
    'attributes', 'anchor_id', 'part_role', 'constraint_strength'],
  constraintColumns: ['feature_class', 'kind', 'geometry_type', 'geometry_json', 'construction_json',
    'min_x', 'min_z', 'max_x', 'max_z', 'attributes_json', 'anchor_id', 'part_role', 'constraint_strength'],

  normalize(input) {
    const featureClass = oneOf(input.feature_class, FEATURE_CLASSES, 'feature_class');
    const kinds = FEATURE_KINDS[featureClass];
    let kind = null;
    if (present(input.kind)) {
      if (!kinds) throw invalid(`${featureClass} features take no kind`);
      kind = oneOf(input.kind, kinds, 'kind');
    }

    const geometryType = oneOf(input.geometry_type, ['point', 'linestring', 'polygon'], 'geometry_type');
    if (!isGeometryTypeAllowedForClass(featureClass, geometryType)) {
      throw invalid(`a ${featureClass} feature cannot have ${geometryType} geometry`);
    }
    if (!present(input.geometry)) throw invalid('geometry is required');
    const g = validateGeometry(geometryType, input.geometry);
    if (!g.ok) {
      throw invalid(`geometry is invalid: ${g.issues.map(i => i.message).join('; ')}`, { issues: g.issues });
    }

    const attributes = blob(input.attributes, 'attributes', (a) => {
      if (featureClass === 'water') {
        onlyKeys(a, ['navigable'], 'attributes');
        if (present(a.navigable)) oneOf(a.navigable, ['yes', 'no', 'unknown'], 'attributes.navigable');
      } else if (featureClass === 'route') {
        // crosses_water is derived from accepted water at query time, never stated.
        onlyKeys(a, ['width_wu'], 'attributes');
        if (present(a.width_wu) && (!finiteNumber(a.width_wu) || a.width_wu <= 0 || a.width_wu > WORLD_LIMIT)) {
          throw invalid('attributes.width_wu must be a positive number of world units');
        }
      } else if (Object.keys(a).length) {
        throw invalid(`${featureClass} features take no attributes`);
      }
    });

    const anchorId = id(input.anchor_id, 'anchor_id');
    const partRole = oneOf(input.part_role, PART_ROLES, 'part_role', { nullable: true });
    if (partRole && !anchorId) throw invalid('part_role requires anchor_id');

    return {
      columns: {
        feature_class: featureClass,
        kind,
        geometry_type: geometryType,
        geometry_json: JSON.stringify(g.geometry),
        construction_json: blob(input.construction, 'construction', checkConstruction),
        ...g.bbox,
        attributes_json: attributes === '{}' ? null : attributes,
        anchor_id: anchorId,
        part_role: partRole,
        name: text(input.name, 'name', { max: NAME_MAX }),
        description: text(input.description, 'description'),
        notes: text(input.notes, 'notes'),
        constraint_strength: oneOf(input.constraint_strength, STRENGTHS, 'constraint_strength'),
        evidence_json: blob(input.evidence, 'evidence', checkEvidence),
      },
    };
  },

  serialize: (row) => ({
    feature_class: row.feature_class,
    kind: row.kind,
    geometry_type: row.geometry_type,
    geometry: parse(row.geometry_json),
    construction: parse(row.construction_json),
    attributes: parse(row.attributes_json),
    bbox: { min_x: row.min_x, min_z: row.min_z, max_x: row.max_x, max_z: row.max_z },
    anchor_id: row.anchor_id,
    part_role: row.part_role,
    constraint_strength: row.constraint_strength,
  }),
};

const anchors = {
  entity: 'anchors',
  type: 'anchor',
  table: 'canonical_anchors',
  hasStrength: true,
  keyField: 'anchor_key',
  input: [...COMMON_INPUT, 'anchor_key', 'category', 'constraint_strength', 'must_exist',
    'required_scope_id', 'linked_location_id'],
  constraintColumns: ['category', 'constraint_strength', 'must_exist', 'required_scope_id', 'linked_location_id'],

  normalize: (input) => ({
    columns: {
      anchor_key: key(input.anchor_key, 'anchor_key'),
      name: text(input.name, 'name', { max: NAME_MAX, required: true }),
      description: text(input.description, 'description'),
      notes: text(input.notes, 'notes'),
      category: oneOf(input.category, ANCHOR_CATEGORIES, 'category'),
      constraint_strength: oneOf(input.constraint_strength, STRENGTHS, 'constraint_strength'),
      must_exist: bool01(input.must_exist, 'must_exist', 1),
      required_scope_id: id(input.required_scope_id, 'required_scope_id'),
      linked_location_id: id(input.linked_location_id, 'linked_location_id'),
      evidence_json: blob(input.evidence, 'evidence', checkEvidence),
    },
  }),

  serialize: (row) => ({
    anchor_key: row.anchor_key,
    category: row.category,
    constraint_strength: row.constraint_strength,
    must_exist: !!row.must_exist,
    required_scope_id: row.required_scope_id,
    linked_location_id: row.linked_location_id,
  }),
};

const connections = {
  entity: 'connections',
  type: 'connection',
  table: 'canonical_connections',
  hasStrength: true,
  keyField: null,
  input: [...COMMON_INPUT, 'connection_kind', 'from_ref_type', 'from_ref_id', 'to_ref_type', 'to_ref_id',
    'from_hint', 'to_hint', 'via_feature_id', 'constraint_strength'],
  constraintColumns: ['connection_kind', 'from_ref_type', 'from_ref_id', 'to_ref_type', 'to_ref_id',
    'from_hint_json', 'to_hint_json', 'via_feature_id', 'constraint_strength'],

  normalize(input) {
    const fromId = id(input.from_ref_id, 'from_ref_id');
    const toId = id(input.to_ref_id, 'to_ref_id');
    if (!fromId) throw invalid('from_ref_id is required');
    if (!toId) throw invalid('to_ref_id is required');
    return {
      columns: {
        // Null means the connection is required but its mode is not (Bible §1.3).
        connection_kind: oneOf(input.connection_kind, CONNECTION_KINDS, 'connection_kind', { nullable: true }),
        from_ref_type: oneOf(input.from_ref_type, REF_TYPES, 'from_ref_type'),
        from_ref_id: fromId,
        to_ref_type: oneOf(input.to_ref_type, REF_TYPES, 'to_ref_type'),
        to_ref_id: toId,
        from_hint_json: hint(input.from_hint, 'from_hint'),
        to_hint_json: hint(input.to_hint, 'to_hint'),
        via_feature_id: id(input.via_feature_id, 'via_feature_id'),
        name: text(input.name, 'name', { max: NAME_MAX }),
        description: text(input.description, 'description'),
        notes: text(input.notes, 'notes'),
        constraint_strength: oneOf(input.constraint_strength, STRENGTHS, 'constraint_strength'),
        evidence_json: blob(input.evidence, 'evidence', checkEvidence),
      },
    };
  },

  serialize: (row) => ({
    connection_kind: row.connection_kind,
    from_ref_type: row.from_ref_type,
    from_ref_id: row.from_ref_id,
    to_ref_type: row.to_ref_type,
    to_ref_id: row.to_ref_id,
    from_hint: parse(row.from_hint_json),
    to_hint: parse(row.to_hint_json),
    via_feature_id: row.via_feature_id,
    constraint_strength: row.constraint_strength,
  }),
};

const scopes = {
  entity: 'scopes',
  type: 'scope',
  table: 'geo_scopes',
  hasStrength: false,
  keyField: 'scope_key',
  hasMembers: true,
  input: [...COMMON_INPUT, 'scope_key', 'scope_kind', 'parent_scope_id', 'boundary_feature_id',
    'land_coverage', 'members'],
  constraintColumns: ['scope_kind', 'parent_scope_id', 'boundary_feature_id', 'land_coverage'],

  normalize(input) {
    let members = [];
    if (present(input.members)) {
      if (!Array.isArray(input.members)) throw invalid('members must be an array of land feature ids');
      if (input.members.length > MAX_SCOPE_MEMBERS) throw invalid(`members may list at most ${MAX_SCOPE_MEMBERS} features`);
      members = input.members.map((m, i) => id(m, `members[${i}]`));
      if (new Set(members).size !== members.length) throw invalid('members lists a feature more than once');
      members.sort((a, b) => a - b);
    }
    return {
      columns: {
        scope_key: key(input.scope_key, 'scope_key'),
        scope_kind: oneOf(input.scope_kind, SCOPE_KINDS, 'scope_kind'),
        parent_scope_id: id(input.parent_scope_id, 'parent_scope_id'),
        boundary_feature_id: id(input.boundary_feature_id, 'boundary_feature_id'),
        land_coverage: oneOf(input.land_coverage ?? 'partial', LAND_COVERAGE, 'land_coverage'),
        name: text(input.name, 'name', { max: NAME_MAX, required: true }),
        description: text(input.description, 'description'),
        notes: text(input.notes, 'notes'),
        evidence_json: blob(input.evidence, 'evidence', checkEvidence),
      },
      members,
    };
  },

  serialize: (row) => ({
    scope_key: row.scope_key,
    scope_kind: row.scope_kind,
    parent_scope_id: row.parent_scope_id,
    boundary_feature_id: row.boundary_feature_id,
    land_coverage: row.land_coverage,
  }),
};

const ENTITIES = { features, anchors, connections, scopes };
const ENTITY_BY_TYPE = Object.fromEntries(Object.values(ENTITIES).map(s => [s.type, s]));
for (const spec of Object.values(ENTITIES)) spec.acceptedColumns = acceptedColumns(spec.constraintColumns);

/** One row as JSON: governance columns, then the entity's own fields; `members` for scopes. */
function serialize(spec, row, members) {
  const out = {
    id: row.id,
    entity_type: spec.type,
    name: row.name,
    description: row.description,
    notes: row.notes,
    ...spec.serialize(row),
    lifecycle_state: row.lifecycle_state,
    provenance: row.provenance,
    replacement_state: row.replacement_state,
    is_locked: !!row.is_locked,
    revision: row.revision,
    draft_version: row.draft_version,
    revises_id: row.revises_id,
    base_revision: row.base_revision,
    evidence: parse(row.evidence_json),
    proposal: parse(row.proposal_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
    accepted_at: row.accepted_at,
  };
  if (spec.hasMembers) out.members = members || [];
  return out;
}

/**
 * The request-shaped fields of a serialized record (or a history snapshot), so a patch or
 * a draft-from-history is validated by exactly the same path as a create.
 */
function toInput(spec, record) {
  const out = {};
  for (const f of spec.input) if (record[f] !== undefined) out[f] = record[f];
  return out;
}

/** Reject every field this entity does not take, naming the dedicated route for governance fields. */
function refuseUnknown(spec, body, extra = []) {
  for (const f of Object.keys(body)) {
    if (spec.input.includes(f) || extra.includes(f)) continue;
    if (GOVERNANCE_FIELDS[f]) throw invalid(`${f} cannot be set here: ${GOVERNANCE_FIELDS[f]}`);
    throw invalid(`${f} is not a field of canonical ${spec.entity}`);
  }
}

module.exports = {
  ENTITIES,
  ENTITY_BY_TYPE,
  LIFECYCLE_STATES,
  EDITOR_PROVENANCE,
  REPLACEMENT_STATES,
  SCOPE_RANK,
  DESCRIPTIVE_FIELDS,
  serialize,
  toInput,
  refuseUnknown,
  normalizeProposal,
  text,
  NAME_MAX,
  isPlainObject,
};
