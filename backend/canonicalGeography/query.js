/**
 * The generator-facing query (plan §5.3, §6): "give me the accepted constraints within
 * extent E, plus a context ring of h world units".
 *
 * Every level of the generation hierarchy asks this same question at a different extent —
 * the city scope, a district, an island group, one island (a land `feature_id`), or an
 * ad-hoc bbox/polygon — and gets back one versioned JSON bundle. The bundle is the whole
 * interface: a planner or generator never reads canonical tables, reference layers or
 * raster pixels, and never sees a draft, proposal or retired row.
 *
 * Algorithm: resolve the extent to a *set* of polygons (never a union), fetch accepted
 * features whose bbox meets the extent bbox grown by the halo (one indexed SQL query),
 * then classify each exactly on the WP1 integer grid:
 *
 *   inside    wholly within the extent;
 *   boundary  shares points with the extent and touches or crosses its edge;
 *   context   misses the extent but meets the halo ring.
 *
 * The halo ring is the extent's bbox grown by `halo_wu` on every side — a rectangle, not a
 * buffer, because buffering is out of scope (plan §2.3). It is context, not obligation.
 *
 * The digest is sha256 over the sorted identities of every accepted entity the bundle was
 * built from — `(entity_type, id, revision, replacement_state, is_locked)` — plus the
 * normalized target and halo. Descriptive edits (name, description, notes) do not bump
 * `revision`, so they leave it unchanged; every accepted constraint change does bump it.
 * Replacement state and lock are included because they decide what a generator may
 * overwrite (`immutable[]`) even though they are not revisions. Row order from SQLite never
 * matters: every list is sorted in JS — never by relying on SQL ORDER BY — before it is
 * hashed or emitted, so the whole bundle, not just its digest, is order-independent.
 *
 * Metrics are overlap-naive sums over inside/boundary features, counted whole: a boundary
 * island contributes its full area. No clipping, no union.
 *
 * This module only reads. It never consults `reference_*` tables or assets.
 */

const crypto = require('crypto');
const {
  WORLD_LIMIT, validateGeometry, relateGeometryToPolygon, geometryIntersectsPolygon,
  linestringPieces, bboxesIntersect, computeBBox, polygonArea, polygonPerimeter,
  linestringLength,
} = require('./geometry');
const { scopeExtent, membershipIncoherence } = require('./validation');
const { SCOPE_RANK } = require('./entities');
const { invalid, notFound, conflict } = require('./errors');
const {
  squareWorldUnitsToSquareMeters, squareWorldUnitsToHectares, worldUnitsToMeters,
} = require('./physicalScale');

const BUNDLE_VERSION = 1;
const INCLUDE = ['land', 'water', 'anchors', 'protected', 'routes', 'sites', 'connections'];
const TARGETS = ['scope_id', 'feature_id', 'bbox', 'polygon'];

/** Which bundle array each feature class lands in; scope boundaries are extent, not content. */
const ARRAY_OF_CLASS = { land: 'land', water: 'water', protected_region: 'protected', route: 'routes', site: 'sites' };

const parse = (json) => (json === null || json === undefined ? null : JSON.parse(json));
const byId = (a, b) => a.id - b.id;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

const rectPolygon = (b) => ({
  outer: [{ x: b.min_x, z: b.min_z }, { x: b.max_x, z: b.min_z }, { x: b.max_x, z: b.max_z }, { x: b.min_x, z: b.max_z }],
  holes: [],
});

// ── request ──────────────────────────────────────────────────────────────────

function positiveId(value, field) {
  if (!Number.isInteger(value) || value <= 0) throw invalid(`${field} must be a positive integer id`);
  return value;
}

