/**
 * Canonical geography as the backend serialises it (plan §3, §5).
 *
 * Pure types: no React, Three.js, network or reference-layer imports. Geometry is world X/Z
 * only, in the same `{x, z}` point convention the inherited generator uses, so accepted
 * canon can feed it without translation (plan §6.1).
 */

export interface WorldXZ {
  x: number;
  z: number;
}

/** Outer ring counter-clockwise, holes clockwise; rings are stored open. */
export interface CanonicalPolygon {
  outer: WorldXZ[];
  holes: WorldXZ[][];
}

export type GeometryType = 'point' | 'linestring' | 'polygon';

export type CanonicalGeometry = WorldXZ | WorldXZ[] | CanonicalPolygon;

export interface BBox {
  min_x: number;
  min_z: number;
  max_x: number;
  max_z: number;
}

// ── governance vocabularies ──────────────────────────────────────────────────

export type LifecycleState = 'draft' | 'proposed' | 'accepted' | 'retired';
export type Provenance = 'authored' | 'imported' | 'generated';
export type ConstraintStrength = 'hard' | 'soft';
export type ReplacementState = 'non_replaceable' | 'replaceable';

export type FeatureClass = 'land' | 'water' | 'route' | 'protected_region' | 'site' | 'scope_boundary';
export type WaterKind = 'open_water' | 'channel' | 'basin' | 'wetland' | 'other';
export type RouteKind = 'wall' | 'bridge' | 'causeway' | 'road' | 'quay_edge' | 'conduit' | 'other';
export type ProtectedKind = 'no_build' | 'preserve_existing' | 'reserved';
export type PartRole = 'core' | 'footprint' | 'precinct' | 'node' | 'link' | 'access' | 'extent';
export type AnchorCategory = 'landmark' | 'precinct' | 'compound' | 'facility' | 'network' | 'other';
export type ConnectionKind = 'road' | 'bridge' | 'ferry' | 'water_route' | 'utility' | 'pedestrian' | 'other';
export type RefType = 'feature' | 'anchor' | 'scope';
export type ScopeKind = 'city' | 'district' | 'island_group' | 'subregion';
export type LandCoverage = 'partial' | 'complete';
export type Navigability = 'yes' | 'no' | 'unknown';

// ── records (GET /api/canonical-geography/:entity) ───────────────────────────

interface GovernedRecord {
  id: number;
  name: string | null;
  description: string | null;
  notes: string | null;
  lifecycle_state: LifecycleState;
  provenance: Provenance;
  replacement_state: ReplacementState;
  is_locked: boolean;
  revision: number;
  draft_version: number;
  revises_id: number | null;
  base_revision: number | null;
  evidence: Record<string, unknown> | null;
  proposal: Record<string, unknown> | null;
  created_at?: string;
  updated_at?: string;
  accepted_at?: string | null;
}

export interface CanonicalFeature extends GovernedRecord {
  entity_type: 'feature';
  feature_class: FeatureClass;
  kind: string | null;
  geometry_type: GeometryType;
  geometry: CanonicalGeometry;
  construction: Record<string, unknown> | null;
  attributes: Record<string, unknown> | null;
  bbox: BBox;
  anchor_id: number | null;
  part_role: PartRole | null;
  constraint_strength: ConstraintStrength;
}

export interface CanonicalAnchor extends GovernedRecord {
  entity_type: 'anchor';
  anchor_key: string;
  category: AnchorCategory;
  constraint_strength: ConstraintStrength;
  must_exist: boolean;
  required_scope_id: number | null;
  linked_location_id: number | null;
}

export interface CanonicalConnection extends GovernedRecord {
  entity_type: 'connection';
  connection_kind: ConnectionKind | null;
  from_ref_type: RefType;
  from_ref_id: number;
  to_ref_type: RefType;
  to_ref_id: number;
  from_hint: WorldXZ | null;
  to_hint: WorldXZ | null;
  via_feature_id: number | null;
  constraint_strength: ConstraintStrength;
}

export interface GeoScope extends GovernedRecord {
  entity_type: 'scope';
  scope_key: string;
  scope_kind: ScopeKind;
  parent_scope_id: number | null;
  boundary_feature_id: number | null;
  land_coverage: LandCoverage;
  members: number[];
}

// ── the generator-facing query (POST /api/canonical-geography/query) ─────────

export type QueryTarget =
  | { scope_id: number }
  | { feature_id: number }
  | { bbox: BBox }
  | { polygon: CanonicalPolygon };

export type QueryInclude = 'land' | 'water' | 'anchors' | 'protected' | 'routes' | 'sites' | 'connections';

export type QueryRequest = QueryTarget & { halo_wu?: number; include?: QueryInclude[] };

/** Where an included entity sits relative to the requested extent. */
export type Relation = 'inside' | 'boundary' | 'context';

export interface ScopeChainEntry {
  id: number;
  scope_key: string;
  scope_kind: ScopeKind;
  name: string;
  revision: number;
  land_coverage: LandCoverage;
}

