/**
 * Cross-feature validation: whether one record may become (or again be) accepted canon,
 * given everything else that already is.
 *
 * These rules run only at accept and restore (plan §4.1). A draft may be saved while it
 * breaks every one of them, because tracing is incremental and the anchor, scope or
 * neighbouring island it needs may not be accepted yet. That is also why none of them is
 * a SQL constraint: a constraint would refuse the incomplete draft.
 *
 * Every violation is collected, not just the first, so the accept response can list them
 * all at once. Warnings do not block; the one warning in this slice is a part accepted
 * against a required scope that has no accepted extent yet (plan §3.3).
 *
 * Topology decisions use the WP1 integer-grid predicates in geometry.js, so "touching"
 * is exact: two land polygons sharing a single vertex or a sloped edge touch.
 */

const { polygonsIntersect, geometryIntersectsPolygon, bboxesIntersect } = require('./geometry');
const { SCOPE_RANK } = require('./entities');

const TABLE_BY_TYPE = { feature: 'canonical_features', anchor: 'canonical_anchors', connection: 'canonical_connections', scope: 'geo_scopes' };

const parse = (json) => JSON.parse(json);

/** Collected findings, de-duplicated so one cause reached two ways is reported once. */
class Findings {
  constructor() { this.violations = []; this.warnings = []; this.seen = new Set(); }
  add(list, code, message, ref) {
    const k = `${list}|${code}|${message}`;
    if (this.seen.has(k)) return;
    this.seen.add(k);
    this[list].push(ref ? { code, message, ref } : { code, message });
  }
  violation(code, message, ref) { this.add('violations', code, message, ref); }
  warning(code, message, ref) { this.add('warnings', code, message, ref); }
}

const acceptedRow = (q, type, id) =>
  q.get(`SELECT * FROM ${TABLE_BY_TYPE[type]} WHERE id = ? AND lifecycle_state = 'accepted'`, [id]);

const canonicalMembers = async (q, scopeId) =>
  (await q.all('SELECT feature_id FROM geo_scope_members WHERE scope_id = ? ORDER BY feature_id', [scopeId]))
    .map(r => r.feature_id);

const rectPolygon = (b) => ({
  outer: [{ x: b.min_x, z: b.min_z }, { x: b.max_x, z: b.min_z }, { x: b.max_x, z: b.max_z }, { x: b.min_x, z: b.max_z }],
  holes: [],
});

/**
 * A scope's extent as a set of polygons, or null when it has none yet (plan §3.5).
 *
 * The boundary polygon if one is set; otherwise its member land polygons; for the city
 * with neither, the bbox of all accepted land. Always a set — never a union.
 * `overrides` maps a feature id to its pending accepted form, or to null when it is about
 * to stop being accepted, so a change can ask "what would this extent be afterwards" —
 * before anything is written.
 */
async function scopeExtent(q, scope, members, overrides = new Map()) {
  const feature = async (fid) => (overrides.has(fid) ? overrides.get(fid) : acceptedRow(q, 'feature', fid));
  if (scope.boundary_feature_id) {
    const f = await feature(scope.boundary_feature_id);
    return f && f.geometry_type === 'polygon' ? [parse(f.geometry_json)] : null;
  }
  if (members.length) {
    const polygons = [];
    for (const m of members) {
      const f = await feature(m);
      if (f && f.feature_class === 'land') polygons.push(parse(f.geometry_json));
    }
    return polygons.length ? polygons : null;
  }
  if (isLandFallback(scope, members)) {
    // The candidate state: every accepted land row not being changed, plus the changed
    // rows' pending form (a revision's new geometry; nothing, for a removal).
    const changed = [...overrides.keys()];
    const b = await q.get(
      `SELECT MIN(min_x) AS min_x, MIN(min_z) AS min_z, MAX(max_x) AS max_x, MAX(max_z) AS max_z
         FROM canonical_features WHERE lifecycle_state = 'accepted' AND feature_class = 'land'
          AND id NOT IN (${changed.map(() => '?').join(', ')})`, changed);
    const boxes = b && b.min_x !== null ? [b] : [];
    for (const f of overrides.values()) if (f && f.feature_class === 'land') boxes.push(f);
    if (!boxes.length) return null;
    return [rectPolygon({
      min_x: Math.min(...boxes.map(x => x.min_x)), min_z: Math.min(...boxes.map(x => x.min_z)),
      max_x: Math.max(...boxes.map(x => x.max_x)), max_z: Math.max(...boxes.map(x => x.max_z)),
    })];
  }
  return null;
}