/** Validate a query body; returns `{ target, halo, include }` with the target normalized. */
function parseRequest(body) {
  if (!isPlainObject(body)) throw invalid('request body must be an object');
  for (const k of Object.keys(body)) {
    if (![...TARGETS, 'halo_wu', 'include'].includes(k)) {
      throw invalid(`${k} is not a query field (allowed: ${[...TARGETS, 'halo_wu', 'include'].join(', ')})`);
    }
  }
  const given = TARGETS.filter(t => body[t] !== undefined && body[t] !== null);
  if (given.length !== 1) throw invalid(`a query takes exactly one of ${TARGETS.join(', ')}`);

  let target;
  const kind = given[0];
  if (kind === 'scope_id') target = { scope_id: positiveId(body.scope_id, 'scope_id') };
  else if (kind === 'feature_id') target = { feature_id: positiveId(body.feature_id, 'feature_id') };
  else if (kind === 'bbox') {
    const b = body.bbox;
    const fields = ['min_x', 'min_z', 'max_x', 'max_z'];
    if (!isPlainObject(b) || Object.keys(b).some(k => !fields.includes(k)) || !fields.every(f => finite(b[f]))) {
      throw invalid('bbox must be {min_x, min_z, max_x, max_z} with finite numbers');
    }
    if (fields.some(f => Math.abs(b[f]) > WORLD_LIMIT)) throw invalid(`bbox lies outside ±${WORLD_LIMIT} world units`);
    if (!(b.min_x < b.max_x && b.min_z < b.max_z)) throw invalid('bbox must have min_x < max_x and min_z < max_z');
    // Rounded to the stored grid, so equal requests hash equally.
    const g = validateGeometry('polygon', rectPolygon(b));
    if (!g.ok) throw invalid(`bbox is invalid: ${g.issues.map(i => i.message).join('; ')}`);
    target = { bbox: g.bbox };
  } else {
    const g = validateGeometry('polygon', body.polygon);
    if (!g.ok) throw invalid(`polygon is invalid: ${g.issues.map(i => i.message).join('; ')}`, { issues: g.issues });
    target = { polygon: g.geometry };
  }

  let halo = 0;
  if (body.halo_wu !== undefined && body.halo_wu !== null) {
    if (!finite(body.halo_wu) || body.halo_wu < 0 || body.halo_wu > WORLD_LIMIT) {
      throw invalid(`halo_wu must be a number of world units between 0 and ${WORLD_LIMIT}`);
    }
    halo = Math.round(body.halo_wu * 1000) / 1000;
  }

  let include = INCLUDE;
  if (body.include !== undefined && body.include !== null) {
    if (!Array.isArray(body.include) || body.include.some(i => !INCLUDE.includes(i))) {
      throw invalid(`include must be an array drawn from ${INCLUDE.join(', ')}`);
    }
    include = INCLUDE.filter(i => body.include.includes(i));
  }
  return { target, halo, include };
}

// ── scopes ───────────────────────────────────────────────────────────────────

async function loadScopes(q) {
  const rows = (await q.all(`SELECT * FROM geo_scopes WHERE lifecycle_state = 'accepted'`)).sort(byId);
  const byScopeId = new Map(rows.map(r => [r.id, r]));
  const children = new Map();
  for (const r of rows) {
    if (!r.parent_scope_id) continue;
    if (!children.has(r.parent_scope_id)) children.set(r.parent_scope_id, []);
    children.get(r.parent_scope_id).push(r.id);
  }
  const root = rows.find(r => r.scope_kind === 'city') || null;
  const members = new Map();
  const memberRows = await q.all(
    `SELECT m.scope_id, m.feature_id FROM geo_scope_members m JOIN geo_scopes s ON s.id = m.scope_id
      WHERE m.is_canonical = 1 AND s.lifecycle_state = 'accepted'`);
  for (const m of memberRows) {
    if (!members.has(m.scope_id)) members.set(m.scope_id, []);
    members.get(m.scope_id).push(m.feature_id);
  }
  for (const list of members.values()) list.sort((a, b) => a - b);
  return { byScopeId, children, root, members, membersOf: (id) => members.get(id) || [] };
}

/** `scope` and its ancestors, root first. */
function lineage(scopes, scope) {
  const out = [];
  const seen = new Set();
  let cursor = scope;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    out.unshift(cursor);
    cursor = cursor.parent_scope_id ? scopes.byScopeId.get(cursor.parent_scope_id) : null;
  }
  return out;
}