export interface BundleScope {
  ref: { type: 'scope' | 'feature'; id: number } | { type: 'bbox'; bbox: BBox } | { type: 'polygon' };
  kind: ScopeKind | 'island' | FeatureClass | 'bbox' | 'polygon';
  scope_key?: string;
  name?: string | null;
  revision?: number;
  /** Enclosing scopes, root first; never includes the queried scope itself. */
  chain: ScopeChainEntry[];
  /** The extent as a set of polygons — never a union. Empty when a scope has no extent yet. */
  extent: CanonicalPolygon[];
  extent_feature_ids: number[];
  land_coverage: LandCoverage;
  halo_wu: number;
  descendant_scope_ids: number[];
}

export interface BundleFeature {
  id: number;
  revision: number;
  feature_class: FeatureClass;
  kind: string | null;
  geometry_type: GeometryType;
  geometry: CanonicalGeometry;
  bbox: BBox;
  constraint_strength: ConstraintStrength;
  attributes: Record<string, unknown> | null;
  anchor_id: number | null;
  part_role: PartRole | null;
  name: string | null;
  replacement_state: ReplacementState;
  is_locked: boolean;
  relation: Relation;
}

export interface BundleLand extends BundleFeature {
  feature_class: 'land';
  geometry: CanonicalPolygon;
}

export interface BundleWater extends BundleFeature {
  feature_class: 'water';
  geometry: CanonicalPolygon;
  navigable: Navigability;
}

export interface BundleProtected extends BundleFeature {
  feature_class: 'protected_region';
  geometry: CanonicalPolygon;
}

export interface BundleRoute extends BundleFeature {
  feature_class: 'route';
  geometry: WorldXZ[];
  /** Sampled at vertices and segment midpoints: explicit water, or complete-coverage complement. */
  crosses_water: boolean;
  leaves_land: boolean;
  crosses_extent_boundary: boolean;
}

export interface BundleSite extends BundleFeature {
  feature_class: 'site';
}

export interface BundleAnchorPart {
  feature_id: number;
  revision: number;
  feature_class: FeatureClass;
  part_role: PartRole | null;
  constraint_strength: ConstraintStrength;
  /** 'outside' parts are listed for completeness; their geometry is not in the bundle. */
  relation: Relation | 'outside';
}

export interface BundleAnchor {
  id: number;
  revision: number;
  anchor_key: string;
  name: string;
  category: AnchorCategory;
  constraint_strength: ConstraintStrength;
  must_exist: boolean;
  required_scope_id: number | null;
  replacement_state: ReplacementState;
  is_locked: boolean;
  placed: boolean;
  relation: Relation | 'unplaced';
  parts: BundleAnchorPart[];
}

export type EndpointPosition = 'in' | 'context' | 'enclosing' | 'out';

export interface BundleConnectionEnd {
  ref_type: RefType;
  ref_id: number;
  hint: WorldXZ | null;
  position: EndpointPosition;
}

export type ConnectionTag = 'internal' | 'crossing' | 'external_obligation';

export interface BundleConnection {
  id: number;
  revision: number;
  connection_kind: ConnectionKind | null;
  constraint_strength: ConstraintStrength;
  name: string | null;
  from: BundleConnectionEnd;
  to: BundleConnectionEnd;
  via_feature_id: number | null;
  replacement_state: ReplacementState;
  is_locked: boolean;
  tag: ConnectionTag;
}

export interface WaterComplement {
  /** 'complete': inside `extent`, non-land non-explicit-water is water; 'partial': unknown. */
  rule: LandCoverage;
  coverage_scope_id: number | null;
  extent: CanonicalPolygon[];
}

export interface BundleReadiness {
  unplaced_must_exist: number[];
  required_scope_unverified: number[];
  /** Always false in this slice: readiness is reported, not enforced. */
  enforced: boolean;
}

export interface EntityRef {
  entity_type: 'feature' | 'anchor' | 'connection' | 'scope';
  id: number;
}

export interface BundleMetrics {
  semantics: 'overlap_naive';
  extent: { polygons: number; area_m2: number; area_ha: number };
  land: { count: number; area_m2: number; area_ha: number; shoreline_m: number };
  water: { explicit_count: number; explicit_area_m2: number; explicit_area_ha: number };
  protected: { count: number; area_m2: number; area_ha: number };
  routes: { count: number; length_m: number };
  anchors: { placed: number; context: number; unplaced_obligations: number; unplaced_must_exist: number };
}

export interface CanonicalQueryBundle {
  bundle_version: 1;
  scope: BundleScope;
  digest: string;
  water_complement: WaterComplement;
  readiness: BundleReadiness;
  immutable: EntityRef[];
  metrics: BundleMetrics;
  land?: BundleLand[];
  water?: BundleWater[];
  anchors?: BundleAnchor[];
  protected?: BundleProtected[];
  routes?: BundleRoute[];
  sites?: BundleSite[];
  connections?: BundleConnection[];
}