/** A scope whose extent is derived from all accepted land: the city with no boundary and no members. */
const isLandFallback = (scope, members) =>
  scope.scope_kind === 'city' && !scope.boundary_feature_id && !members.length;

/**
 * Re-check every accepted scope whose extent is derived from all accepted land, under a
 * pending change to accepted land (`overrides`). Any change to accepted land — a new
 * island, a moved one, one reclassified or retired — can move such an extent, so this is
 * run for all of them rather than only when the land is explicitly referenced.
 */
async function checkLandFallbackScopes(q, overrides, findings) {
  const cities = await q.all(
    `SELECT * FROM geo_scopes WHERE scope_kind = 'city' AND lifecycle_state = 'accepted' AND boundary_feature_id IS NULL`);
  for (const scope of cities) {
    const members = await canonicalMembers(q, scope.id);
    if (!isLandFallback(scope, members)) continue;
    await checkScopeDependents(q, scope.id, await scopeExtent(q, scope, members, overrides), overrides, findings);
  }
}

const intersectsExtent = (feature, extent) =>
  extent.some(poly => geometryIntersectsPolygon(feature.geometry_type, parse(feature.geometry_json), poly));

const ref = (type, id) => ({ entity_type: type, id });

/** Check a part against its anchor's required scope; `extent` null means unverified, not invalid. */
function checkPartInScope(part, extent, anchor, scopeId, findings) {
  const label = `part #${part.id} of anchor "${anchor.anchor_key}"`;
  if (!extent) {
    findings.warning('required_scope_unverified',
      `${label}: required scope #${scopeId} has no accepted extent yet, so placement inside it is unverified`,
      ref('feature', part.id));
  } else if (!intersectsExtent(part, extent)) {
    findings.violation('required_scope_violation',
      `${label} lies outside the extent of its anchor's required scope #${scopeId}`,
      ref('feature', part.id));
  }
}

/** Accepted parts of every anchor that requires `scopeId`, re-checked against a (possibly new) extent. */
async function checkScopeDependents(q, scopeId, extent, overrides, findings) {
  const requiring = await q.all(
    `SELECT id, anchor_key FROM canonical_anchors WHERE required_scope_id = ? AND lifecycle_state = 'accepted'`, [scopeId]);
  for (const anchor of requiring) {
    const parts = await q.all(`SELECT * FROM canonical_features WHERE anchor_id = ? AND lifecycle_state = 'accepted'`, [anchor.id]);
    for (const p of parts) checkPartInScope(overrides.get(p.id) || p, extent, anchor, scopeId, findings);
  }
}

async function scopeExtentById(q, scopeId, overrides) {
  const scope = await acceptedRow(q, 'scope', scopeId);
  if (!scope) return { scope: null, extent: null };
  return { scope, extent: await scopeExtent(q, scope, await canonicalMembers(q, scopeId), overrides) };
}

// ── per-entity rules ────────────────────────────────────────────────────────