function descendantsOf(scopes, id) {
  const out = [];
  const stack = [...(scopes.children.get(id) || [])];
  while (stack.length) {
    const next = stack.pop();
    out.push(next);
    stack.push(...(scopes.children.get(next) || []));
  }
  return out.sort((a, b) => a - b);
}

const chainEntry = (s) => ({
  id: s.id, scope_key: s.scope_key, scope_kind: s.scope_kind, name: s.name,
  revision: s.revision, land_coverage: s.land_coverage,
});

// ── target resolution ────────────────────────────────────────────────────────

/**
 * The extent (polygon set, or null when a scope has none yet), the features that *are*
 * that extent, the enclosing scope chain, and the scope itself for a scope query.
 */
async function resolveTarget(q, scopes, target) {
  if (target.scope_id) {
    const scope = scopes.byScopeId.get(target.scope_id);
    if (!scope) throw notFound(`accepted scope #${target.scope_id} not found`);
    const members = scopes.membersOf(scope.id);
    const extent = await scopeExtent(q, scope, members);
    const sources = scope.boundary_feature_id ? [scope.boundary_feature_id] : members;
    const chain = lineage(scopes, scope).slice(0, -1);
    return {
      ref: { type: 'scope', id: scope.id }, kind: scope.scope_kind, scope, extent, sources, chain,
      label: { scope_key: scope.scope_key, name: scope.name, revision: scope.revision },
    };
  }

  if (target.feature_id) {
    const f = await q.get(`SELECT * FROM canonical_features WHERE id = ? AND lifecycle_state = 'accepted'`, [target.feature_id]);
    if (!f) throw notFound(`accepted feature #${target.feature_id} not found`);
    if (f.geometry_type !== 'polygon') throw invalid(`feature #${f.id} is a ${f.geometry_type}; a query extent must be a polygon feature`);
    // An island's chain is the lineage of the most specific scope that lists it as a
    // member; a scope boundary's is the lineage of the scope it bounds. Anything else sits
    // directly under the city.
    //
    // Every explicit membership must lie on that one lineage. Accept-time validation keeps
    // it so; if stored state contradicts it anyway (historical or direct DB data), the query
    // refuses rather than silently dropping a membership or picking a lineage.
    const memberOf = [...scopes.members].filter(([, list]) => list.includes(f.id)).map(([scopeId]) => scopeId);
    const lineageIds = (id) => lineage(scopes, scopes.byScopeId.get(id)).map(s => s.id);
    const problem = membershipIncoherence(memberOf, scopes.byScopeId, lineageIds);
    if (problem) {
      throw conflict(
        `land #${f.id} has accepted memberships that do not form one ancestry chain: `
        + `${problem.stray.map(s => `${s.scope_kind} #${s.id}`).join(', ')} not on the lineage of `
        + `${problem.deepest.scope_kind} #${problem.deepest.id}`,
        {
          code: 'scope_membership_incoherent',
          feature_id: f.id,
          memberships: memberOf.slice().sort((a, b) => a - b),
          lineage: problem.chain.map(s => s.id),
          stray: problem.stray.map(s => s.id),
        });
    }
    let enclosing = null;
    for (const scopeId of memberOf) {
      const s = scopes.byScopeId.get(scopeId);
      if (s && (!enclosing || SCOPE_RANK[s.scope_kind] > SCOPE_RANK[enclosing.scope_kind])) enclosing = s;
    }
    if (!enclosing) {
      for (const s of scopes.byScopeId.values()) if (s.boundary_feature_id === f.id) enclosing = s;
    }
    const chain = enclosing ? lineage(scopes, enclosing) : (scopes.root ? [scopes.root] : []);
    return {
      ref: { type: 'feature', id: f.id },
      kind: f.feature_class === 'land' ? 'island' : f.feature_class,
      scope: null, extent: [parse(f.geometry_json)], sources: [f.id], chain,
      label: { name: f.name, revision: f.revision },
    };
  }

  const polygon = target.bbox ? rectPolygon(target.bbox) : target.polygon;
  return {
    ref: target.bbox ? { type: 'bbox', bbox: target.bbox } : { type: 'polygon' },
    kind: target.bbox ? 'bbox' : 'polygon',
    scope: null, extent: [polygon], sources: [], chain: scopes.root ? [scopes.root] : [],
    label: {},
  };
}

