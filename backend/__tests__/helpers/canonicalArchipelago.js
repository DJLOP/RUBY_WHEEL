/**
 * The synthetic archipelago the generator-query tests run against (plan §10 "Query").
 *
 * Built through the public API — draft, then accept — so every row is exactly what the
 * lifecycle would produce. In a fresh database the ids are deterministic.
 *
 *   z
 *   ^
 *   |  [A]===bridge===[B]                          [C]   (inside east's boundary box)
 *   |  canal through A, basin between A and B,
 *   |  no-build zone on B, arboretum nodes on A and B
 *   +----------------------------------------------------> x
 *
 * Scopes: city (root, partial) → west district (partial, members A, B) → west-pair island
 * group (members A, B); east district (complete, explicit boundary around C); artisan
 * district with no extent at all.
 *
 * Anchors: arboretum (network, must-exist, two node parts, one on A and one on B); arena
 * (must-exist, required in west, unplaced); guild-office (required in artisan, which has
 * no extent — so its soft point part is accepted with a warning and reported
 * required_scope_unverified); lighthouse (not must-exist, required in east, unplaced).
 *
 * Connections: a hard bridge A↔B via the bridge route, a soft utility link between the two
 * arboretum nodes, and a soft ferry obligation between the west and east districts.
 *
 * Noise that must never reach a bundle: a draft island, a proposed water body, an island
 * that was accepted and then retired, a draft district, and a draft must-exist anchor.
 */

const { square, land, site, route, boundary, anchor, scope, connection } = require('./canonicalApi');

const CITY = 1;

async function buildArchipelago(api) {
  const ids = { city: CITY };

  ids.islandA = (await api.accepted('features', land(0, 0, 100, { name: 'Isle A' }))).id;
  ids.islandB = (await api.accepted('features', land(150, 0, 100, { name: 'Isle B' }))).id;
  ids.islandC = (await api.accepted('features', land(400, 0, 100, { name: 'Isle C' }))).id;

  ids.canal = (await api.accepted('features', {
    feature_class: 'water', kind: 'channel', geometry_type: 'polygon', constraint_strength: 'hard',
    geometry: { outer: [{ x: 45, z: -10 }, { x: 55, z: -10 }, { x: 55, z: 110 }, { x: 45, z: 110 }], holes: [] },
    attributes: { navigable: 'yes' }, name: 'Canal',
  })).id;
  ids.basin = (await api.accepted('features', {
    feature_class: 'water', kind: 'basin', geometry_type: 'polygon', constraint_strength: 'soft',
    geometry: { outer: [{ x: 110, z: 20 }, { x: 140, z: 20 }, { x: 140, z: 80 }, { x: 110, z: 80 }], holes: [] },
    name: 'Basin',
  })).id;
  ids.bridge = (await api.accepted('features', route([{ x: 100, z: 90 }, { x: 150, z: 90 }],
    { kind: 'bridge', attributes: { width_wu: 4 }, name: 'Great Bridge' }))).id;
  ids.noBuild = (await api.accepted('features', {
    feature_class: 'protected_region', kind: 'no_build', geometry_type: 'polygon', constraint_strength: 'hard',
    geometry: square(160, 60, 20),
  })).id;

  // Scopes.
  const westBoundaryless = await api.accepted('scopes', scope('west', 'district', CITY, { members: [ids.islandA, ids.islandB] }));
  ids.west = westBoundaryless.id;
  ids.westPair = (await api.accepted('scopes', scope('west-pair', 'island_group', ids.west, { members: [ids.islandA, ids.islandB] }))).id;
  // A boundary must be referenced by a scope before it is accepted: draft the scope first.
  const eastBoundaryDraft = await api.draft('features', boundary(350, -50, 200));
  const eastDraft = await api.draft('scopes', scope('east', 'district', CITY, {
    boundary_feature_id: eastBoundaryDraft.id, land_coverage: 'complete',
  }));
  ids.eastBoundary = (await api.expectStatus(await api.accept('features', eastBoundaryDraft), 200, 'accept east boundary')).record.id;
  ids.east = (await api.expectStatus(await api.accept('scopes', eastDraft), 200, 'accept east')).record.id;
  ids.artisan = (await api.accepted('scopes', scope('artisan', 'district', CITY))).id;

  // Anchors.
  ids.arboretum = (await api.accepted('anchors', anchor('arboretum', { category: 'network' }))).id;
  ids.nodeA = (await api.accepted('features', site('point', { x: 20, z: 20 }, { anchor_id: ids.arboretum, part_role: 'node' }))).id;
  ids.nodeB = (await api.accepted('features', site('point', { x: 200, z: 20 }, { anchor_id: ids.arboretum, part_role: 'node' }))).id;
  ids.arena = (await api.accepted('anchors', anchor('arena', { required_scope_id: ids.west }))).id;
  ids.guildOffice = (await api.accepted('anchors', anchor('guild-office', { category: 'facility', required_scope_id: ids.artisan }))).id;
  const hint = await api.draft('features', site('point', { x: 230, z: 90 }, {
    anchor_id: ids.guildOffice, part_role: 'core', constraint_strength: 'soft',
  }));
  const hintRes = await api.expectStatus(await api.accept('features', hint), 200, 'accept guild hint');
  ids.guildHint = hintRes.record.id;
  ids.lighthouse = (await api.accepted('anchors', anchor('lighthouse', { must_exist: false, required_scope_id: ids.east }))).id;

  // Connections.
  ids.bridgeLink = (await api.accepted('connections', connection(['feature', ids.islandA], ['feature', ids.islandB], {
    connection_kind: 'bridge', constraint_strength: 'hard', via_feature_id: ids.bridge,
  }))).id;
  ids.utility = (await api.accepted('connections', connection(['feature', ids.nodeA], ['feature', ids.nodeB], {
    connection_kind: 'utility',
  }))).id;
  ids.ferry = (await api.accepted('connections', connection(['scope', ids.west], ['scope', ids.east], {
    connection_kind: 'ferry', from_hint: { x: 240, z: 50 }, to_hint: { x: 410, z: 50 },
  }))).id;

  // Noise.
  ids.draftIsland = (await api.draft('features', land(300, 0, 20))).id;
  ids.proposedWater = (await api.expectStatus(await api.propose('features', {
    feature_class: 'water', geometry_type: 'polygon', geometry: square(330, 0, 10), constraint_strength: 'soft',
  }), 201, 'propose water')).id;
  const retired = await api.accepted('features', land(300, 50, 20));
  await api.expectStatus(await api.post(`/features/${retired.id}/retire`), 200, 'retire island');
  ids.retiredIsland = retired.id;
  ids.draftScope = (await api.draft('scopes', scope('draft-district', 'district', CITY))).id;
  ids.draftAnchor = (await api.draft('anchors', anchor('draft-anchor', { required_scope_id: ids.west }))).id;

  return ids;
}

module.exports = { buildArchipelago, CITY };