async function validateFeature(q, cand, canonicalId, findings, { isRevision }) {
  const asAccepted = { ...cand, id: canonicalId, lifecycle_state: 'accepted' };
  const overrides = new Map([[canonicalId, asAccepted]]);

  // Accepted land is pairwise disjoint, boundaries included: land polygons that touch are
  // one island, and must be traced as one (a bridge between them is a route).
  if (cand.feature_class === 'land') {
    const polygon = parse(cand.geometry_json);
    const nearby = await q.all(
      `SELECT id, name, geometry_json, min_x, min_z, max_x, max_z FROM canonical_features
        WHERE lifecycle_state = 'accepted' AND feature_class = 'land' AND id <> ?
          AND min_x <= ? AND max_x >= ? AND min_z <= ? AND max_z >= ?`,
      [canonicalId, cand.max_x, cand.min_x, cand.max_z, cand.min_z]);
    for (const other of nearby) {
      if (!bboxesIntersect(cand, other)) continue;
      if (polygonsIntersect(polygon, parse(other.geometry_json))) {
        findings.violation('land_contact',
          `land overlaps or touches accepted land #${other.id}${other.name ? ` (${other.name})` : ''}; `
          + 'touching land polygons are one island and must be accepted as a single land feature',
          ref('feature', other.id));
      }
    }
  }

  if (cand.anchor_id) {
    const anchor = await q.get('SELECT * FROM canonical_anchors WHERE id = ?', [cand.anchor_id]);
    if (!anchor || anchor.lifecycle_state !== 'accepted') {
      findings.violation('part_anchor_not_accepted',
        `anchor #${cand.anchor_id} is not accepted; accept the anchor before its parts`, ref('anchor', cand.anchor_id));
    } else if (anchor.required_scope_id) {
      const { scope, extent } = await scopeExtentById(q, anchor.required_scope_id, overrides);
      if (!scope) {
        findings.violation('required_scope_not_accepted',
          `anchor "${anchor.anchor_key}" requires scope #${anchor.required_scope_id}, which is not accepted`,
          ref('scope', anchor.required_scope_id));
      } else {
        checkPartInScope(asAccepted, extent, anchor, anchor.required_scope_id, findings);
      }
    }
  }

  if (cand.feature_class === 'scope_boundary') {
    const user = await q.get(
      `SELECT id FROM geo_scopes WHERE boundary_feature_id = ? AND lifecycle_state IN ('draft', 'proposed', 'accepted') LIMIT 1`,
      [canonicalId]);
    if (!user) {
      findings.violation('scope_boundary_unreferenced',
        'a scope_boundary feature must be referenced by a scope (set boundary_feature_id on the scope first)');
    }
  }

  // A revision must leave the canon that already depends on this feature valid.
  if (isRevision) {
    const memberOf = await q.all(
      `SELECT s.id FROM geo_scope_members m JOIN geo_scopes s ON s.id = m.scope_id
        WHERE m.feature_id = ? AND m.is_canonical = 1 AND s.lifecycle_state = 'accepted'`, [canonicalId]);
    const boundaryOf = await q.all(
      `SELECT id FROM geo_scopes WHERE boundary_feature_id = ? AND lifecycle_state = 'accepted'`, [canonicalId]);
    const viaOf = await q.all(
      `SELECT id FROM canonical_connections WHERE via_feature_id = ? AND lifecycle_state = 'accepted'`, [canonicalId]);

    if (cand.feature_class !== 'land') {
      for (const s of memberOf) {
        findings.violation('dependent_requires_land', `accepted scope #${s.id} lists this feature as a member, so it must stay land`, ref('scope', s.id));
      }
    }
    if (cand.feature_class !== 'scope_boundary') {
      for (const s of boundaryOf) {
        findings.violation('dependent_requires_scope_boundary', `accepted scope #${s.id} uses this feature as its boundary`, ref('scope', s.id));
      }
    }
    if (cand.feature_class !== 'route') {
      for (const c of viaOf) {
        findings.violation('dependent_requires_route', `accepted connection #${c.id} runs via this feature, so it must stay a route`, ref('connection', c.id));
      }
    }
    for (const s of [...memberOf, ...boundaryOf]) {
      const { extent } = await scopeExtentById(q, s.id, overrides);
      await checkScopeDependents(q, s.id, extent, overrides, findings);
    }
  }

  // Land, or a revision that may stop being land, can move a fallback-derived extent.
  if (cand.feature_class === 'land' || isRevision) await checkLandFallbackScopes(q, overrides, findings);
}

async function validateAnchor(q, cand, canonicalId, findings, { target }) {
  // Bible §9 anchors are protected from automatic replacement; the SQL CHECK enforces it
  // too, but a revision that turns must_exist on is refused here with a reason.
  if (cand.must_exist && target.replacement_state === 'replaceable') {
    findings.violation('must_exist_replaceable',
      'a must_exist anchor can never be replaceable; make the anchor non_replaceable before accepting this revision');
  }
  if (cand.required_scope_id) {
    const { scope, extent } = await scopeExtentById(q, cand.required_scope_id, new Map());
    if (!scope) {
      findings.violation('required_scope_not_accepted',
        `required scope #${cand.required_scope_id} is not accepted`, ref('scope', cand.required_scope_id));
    } else {
      const parts = await q.all(`SELECT * FROM canonical_features WHERE anchor_id = ? AND lifecycle_state = 'accepted'`, [canonicalId]);
      for (const p of parts) checkPartInScope(p, extent, cand, cand.required_scope_id, findings);
    }
  }
}