// ── classification ───────────────────────────────────────────────────────────

function extentBBox(extent) {
  const boxes = extent.map(p => computeBBox('polygon', p));
  return {
    min_x: Math.min(...boxes.map(b => b.min_x)), min_z: Math.min(...boxes.map(b => b.min_z)),
    max_x: Math.max(...boxes.map(b => b.max_x)), max_z: Math.max(...boxes.map(b => b.max_z)),
  };
}

/** inside | boundary | context | null for one candidate feature. */
function classify(row, geometry, extent, extentBoxes, haloPolygon, sourceIds) {
  if (sourceIds.has(row.id)) return 'inside';
  let inside = false;
  for (let i = 0; i < extent.length; i++) {
    if (!bboxesIntersect(row, extentBoxes[i])) continue;
    const r = relateGeometryToPolygon(row.geometry_type, geometry, extent[i]);
    if (r === 'boundary') return 'boundary';
    if (r === 'inside') inside = true;
  }
  if (inside) return 'inside';
  if (haloPolygon && geometryIntersectsPolygon(row.geometry_type, geometry, haloPolygon)) return 'context';
  return null;
}

// ── the query ────────────────────────────────────────────────────────────────

const featureEntry = (row, geometry, relation) => ({
  id: row.id,
  revision: row.revision,
  feature_class: row.feature_class,
  kind: row.kind,
  geometry_type: row.geometry_type,
  geometry,
  bbox: { min_x: row.min_x, min_z: row.min_z, max_x: row.max_x, max_z: row.max_z },
  constraint_strength: row.constraint_strength,
  attributes: parse(row.attributes_json),
  anchor_id: row.anchor_id,
  part_role: row.part_role,
  name: row.name,
  replacement_state: row.replacement_state,
  is_locked: !!row.is_locked,
  relation,
});

const identity = (type, row) => [type, row.id, row.revision, row.replacement_state, row.is_locked ? 1 : 0];