async function validateConnection(q, cand, canonicalId, findings) {
  for (const end of ['from', 'to']) {
    const type = cand[`${end}_ref_type`];
    const id = cand[`${end}_ref_id`];
    if (!(await acceptedRow(q, type, id))) {
      findings.violation('endpoint_not_accepted', `${end} endpoint ${type} #${id} is not accepted canon`, ref(type, id));
    }
  }
  if (cand.from_ref_type === cand.to_ref_type && cand.from_ref_id === cand.to_ref_id) {
    findings.violation('connection_self', 'a connection must join two different entities');
  }
  if (cand.via_feature_id) {
    const via = await acceptedRow(q, 'feature', cand.via_feature_id);
    if (!via || via.feature_class !== 'route') {
      findings.violation('via_not_accepted_route', `via feature #${cand.via_feature_id} must be an accepted route feature`,
        ref('feature', cand.via_feature_id));
    }
  }
  // Hard means the alignment is canon, and an alignment is geometry. Without a route to
  // hold it, the connection is an obligation only — soft.
  if (cand.constraint_strength === 'hard' && !cand.via_feature_id) {
    findings.violation('hard_connection_requires_via',
      'a hard connection must have an accepted via_feature_id fixing its alignment; without one it must be soft');
  }
}

async function validateScope(q, cand, canonicalId, members, findings) {
  const rank = SCOPE_RANK[cand.scope_kind];

  if (cand.scope_kind === 'city') {
    if (cand.parent_scope_id) findings.violation('scope_parent_rank', 'the city scope cannot have a parent');
    const otherCity = await q.get(
      `SELECT id FROM geo_scopes WHERE scope_kind = 'city' AND lifecycle_state = 'accepted' AND id <> ?`, [canonicalId]);
    if (otherCity) {
      findings.violation('second_city_scope', `accepted city scope #${otherCity.id} already exists; there is one canonical world`,
        ref('scope', otherCity.id));
    }
  } else if (!cand.parent_scope_id) {
    findings.violation('scope_parent_required', `a ${cand.scope_kind} scope needs an accepted parent scope`);
  }

  if (cand.parent_scope_id) {
    const parent = await acceptedRow(q, 'scope', cand.parent_scope_id);
    if (!parent) {
      findings.violation('scope_parent_not_accepted', `parent scope #${cand.parent_scope_id} is not accepted`, ref('scope', cand.parent_scope_id));
    } else if (SCOPE_RANK[parent.scope_kind] >= rank) {
      findings.violation('scope_parent_rank',
        `a ${cand.scope_kind} scope cannot sit under a ${parent.scope_kind} scope (#${parent.id}); parents must rank lower (city < district < island_group < subregion)`,
        ref('scope', parent.id));
    }
    // Strict rank already rules cycles out; walking the chain states it rather than relying on it.
    const seen = new Set();
    let cursor = cand.parent_scope_id;
    while (cursor && !seen.has(cursor)) {
      if (cursor === canonicalId) {
        findings.violation('scope_cycle', 'the parent chain leads back to this scope');
        break;
      }
      seen.add(cursor);
      const next = await q.get('SELECT parent_scope_id FROM geo_scopes WHERE id = ?', [cursor]);
      cursor = next ? next.parent_scope_id : null;
    }
  }

  const children = await q.all(
    `SELECT id, scope_kind FROM geo_scopes WHERE parent_scope_id = ? AND lifecycle_state = 'accepted'`, [canonicalId]);
  for (const c of children) {
    if (SCOPE_RANK[c.scope_kind] <= rank) {
      findings.violation('scope_child_rank', `accepted child scope #${c.id} (${c.scope_kind}) would no longer rank below this ${cand.scope_kind}`,
        ref('scope', c.id));
    }
  }

  if (cand.boundary_feature_id) {
    const b = await acceptedRow(q, 'feature', cand.boundary_feature_id);
    if (!b || b.feature_class !== 'scope_boundary') {
      findings.violation('boundary_not_accepted', `boundary feature #${cand.boundary_feature_id} must be an accepted scope_boundary polygon`,
        ref('feature', cand.boundary_feature_id));
    }
  }

  for (const fid of members) {
    const f = await acceptedRow(q, 'feature', fid);
    if (!f || f.feature_class !== 'land') {
      findings.violation('scope_member_not_land', `member #${fid} must be an accepted land feature`, ref('feature', fid));
      continue;
    }
    const clash = await q.get(
      `SELECT s.id FROM geo_scope_members m JOIN geo_scopes s ON s.id = m.scope_id
        WHERE m.feature_id = ? AND m.scope_kind = ? AND m.is_canonical = 1 AND m.scope_id <> ? AND s.lifecycle_state = 'accepted'`,
      [fid, cand.scope_kind, canonicalId]);
    if (clash) {
      findings.violation('scope_member_conflict',
        `land #${fid} already belongs to accepted ${cand.scope_kind} scope #${clash.id}; an island belongs to at most one scope of each kind`,
        ref('scope', clash.id));
    }
  }

  await checkMembershipCoherence(q, cand, canonicalId, members, findings);

  // Parts that already had to lie inside this scope must still do so under its new extent.
  const extent = await scopeExtent(q, cand, members);
  await checkScopeDependents(q, canonicalId, extent, new Map(), findings);
}

/**
 * Every accepted land feature's explicit memberships must lie on one ancestry chain:
 * each membership scope is the deepest membership scope or one of its ancestors
 * (city → district → island group → subregion). Island X in district A and in island
 * group G whose parent is district B is a contradiction — a query would have to drop one.
 *
 * Checked against the candidate state: this scope with its proposed parent and members in
 * place of its current accepted form, and every other accepted scope and membership as it
 * is. Affected are this scope's members and the members of every accepted scope beneath
 * it, since a parent change moves their lineage too. Membership stays explicit: nothing
 * here infers membership from boundaries.
 */
async function checkMembershipCoherence(q, cand, canonicalId, members, findings) {
  const tree = new Map((await q.all(
    `SELECT id, scope_kind, parent_scope_id FROM geo_scopes WHERE lifecycle_state = 'accepted'`)).map(s => [s.id, s]));
  tree.set(canonicalId, { id: canonicalId, scope_kind: cand.scope_kind, parent_scope_id: cand.parent_scope_id });
  const lineage = (id) => {
    const out = [];
    const seen = new Set();
    for (let cur = tree.get(id); cur && !seen.has(cur.id); cur = cur.parent_scope_id ? tree.get(cur.parent_scope_id) : null) {
      seen.add(cur.id);
      out.unshift(cur.id);
    }
    return out;
  };

  const byFeature = new Map();
  const add = (fid, sid) => {
    if (!byFeature.has(fid)) byFeature.set(fid, []);
    byFeature.get(fid).push(sid);
  };
  const rows = await q.all(
    `SELECT m.scope_id, m.feature_id FROM geo_scope_members m JOIN geo_scopes s ON s.id = m.scope_id
      WHERE m.is_canonical = 1 AND s.lifecycle_state = 'accepted' AND m.scope_id <> ?`, [canonicalId]);
  for (const r of rows) add(r.feature_id, r.scope_id);
  for (const fid of members) add(fid, canonicalId);

  const affected = new Set(members);
  for (const [fid, scopeIds] of byFeature) {
    if (scopeIds.some(sid => lineage(sid).includes(canonicalId))) affected.add(fid);
  }
  for (const fid of [...affected].sort((a, b) => a - b)) {
    const scopeIds = byFeature.get(fid) || [];
    // Two memberships of one kind (two districts) is already `scope_member_conflict`, and
    // the unique index; reporting it again as incoherence would list one cause twice.
    const kinds = scopeIds.map(id => tree.get(id)).filter(Boolean).map(s => s.scope_kind);
    if (new Set(kinds).size !== kinds.length) continue;
    const problem = membershipIncoherence(scopeIds, tree, lineage);
    if (problem) {
      findings.violation('scope_membership_incoherent',
        `land #${fid} would belong to ${problem.stray.map(s => `${s.scope_kind} #${s.id}`).join(', ')}, `
        + `which ${problem.stray.length === 1 ? 'is' : 'are'} not on the lineage of its deepest membership `
        + `${problem.deepest.scope_kind} #${problem.deepest.id} (${problem.chain.map(s => `${s.scope_kind} #${s.id}`).join(' → ')}); `
        + 'a land feature\'s memberships must form one ancestry chain',
        ref('feature', fid));
    }
  }
}

/**
 * Whether a land feature's membership scopes fail to form one ancestry chain. `tree` maps
 * scope id to `{id, scope_kind, parent_scope_id}`; `lineage(id)` is root-first ids.
 * Returns null when coherent, else the deepest membership, its chain and the strays.
 */