async function runQuery(q, body) {
  const { target, halo, include } = parseRequest(body);
  const scopes = await loadScopes(q);
  const resolved = await resolveTarget(q, scopes, target);
  const extent = resolved.extent || [];
  const sourceIds = new Set(resolved.sources);

  // ── features ──
  const features = [];
  if (extent.length) {
    const box = extentBBox(extent);
    const grown = { min_x: box.min_x - halo, min_z: box.min_z - halo, max_x: box.max_x + halo, max_z: box.max_z + halo };
    const haloPolygon = halo > 0 ? rectPolygon(grown) : null;
    const extentBoxes = extent.map(p => computeBBox('polygon', p));
    const candidates = await q.all(
      `SELECT * FROM canonical_features
        WHERE lifecycle_state = 'accepted' AND feature_class <> 'scope_boundary'
          AND max_x >= ? AND min_x <= ? AND max_z >= ? AND min_z <= ?`,
      [grown.min_x, grown.max_x, grown.min_z, grown.max_z]);
    for (const row of candidates) {
      const geometry = parse(row.geometry_json);
      const relation = classify(row, geometry, extent, extentBoxes, haloPolygon, sourceIds);
      if (relation) features.push({ row, geometry, relation });
    }
  }
  features.sort((a, b) => a.row.id - b.row.id);
  const relationOf = new Map(features.map(f => [f.row.id, f.relation]));
  const inExtent = (rel) => rel === 'inside' || rel === 'boundary';

  // ── scopes the bundle is answerable to ──
  const selfAndBelow = resolved.scope ? [resolved.scope.id, ...descendantsOf(scopes, resolved.scope.id)] : [];
  const selfAndBelowSet = new Set(selfAndBelow);
  const chainIds = new Set(resolved.chain.map(s => s.id));
  const chainExtents = new Map();
  for (const s of resolved.chain) chainExtents.set(s.id, await scopeExtent(q, s, scopes.membersOf(s.id)));
  // An enclosing scope counts for readiness when its extent overlaps this one — or when
  // either has no extent yet, since overlap then cannot be ruled out.
  const overlapsExtent = (polys) => !polys || !extent.length
    || polys.some(p => extent.some(e => geometryIntersectsPolygon('polygon', p, e)));
  const readinessScopes = new Set(selfAndBelow);
  for (const s of resolved.chain) if (overlapsExtent(chainExtents.get(s.id))) readinessScopes.add(s.id);
  const rootId = scopes.root ? scopes.root.id : null;
  // An anchor with no required scope may be anywhere in the city: it answers to the root.
  const requiredScopeOf = (a) => a.required_scope_id || rootId;

  // ── anchors ──
  const partAnchorIds = [...new Set(features.filter(f => f.row.anchor_id).map(f => f.row.anchor_id))];
  const placedAnchors = partAnchorIds.length
    ? await q.all(`SELECT * FROM canonical_anchors WHERE lifecycle_state = 'accepted' AND id IN (${partAnchorIds.map(() => '?').join(', ')})`, partAnchorIds)
    : [];
  const allParts = partAnchorIds.length
    ? await q.all(
      `SELECT id, revision, feature_class, part_role, constraint_strength, anchor_id, replacement_state, is_locked
         FROM canonical_features WHERE lifecycle_state = 'accepted' AND anchor_id IN (${partAnchorIds.map(() => '?').join(', ')})
`, partAnchorIds)
    : [];
  allParts.sort(byId);
  const unplaced = await q.all(
    `SELECT a.* FROM canonical_anchors a WHERE a.lifecycle_state = 'accepted'
        AND NOT EXISTS (SELECT 1 FROM canonical_features f WHERE f.anchor_id = a.id AND f.lifecycle_state = 'accepted')
`);
  unplaced.sort(byId);

  // Extents of required scopes, for `required_scope_unverified`.
  const requiredExtentKnown = new Map();
  const extentKnown = async (scopeId) => {
    if (!requiredExtentKnown.has(scopeId)) {
      const s = scopes.byScopeId.get(scopeId);
      requiredExtentKnown.set(scopeId, !!(s && await scopeExtent(q, s, scopes.membersOf(scopeId))));
    }
    return requiredExtentKnown.get(scopeId);
  };

  const anchors = [];
  const anchorRelation = new Map();
  const requiredScopeUnverified = [];
  for (const a of placedAnchors.sort(byId)) {
    const parts = allParts.filter(p => p.anchor_id === a.id).map(p => ({
      feature_id: p.id, revision: p.revision, feature_class: p.feature_class, part_role: p.part_role,
      constraint_strength: p.constraint_strength, relation: relationOf.get(p.id) || 'outside',
    }));
    const rels = parts.map(p => p.relation);
    const relation = rels.every(r => r === 'inside') ? 'inside'
      : rels.some(inExtent) ? 'boundary' : 'context';
    anchorRelation.set(a.id, relation);
    if (a.required_scope_id && !(await extentKnown(a.required_scope_id))) {
      for (const p of parts) if (p.relation !== 'outside') requiredScopeUnverified.push(p.feature_id);
    }
    anchors.push({ row: a, relation, placed: true, parts, allParts: allParts.filter(p => p.anchor_id === a.id) });
  }
  // Unplaced obligations: anchors that must be somewhere in this scope or below it.
  for (const a of unplaced) {
    if (!selfAndBelowSet.has(requiredScopeOf(a))) continue;
    anchorRelation.set(a.id, 'unplaced');
    anchors.push({ row: a, relation: 'unplaced', placed: false, parts: [], allParts: [] });
  }
  anchors.sort((x, y) => x.row.id - y.row.id);

  const unplacedMustExist = unplaced
    .filter(a => a.must_exist && readinessScopes.has(requiredScopeOf(a)))
    .map(a => a.id);
  // Anchors named only by readiness are still inputs this bundle depends on.
  const readinessOnly = unplaced.filter(a => unplacedMustExist.includes(a.id) && !anchorRelation.has(a.id));

  // ── connections ──
  const endpoint = (type, id) => {
    if (type === 'feature') {
      const rel = relationOf.get(id);
      return inExtent(rel) ? 'in' : rel === 'context' ? 'context' : 'out';
    }
    if (type === 'anchor') {
      const rel = anchorRelation.get(id);
      return rel === 'unplaced' || inExtent(rel) ? 'in' : rel === 'context' ? 'context' : 'out';
    }
    if (selfAndBelowSet.has(id)) return 'in';
    return chainIds.has(id) ? 'enclosing' : 'out';
  };
  const connections = [];
  const connectionRows = (await q.all(`SELECT * FROM canonical_connections WHERE lifecycle_state = 'accepted'`)).sort(byId);
  for (const c of connectionRows) {
    const from = endpoint(c.from_ref_type, c.from_ref_id);
    const to = endpoint(c.to_ref_type, c.to_ref_id);
    const via = c.via_feature_id ? relationOf.get(c.via_feature_id) : null;
    if (from === 'out' && to === 'out' && !via) continue;
    const ins = (from === 'in') + (to === 'in');
    connections.push({
      row: c, from, to,
      tag: ins === 2 ? 'internal' : ins === 1 ? 'crossing' : 'external_obligation',
    });
  }

  // ── exact route classification (WP1 grid topology; no sampling) ──
  // Land and water are loaded from each route's own bbox, not from the query extent: a
  // route in the bundle may run on past the halo, and what it crosses out there is still
  // part of what the bundle claims about it.
  const governing = [...(resolved.scope ? [resolved.scope] : []), ...[...resolved.chain].reverse()]
    .find(s => s.land_coverage === 'complete') || null;
  const complementExtent = governing
    ? (governing === resolved.scope ? extent : (chainExtents.get(governing.id) || []))
    : [];

  const routeRows = features.filter(f => f.row.feature_class === 'route');
  const parsedById = new Map(features.map(f => [f.row.id, f.geometry]));
  let surroundings = [];
  if (routeRows.length) {
    const u = {
      min_x: Math.min(...routeRows.map(r => r.row.min_x)), min_z: Math.min(...routeRows.map(r => r.row.min_z)),
      max_x: Math.max(...routeRows.map(r => r.row.max_x)), max_z: Math.max(...routeRows.map(r => r.row.max_z)),
    };
    surroundings = (await q.all(
      `SELECT id, feature_class, geometry_json, min_x, min_z, max_x, max_z, revision, replacement_state, is_locked
         FROM canonical_features
        WHERE lifecycle_state = 'accepted' AND feature_class IN ('land', 'water')
          AND max_x >= ? AND min_x <= ? AND max_z >= ? AND min_z <= ?`,
      [u.min_x, u.max_x, u.min_z, u.max_z]))
      .map(r => ({ ...r, geometry: parsedById.get(r.id) || parse(r.geometry_json) }))
      .sort(byId);
  }
  const routeContext = new Map();

  /**
   * crosses_water: some positive-length stretch of the route lies in the open interior of
   * explicit water (exact pieces; boundary-only contact does not count), or some stretch of
   * it is off accepted land inside a complete-coverage
   * extent (plan §4.2: there, non-land is water). leaves_land: some stretch of it is not
   * covered by accepted land (a stretch along a shoreline counts as covered). Off-land under
   * partial coverage is unknown ground — it makes leaves_land true, never crosses_water.
   */
  const classifyRoute = (row, line) => {
    const near = surroundings.filter(c => bboxesIntersect(c, row));
    const lands = near.filter(c => c.feature_class === 'land');
    const waters = near.filter(c => c.feature_class === 'water');
    // Only a positive-length stretch in a water body's open interior is a crossing: running
    // along its edge (a quay), touching it at a point or a corner, or passing through one of
    // its holes is not.
    const explicitWater = waters.length > 0
      && linestringPieces(line, waters.map(w => w.geometry)).some(pc => pc.interior.length > 0);
    const pieces = linestringPieces(line, [...lands.map(l => l.geometry), ...complementExtent]);
    const onLand = (piece) => piece.within.some(i => i < lands.length);
    const inComplement = (piece) => piece.within.some(i => i >= lands.length);
    const offLand = pieces.filter(pc => !onLand(pc));
    for (const c of near) routeContext.set(c.id, c);
    return {
      crosses_water: explicitWater || offLand.some(inComplement),
      leaves_land: offLand.length > 0,
    };
  };

  // ── bundle arrays ──
  const arrays = { land: [], water: [], protected: [], routes: [], sites: [] };
  for (const f of features) {
    const entry = featureEntry(f.row, f.geometry, f.relation);
    if (f.row.feature_class === 'water') entry.navigable = (entry.attributes && entry.attributes.navigable) || 'unknown';
    if (f.row.feature_class === 'route') {
      Object.assign(entry, classifyRoute(f.row, f.geometry), { crosses_extent_boundary: f.relation === 'boundary' });
    }
    arrays[ARRAY_OF_CLASS[f.row.feature_class]].push(entry);
  }

  const anchorEntry = (a) => ({
    id: a.row.id,
    revision: a.row.revision,
    anchor_key: a.row.anchor_key,
    name: a.row.name,
    category: a.row.category,
    constraint_strength: a.row.constraint_strength,
    must_exist: !!a.row.must_exist,
    required_scope_id: a.row.required_scope_id,
    replacement_state: a.row.replacement_state,
    is_locked: !!a.row.is_locked,
    placed: a.placed,
    relation: a.relation,
    parts: a.parts,
  });

  const refOf = (type, id, hint) => ({ ref_type: type, ref_id: id, hint: parse(hint) });
  const connectionEntry = (c) => ({
    id: c.row.id,
    revision: c.row.revision,
    connection_kind: c.row.connection_kind,
    constraint_strength: c.row.constraint_strength,
    name: c.row.name,
    from: { ...refOf(c.row.from_ref_type, c.row.from_ref_id, c.row.from_hint_json), position: c.from },
    to: { ...refOf(c.row.to_ref_type, c.row.to_ref_id, c.row.to_hint_json), position: c.to },
    via_feature_id: c.row.via_feature_id,
    replacement_state: c.row.replacement_state,
    is_locked: !!c.row.is_locked,
    tag: c.tag,
  });

  // ── identities: digest and immutable ──
  const consulted = [];
  for (const f of features) consulted.push(identity('feature', f.row));
  const seenParts = new Set(features.map(f => f.row.id));
  for (const a of anchors) {
    consulted.push(identity('anchor', a.row));
    for (const p of a.allParts) if (!seenParts.has(p.id)) { seenParts.add(p.id); consulted.push(identity('feature', p)); }
  }
  for (const a of readinessOnly) consulted.push(identity('anchor', a));
  for (const c of connections) consulted.push(identity('connection', c.row));
  const scopeIds = new Set([...selfAndBelow, ...chainIds]);
  for (const id of scopeIds) consulted.push(identity('scope', scopes.byScopeId.get(id)));
  // Features that define the extent but are not content (a scope boundary).
  for (const fid of resolved.sources) {
    if (seenParts.has(fid)) continue;
    const row = await q.get(`SELECT id, revision, replacement_state, is_locked FROM canonical_features WHERE id = ? AND lifecycle_state = 'accepted'`, [fid]);
    if (row) { seenParts.add(fid); consulted.push(identity('feature', row)); }
  }
  const TYPE_ORDER = { scope: 0, feature: 1, anchor: 2, connection: 3 };
  const byTypeThenId = (a, b) => TYPE_ORDER[a[0]] - TYPE_ORDER[b[0]] || a[1] - b[1];
  consulted.sort(byTypeThenId);

  // Land and water beyond the halo that a route was classified against also shape the
  // bundle (its crosses_water / leaves_land), so they are digest inputs too. They are not
  // bundle content, so they are not listed in immutable[].
  const digestEntities = [...consulted];
  for (const c of routeContext.values()) if (!seenParts.has(c.id)) digestEntities.push(identity('feature', c));
  digestEntities.sort(byTypeThenId);

  const digest = crypto.createHash('sha256')
    .update(JSON.stringify({ bundle_version: BUNDLE_VERSION, target, halo_wu: halo, entities: digestEntities }))
    .digest('hex');

  const immutable = consulted
    .filter(([, , , replacement, locked]) => replacement === 'non_replaceable' || locked === 1)
    .map(([entity_type, id]) => ({ entity_type, id }));

  // ── metrics: overlap-naive, whole features, via physicalScale only ──
  const counted = (list) => list.filter(e => inExtent(e.relation));
  const landIn = counted(arrays.land);
  const waterIn = counted(arrays.water);
  const landArea = landIn.reduce((s, e) => s + polygonArea(e.geometry), 0);
  const shoreline = landIn.reduce((s, e) => s + polygonPerimeter(e.geometry), 0);
  const waterArea = waterIn.reduce((s, e) => s + polygonArea(e.geometry), 0);
  const routeLength = counted(arrays.routes).reduce((s, e) => s + linestringLength(e.geometry), 0);
  const protectedArea = counted(arrays.protected).reduce((s, e) => s + polygonArea(e.geometry), 0);
  const extentArea = extent.reduce((s, p) => s + polygonArea(p), 0);
  const metrics = {
    semantics: 'overlap_naive',
    extent: { polygons: extent.length, area_m2: squareWorldUnitsToSquareMeters(extentArea), area_ha: squareWorldUnitsToHectares(extentArea) },
    land: { count: landIn.length, area_m2: squareWorldUnitsToSquareMeters(landArea), area_ha: squareWorldUnitsToHectares(landArea), shoreline_m: worldUnitsToMeters(shoreline) },
    water: { explicit_count: waterIn.length, explicit_area_m2: squareWorldUnitsToSquareMeters(waterArea), explicit_area_ha: squareWorldUnitsToHectares(waterArea) },
    protected: { count: counted(arrays.protected).length, area_m2: squareWorldUnitsToSquareMeters(protectedArea), area_ha: squareWorldUnitsToHectares(protectedArea) },
    routes: { count: counted(arrays.routes).length, length_m: worldUnitsToMeters(routeLength) },
    anchors: {
      placed: anchors.filter(a => a.placed && a.relation !== 'context').length,
      context: anchors.filter(a => a.relation === 'context').length,
      unplaced_obligations: anchors.filter(a => !a.placed).length,
      unplaced_must_exist: unplacedMustExist.length,
    },
  };

  const bundle = {
    bundle_version: BUNDLE_VERSION,
    scope: {
      ref: resolved.ref,
      kind: resolved.kind,
      ...resolved.label,
      chain: resolved.chain.map(chainEntry),
      extent,
      extent_feature_ids: [...resolved.sources].sort((a, b) => a - b),
      land_coverage: resolved.scope ? resolved.scope.land_coverage : (governing ? 'complete' : 'partial'),
      halo_wu: halo,
      descendant_scope_ids: selfAndBelow.slice(1),
    },
    digest,
    water_complement: {
      // Inside `extent`, a point that is neither accepted land nor explicit water is water
      // when rule is 'complete', and unknown — neither buildable nor water — otherwise.
      rule: governing ? 'complete' : 'partial',
      coverage_scope_id: governing ? governing.id : null,
      extent: complementExtent,
    },
    readiness: {
      unplaced_must_exist: unplacedMustExist,
      required_scope_unverified: [...new Set(requiredScopeUnverified)].sort((a, b) => a - b),
      // Reported only. Refusing generation while must-exist anchors are unplaced is the
      // generation slice's job (Bible §9).
      enforced: false,
    },
    immutable,
    metrics,
  };
  if (include.includes('land')) bundle.land = arrays.land;
  if (include.includes('water')) bundle.water = arrays.water;
  if (include.includes('anchors')) bundle.anchors = anchors.map(anchorEntry);
  if (include.includes('protected')) bundle.protected = arrays.protected;
  if (include.includes('routes')) bundle.routes = arrays.routes;
  if (include.includes('sites')) bundle.sites = arrays.sites;
  if (include.includes('connections')) bundle.connections = connections.map(connectionEntry);
  return bundle;
}

module.exports = { runQuery, parseRequest, BUNDLE_VERSION, INCLUDE };