function membershipIncoherence(scopeIds, tree, lineage) {
  const scopes = scopeIds.map(id => tree.get(id)).filter(Boolean);
  if (scopes.length < 2) return null;
  const deepest = scopes.reduce((d, s) =>
    (SCOPE_RANK[s.scope_kind] > SCOPE_RANK[d.scope_kind] || (SCOPE_RANK[s.scope_kind] === SCOPE_RANK[d.scope_kind] && s.id < d.id) ? s : d));
  const chainIds = lineage(deepest.id);
  const stray = scopes.filter(s => !chainIds.includes(s.id)).sort((a, b) => a.id - b.id);
  if (!stray.length) return null;
  return { deepest, chain: chainIds.map(id => tree.get(id)), stray };
}

/**
 * Whether `cand` (the columns that would become canonical) may be accepted as `canonicalId`.
 *
 * `target` is the row whose governance state survives the accept: the canonical row for a
 * revision, or the candidate itself for a new record or a restore. `isRevision` is true
 * when an existing accepted row's constraints are being replaced.
 */
async function validateAccept(q, spec, cand, canonicalId, { members = [], target = cand, isRevision = false } = {}) {
  const findings = new Findings();
  switch (spec.type) {
    case 'feature': await validateFeature(q, cand, canonicalId, findings, { isRevision }); break;
    case 'anchor': await validateAnchor(q, cand, canonicalId, findings, { target }); break;
    case 'connection': await validateConnection(q, cand, canonicalId, findings); break;
    case 'scope': await validateScope(q, cand, canonicalId, members, findings); break;
    default: throw new TypeError(`unknown entity type ${spec.type}`);
  }
  return { violations: findings.violations, warnings: findings.warnings };
}

/**
 * Accepted canon that depends on an accepted record, which retiring it would orphan
 * (plan §3.7): anchor parts, scope membership and boundaries, child scopes, anchors that
 * require a scope, and connection endpoints and via routes.
 */
async function findDependents(q, spec, id) {
  const out = [];
  const push = (rows, entity_type, relation) => rows.forEach(r => out.push({ entity_type, id: r.id, relation }));
  const connectionEnds = () => q.all(
    `SELECT id FROM canonical_connections WHERE lifecycle_state = 'accepted'
       AND ((from_ref_type = ? AND from_ref_id = ?) OR (to_ref_type = ? AND to_ref_id = ?)) ORDER BY id`,
    [spec.type, id, spec.type, id]);

  if (spec.type === 'feature') {
    push(await q.all(
      `SELECT s.id FROM geo_scope_members m JOIN geo_scopes s ON s.id = m.scope_id
        WHERE m.feature_id = ? AND m.is_canonical = 1 AND s.lifecycle_state = 'accepted' ORDER BY s.id`, [id]),
    'scope', 'member');
    push(await q.all(`SELECT id FROM geo_scopes WHERE boundary_feature_id = ? AND lifecycle_state = 'accepted' ORDER BY id`, [id]),
      'scope', 'boundary');
    push(await connectionEnds(), 'connection', 'endpoint');
    push(await q.all(`SELECT id FROM canonical_connections WHERE via_feature_id = ? AND lifecycle_state = 'accepted' ORDER BY id`, [id]),
      'connection', 'via');
  } else if (spec.type === 'anchor') {
    push(await q.all(`SELECT id FROM canonical_features WHERE anchor_id = ? AND lifecycle_state = 'accepted' ORDER BY id`, [id]),
      'feature', 'part');
    push(await connectionEnds(), 'connection', 'endpoint');
  } else if (spec.type === 'scope') {
    push(await q.all(`SELECT id FROM geo_scopes WHERE parent_scope_id = ? AND lifecycle_state = 'accepted' ORDER BY id`, [id]),
      'scope', 'child');
    push(await q.all(`SELECT id FROM canonical_anchors WHERE required_scope_id = ? AND lifecycle_state = 'accepted' ORDER BY id`, [id]),
      'anchor', 'required_scope');
    push(await connectionEnds(), 'connection', 'endpoint');
  }
  return out;
}

/**
 * Whether an accepted record may be retired without leaving accepted canon invalid, beyond
 * the explicit dependents `findDependents` reports. Retiring land removes it from every
 * fallback-derived extent, so the parts required to lie inside those are re-checked
 * against the extent as it would be without it.
 */
async function validateRetire(q, spec, row) {
  const findings = new Findings();
  if (spec.type === 'feature' && row.feature_class === 'land') {
    await checkLandFallbackScopes(q, new Map([[row.id, null]]), findings);
  }
  return { violations: findings.violations, warnings: findings.warnings };
}

module.exports = { validateAccept, validateRetire, findDependents, scopeExtent, membershipIncoherence };
