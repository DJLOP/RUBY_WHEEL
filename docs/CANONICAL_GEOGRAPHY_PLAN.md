# Normalized Canonical Macro Geography and Hard Anchors — Implementation Plan

**Status:** Approved — human-approved for implementation.
**Baseline:** `main` at `2b446c2` (Add Imperial City generation bible).
**Governing documents:** `docs/REQUIREMENTS.md` (R-002, R-005–R-007, R-010–R-012, R-020–R-025, R-050, R-090–R-093, R-100–R-101), `docs/ARCHITECTURE.md` (A-001–A-017, §7, §8, §14, §15, §21, §22, §24, §31). `docs/IMPERIAL_CITY_GENERATION_BIBLE.md` (the "Bible") is the authoritative human-readable world specification. It supplies the initial must-exist hard-anchor set (§9) and the district/world context used here (§1, §3, §4, §8). It does not override the requirements or architecture.

**Post-WP6 amendment.** WP6 human use established that districts are drawn spatial regions independent of physical islands, that island groups are optional semantic scopes rather than a generation tier, and that future generation runs through demand-created generation worksets/batches. These are recorded authoritatively in `docs/REQUIREMENTS.md` (R-011, R-013, R-014, R-025, R-026, R-031) and `docs/ARCHITECTURE.md` (A-017–A-020, §8, §9). This plan is reconciled with them in §3.5, §6, §9, and §13. The WP1–WP6 schema and behavior are unchanged, and WP7 scope is unchanged.

**Pre-WP7 authoring-tools slice.** §15 adds a small inserted slice, **AT1 — deterministic radial construction**, which executes R-014 / A-020 between WP6 and WP7. It does not renumber, re-scope, or depend on WP7. §15 is planned and awaiting human review before implementation.

## 1. Goal and completion criteria

Establish persistent, structured, explicitly accepted canonical spatial constraints — land, major water, hard/soft anchors, protected regions, canonical linear/connective features, required connections, and hierarchical spatial scopes — that later planners and generators can query without touching raster evidence.

The capability is complete when:

- An authorized world editor can trace normalized geometry over a visible calibrated reference layer, or import it, and it is stored in canonical world X/Z units as **draft**, never as accepted canon.
- Drafts, software proposals, accepted canon, and retired records are distinct persisted states. Only one explicit, world-editor-authorized accept operation can make geometry canonical.
- Accepted records carry explicit provenance, constraint strength, replacement state, lock state, and revision history, and cannot be silently overwritten, deleted, or auto-replaced.
- The Bible §9 must-exist hard anchors can be registered (placed or not yet placed), composed of one or more geometric parts (points, footprints, precincts, linear parts, network nodes/links), inspected, and never made automatically replaceable. The register is imported from a Bible-derived document and accepted by the GM, not re-typed by hand.
- Generator queries report which must-exist hard anchors in a scope are still unplaced. This makes the Bible §9 rule "represented before ordinary procedural generation is allowed to replace surrounding fabric" checkable by the later generation slice.
- Spatial scopes (supported kinds ranked city → district → island group → subregion; islands are land features) persist with parent/containment relationships. The rank orders scope parentage; it does not make `island_group` a mandatory generation stage (see §3.5).
- A generator-facing query returns, for any scope, bounding box, polygon, or island, the accepted land, water, anchors, protected regions, routes, and boundary-crossing connections, plus a deterministic canonical-input digest.
- Physical scale (1 wu = 1.524 m) is preserved and independent of the inherited `GLOBAL MAP SCALE` setting.
- Legacy saved-map load/clear, region purge, inherited undo, and reference-layer edits cannot alter canonical geography.
- Existing backend/frontend suites and the frontend production build pass.

This slice creates the constraint substrate. It does not plan, allocate, or generate.

## 2. Relevant repository findings

Only findings that materially affect this slice.

### 2.1 Inherited primitives are not suitable canonical storage

- **`water_bodies`** (`backend/db.js:290–298`): `points_json`, an inherited `map_scale_multiplier` text column, and a boolean `generated`. It has no provenance vocabulary, lifecycle, lock, replacement state, semantic type, or revision. It is deleted wholesale by legacy map load and clear (`backend/routes/maps.js:97`, `:163`), and generated rows are deleted by `POST /api/locations/purge-region` (`backend/routes/locations.js:253–272`). Its writes are `authenticate`-only (`backend/routes/admin.js:226–255`), with an unguarded `DELETE /api/water` that deletes everything. If canonical water were stored there, current inherited behavior would violate R-002/A-002.
- **`districts`** (`backend/db.js:45`): `name` + `color` only, `authenticate`-only CRUD (`backend/routes/admin.js:140–213`), and deleted by legacy load/clear. It carries no geometry.
- **`roads`** / **`overpasses`**: segment/polyline rows with no governance fields. They are also deleted by legacy load/clear.
- **Freehand drawing** (`frontend/src/components/MapElements.tsx:10–247`, `DistrictInteractions`): water and generation boundaries are recorded as dense pointer-drag trails. That is the wrong input model for normalized geometry, which needs deliberate vertices, vertex editing, snapping, and regular-shape construction. The **Y=0 plane raycast** pattern (`MapElements.tsx:59–62`, `:112–114`) can be reused.

**Conclusion:** create a dedicated canonical-geography persistence model, isolated in the same way as reference layers. Reuse inherited mechanisms (see 2.2) rather than inherited tables. Architecture open decision §31.5 is resolved for canonical macro geography: it gets a new geographic-region abstraction.

### 2.2 Seams worth reusing

- **Ordered migrations:** `backend/migrations/index.js` (append-only list, ledger, transactional apply) and the `db.ready` gate in `backend/db.js`. Canonical geography becomes migration `002`.
- **Authorization:** `requireWorldEditor` in `backend/middleware/auth.js:48` (primary admin only, not temporary elevation) is used unchanged.
- **Router pattern:** `backend/routes/reference_layers.js` provides the promisified `run/get/all` helpers, `Invalid` error → status mapping, protected/display field split, locked-row 409 semantics, "unlock is its own request", normalized serialization, and one `emitUpdate()` per successful mutation.
- **Realtime:** the generic `dataUpdated` → refetch path (`frontend/src/hooks/useSocket.ts:24,62`; `useMapData.ts:57–72`), extended in the same way as `onFetchReferenceLayers`.
- **Calibration:** `sourceToWorld` / `worldToSource` in `frontend/src/modules/referenceLayers/calibration.ts:39,57` support source-pixel readouts while tracing and source-pixel-coordinate import. The reference-layer module does not otherwise change.
- **Geometry predicates:** `pointInPolygon` / `Polygon` `{x,z}[]` in `frontend/src/cityGen/water.ts`, `makeRegionTest` in `frontend/src/cityGen/region.ts` (and its backend twin used by purge-region), and `SpatialGrid` in `frontend/src/cityGen/collision.ts:29`. Canonical geometry uses the same `{x, z}` point convention so it can feed the generator directly later.
- **Generator input seam:** `GenerateCityContext` / `GenerateCityOptions.boundary` in `frontend/src/cityGen/types.ts` already accept polygons, water polygons, and obstacles. That is the natural future bridge, but it is not wired in this slice.
- **Module layout:** `frontend/src/modules/referenceLayers/` is the precedent for a dedicated feature module, a primary-admin launcher in the AdminPanel CITY tab, and integration-only edits to `App.tsx`.
- **Test patterns:** `backend/__tests__/reference_layers.test.js`, `maps.reference_layers.test.js` (legacy boundary), `migrations.test.js`, `require_world_editor.test.js`, and `purge_region.test.js`.

### 2.3 Gaps that shape the design

- **No polygon boolean library exists** (backend deps: `image-size`, no geometry; frontend: `three` only). The inherited generator works through point and footprint predicates, not clipping. This slice therefore needs only predicates (point-in-polygon, segment intersection, bbox, polygon-intersects, area/length) and must **not** depend on union, difference, or buffering. A clipping dependency is deferred to the slice that first needs it (probably island morphology), recorded then as an architecture decision under §3.
- **Generation currently runs in the browser** (`AdminPanel.tsx:618`, `generateCity`). The canonical query must therefore be a server endpoint returning a versioned JSON bundle, plus a pure client-side adapter. Neither side depends on the other's runtime, so generation can later move server-side without changing the bundle.
- **No physical-scale constant exists in code**, apart from the calibration default. This slice adds one and makes every metric use it.
- **SQLite `PRAGMA foreign_keys` is not enabled globally** (recorded in `REFERENCE_LAYER_PLAN.md` §3.1). Referential integrity is enforced in route transactions, as reference layers do.

### 2.4 Generation Bible findings that shape this slice

Only the Bible content that materially affects persistence, workflow, or acceptance is listed here. Everything else is left to later profile and generation slices.

- **Must-exist hard anchors (Bible §9).** Nine features must be represented as *protected hard anchors or protected infrastructure* before ordinary generation may replace surrounding fabric. Their **identity, required presence, and established spatial/functional relationships** are protected. Surrounding fabric does **not** need to be hand-authored. The model therefore separates anchor-level protection (identity, presence, district, relationships) from part-level geometric fidelity (§3.3). It also makes unplaced anchors visible to queries (§5.3).
- **Districts are established identities (Bible §1.1, §3, §4).** These are the eight inner districts around White-Gold, the White-Gold District itself, and the outer districts/island chains: Nibenese, Arcane, Waterfront, Colovian, the Agrarian Estates island chain, and the Prison / Legion Headquarters complex. Several anchors are tied to a district by the Bible, so `district` scopes must be able to carry them. The Bible establishes district *roles*, not district boundary geometry. Boundaries remain world-editor tracing/acceptance work.
- **Archipelago scale (Bible §1.1).** The city is built across "hundreds of islands and broad waterways". This confirms that island identity must be cheap: land features, not a heavyweight table (§3.5). It also sets the scale of the WP3 synthetic measurement.
- **Crossing hierarchy (Bible §1.3).** Crossings are hierarchical, and "ferry-only gaps are normal". A canonical required connection must therefore not imply a bridge. `connection_kind` gains `ferry`, and may be left unspecified so later synthesis can choose the mode (§3.4).
- **Walls (Bible §1.3).** Walls are inhabited linear fortresses and military highways, and water posterns combine gate and water control. These fit the existing `route/wall` plus gate `site`/`access` parts. No new type is needed.
- **Arboretum (Bible §3.4).** It is a water-management system of channels, settling basins, reed beds, controlled marshes, locks, and overflow basins, where water-management geometry dominates street grids. The existing network-anchor representation is sufficient. The one vocabulary addition is `water.kind = wetland` for controlled marsh/reed-bed extents, so they are not mislabeled as open water (§4.1).
- **White-Gold caution (Bible §3.9).** Older working dimensions conflict with the current scale. White-Gold geometry is traced against the current-scale calibrated raster, and no numeric dimensions from older sources are encoded.
- **Division of labor (Bible "Division of labor", §8, §9).** The GM supplies high-level truth and acceptance. RUBY_WHEEL/AI derive lower-level detail, and the Bible→machine-profile conversion is itself AI work. Canonical geography therefore carries **no** profile, culture, crop, household, façade, or archetype data. Those attach later to scopes by id (§6.5, §7.1).

## 3. Proposed persistent data model

Migration `backend/migrations/002-canonical-geography.js`. It is additive: no existing table is read, rewritten, or reinterpreted.

### 3.1 Governance axes (shared by every canonical entity)

Five independent columns, never inferred from each other:

| Axis | Column | Values | Meaning |
| --- | --- | --- | --- |
| Lifecycle | `lifecycle_state` | `draft`, `proposed`, `accepted`, `retired` | `draft` = editor working state; `proposed` = software/AI-synthesized, awaiting review; `accepted` = canonical; `retired` = formerly canonical, soft-removed and restorable. Only `accepted` is visible to generator queries. |
| Provenance | `provenance` | `authored`, `imported`, `generated` | Origin only (A-003). Tracing over a raster is `authored` with evidence metadata. File/legacy import is `imported`. Proposals are `generated`. Acceptance never rewrites provenance. |
| Constraint strength | `constraint_strength` | `hard`, `soft` | R-007/A-016. `hard` = geometry/location is preserved closely. `soft` = existence, role, and approximate location/extent are canonical, but exact geometry is free. Not present on scopes. |
| Replacement | `replacement_state` | `non_replaceable` (default), `replaceable` | Whether any *automatic* process may replace the record (A-004). Changed only by an explicit dedicated request. |
| Protection | `is_locked` | 0/1 (default 0) | Blocks manual destructive edits (revise-accept, retire, replacement-state change, constraint-field edits) until a separate unlock request. |

Supporting columns on every entity table:

- `revision INTEGER NOT NULL DEFAULT 0`: increments on each accepted **constraint** change. 0 means never accepted. Descriptive edits do not increment it (see 3.7).
- `draft_version INTEGER NOT NULL DEFAULT 1`: optimistic-concurrency counter for draft edits. Accept requires the caller's `expected_draft_version`, so the UI cannot accept something other than what it displayed.
- `revises_id INTEGER NULL`: on a draft or proposal, the accepted row it would replace. At most one open draft/proposal revision per accepted row per origin.
- `evidence_json TEXT NULL`: `{ reference_layer_id, calibration_snapshot: {world_center_x, world_center_z, world_units_per_pixel, rotation_rad}, note }`. This is documentation of evidence, **not** a dependency. Deleting or recalibrating a reference layer never touches canonical geometry.
- `proposal_json TEXT NULL`: required when `provenance='generated'`: `{ source, generator, generator_version, seed, input_digest, rationale }`.
- `name`, `description`, `notes`: descriptive text, length-limited.
- `created_at`, `updated_at`, `accepted_at`.

SQLite `CHECK` constraints enforce each vocabulary and the rule `provenance='generated' ⇒ proposal_json IS NOT NULL`. Request validation mirrors them so callers get useful 400 responses.

### 3.2 `canonical_features`: all canonical geometry

One table for geometry. Semantics come from a closed `feature_class`, not from separate tables, because every class shares the lifecycle, governance, bbox query path, and revision history, and a generator asking "what is in this scope" needs one indexed query.

| Column | Meaning |
| --- | --- |
| `id` | Stable identity. Accepting a revision keeps the id. This is what planners reference. |
| `feature_class` | `land`, `water`, `route`, `protected_region`, `site`, `scope_boundary` (see §4). |
| `kind` | Optional class-specific subtype from a small validated vocabulary (§4). Null means unspecified. |
| `geometry_type` | `point`, `linestring`, `polygon`. Class compatibility is enforced (§4). |
| `geometry_json` | World X/Z only: point `{x,z}`; linestring `[{x,z}…]` (closed when first equals last); polygon `{ outer: [{x,z}…], holes: [[…]…] }`. Rings are stored open. The outer ring is normalized counter-clockwise in X/Z and holes clockwise. Coordinates are rounded to 0.001 wu (~1.5 mm) for stable digests. |
| `construction_json` | Optional normalized construction parameters from which the geometry was derived, for example `{type:'circle', center:{x,z}, radius}` or `{type:'ellipse', …}` / `{type:'rect', …}`. Geometry stays authoritative, and construction lets later edits and synthesis preserve intent. |
| `min_x, min_z, max_x, max_z` | Server-computed bbox, indexed. |
| `attributes_json` | Class-validated optional physical/semantic attributes (§4). Every attribute is optional; unspecified means "derivable later". |
| `anchor_id`, `part_role` | Optional membership as a part of one anchor (§3.3). `part_role` requires `anchor_id`. |
| governance columns | §3.1. |

Indexes: `(lifecycle_state, feature_class)`, `(min_x, max_x)`, `(min_z, max_z)`, `(anchor_id)`, `(revises_id)`.

**Spatial indexing decision:** use plain indexed bbox columns plus an exact JS predicate. Macro geography is expected to be hundreds to low thousands of features. An SQLite R\*Tree virtual table is deferred until the WP3 measurement shows a need. The `min/max` columns map directly onto an R\*Tree later without schema replacement.

### 3.3 `canonical_anchors`: semantic identity, not geometry

An anchor is a lightweight semantic register entry that owns zero or more geometric parts in `canonical_features`. This keeps "the Arena must exist and is here" separate from its footprint, lets an anchor be registered before it is traced ("unplaced"), and lets one anchor span several geometries (for example, a basin, a quay edge, and a land precinct).

| Column | Meaning |
| --- | --- |
| `id`, `anchor_key` | Stable id plus unique human-readable slug (for example `arena`) for import/export matching. |
| `name`, `description`, `notes` | Descriptive. |
| `category` | `landmark`, `precinct`, `compound`, `facility`, `network`, `other`. This is organizational only; generators never branch on it (A-007). |
| `constraint_strength` | Anchor-level strength. `hard` means identity, required presence, required scope, and established spatial/functional relationships are protected canon, as for every Bible §9 anchor. `soft` means the feature must exist in an appropriate place and role (R-007). This does **not** say how exact the geometry is. |
| `must_exist` | 1 by default. When `must_exist = 1`, `replacement_state` is fixed at `non_replaceable` (DB `CHECK` plus route validation), because Bible §9 anchors are protected from automatic replacement. |
| `required_scope_id` | Optional. The anchor must lie within this scope, for example the Artisan District for the Mages' Guild satellite office. On part acceptance the part must intersect the scope's extent. If the scope has no accepted extent yet, the accept response returns a warning and the query marks the part `required_scope_unverified`, so tracing is never blocked on district boundaries being finished. |
| `linked_location_id` | Optional pointer to a future semantic POI (`locations` row). Not enforced and not used in this slice. It is the promotion seam (R-071) and does not make every POI an anchor. |
| governance columns | §3.1. |

Placement is **derived**, not stored: an accepted anchor is `placed` if at least one accepted part exists, otherwise `unplaced`. Ordinary future POIs are **not** anchors. Anchors are only canonical constraints that generation must respect.

**Anchor strength and part strength are independent.** A hard anchor may have soft parts. For example, the Mages' Guild office's district placement may be canon while its exact footprint is not. In that case the anchor is `hard` with `required_scope_id` set, and it has a `soft` point part used as a placement hint (or no part yet). A later accepted proposal can supply the exact footprint. Nothing forces exact geometry where the source leaves it approximate. A **hard part** is geometry preserved closely. A **soft part** is indicative location/extent that a future generator or AI proposal may refine through the proposal → accept path, never automatically.

An anchor may have several non-contiguous parts. The Bible (§6) warns against assuming "one mansion equals one house". Only *canonical* parts belong here, though. Ordinary satellite properties and economic attachments are later generation output, not anchor parts.

### 3.4 `canonical_connections`: required connectivity and topology

Some canon is a relationship rather than a shape: "a bridge must connect these two islands", "the treatment works must connect to the flood channel", "this gate must be reachable from the docks". Point and polygon geometry alone cannot express that obligation.

| Column | Meaning |
| --- | --- |
| `id` | Stable identity. |
| `connection_kind` | Nullable: `road`, `bridge`, `ferry`, `water_route`, `utility`, `pedestrian`, `other`. Null means the canon requires the connection but not its mode, and later synthesis chooses (Bible §1.3: ferry-only gaps are normal; not every gap is bridged). |
| `from_ref_type` / `from_ref_id`, `to_ref_type` / `to_ref_id` | Each endpoint is a `feature`, `anchor`, or `scope`. |
| `from_hint_json`, `to_hint_json` | Optional approximate endpoint points `{x,z}`. |
| `via_feature_id` | Optional accepted `route` feature that fixes the alignment. When present with `hard` strength, the path is canonical geometry. When absent, the connection is an obligation that a generator must realize. |
| `constraint_strength` | `hard` (fixed alignment via a route feature) or `soft` (must connect, alignment free). |
| governance columns | §3.1. |

### 3.5 `geo_scopes` and `geo_scope_members`: hierarchy without planners

| Column | Meaning |
| --- | --- |
| `id`, `scope_key` | Stable id plus unique slug. |
| `scope_kind` | `city`, `district`, `island_group`, `subregion`. Rank order is city < district < island_group < subregion. |
| `parent_scope_id` | Must point to an accepted scope of lower rank. Cycles are rejected. A subregion may be parented by a district or an island group. |
| `boundary_feature_id` | Optional accepted `scope_boundary` polygon feature. |
| `land_coverage` | `partial` (default) or `complete`. Governs water-by-complement semantics (§4.2). |
| `name`, `description` | Descriptive. |
| governance columns | §3.1 (no constraint strength). |

`geo_scope_members (scope_id, feature_id, scope_kind, is_canonical)` holds explicit **land-feature** membership. A partial unique index `UNIQUE(feature_id, scope_kind) WHERE is_canonical = 1` ensures that an island belongs to at most one accepted district and one accepted island group. Draft scope rows own their own draft member rows, which transfer on accept.

**Islands are first-class as accepted `land` features** (stable id, optional name, revision), not as a separate table or scope row. Queries accept an island (`feature_id`) as a scope. This gives islands identity now without making them independent generation units (§6.4).

**Scope extent** is defined as follows. If `boundary_feature_id` is set, the extent is that polygon. Otherwise it is the set of member land polygons, and for `city` with neither, the bbox of all accepted land. A multi-polygon extent is always handled as a *set* of polygons, so no union operation is ever required. (Post-WP6: the member-polygon fallback is retained as implemented, but it is a legacy query/selection convenience only and not authoritative district geometry; see the clarification below.)

Migration `002` inserts exactly one root scope: `scope_key='city'`, `scope_kind='city'`, name `Imperial City`, `accepted`, `authored`, `non_replaceable`, unlocked. This is structural (A-001: one canonical world). The migration seeds no district, island, or anchor data, and seed data never depends on migrations.

The Bible's district set (§2.4) is instead delivered as part of a Bible-derived register document (§8.3, WP7). It contains `district` scopes by key and name, with no geometry, and is imported as drafts for GM acceptance. The Bible names the Agrarian Estates an island *chain* and the Prison / Legion Headquarters complex an outer district. Both are `district` scopes that may later contain `island_group` children. The substrate does not decide whether a district is "inner" or "outer". That is a strategy-level attribute for the next slice.

**Post-WP6 clarification (accepted WP6 behavior).**

- `city`, `district`, `island_group`, and `subregion` are the supported semantic scope kinds, and their rank governs only valid parentage. `island_group` is an optional scope for a genuine named grouping (for example, an island chain). It is not a mandatory planning or generation tier, and no island needs an island group.
- A district's authoritative spatial extent comes only from its accepted drawn boundary (`boundary_feature_id`). A district with no accepted boundary has no authoritative spatial extent. Explicit whole-island membership (`geo_scope_members`) is metadata/convenience only and never defines authoritative district extent.
- The current implementation still resolves a member-polygon extent for a boundaryless scope in its query and accept-time validation paths. That behavior is unchanged, but it is a legacy query/selection convenience only: it is not canonical district geometry, future district planning/generation must not interpret it as authoritative district extent, and it must not recreate a District → Island ownership model.
- One island may spatially intersect several district boundaries. The `UNIQUE(feature_id, scope_kind)` constraint limits only *explicit whole-island membership*; it does not limit spatial intersection, and the query already returns land that a district boundary cuts as `boundary` land.
- Accepted `land` polygons remain the physical island identity. Districts and islands are independent geometries (A-019), and later generation may derive `island ∩ district` pieces, only from authoritative (accepted-boundary) district geometry, rather than requiring manually split island features.

Scopes carry **no** generation-profile, culture, crop, or wealth fields. Machine-readable profiles derived from the Bible (Bible §8) attach to scopes by id in later slices.

### 3.6 `canonical_revisions`: history and recoverability

`(id, entity_type, entity_id, revision, change_kind, snapshot_json, created_at)` is append-only. `change_kind` is one of `accept`, `descriptive_edit`, `retire`, `restore`, `lock`, `unlock`, `replacement_change`. It is written in the same transaction as the change. Restoring an older revision creates a **draft** from its snapshot, which must then be accepted, so there is no bypass path. Canonical operations do **not** write to the inherited `action_history` / `/api/admin/undo` mechanism, whose semantics are map-wide and legacy.

### 3.7 Editing rules for accepted records

- **Constraint fields** (geometry, class, kind, attributes, strength, anchor/part linkage, endpoints, `via_feature_id`, parent scope, boundary, membership, `land_coverage`, `required_scope_id`) are **never** edited in place on an accepted row. `POST …/:id/revise` creates a draft copy with `revises_id`. Accepting that draft copies the fields onto the canonical row in one transaction (same id, `revision + 1`), writes history, and deletes the draft. This is rejected with 409 while the canonical row is locked.
- **Descriptive fields** (`name`, `description`, `notes`) may be edited in place on an unlocked accepted row. The change is recorded as `descriptive_edit` history without a revision bump, so planner references do not go stale over a typo fix.
- Drafts and proposals are freely editable by the world editor and may be hard-deleted, because they are not canonical. Accepted rows are never hard-deleted through the API. They are retired (unlocked only), and retirement is rejected with 409 while accepted dependents exist (anchor parts, scope membership, connection endpoints, or `via` routes), listing them.

## 4. Geometry and anchor types required in this slice

### 4.1 Feature classes

| Class | Geometry | `kind` vocabulary (optional) | Attributes (all optional) | Purpose |
| --- | --- | --- | --- | --- |
| `land` | polygon (holes allowed) | — | — | Island / landmass. An accepted land feature *is* the island identity. |
| `water` | polygon (holes allowed) | `open_water`, `channel`, `basin`, `wetland`, `other` | `navigable: yes/no/unknown` | Explicit major water. It is needed only where water must be named, typed, have differing navigability, or cut through land (canal or pond inside an island). `wetland` covers canonical controlled marsh/reed-bed extents such as the Arboretum's (Bible §3.4). It is a subtype, not a new land/water class. |
| `route` | linestring (open or closed) | `wall`, `bridge`, `causeway`, `road`, `quay_edge`, `conduit`, `other` | `width_wu`, `crosses_water` (derived) | Canonically important linear/connective geometry: exterior wall ring, fixed bridges, canonical major roads, quay lines, fixed conduits. |
| `protected_region` | polygon | `no_build`, `preserve_existing`, `reserved` | — | Regions generators must not build into or must leave as-is, independent of anchors. |
| `site` | point, linestring, or polygon | — | — | Anchor geometry that is neither land, water, nor a route: footprints, precincts, compound boundaries, network nodes, gates as points. |
| `scope_boundary` | polygon | — | — | Explicit boundary for a district/island-group/subregion scope whose extent is not whole islands. Post-WP6: for a district, this is the only authoritative spatial extent (§3.5). |

Validation (backend, pure JS module, no new dependency):

- Finite coordinates within `±WORLD_LIMIT` = 20,000 wu (~30 km, about 4.5× the 4,425.20 wu canonical span). This catches unit mistakes without constraining the city.
- Polygons: at least 3 distinct vertices per ring, no zero-length edges, no self-intersection (segment-pair test with bbox prefilter), holes strictly inside the outer ring and mutually disjoint, and area ≥ 1 wu². Vertex cap: 20,000 per feature.
- Linestrings: at least 2 distinct vertices, no zero-length segments, no self-crossing except closure.
- Class/geometry compatibility per the table.
- On **accept only**, with cross-feature rules checked against accepted rows via bbox candidates: accepted `land` interiors must be pairwise disjoint (islands that touch are one island, and a bridge is a route). An anchor part may be accepted only when its anchor is accepted, and must intersect the anchor's `required_scope_id` extent when that is set. A `scope_boundary` must be referenced by a scope. Scope parent rank and acyclicity are checked. Scope members must be accepted `land`. Connection endpoints and `via` must be accepted.
- Drafts may be saved while cross-feature-invalid, so work in progress is not blocked. The accept response reports every violation at once.

**Normalization aids** (for "preserve canon, not pixels") are client-side helpers that produce ordinary vertices plus `construction_json`:

- a circle from 3 points clicked on an imperfect raster circle, or from center plus radius;
- an axis-rotated ellipse;
- a rotated rectangle;
- an optional Douglas–Peucker simplification of an imported dense vertex list, with a displayed tolerance in metres.

Segment counts are derived automatically from a fixed maximum chord error (0.25 m), not requested from the GM.

### 4.2 Land/water semantics

- **Land is explicit.** Only accepted `land` polygons are land.
- **Explicit water wins over land.** A water polygon inside land is a canal, pond, or basin cut into the island.
- **Water by complement is scope-gated.** Inside a scope whose `land_coverage='complete'`, every point in the scope extent that is not accepted land is water (navigability `unknown` unless an explicit water feature says otherwise). Inside `partial` coverage, non-land, non-explicit-water points are **`unknown`**, and generators must treat them as neither buildable nor water. This prevents an unfinished trace from being read as "everything else is lake".
- A `route` with `kind='bridge'` or `causeway` may cross water. Other routes that cross water are reported by the query (`crosses_water`) and are not rejected.

**Working decision (formerly D-2, resolved).** The Bible describes the city as islands and waterways (§1.1, §1.3), with wet ground and fill beneath islands as a construction-history property of land (§1.4). It establishes no macro-scale terrain that is neither land nor water. Engineered marsh/reed beds are water-management features, represented as explicit `water/wetland` where canonical. The rule above therefore stands as the plan's decision, and no additional terrain class is introduced. If later canon introduces such terrain, it can be added as a `land` `kind` or a class-vocabulary extension without schema replacement.

### 4.3 Anchors, including the listed must-exist anchors

Anchors are composed of parts through `anchor_id` + `part_role`, where `part_role` ∈ `core`, `footprint`, `precinct`, `node`, `link`, `access`, `extent`. Any feature class may be a part, so a docks basin stays semantically `water` while also belonging to the docks anchor.

Bible §9 is the authority for the initial must-exist set. All nine are **anchor-level `hard`**, `must_exist = 1`, and `non_replaceable`. The Bible fixes their identity, required presence, and established relationships. It does **not** fix exact geometry for most of them, so **part-level** strength and composition are chosen at tracing time from the calibrated evidence and campaign material. Where that evidence is ambiguous, the part is `soft` or the anchor stays unplaced. The table records only what the Bible establishes and how the existing model holds it. The "required scope" column names the Bible's district association. It becomes `required_scope_id` once that district scope is accepted.

| Bible §9 anchor | Bible context used | Required scope (Bible) | Representation |
| --- | --- | --- | --- |
| Two established player compounds | Must preserve "already-established locations, extents, and campaign identity". The active player houses named are Krotolous (resides in Nobles, §3.7) and Runellius (resides in Arcane, §4). | The district of each compound | Two `compound` anchors. Established location and extent mean **hard** `site` polygon parts (`footprint`/`precinct`) traced from the established material, plus optional `access` points. |
| White-Gold Tower and Imperial Palace / central palace precinct | White-Gold District: Tower, controlled/processional spaces, government rings (§3.9). Older dimensions must not be baked in. | White-Gold District | One anchor with a `core` part (point, or a circle-constructed polygon traced at current scale) and a `precinct` polygon. Split into two anchors only if the source separates them. Processional space and government rings are generator implications, not parts. |
| Temple of the One | Temple District landmark (§3.5). Processional routes and water approaches are first-class *generation implications*. | Temple District | `landmark` anchor with `footprint` and/or `precinct` parts. Processional routes become canonical `route`s or `connection`s only where the source actually fixes them. |
| Arcane University | Mages' Guild / Arcane University. Arcane District is a University/Guild city (§4, §6). | Arcane District | `precinct` anchor with `footprint`/`precinct` parts. |
| Imperial City Prison | Prison / Legion Headquarters complex: northeastern, fortress-campus, "connected by great bridge and military water route" (§4). | Prison / Legion HQ scope | `precinct` anchor. The great bridge and military water route are `canonical_connections` (`bridge`, `water_route`), `hard` with a `via` route where their alignment is traced, and `soft` obligations otherwise. |
| Waterfront mega-docks / principal large-ship harbor complex | Waterfront District: principal large-ship port with engineered quays, bonded yards, customs, quarantine, and repair basins (§4). | Waterfront District | `facility` anchor with composite parts: land `precinct` (`site` polygon), `quay_edge` routes (`link`), and navigable `water` basin(s) (`extent`). Cranes, yards, and customs buildings are later generated fabric, not parts. |
| Mages' Guild satellite certification office in the Artisan District | Artisan District hosts magical certification bureaucracy (§3.8). The Bible fixes district placement but not a footprint. | Artisan District | `facility` anchor, anchor-level `hard` with `required_scope_id` = Artisan District. Its part is a `soft` point hint unless an exact site is established, in which case it is a `hard` footprint. An unplaced state is valid and is reported to planners. |
| Arena | Arena District complex (§3.2). | Arena District | `landmark` anchor with a `footprint` part. Ellipse/circle construction is available if the traced evidence is regular. |
| Arboretum water-treatment and flood-management networks | "Functional infrastructure system, not merely a decorative landmark" (§9). Channels, settling basins, reed beds, controlled marshes, locks, overflow basins; water-management geometry dominates street grids; linked to Arcane (§3.4, §4). | Arboretum | `network` anchor. Canonically established parts: `node` sites (treatment/lock/control works), `link` `route/conduit` or `water/channel`, and `extent` parts (`water/wetland`, `water/basin`, or `protected_region` flood-buffer areas). Topology uses `utility`/`water_route` connections. The network's **identity and system character are canon**, but its **detailed layout is largely not**. The GM accepts the established skeleton, and future synthesis proposes the remaining basins, reed beds, and channels through `/proposals`. The GM does not hand-trace the whole network. The Arcane link is a district-level relationship for strategy records, not a canonical connection unless a physical link is established. |

Additional hard anchors may be promoted later (Bible §9) through the same register import or manual creation. No schema change is required.

### 4.4 Linear and connective canon

| Constraint | Representation |
| --- | --- |
| Walls | `route/wall` (closed linestring for the exterior ring). |
| Gates | `site` point parts of a gate anchor, or `access` parts. A gate's required passage is a `connection`. |
| Fixed bridges | `route/bridge` plus a `hard` connection with `via`. |
| Required but unplaced crossings | `soft` connection between two islands (`feature` endpoints) with optional hints. The mode (`bridge`, `ferry`, or unspecified) is set only if canon fixes it. |
| Docks and quays | `route/quay_edge` plus `water` basins as anchor parts. |
| Canonical major roads | `route/road`. |

Ordinary streets are **not** in this model (R-007).

## 5. Backend / API changes

A new router `backend/routes/canonical_geography.js`, mounted at `/api/canonical-geography`. Shared persistence helpers live in `backend/canonicalGeography/` (`geometry.js` for validation and predicates, `physicalScale.js`, `store.js` for transactional lifecycle operations, and `query.js`). One generic lifecycle implementation is parameterized per entity type (`features`, `anchors`, `connections`, `scopes`) with entity-specific validators. There are not four hand-written copies.

### 5.1 Reads

- `GET /:entity` returns **accepted** rows publicly (the shared world scene, matching reference layers). `?states=draft,proposed,retired` requires the world editor.
- `GET /:entity/:id`, and `GET /:entity/:id/revisions` (world editor).
- `GET /anchors/register` returns every accepted anchor with derived `placed`/`unplaced` status and part summary. This is the must-exist checklist.
- `GET /export` (world editor) returns a versioned logical export (§8.4).

### 5.2 Mutations (all `authenticate, requireWorldEditor`)

| Route | Behavior |
| --- | --- |
| `POST /:entity` | Create a **draft** (`provenance` `authored` or `imported`; `generated` is rejected here). `lifecycle_state` in the body is ignored or rejected. No creation route can produce `accepted`. |
| `PATCH /:entity/:id` | Drafts and proposals: any field, with `draft_version` bump. Accepted: descriptive fields only, when unlocked. Everything else is 409. |
| `POST /:entity/:id/revise` | From an accepted row, create a draft revision (409 when locked, or when an open editor draft revision already exists). |
| `POST /:entity/:id/accept {expected_draft_version}` | **The only canonization path.** It runs full and cross-feature validation. A draft/proposal with `revises_id` updates the canonical row in place (`revision+1`); otherwise the row becomes `accepted` with `revision=1`. It writes history and emits one update. A 409 lists every violation. |
| `POST /:entity/:id/retire`, `POST /:entity/:id/restore` | Retire is accepted→retired (unlocked, no accepted dependents). Restore is retired→accepted after re-running cross-feature validation. |
| `PATCH /:entity/:id/lock {is_locked}` | A separate request. Unlocking is never combined with another change. |
| `PATCH /:entity/:id/replacement {replacement_state}` | A separate request. Rejected while locked, and always rejected for `must_exist` anchors. |
| `POST /:entity/:id/revisions/:rev/draft` | Create a draft from a historical snapshot. |
| `DELETE /:entity/:id` | Drafts and proposals only. Accepted/retired rows get 409. |
| `POST /proposals` | Software/AI channel. It creates `proposed` rows (`provenance='generated'`, `proposal_json` required), optionally with `revises_id` targeting an accepted row. A proposal targeting a **locked** row is still stored, but cannot be accepted until the row is unlocked. Proposals can never set `accepted`, lock, or replacement state. |
| `POST /import` | Versioned interchange document (§8.3) → **drafts only**. `?dry_run=1` returns a validation report without writing. |
| `POST /import/legacy-water {water_body_ids}` | Copies selected inherited `water_bodies` outlines into `water` **drafts** (`imported`, evidence note `legacy water_bodies #id`). The legacy rows are untouched. |

Every successful mutation calls `emitUpdate()` once. Rejected writes emit nothing. Parameterized SQL is used throughout, with a transaction for every read-check-write.

### 5.3 Generator-facing query

`POST /api/canonical-geography/query` (public read of accepted canon only) takes one of:

- `{scope_id}`;
- `{feature_id}` (an island, or any polygon feature);
- `{bbox}`;
- `{polygon}`;

plus `halo_wu` (default 0; context ring for neighbors) and `include` (subset of classes/entities).

Algorithm: resolve the extent polygon set, run the SQL bbox candidate query on `canonical_features` over the extent bbox expanded by the halo, apply the exact JS `intersects` predicate, then classify each result as `inside`, `boundary` (intersects extent boundary), or `context` (halo only). The response is a **versioned bundle**:

```text
bundle_version: 1
scope: { ref, kind, chain: [city … immediate parent], extent: Polygon[], land_coverage }
digest: sha256 over sorted (entity_type, id, revision) of every included accepted entity
land[]            feature id, revision, polygon, strength, name, relation (inside/boundary/context)
water[]           explicit water features + navigability; complement rule flag from land_coverage
anchors[]         accepted anchors with ≥1 part in extent, plus unplaced anchors whose
                  required_scope_id is this scope or a descendant (obligations with no geometry)
protected[]       protected_region features
routes[]          route features, with crosses_water and crosses_extent_boundary
connections[]     accepted connections touching any included entity or scope, each tagged
                  internal | crossing (one endpoint outside extent) | external_obligation
immutable[]       ids of every included accepted entity that is non_replaceable or locked
readiness         { unplaced_must_exist: anchor ids whose required scope is this scope, an ancestor
                    with an overlapping extent, or a descendant, and which have no accepted part;
                    required_scope_unverified: part ids }. Informational only here; the generation
                    slice uses it to enforce Bible §9 ("represented before ordinary procedural
                    generation is allowed to replace surrounding fabric").
metrics           land area (m², ha), explicit-water area, shoreline length (m), anchor counts —
                  all via physicalScale.js; overlap-naive sums, no boolean ops
```

The digest excludes descriptive edits, so it changes exactly when canonical *constraints* change. This gives R-022 its "equivalent canonical inputs" test. Drafts, proposals, and retired rows are never included. No endpoint reads reference-layer assets or pixels.

## 6. Generator-facing interface seam and hierarchy compatibility

### 6.1 The seam

`frontend/src/modules/canonicalGeography/constraints.ts` is pure TypeScript with no React, Three.js, network, or reference-layer imports. It turns a query bundle into a `CanonicalConstraints` object:

- the bundle data, typed;
- `classifyPoint(x, z) → 'land' | 'water' | 'unknown'`, implementing §4.2;
- `isProtected(x, z)`, `anchorPartsAt(x, z)`;
- `footprintConflicts(rect) → reasons[]` (off-land, in water, unknown, protected, anchor part, hard route corridor), using the inherited corner-and-center sampling approach from `footprintInWater`;
- `boundaryObligations()`, which returns the crossing/external connections.

Hard canonical geometry is surfaced as obstacles through `SpatialGrid`-compatible footprints/polygons. It is not written into `water_bodies` or `locations`.

This slice adds the adapter and tests only. It does **not** modify `generateCity`, `AdminPanel` generation, or purge. The bridge `CanonicalConstraints → GenerateCityContext` belongs to the pilot slice.

This matches the Bible §8 pipeline: *Bible → machine-readable culture/district/archetype/food profiles → strategic city/district/island allocation → deterministic geometry generator*. Canonical geography is the spatial constraint input to the last two stages. It is neither a profile nor a plan, and it stores neither.

### 6.2 How planners query a requested scope

Every hierarchy level asks the same question at a different scope: "give me the accepted constraints within scope *S* (with halo *h*)." City strategy queries the `city` scope. A district program queries a `district`. A generation workset queries its selected islands or land pieces (for example as a `polygon` or a set of `feature_id`s), and may query an `island_group` where one genuinely exists. Island morphology queries a land `feature_id` with a halo. Block refinement queries a `polygon`. The answers to the task's example questions map onto the bundle as follows:

| Question | Bundle source |
| --- | --- |
| Land here? | `land[]` |
| Water excluded or navigable? | `water[]` plus the complement rule |
| Anchors that must exist? | `anchors[]`, including unplaced obligations |
| Protected regions? | `protected[]` |
| Required connections across the boundary? | `connections[]` tagged `crossing` / `external_obligation` |
| What must not be overwritten? | `immutable[]` |

### 6.3 Parent/containment without planners

- **Explicit:** the scope `parent_scope_id` chain plus land-feature membership.
- **Derived:** anchor, route, protected-region, and connection association to a scope is **computed spatially at query time** and never stored. This avoids stale membership when geometry is revised.
- The query returns the full ancestor `chain`, so a consumer at any level knows which district and city constraints enclose it.

### 6.4 Why this does not create independent-island generation units

- An island is a land feature. The unit of generation is a **scope request**, not an island record.
- Every island query carries its ancestor chain, halo context (neighboring islands, shared channels, bridges), and `crossing` connections, so no island can be generated without its cross-boundary obligations.
- A pilot can target several islands as one unit, and a bridge between two of them appears as an `internal` connection rather than two dangling ends. Post-WP6, that unit is a demand-created generation workset (A-018) rather than a mandatory island-group scope. An accepted island group may still serve as a convenient selection where one genuinely exists.
- Nothing in the schema stores per-island generation settings, profiles, or seeds. Those belong to future planning/generation-run records that reference scopes.

### 6.5 How strategic outputs reference geography without embedding it

Future planning records (city strategy, district program, and the generation worksets/batches below them) store `{scope_id | feature_id | anchor_id, revision, digest}` references plus roles, budgets, weights, and obligations. For example, the Bible's Arcane district-level productive-land weights (§5.3) would be a district-program record referencing the Arcane `district` scope. They never copy geometry. Staleness is detectable: if a referenced entity's `revision` or the scope `digest` changes, the plan is flagged for re-evaluation. **Feasibility feedback** can use `metrics` (for example, allocated budget versus measured land area and shoreline length) and `footprintConflicts` without new schema. This is the upward rejection path the Bible describes for crops on unsuitable parcels (§5.3). Richer feasibility records belong to the planning slice.

### 6.6 How local generators inherit both constraint sources

A future island/block generator receives:

1. inherited planning constraints: the planning records attached to each scope in `scope.chain`, resolved by the planner layer;
2. local canonical constraints: the query bundle for its own extent plus halo.

The two are joined by scope id, not by geometry duplication. Proposals it produces flow back through `POST /proposals` and remain noncanonical until accepted.

### 6.7 How block and building generation stays decoupled from the raster

Generators depend only on the query bundle and adapter. Neither imports `modules/referenceLayers` nor reads `reference_*` tables. A lint-level test enforces the import boundary (§10). The raster may be hidden, archived, or deleted without affecting any query result.

## 7. Frontend / editor workflow

### 7.1 Human role: accept canon, do not author procedural detail

Following the Bible's division of labor, the editor asks the GM for **canonical truth and acceptance** only:

- trace or accept established geography;
- confirm anchor identity, district, and strength from the Bible-derived register;
- mark a scope's land coverage complete;
- accept, lock, or reject proposals.

It never asks for procedural parameters. Every physical attribute (`width_wu`, `navigable`, `kind`, `connection_kind`, construction segment counts) is optional or derived. Unspecified values are synthesis inputs, not missing work. There are no culture, crop, household, façade, material, roof, or archetype fields anywhere in this slice.

Coverage is **progressive and demand-driven**. The city has hundreds of islands, and the GM is not expected to trace all of them before generation starts anywhere. Only scopes about to be generated need accepted land and `land_coverage = complete`. Canonical hard anchors need to be placed only where they fall in such a scope. Beyond manual tracing, bulk normalized drafts arrive through import (§8.3) and, later, through AI/procedural proposals (`/proposals`). Both still require GM acceptance, but not GM authorship. Raster vectorization and computer vision are out of scope here. The proposal seam is where such tools would plug in later.

### 7.2 Module and integration

A new module `frontend/src/modules/canonicalGeography/`:

| File | Responsibility |
| --- | --- |
| `types.ts`, `api.ts` | Payload types and fetch helpers. |
| `physicalScale.ts` | `METERS_PER_WORLD_UNIT = 1.524` and m/ha/km formatting. **Never** reads `map_scale_multiplier`. |
| `geometry.ts` | Client validation mirror, normalization aids (§4.1), area/length. |
| `constraints.ts` | Generator seam (§6.1). |
| `CanonicalGeographyLayer.tsx` | World-scene renderer. |
| `TracingTool.tsx` | In-scene vertex placement and editing. |
| `CanonicalGeographyManager.tsx` | Panel: list/filter, inspector, anchor register, scopes, connections, lifecycle actions, import. |

Integration mirrors reference layers:

- `useMapData` gains `canonicalGeography` (accepted collections, plus drafts/proposals for the world editor) and a fetch function in `fetchAll`.
- `useSocket` gains an `onFetchCanonicalGeography` callback on `dataUpdated`.
- `App.tsx` makes integration edits only: the renderer in the world branch, a new `view === 'canonical_geo'` so inherited `DistrictInteractions` handlers are inactive while tracing, and a manager-open flag.
- The AdminPanel CITY tab gets a `CANONICAL_GEOGRAPHY` launcher for `isPrimaryAdmin` only.

**Tracing against evidence**

- Reference layers stay rendered underneath. Their existing opacity/visibility controls remain usable, and the tracing tool raycasts the Y=0 plane exactly as inherited drawing does, so the non-raycast raster never intercepts clicks.
- Vertex placement is click-based, not freehand. Click-versus-drag is distinguished by a movement threshold so the inherited left-button camera truck (`App.tsx:2775`) still pans. Camera controls are gated the same way `isDragging` / `measureMode` already gate them.
- Editing supports: undo last vertex, close ring, drag vertex, insert vertex on edge, delete vertex, snap to existing accepted/draft vertices and edges (so shared shorelines and anchor edges coincide), and the circle/ellipse/rectangle constructors.
- A live readout shows world X/Z, metres, and **source pixel u/v** for the selected evidence layer (via `worldToSource`), plus segment length and ring area in metres and hectares. Saving a draft records `evidence_json` with the current calibration snapshot.

**Draft versus accepted visibility**

- Accepted: solid fill/line per class.
- Draft: dashed outline, hatched or low-alpha fill, and a "DRAFT" label.
- Proposed: a distinct dashed color with a "PROPOSED · generated" badge.
- Retired: hidden unless filtered in.
- Locked: lock glyph in the list and inspector.
- The overlay renders in a fixed Y band above the reference-layer stack and below inherited overlays, pinned by a test. It is non-raycast except for vertex handles of the feature being edited.
- A global toggle hides or shows the canonical overlay so evidence can be compared against it.
- Rendering uses merged buffer geometry per class/state for accepted canon. Per-feature meshes are used only for the selection being edited.

**Hard anchors**

The anchor register panel lists every accepted anchor with a placed/unplaced badge. The workflow is:

1. Import the Bible-derived register (or create an anchor record manually for later promotions), review each draft entry, and accept it. Accepted entries appear in the register as unplaced.
2. Choose "add part", pick a part role, and trace or construct the geometry. It is saved as a draft part.
3. Accept the part, which makes the anchor placed.

The inspector shows parts, connections, scope, strength, provenance, evidence, revision history, and dependents.

**Preventing accidental canonization**

- Nothing is accepted implicitly. Save, import, legacy-water promotion, and proposals all produce drafts or proposals.
- Accept is a per-record action with a confirmation dialog showing class, strength, replacement state, area/length in metres, vertex count, and any cross-feature validation result. It sends `expected_draft_version`.
- Multi-select accept is allowed only from an explicit selection, with a confirmation that states the count. There is no "accept all".
- "Accept & lock" is offered as two explicit sequential requests, never as one merged state change.
- Locked accepted rows disable revise/retire/replacement controls in the UI. The server enforces this independently.

## 8. Authorization, protection, migration, and legacy boundaries

### 8.1 Authorization

- Every mutation, the `draft` / `proposed` / `retired` reads, revisions, and export require `authenticate, requireWorldEditor`.
- Accepted canon and the query are public reads (the shared world scene). The frontend `isPrimaryAdmin` flag only hides UI and is never the boundary.
- The single primary-admin identity cannot cryptographically distinguish a human clicking Accept from a script holding the same token. The architectural control is that **software proposals have their own route that cannot canonize**, and acceptance is one explicit route. A future non-world-editor "proposer" credential that can reach only `/proposals` fits this seam without schema change (deferred).

### 8.2 Protection semantics summary

| State | Generators read it? | Manual constraint edit | Retire | Automatic replacement |
| --- | --- | --- | --- | --- |
| draft / proposed | no | yes | n/a (hard delete) | n/a |
| accepted, unlocked, non_replaceable | yes | via revise → accept | yes, if no dependents | **never** |
| accepted, unlocked, replaceable | yes | via revise → accept | yes, if no dependents | only through a future explicit replace flow that still produces proposals |
| accepted, locked | yes | **no** (unlock first) | **no** | **never** |
| retired | no | no (restore first) | — | never |

No automatic replacer exists in this slice. `replaceable` only records permission. `must_exist` anchors can never be `replaceable`. Locking the nine Bible §9 anchors after acceptance is recommended (the Bible calls them "protected"), but it stays a separate explicit action (A-004).

### 8.3 Import

The interchange document is `{format: 'ruby_wheel.canonical_geography', version: 1, coordinate_space: 'world' | 'source_pixels', reference_layer_id?, features[], anchors[], connections[], scopes[]}`, with internal references by `anchor_key` / `scope_key` / local ids.

- `source_pixels` input is converted **client-side** with the persisted calibration of the named layer (`sourceToWorld`) before POST, and the calibration snapshot is kept in `evidence_json`. The server stores world coordinates only.
- All imported entities become drafts. Matching `anchor_key` / `scope_key` against accepted rows creates draft revisions (`revises_id`), never overwrites.
- SVG/GeoJSON parsing is deferred. The versioned JSON format is the stable seam that such importers would emit later.
- **Bible-derived register document (WP7).** The implementing agent derives an interchange document from the Bible: the nine §9 anchors (key, name, category, `hard`, `must_exist`, required district `scope_key`) and the district scopes (key, name, kind), with **no geometry** and nothing beyond what the Bible states. It is stored as `docs/canonical/initial_register.v1.json` beside the Bible, so its derivation is reviewable. It is imported as drafts and accepted by the GM entry by entry. This keeps the Bible as the single human-readable authority and the register as a traceable machine-readable derivative, rather than a second hand-maintained list. When the Bible changes, the register is re-derived, and the import creates draft revisions only.

### 8.4 Snapshots, export, and legacy maps

- **Legacy saved maps:** save/load/clear neither include nor delete canonical tables. This is the same boundary as reference layers. Legacy saved maps are not rollback for canonical geography, and the UI must not say they are.
- **`GET /export`:** a versioned, self-contained logical snapshot of accepted and retired canon, anchors, connections, scopes, and current revisions. It is asset-free, so the file can be stored independently. It is still **not** the full backup required by R-101, which additionally needs the database volume and reference assets. Re-import produces drafts.
- `purge-region`, `DELETE /api/water`, `/api/admin/undo`, the inherited `districts` routes, and reference-layer PATCH/DELETE all leave canonical tables unchanged. Regression tests cover each.
- **Existing data:** the migration creates empty tables plus the root city scope. Inherited `water_bodies` and `districts` are not converted automatically. Promotion is an explicit per-row draft import (§5.2). No legacy content is inferred to be canonical, which is conservative per R-002.

### 8.5 Physical scale

- Geometry is persisted only in world units. Every metre/hectare value is derived through `physicalScale.js` / `physicalScale.ts` from the single constant 1.524.
- The inherited `GLOBAL MAP SCALE (FT/UNIT)` (`global_settings.map_scale_multiplier`) is neither read nor written by this subsystem. Tests pin this.
- Recalibrating a reference layer never moves canonical geometry. The inspector may show that the evidence calibration snapshot differs from the layer's current calibration, as an informational notice.

## 9. Explicit non-goals

- Full-raster vectorization, computer vision, color interpretation, automatic coastline cleaning, or automatic road/building reconstruction.
- City strategy, district programs, generation worksets/batches, district fulfillment state, district density/intensity models, island morphology, block/lot/building/street generation, cultural components, cuisine, or agriculture generation.
- Wiring canonical constraints into `generateCity`, the inherited generator panel, or purge. That is the pilot slice.
- Generation-run tables, planning/feasibility records, or an AI synthesis implementation (only the `/proposals` seam exists).
- A polygon boolean/clipping library, buffering, multipolygon geometry, elevation/terrain, or 3D bridge decks.
- Minor canal networks (§31.4 remains open), waterfront function typing beyond `kind`, food-system infrastructure, or district generation profiles.
- SVG, GeoJSON, or other external vector import beyond the JSON interchange format.
- An SQLite R\*Tree, unless WP3 measurement requires it.
- Repairing or versioning the legacy saved-map format, a backup implementation, or changes to reference layers.
- Migrating, replacing, or linking the inherited `districts` table, `water_bodies`, or `locations.district_name`.
- Richer roles, proposer credentials, per-campaign geography, or visibility systems.
- Refactoring `App.tsx` / `AdminPanel.tsx` beyond integration seams.

## 10. Validation strategy

**Backend** (Vitest + Supertest, with in-memory schema via `__tests__/helpers/testDb.js` extended):

- **Migration:** empty and representative pre-feature DBs; ledger idempotency; exactly one root city scope; no existing row changed; `CHECK` vocabularies reject invalid values at the SQL level.
- **Geometry:** a validity table of fixture cases (valid square/concave/holed polygon; self-intersecting bow-tie; hole outside or touching the outer ring; duplicate vertices; zero-area; NaN/Infinity; out-of-`WORLD_LIMIT`; closed and open linestrings; self-crossing linestring), ring orientation normalization, rounding stability, and bbox correctness.
- **Lifecycle:** draft → accept (revision 1); revise → accept keeps the id and sets revision 2 with a history row; descriptive edit leaves the revision unchanged and writes history; stale `expected_draft_version` gives 409; retire/restore; hard delete is rejected for accepted rows; a draft from a historical revision.
- **Cross-feature:** overlapping accepted land rejected; an anchor part before its anchor is accepted rejected; `required_scope_id` violation, plus warning-not-rejection when the required scope has no extent yet; a `must_exist` anchor cannot become `replaceable` (SQL and route); a hard anchor with only a soft part is valid; a null-mode and a `ferry` connection are valid; scope rank and cycle rejection; member uniqueness per kind; retire blocked by dependents, listing them; restore re-validation.
- **Protection:** a locked row rejects revise/retire/replacement/constraint PATCH with 409 by direct API call; unlock-plus-edit in one request is rejected; a proposal against a locked row is stored but cannot be accepted until unlock; `replacement_state` changes only via its own route.
- **Authorization:** 401 without a token; 403 for player and temporary-admin tokens on every mutation and on draft/proposal/retired/export reads; the public accepted list and query succeed without a token and never contain non-accepted rows.
- **Proposals:** `generated` is required; `proposal_json` is required; no path yields `accepted`; `POST /:entity` rejects `generated`.
- **Query:** a synthetic archipelago fixture (islands, a canal cutting one island, a basin, bridge routes, a network anchor spanning two islands, a soft anchor with `required_scope_id`, a `partial` and a `complete` scope). Tests assert inside/boundary/context classification, halo, crossing/internal/external connections, unplaced obligations and `readiness` (an unplaced must-exist anchor required in a district appears in that district's, its island groups', and the city's bundle), `immutable[]`, digest stability under descriptive edits and change under constraint revisions, and exclusion of drafts/retired rows.
- **Physical scale:** metric values for known squares (1,000 wu side = 1,524 m); unchanged after altering `global_settings.map_scale_multiplier`.
- **Legacy boundary:** legacy map save/load/clear, `purge-region`, `DELETE /api/water`, `/api/admin/undo`, district CRUD, and reference-layer delete/recalibration each leave canonical rows byte-identical.
- **Import:** dry-run report; all imported entities are drafts; key matching creates revisions and does not overwrite; legacy-water promotion leaves the `water_bodies` row intact; the Bible-derived register document validates and imports as nine anchor drafts plus district scope drafts with no geometry.
- **Emit:** one `dataUpdated` per successful mutation and none on rejection.

**Frontend** (Vitest + Testing Library, mocked R3F as in existing tests):

- `constraints.ts`: `classifyPoint` for the complete/partial/explicit-water-in-land cases; `footprintConflicts` reasons; parity with backend fixtures (the same JSON fixtures copied into each package's tests).
- `geometry.ts`: 3-point circle, ellipse, rectangle, simplification tolerance, and area/length in metres.
- `physicalScale.ts`: independence from map-scale settings.
- Renderer: accepted, draft, and proposed styles are distinct; Y band ordering relative to `REFERENCE_LAYER_Y`; non-raycast; nothing rendered under `BattleMapScene`.
- Tracing tool: vertex add/undo/close/drag/insert/delete, snapping, click-versus-drag threshold, and a source-pixel readout that matches `worldToSource`.
- Manager: accept confirmation sends `expected_draft_version`; locked controls are disabled; there is no accept-all; the anchor register shows placed/unplaced; errors keep the draft.
- Import boundary: a test that fails if any file under `modules/canonicalGeography/` other than the manager/tracing UI imports from `modules/referenceLayers`, and that `constraints.ts` imports nothing from React, Three.js, the network, or reference layers.

**Scale measurement (WP3 gate, recorded in the WP report):** a synthetic dataset sized to the Bible's "hundreds of islands" (about 500 islands × 400 vertices), 200 anchors with 600 parts, 500 routes, and 300 connections. Measure the city-scope and single-island query times, bundle payload size, DB size delta, and frontend overlay render time. Targets: island query < 100 ms, city query < 1 s, and renderer interactive. If a target is missed, record the numbers and propose the R\*Tree or chunked-response change before WP4. Do not silently adopt it.

**Commands per WP:** targeted test files, then `cd backend && npm test`, then `cd frontend && npm test && npm run build`. Stop on any failure.

## 11. Human acceptance checks

1. **Boot/migration:** start against an existing CITY_NET database. The app boots, the canonical manager shows only the `Imperial City` root scope, and inherited map data is unchanged.
2. **Trace against the calibrated raster:** with the 6032 × 4584 Imperial City layer visible at about 50% opacity, trace one island by clicking vertices. Snap one edge to a second traced island's shoreline. Confirm the readout shows source-pixel u/v consistent with the raster. Confirm the draft renders dashed and labelled DRAFT. Measure one straight shoreline segment: its length in metres ≈ (pixel distance × 3 m) within tracing tolerance.
3. **Normalization:** on a circular feature drawn imperfectly in the raster, use the 3-point circle. The saved geometry is a clean circle, and `construction_json` records center and radius.
4. **Accept flow and accidental-canonization guard:** save a draft and reload; it is still a draft. Run the generator-facing query for the city scope via the browser dev tools or `curl`; the draft is absent. Accept through the confirmation dialog, re-query, and the island is present with revision 1 and changes the digest.
5. **Hard anchor from the Bible register:**
   1. Import the Bible-derived register. Confirm the nine §9 anchors and the district scopes arrive as drafts with no geometry. Accept them.
   2. The register shows all nine as *unplaced* and hard. The `replaceable` control is unavailable for them, and a direct API attempt to make one replaceable returns 409.
   3. Trace the Arena footprint over the raster and accept it; the Arena shows *placed*.
   4. For the Mages' Guild satellite office, accept a `soft` point hint while the Artisan District has no traced extent. It is accepted with a warning and marked `required_scope_unverified`.
   5. Trace and accept the Artisan District boundary, then try to accept a second Mages' Guild part outside it: rejected with a clear message.
   6. The city-scope query lists the still-unplaced anchors under `readiness.unplaced_must_exist`.
6. **Network anchor (Arboretum):** give the Arboretum anchor two `node` sites on different islands, one `route/conduit`, one `water/wetland` extent, and a soft `utility` connection between the nodes. Query one island's scope: the connection is tagged `crossing`, and the other node appears as context. Confirm nothing required tracing channels or basins the source does not establish.
7. **Protection:** lock the accepted island. The UI disables revise, retire, and replacement. Direct API `POST …/revise`, `…/retire`, and `PATCH …/replacement` with the admin token each return 409. Unlock, revise the geometry, and accept: the same id now has revision 2 and history shows both revisions. Create a draft from revision 1 to confirm recoverability.
8. **Proposal stays noncanonical:** `POST /proposals` with a generated water feature (via `curl`). It appears as PROPOSED · generated, is absent from query results, and appears only after explicit accept.
9. **Reload/restart persistence:** reload the browser and restart the backend. All accepted, draft, proposed, locked, and anchor-register state is unchanged.
10. **Physical-scale independence:** change `GLOBAL MAP SCALE (FT/UNIT)`. Canonical coordinates, readouts in metres, and query metrics are unchanged. Recalibrate or move the reference layer: canonical geometry does not move, and the inspector notes that the evidence calibration differs.
11. **Legacy boundary:** save and then load a legacy saved map, run *clear map*, and run a region purge over the traced island. Canonical geography is intact. Delete the reference layer: canonical geometry is intact, and evidence metadata remains as a historical note.
12. **Authorization:** as a player or temporary admin, the manager launcher is absent and direct mutation API calls return 403. A second client sees accepted changes arrive through realtime refresh, and sees no drafts.
13. **Export/import round trip:** export, then import the file with a dry run first. Every entity arrives as a draft or draft revision, and nothing is overwritten.

## 12. Sequential work packages

Stop after each WP, report the evidence, and wait for validation before proceeding.

### WP1 — Schema, geometry core, physical scale (backend only)

Migration `002`, root scope, `backend/canonicalGeography/geometry.js` (validation, normalization, bbox, predicates, area/length) and `physicalScale.js`, plus the `testDb` helper extension.

**Gate:** migration and geometry fixture tests; full backend suite.

### WP2 — Lifecycle REST and protection

Generic entity store and router for features, anchors, connections, and scopes: draft CRUD, revise/accept/retire/restore, lock, replacement, revisions, `/proposals`, cross-feature validation, `emitUpdate`, and mounting in `server.js`.

**Gate:** lifecycle, cross-feature, protection, authorization, proposal, and emit tests; legacy-boundary regressions (maps load/clear, purge-region, water delete, undo, districts, reference-layer delete); full backend suite.

### WP3 — Query seam and scale measurement

`POST /query` bundle, digest/metrics, and `readiness` on the backend. `modules/canonicalGeography/{types,constraints,physicalScale}.ts` on the frontend, with shared fixtures. Synthetic-scale measurement.

**Gate:** query and adapter tests; import-boundary test; measurements recorded against targets; both full suites and the build.

### WP4 — Data wiring and rendering

`useMapData` / `useSocket` / `App.tsx` integration, `CanonicalGeographyLayer` (accepted/draft/proposed styles, Y band, non-raycast, overlay toggle), and the AdminPanel launcher shell.

**Gate:** renderer, hook, and battle-map-exclusion tests; frontend suite and build; brief live check that accepted fixtures render over the raster.

### WP5 — Tracing and feature editing

`TracingTool`, normalization aids, coordinate/source-pixel readout, and a manager feature list/inspector with save-draft, accept confirmation, revise, lock, retire, replacement, and history.

**Gate:** tool and manager tests; frontend suite and build; human checks 2–4, 7, and 9.

### WP6 — Anchors, connections, scopes UI

Anchor register and part workflow, connection creation between parts/islands, scope creation (district/island group/subregion) with membership, boundary, and coverage flag.

**Gate:** component tests; live smoke of manual anchor create → accept → add part → placed plus connection/scope editing; human checks 6 and 8. The Bible-register import portion of human check 5 is deferred to WP7 because the import path and register document are delivered there.

### Pre-WP7 slice AT1 — Deterministic radial construction (inserted; not a renumbering)

The generic radial/spoke constructor (R-014, A-020), specified in full in §15: a pure ray/closed-ring intersection core mirrored on backend and frontend, one transactional construct endpoint that produces drafts only, a minimal constructor panel with in-scene preview, and a construction-review list.

**Gate:** §15.14 tests; both full suites and the build; human acceptance §15.15.

### WP7 — Import/export, legacy promotion, final verification

Interchange import (world and source-pixel modes, dry run), legacy-water promotion, export, and the Bible-derived register document (`docs/canonical/initial_register.v1.json`, submitted for human review of its derivation before import). Full regression suites, build, and the complete human acceptance list (§11).

**Gate:** all tests, build, and human checks 1–13.

## 13. Final capability statement

**When complete:** RUBY_WHEEL persists a governed, versioned canonical spatial substrate for the Imperial City. It contains:

- accepted land polygons (the islands, each with stable identity);
- explicit major water with navigability, and scope-gated complement semantics;
- protected regions;
- canonical linear features (walls, fixed bridges, quays, conduits, major roads);
- a must-exist anchor register, holding the Bible §9 anchors from a Bible-derived document, whose entries are placed through composite point, line, and polygon parts (including infrastructure networks) and are never automatically replaceable;
- required-connection obligations;
- semantic scopes (city, district, optional island group, subregion) with ranked parentage, drawn district boundaries that may cut through islands, and optional explicit whole-island membership.

Every record has explicit lifecycle, provenance, strength, replacement, and lock state, plus revision history. The only path to canon is an authorized explicit accept, and software proposals cannot self-canonize. A scoped query returns everything a planner or generator must respect, with a deterministic digest and metric summary, and never reads raster pixels or reference-layer state.

**What the next slice can build on it:** a thin *city strategy → district program → demand-created generation worksets/batches* layer can do the following without replacing this substrate's schema:

- add planning records that reference `geo_scopes`, land features, and anchors by id and revision;
- read `metrics`, `anchors[]` obligations, and `readiness` to size budgets, detect infeasibility, and refuse generation in scopes with unplaced must-exist anchors;
- attach AI-derived machine profiles (Bible §8) to district scopes by id;
- propose district boundaries, optional island-group scopes, or district membership through `/proposals` for acceptance;
- form a generation workset from selected islands or derived district/island land pieces (the latter requiring the deferred clipping capability), inheriting its district program and reading the district's prior generated/accepted state and still-unfulfilled requirements (A-018; the persistence of that fulfillment state belongs to the planning slice);
- hand a pilot generator one workset whose query bundle plus inherited plan constraints drive a bridge from `CanonicalConstraints` into `GenerateCityContext` (boundary polygons, water polygons from `classifyPoint`, obstacles from anchors, protected regions, and hard routes), with the seed and canonical digest recorded for reproducibility.

**Intentionally deferred:**

- polygon boolean operations, buffering, and any clipping dependency;
- multipolygon geometry and terrain/elevation;
- minor canal networks;
- generation profiles, generation runs, generation worksets, district fulfillment state, spatial density/intensity models, and planning/feasibility records;
- deterministic parametric construction aids beyond the §4.1 circle/ellipse/rectangle constructors and the AT1 radial constructor (§15);
- the AI synthesis implementation and a dedicated proposer credential;
- SVG/GeoJSON import;
- the R\*Tree (pending measurement);
- inherited-district reconciliation;
- saved-map/snapshot fidelity repair and a full backup implementation.

## 14. Decisions requiring human input

None are open. The resolved decisions are recorded here so the reasoning stays traceable:

- **D-1 (resolved): authority for the must-exist anchors.** `docs/IMPERIAL_CITY_GENERATION_BIBLE.md` is committed and authoritative for the initial hard-anchor set (§9) and the world context used in this plan. §2.4 and §4.3 are reconciled against it. The Bible-derived register document (§8.3) is its machine-readable derivative, not a competing source.
- **D-2 (resolved): land/water default.** This is recorded as the working decision in §4.2. The Bible establishes an island/waterway city with no macro-scale neither-land-nor-water terrain, and engineered wetlands are represented as `water/wetland`.

Per the Bible's escalation rule, a *specific* hard-anchor placement that turns out to be genuinely ambiguous in the source material is raised to the GM when that anchor is traced, as data rather than as a plan decision. Until then the anchor stays unplaced or carries a `soft` part.

## 15. Pre-WP7 slice AT1 — deterministic radial construction

**Status:** Planned, pending human review. This is the next implementation step before WP7 (`docs/PROJECT_STATUS.md`).
**Governing:** R-006, R-014; A-015, A-020; this plan §3.1, §3.2, §3.7, §4.1, §7.2, §8.1, §8.2.
**Position:** Inserted between WP6 and WP7 on `feature/canonical-geography`. WP7 keeps its number, scope, and gate. AT1 needs nothing from WP7, and WP7 needs nothing from AT1 except the interface note in §15.8.

### 15.1 Goal

An authorized world editor can construct exact radial spokes: straight line features cast from a center at `θₙ = θ₀ + n · (360° / N)` and running between two accepted closed boundaries. The editor previews them, then persists them as ordinary **draft** canonical features that go through the normal revise/accept/lock/retire lifecycle.

This is deterministic canonical-geometry authoring (A-020). It is not procedural generation, it involves no AI, and it creates nothing but draft line geometry.

### 15.2 Generic domain boundary

- The mechanism is named and coded as **radial construction**, in files `radialConstruction.{js,ts}`, a construction type `radial_spoke`, and the route `/constructions/radial`. No code, identifier, constant, default, or test fixture names a world, city, district, wall system, or campaign concept.
- It knows only center, two closed rings, `N`, `θ₀`, and the output feature settings the editor chooses. It is equally usable for a radial city, a star fortress, a precinct, or any similar geometry.
- The output feature class and kind are chosen by the editor (§15.3.4). The tool attaches no semantic meaning to spokes, and the default output has no `kind`.
- It never creates, edits, or infers scopes, district boundaries, anchors, anchor parts, connections, or memberships. The editor makes any semantic use of the resulting lines separately, through the existing WP5/WP6 workflows.
- Test fixtures are synthetic shapes (§15.14). Real-world geometry appears only in human acceptance (§15.15), never in code or automated tests.

### 15.3 Inputs and eligibility

No new entity type or table is added. All inputs are existing `canonical_features` rows or explicit parameters.

#### 15.3.1 Boundaries (inner and outer)

| Rule | Decision |
| --- | --- |
| Eligible geometry | A `polygon` (its **outer ring** is the boundary, and holes are ignored), or a **closed** `linestring` (first vertex equals last). Points and open linestrings are ineligible. |
| Eligible class | Any `feature_class`. For example, a `route` wall ring, a `land` polygon, a `scope_boundary`, or a `site` precinct. Class is irrelevant to the geometry. |
| Lifecycle | **Accepted only**, for preview and persistence alike. Draft, proposed, and retired features are not offered by the pickers and are rejected by the server. To construct against an unaccepted ring, accept it first. That is the explicit canon decision A-020 requires. |
| Lock / replacement | Locked and `non_replaceable` inputs are eligible. Construction only reads them. |
| Distinct | Inner and outer must be different features. |
| Revision pinning | The request carries each input's `expected_revision`. If the accepted revision differs at persist time (someone revised it after preview), the server returns 409 `stale input`, and the UI reloads and re-previews. |
| Containment | Rings need not be nested. Radial order is checked per spoke (§15.5). |

#### 15.3.2 Center

The center is an explicit world `{x, z}`, rounded to the 0.001-wu grid. A-020 permits explicit parameters, so the center need not be a stored entity. It is chosen by exactly one of these sources, which is recorded in `construction.center_source`:

| Source | How | Server behavior |
| --- | --- | --- |
| `coordinate` | Numeric X/Z entry, or a map click on the Y=0 plane (with the existing vertex snapping from `tracing.ts`). | Uses the submitted `center`. |
| `feature_point` | Pick an accepted `point` feature (for example a `site` point). | Loads the feature at `expected_revision` and derives the center from its geometry. A submitted `center` must be absent. |
| `feature_construction_center` | "Use center of" an accepted inner/outer (or other) feature whose `construction.type` is `circle` or `ellipse`. | Loads the feature at `expected_revision` and derives the center from `construction.center`. A submitted `center` must be absent. |

The center must be **strictly inside** both boundary rings. This is decided exactly on the 0.001-wu grid with the existing `gLocatePointInRing`, the frontend mirror being `locateInRing`. A center on a ring or outside it is a construction-level error. Radial semantics (§15.5) depend on this, and it is what makes "no intersection" and "exactly one ambiguous intersection" impossible for a valid ring.

#### 15.3.3 Spoke parameters

- `count` (`N`): an integer from 1 to 360. Non-integers are rejected, never rounded. `N = 1` (a single spoke) is valid.
- `offset_deg` (`θ₀`): any finite number, normalized as in §15.4. NaN and ±Infinity are rejected.
- `omit_indices` (optional): sorted, unique integers in `[0, N)`, explicitly excluding spokes (§15.13). At least one spoke must remain.

#### 15.3.4 Output settings (new-drafts mode only)

- `feature_class`: `route` (the default) or `site`, the classes that allow `linestring`.
- `kind`: optional, from the existing vocabulary for the chosen class (for example `route` → `wall`). There is no default kind.
- `constraint_strength`: `hard` or `soft`. It defaults to `hard`, matching the existing draft form (`featureEditing.ts`).
- `width_wu`: optional, `route` only, and shared by every spoke.
- `name_prefix`: optional, defaulting to `Spoke`. Each spoke is named `<prefix> #<index>` with the 0-based construction index, so names match `construction.index` and the preview table.
- There are no anchor/part, attribute, or evidence fields. `evidence_json` is null, because the derivation is recorded in `construction_json`. Anchor linkage can be added per draft afterwards through the existing inspector.

### 15.4 Angular convention and determinism

- **Convention.** Angles are measured from **+X toward +Z** in world X/Z. This matches the existing `rotation_rad` in circle, ellipse, and rectangle records and the reference-layer calibration (+X is image-right, +Z is image-down). On an unrotated reference layer, 0° points image-right and 90° points image-down, so angles increase clockwise in the top-down view. It is **not** a compass bearing, and it never depends on camera, zoom, or renderer state. The UI states the convention beside the offset field and highlights spoke 0 in the preview.
- **Units.** The UI and records use degrees (`*_deg` field names). Radians exist only transiently inside the math.
- **Offset normalization** (identical in both mirrors):
  `o = ((θ₀ % 360) + 360) % 360`, then `o = Math.round(o * 1e6) / 1e6`. If `o >= 360` or `o === 0` (including `-0`), `o = 0`. The resolution is 1e-6°, which is sub-grid at any radius inside `WORLD_LIMIT`.
  Offsets that differ by a multiple of `360/N` produce the same set of lines with shifted indices. They are **not** re-normalized to `[0, 360/N)`, because the index-to-angle mapping is part of the record.
- **Spoke angle:** `step = 360 / N`, `raw = o + n * step`, `θₙ = raw >= 360 ? raw - 360 : raw`, evaluated in exactly this order in both mirrors.
- **Direction:** `d = (cos θ, sin θ)`, where `θ` is `θₙ · π / 180`. When `θₙ` is exactly 0, 90, 180, or 270, the exact unit vectors `(1,0)`, `(0,1)`, `(−1,0)`, `(0,−1)` are used instead of trigonometry.
- **Numeric rules.** Two fixed constants are defined once per mirror:
  - `CONTACT_TOLERANCE_WU = 0.001`, one grid step, used as the perpendicular-distance tolerance for "a vertex lies on the ray";
  - `MIN_SPOKE_LENGTH_WU = 1`.
  Ray arithmetic is float64. Containment is exact on the grid (§15.3.2). Output endpoints are normalized to the 0.001-wu grid by the existing `normalizeGeometry`, and each spoke must pass the existing `validateGeometry('linestring')`.
- **Determinism.** Identical inputs (input geometries at their pinned revisions, center, `N`, `θ₀`, and `omit_indices`) yield byte-identical geometry and construction records, apart from `construction_id` (§15.8). No randomness, reference-layer data, pixel data, or view state is read.
- **Authority.** The **server** computes persisted geometry. The client mirror exists for live preview only. The two share fixtures (§15.14), and after Create the UI shows the server's returned geometry.

### 15.5 Boundary intersection semantics

This needs only one new capability: a ray against a single closed ring. There is no clipping, no boolean operation, and no new dependency (§2.3, §9).

**Per-ring crossing extraction.** Let `C` be the center and `d` the unit direction. For each ring vertex `Vᵢ`, compute:

- side `sᵢ = cross(d, Vᵢ − C) = d.x·(Vᵢ.z − C.z) − d.z·(Vᵢ.x − C.x)`, treated as 0 when `|sᵢ| ≤ CONTACT_TOLERANCE_WU`;
- along-ray parameter `tᵢ = dot(d, Vᵢ − C)`.

Walk the ring cyclically:

- An edge whose endpoints have strictly opposite nonzero sides is a **crossing** at `P = A + (B − A) · sA / (sA − sB)`, with `t = dot(d, P − C)`.
- A maximal run of consecutive zero-side vertices is an **on-ray run**.
  - **Single-vertex run.** Compare the nonzero sides immediately before and after it. If they are opposite, it is a **crossing at that vertex**, using the vertex's exact stored coordinates. If they are the same, it is a **touch** (tangential contact, not a crossing).
  - **Multi-vertex run** (the ray overlaps a boundary edge). If any vertex of the run has `t > CONTACT_TOLERANCE_WU` (a *forward* overlap), the spoke has the blocking error `collinear_overlap` on that ring. This applies whatever the neighbouring sides are, and whether the overlap lies before, at, or beyond the endpoint that would otherwise be selected. The error reports the overlap's `t` range and its X/Z endpoints. The overlap is not classified as a crossing or a touch, and no endpoint is selected for that spoke. A multi-vertex run lying wholly at or behind the center is ignored, like any other contact there.
  - This deliberately defines no point or ordering rule for overlaps. The editor resolves one by changing `θ₀` or `N`, by explicit omission, or by revising the boundary.
- Only crossings and touches with `t > CONTACT_TOLERANCE_WU` are considered. Everything behind or at the center is ignored. The center is strictly inside, so a valid ring always yields an **odd** number of crossings along the ray. An even count can only come from tolerance degeneracy, and is a per-spoke error.

**Endpoint selection.** Let the inner crossings sorted by `t` be `I₁ … Iₖ`, and the outer crossings `O₁ … Oₘ`.

- **Spoke start = `Iₖ`**, the outermost exit from the inner ring. Past it the ray never re-enters the inner region.
- **Spoke end = `O₁`**, the first exit from the outer ring. Before it the ray never leaves the outer region.
- The spoke `[Iₖ, O₁]` therefore lies entirely outside the inner region and inside the outer region, and crosses neither boundary. This is the only choice with that property, which is why it is used.
- Geometry is exactly two vertices `[start, end]`, directed inner → outer.

**Case table:**

| Case | Result | Blocks persistence? |
| --- | --- | --- |
| Center not strictly inside inner or outer ring | Construction error `center_not_inside` (names which ring). No spokes are computed. | Yes |
| Ineligible, missing, unaccepted, or stale input, or inner = outer | Construction error (`ineligible_input`, `not_found`, `not_accepted`, `stale_input`, `same_input`) | Yes |
| Exactly one crossing per ring, in order | Valid spoke | — |
| Inner ring crossed `k > 1` times (concave inner) | Valid spoke from `Iₖ`, with warning `inner_multiple_crossings (k)` | No |
| Outer ring crossed `m > 1` times (concave outer; the ray re-enters beyond the end) | Valid spoke to `O₁`, with warning `outer_multiple_crossings (m)` | No |
| Even crossing count on either ring | Spoke error `ambiguous_ray` | Yes, unless omitted |
| Any forward multi-vertex on-ray run on either ring (collinear overlap anywhere along the ray: before, at, or beyond the would-be endpoint) | Spoke error `collinear_overlap` (names the ring, `t` range, and X/Z) | Yes, unless omitted |
| An inner **touch** with `t` in `(tIₖ, tO₁)`, or an outer touch with `t < tO₁` (the spoke would graze a boundary) | Spoke error `grazes_inner` / `grazes_outer` at the contact point | Yes, unless omitted |
| A touch outside the spoke segment | Ignored | — |
| `tO₁ ≤ tIₖ` (the outer ring is reached before the ray leaves the inner ring, as when the rings cross) | Spoke error `invalid_radial_order` | Yes, unless omitted |
| Length `< MIN_SPOKE_LENGTH_WU`, or linestring validation fails after grid rounding | Spoke error `too_short` / `invalid_geometry` | Yes, unless omitted |

Spokes never intersect each other: distinct rays from one center meet only at the center, which is inside the inner ring and excluded. A computed endpoint that is not a vertex crossing lies within about 0.0007 wu of the true ring after grid rounding. This is accepted. **Input rings are never modified**, for example by inserting a vertex, to force exact coincidence.

**Performance bound.** The cost is `N ≤ 360` rays × two rings of up to 20,000 vertices each (`MAX_VERTICES`), a linear scan with no index. The live-preview target is under 50 ms for `N = 16` against two 4,096-vertex rings in the frontend. The implementing agent records the measured time in the WP report.

### 15.6 Preview and persistence workflow

1. **Open.** In the canonical-geography manager, open **RADIAL CONSTRUCT** (world editor only). It is mutually exclusive with tracing, map-pick inspection, and land selection, like the existing tools.
2. **Inner boundary.** Pick by map click (candidates from `mapPick.ts`, filtered to eligible accepted features) or from a list of eligible accepted features. The panel shows id, name, class, and revision. Ineligible candidates are listed with their reason (for example "open linestring" or "draft").
3. **Outer boundary.** The same as step 2.
4. **Center.** Choose one source from §15.3.2. The readout shows X/Z (wu and m). An inside/outside status is shown against both rings immediately.
5. **Spoke count.** Numeric input for `N`.
6. **Angular offset.** Numeric degrees (±1° and ±0.1° nudges), plus **Aim spoke 0**: click a map point, and `θ₀` becomes the angle from center to that point, rounded to 0.001°. The convention is stated inline (§15.4).
7. **Preview** (no network; client mirror). Recomputation runs on every parameter change. Valid spokes render in a distinct **PREVIEW** style, different from draft/proposed/accepted, and spoke 0 is emphasized. The center marker is shown. Invalid spokes render as an error-colored ray segment from the center to the outer ring's bbox. A table lists index, `θₙ`, length (m), status, and warnings or errors, and hovering a row highlights its spoke.
8. **Resolve problems.** Construction errors disable Create and state the reason. Per-spoke errors disable Create unless every invalid index is ticked **Omit** (§15.13).
9. **Output settings** (§15.3.4).
10. **Create drafts.** A single request to the construct endpoint. The server reloads the inputs at the pinned revisions, recomputes, and inserts every spoke draft in **one transaction**, or inserts nothing and returns the full report. It emits one `dataUpdated` on success.
11. **Inspect and edit.** The constructor switches to a **construction review list** (the drafts of this `construction_id`). Each row opens the existing inspector, where drafts can be edited, deleted, or traced through the existing WP5 workflow. Editing a spoke's geometry clears its construction record (§15.8).
12. **Accept explicitly.** Either accept each spoke through the existing accept confirmation, or tick an explicit selection in the review list and use **Accept selected (k)**. That shows one confirmation stating count, class, kind, strength, and total length. It then issues the existing per-record `accept` calls sequentially with each `expected_draft_version`, stops at the first failure, and reports which rows were accepted. Nothing is pre-ticked, there is no accept-all, and there is no accept-and-lock (§7.2).

Preview never writes. Closing the tool discards preview state. Nothing reaches the server until Create.

### 15.7 Output representation

- **One `canonical_features` row per spoke:** `geometry_type = 'linestring'`, exactly two vertices, and the class/kind/strength/width/name from §15.3.4.
- Governance: `lifecycle_state = 'draft'`, `provenance = 'authored'` (an editor using a deterministic aid, like the §4.1 constructors), `replacement_state = 'non_replaceable'`, and `is_locked = 0`. These are the same defaults as `POST /:entity`.
- There is **no grouping entity, table, or relationship.** Spokes are independent features with independent lifecycle and revision. The `construction_id` in each record (§15.8) is informational only. It lets the UI list siblings and pre-fill reconstruction. It is never a foreign key, a query input, or a generator input, and it confers no joint lifecycle.
- It does **not** create closed district polygons, scopes, scope boundaries, memberships, anchors, or connections.

### 15.8 Construction metadata (`construction_json`)

Each spoke stores a `radial_spoke` construction record:

```text
{
  type: 'radial_spoke',
  version: 1,
  construction_id: '<uuid, server-generated per construction>',
  center: {x, z},
  center_source: { kind: 'coordinate' }
               | { kind: 'feature_point' | 'feature_construction_center', feature_id, revision },
  inner: { feature_id, revision },
  outer: { feature_id, revision },
  count: N,
  offset_deg: <normalized θ₀>,
  omit_indices: [...],
  index: n,
  angle_deg: θₙ,
  angle_convention: 'deg_from_+x_toward_+z'
}
```

Rules:

- **Geometry remains authoritative** (§3.2). The record explains how the geometry was derived and pre-fills reconstruction. It is never re-evaluated automatically. The query bundle, generators, and the digest never read it. The digest changes only through the normal `revision` bump, since `construction_json` is already a constraint column.
- **Only the constructor writes `radial_spoke` records.** The backend `checkConstruction` (`entities.js`) gains the `radial_spoke` shape with strict keys. `POST /:entity` and `POST /proposals` reject a client-supplied `radial_spoke` construction with 400. `PATCH` on a draft or proposal accepts a `radial_spoke` record only when both the record and the geometry equal the stored values. A PATCH that changes geometry while keeping the record is rejected with 400 ("clear the construction record when editing constructed geometry"). `revise` and draft-from-history copy the record together with its geometry, so they stay consistent.
- **The frontend clears, never adapts, the record.** Vertex edits already clear `construction` in `tracing.ts`. `translateConstruction` must return `null` for `radial_spoke` rather than shifting `center`, because the record would otherwise misdescribe its inputs.
- The inspector shows the record read-only (center, inputs with revisions, `N`, `θ₀`, index, `θₙ`). It also shows a **stale-inputs notice**: a client-side comparison of each recorded input revision with the currently loaded accepted revision, or "input retired / not found". The notice is informational and triggers nothing.
- **Interface note for WP7 (no scope change):** export carries `construction_json` unchanged like any field. Interchange import sets an incoming `radial_spoke` record to `null` and lists that in the dry-run report, because its feature ids and revisions are database-local. Circle, ellipse, and rectangle records are unaffected.
- This is a record of one construction type, not a parametric-CAD framework. There are no expressions, no dependency graph, and no generic constraint solver.

### 15.9 Revision and input-change semantics

Nothing is ever rewritten automatically. Every path ends in drafts and explicit acceptance.

| Change after spokes exist | Behavior |
| --- | --- |
| Inner or outer boundary revised and accepted | Existing spokes (draft or accepted) are untouched. The inspector shows the stale-inputs notice. The editor may reconstruct. |
| Center, `N`, `θ₀`, or omissions should change | The editor reconstructs explicitly. |
| An input is retired | Spokes are untouched, with a notice. Reconstruction against it is impossible until it is restored or replaced by another accepted input. |

**Reconstruct** is started from any spoke's inspector ("Reconstruct from this construction"). It opens the constructor pre-filled from the record: current accepted input revisions, recorded center source, `N`, `θ₀`, and omissions. The editor adjusts and previews, then persists in one of two modes:

- **Revision mode.** This mode may change only the center (and center source), `θ₀`, and the pinned input revisions or input features. **`count` and `omit_indices` must equal the values in the targets' accepted construction records**, which must all agree with each other. Changing either one is a different set of spokes, and must use new-drafts mode. Revision mode is offered only when all of the following hold:
  - every non-omitted index has exactly one existing **accepted** spoke with the same `construction_id` and `index`;
  - `revises` names exactly those spokes, and **every accepted feature carrying that `construction_id` is among them**, so no accepted sibling is left outside the reconstructed set;
  - all of them are unlocked with no open draft revision.

  The request carries `revises: [{index, feature_id, expected_revision}]`. The server re-checks every one of these conditions inside the transaction. In one transaction the server creates a **draft revision** (`revises_id`) of each target, replacing only geometry and construction. Class, kind, strength, width, name, and anchor linkage are copied from canon as `revise` does, and `construction_id` is kept. The request returns 409 with the full list and writes nothing if any of these hold:

  - a target is locked, has an open revision, or is stale;
  - an index or `construction_id` does not match;
  - `count` or `omit_indices` differs from the recorded values, or the records disagree;
  - an accepted sibling is missing from `revises`. Accepting each revision keeps its id and bumps its revision (§3.7), so planner references survive.
- **New-drafts mode.** This is always available. It creates independent new drafts with a new `construction_id`. The old spokes stay exactly as they are. The review list names the old accepted spokes and says they remain canonical until the editor retires them explicitly through the existing per-record retire action. Nothing is retired automatically.

Draft spokes from an earlier construction are simply edited or deleted, since drafts are hard-deletable (§3.7). The review list offers **Discard drafts of this construction**. It issues existing per-record `DELETE` calls for drafts only after a count confirmation, and never touches accepted rows.

### 15.10 Authorization, protection, and lifecycle

- The construct endpoint is mounted with `authenticate, requireWorldEditor`, including `dry_run`. It cannot be reached by player or temporary-admin tokens. Frontend gating (`isPrimaryAdmin`) is presentation only.
- Outputs are always `draft`. No request field can set lifecycle, lock, replacement state, or provenance, and the endpoint never calls accept.
- Acceptance is only the existing `POST /features/:id/accept`, with its full validation and `expected_draft_version`.
- Inputs are only read. Construction never modifies, locks, revises, or retires an input feature. A test pins that the input rows are byte-identical afterwards.
- Revision mode goes through the same guards as `revise`: 409 when locked, and 409 on an open revision. Accepted, locked, `non_replaceable`, retired, and history rules apply to spokes exactly as to any feature.
- The constructor is not a software proposal channel. It is an editor tool writing `authored` drafts, so `/proposals` is not used.

### 15.11 Implementation surfaces

**Backend**

| Surface | Change |
| --- | --- |
| `backend/canonicalGeography/radialConstruction.js` (new, pure) | Parameter normalization (§15.4), ring extraction from polygon or closed linestring, per-ring crossing extraction and endpoint selection (§15.5), and per-spoke report building. Reuses `gLocatePointInRing`, `normalizeGeometry`, and `validateGeometry` from `geometry.js`. No DB or Express imports. |
| `backend/canonicalGeography/entities.js` | `CONSTRUCTION_TYPES` gains `radial_spoke` with a strict-key shape check. The client-write refusal (§15.8) is enforced in the create and proposal paths, and in the patch path through `store.js`. |
| `backend/canonicalGeography/store.js` | `constructRadial(body)`: one `BEGIN IMMEDIATE` transaction that loads inputs, checks eligibility and pinned revisions, computes, and then either inserts N drafts or, in revision mode, uses the existing `refuseOpenRevision` / `insertRevision` path per target. It is all-or-nothing. A patch-path guard enforces the `radial_spoke` invariant. |
| `backend/routes/canonical_geography.js` | `POST /constructions/radial`, registered **before** `/:entity` (like `/proposals` and `/query`). It uses the `mutation` wrapper (one `emitUpdate`) for real writes. `dry_run: true` returns the report with 200 and emits nothing. Status codes: 400 for malformed parameters, 404 for a missing input, 409 for ineligible, stale, per-spoke-invalid, locked, or mismatched requests, and 201 on success. |

**Request:** `{ inner: {feature_id, expected_revision}, outer: {…}, center? , center_source?, count, offset_deg, omit_indices?, output?, revises?, dry_run? }`. `output` is required in new-drafts mode and forbidden in revision mode. In revision mode, `count` and `omit_indices` must equal the recorded values (§15.9).

**Report:** `{ ok, normalized: {center, count, offset_deg, omit_indices}, errors: [construction-level], spokes: [{index, angle_deg, status: 'valid'|'invalid'|'omitted', geometry?, length_wu, length_m, warnings[], error?}] }`. On 201 it also returns `construction_id` and the created or revised feature records.

**Frontend** (`frontend/src/modules/canonicalGeography/`)

| Surface | Change |
| --- | --- |
| `radialConstruction.ts` (new, pure) | A mirror of the backend module with the same constants and formulas. It uses `locateInRing` from `constraints.ts`. No React, Three.js, network, or reference-layer imports, and it is added to `importBoundary.test.ts`. |
| `types.ts`, `geometry.ts` | A `RadialSpokeConstruction` type added to the `Construction` union (read and display only). No client code constructs one. |
| `tracing.ts` | `translateConstruction` returns `null` for `radial_spoke`. |
| `api.ts` | `constructRadial(body)` and `previewRadialOnServer(body)` (`dry_run`, used by tests and debugging, not the live preview). |
| `RadialConstructionPanel.tsx` (new) | Steps 2–12 of §15.6: pickers, parameters, spoke table, omissions, output settings, Create, review list, Accept selected, Discard drafts, and Reconstruct pre-fill and mode choice. It keeps `CanonicalGeographyManager.tsx` to a launcher and tool-exclusivity integration only. |
| `RadialConstructionPreview.tsx` (new) | In-scene preview lines, center marker, and spoke-0 emphasis. Non-raycast, drawn in the canonical overlay Y band (§7.2), with Y=0 click capture for center, aim, and boundary picking following the existing `TracingTool` / `CanonicalPickTool` pattern. |
| Inspector (in the existing manager/inspector code) | A read-only construction-record display, the stale-inputs notice, and the Reconstruct entry point. |
| `App.tsx` | Integration only: mount the preview beside the existing canonical tools. |

No dependency is added. No migration is needed, because `construction_json` already exists.

### 15.12 UI scope

It contains only what §15.6 lists. It explicitly excludes:

- general CAD tools and snapping beyond the existing vertex snap;
- expressions, scripting, and saved parametric templates;
- a dependency editor or live-linked geometry;
- automatic district, scope, or polygon creation from spokes;
- worksets, density tooling, and batch generation;
- open-linestring or multi-ring boundaries.

### 15.13 Failure UX

- **All-or-nothing by default.** Any construction-level or per-spoke error blocks persistence. Unexplained partial output would break the regular index-to-angle mapping that the record, the review list, and revision-mode reconstruction rely on, and a silently missing spoke is exactly the unexplained omission this tool must not produce.
- **Explicit omission is the recoverable path.** When a spoke is geometrically invalid (for example, the rings cross at that angle), the editor may tick Omit for that index. The omission is recorded in `omit_indices` on every sibling. The alternatives are to adjust `θ₀` or `N`, or to revise a boundary through the normal lifecycle. Omission is never automatic. During reconstruction, a new omission (or a new `N`) changes the set of spokes, so it is available only in new-drafts mode (§15.9). In revision mode, an invalid spoke can be fixed only through `θ₀`, the center, or the boundaries.
- **Actionable messages.** Every error names the spoke index and angle, the ring (inner/outer), the reason in plain words, and, where relevant, the contact or crossing point in X/Z. The point is highlighted in the preview. Examples:
  - "Spoke 3 (135.000°): outer boundary reached before leaving inner boundary — rings cross here. Omit this spoke, change the offset, or revise a boundary."
  - "Center lies outside the inner boundary (feature #41). Choose a center inside both boundaries."
  - "Outer boundary (feature #57) changed from revision 2 to 3 since preview. Preview refreshed; review and create again."
- Warnings (multiple crossings) are shown but do not block.
- After a failed Create, the preview state is kept so the editor can correct it and retry.

### 15.14 Automated validation

**Shared fixtures.** `backend/__tests__/fixtures/radial_construction_cases.v1.json` holds synthetic rings, centers, `N`, `θ₀`, omissions, and expected per-spoke results. It is copied byte-identically to `frontend/src/modules/canonicalGeography/__tests__/fixtures/`, with a parity test following the existing `canonical_query_bundles.v1.json` pattern. Cases:

1. Regular 64-gon rings (inner r=100, outer r=300) with `N` = 1, 2, 3, 7, 8, 360 and `θ₀` = 0 and 22.5: angles, lengths, and all valid.
2. Axis-aligned square rings with exact endpoints at 0/90/180/270°, and a 45° ray through the square corners, testing the exact vertex-crossing coordinates.
3. Concave (notched) inner ring: outermost exit plus the `inner_multiple_crossings` warning.
4. Concave (bay) outer ring: first exit plus the `outer_multiple_crossings` warning.
5. Outer ring with an inward vertex touching a ray before the exit: `grazes_outer`. Inner lobe touching from outside: `grazes_inner`. A touch beyond the spoke end is ignored.
6. Collinear runs: a ray overlapping an inner edge before the spoke start, an outer edge at the would-be endpoint, an outer edge beyond the would-be endpoint (the outer boundary is re-entered and then runs along the ray), and a multi-vertex run behind the center. The first three give `collinear_overlap`, and only for that spoke. The last is ignored. A companion case puts a single on-ray vertex at the same position, and confirms it is still classified as a crossing or a touch.
7. Crossing rings: `invalid_radial_order` for the affected indices only, and valid everywhere else.
8. Center outside inner, on inner, outside outer, and on outer: `center_not_inside`.
9. Offset normalization: −30 → 330, 720.5 → 0.5, −0 → 0, 1e−7 → 0, 359.9999999 → 0. NaN, ±Infinity, and non-integer or out-of-range `N` are rejected. Omission out of range or all omitted is rejected.
10. Determinism and rotation: identical results on repeated runs. `θ₀ + 360/N` yields the same set of line geometries with indices shifted by one. Changing `θ₀` changes every spoke deterministically.

**Backend** (Vitest + Supertest):

- `canonical_geography_radial_geometry.test.js`: the pure module against the fixtures, plus ring extraction (polygon outer ring with holes ignored, closed linestring, and open linestring rejected).
- `canonical_geography_radial_construction.test.js`, covering the route and lifecycle:
  - 401 without a token, and 403 for player and temporary admin (including `dry_run`);
  - rejection of draft, proposed, retired, point, open-linestring, same-input, and stale-revision inputs;
  - feature-derived centers (point and circle construction), including rejection of a submitted `center` alongside them;
  - outputs are `draft` / `authored` / `non_replaceable` / unlocked with the exact `construction_json`, and are absent from `/query` until accepted;
  - per-spoke accept via the existing route yields revision 1, and the digest changes;
  - input rows are byte-identical after construction;
  - any per-spoke error writes zero rows;
  - one emit per success, and none on rejection or `dry_run`;
  - revision mode creates draft revisions with `revises_id` and a kept `construction_id`, and accepting keeps the id and sets revision 2;
  - revision mode returns 409 with zero rows for a locked target, an open revision, a stale target, or an index/`construction_id` mismatch;
  - revision mode returns 409 with zero rows, and every sibling's row stays byte-identical, when:
    - `count` differs from the record (fewer or more spokes);
    - `omit_indices` differs from the record (an index added or removed);
    - the targets' records disagree on `count` or `omit_indices`;
    - `revises` leaves out an accepted sibling carrying the same `construction_id`;
  - the same `count` or `omit_indices` change succeeds in new-drafts mode, with a new `construction_id`, and leaves the old accepted spokes untouched;
  - `radial_spoke` construction is rejected on `POST /features` and `/proposals`;
  - PATCH that changes geometry while keeping the record returns 400, and PATCH with `construction: null` plus new geometry succeeds;
  - `revise` and draft-from-history preserve the record with its geometry.

**Frontend** (Vitest + Testing Library, mocked R3F):

- `radialConstruction.test.ts`: the pure mirror against the shared fixtures, plus parity.
- `RadialConstructionPanel.test.tsx`: only accepted, eligible features are pickable, and ineligible ones show their reason. Construction errors disable Create. Per-spoke errors disable Create until omitted. Create sends the pinned revisions and the output settings. A failed Create keeps state. The review list pre-ticks nothing. Accept selected confirms the count and uses each `expected_draft_version`. Discard touches drafts only. Reconstruct pre-fills from the record and offers revision mode only when eligible. Editing `N` or an omission during reconstruction disables revision mode, with a reason that points to new-drafts mode, and restoring the recorded values re-enables it. When the server refuses a revision request with 409, the panel shows the listed reasons, keeps the preview state, and does not show any draft revisions.
- `RadialConstructionPreview.test.tsx`: the preview style differs from draft/proposed/accepted, spoke 0 is emphasized, the preview is non-raycast and in the Y band, and nothing renders under `BattleMapScene`.
- `translation.test.ts` / `tracing.test.ts`: translating or vertex-editing a `radial_spoke` draft clears the record.
- `importBoundary.test.ts`: `radialConstruction.ts` is pure.
- Inspector: the construction record display and the stale-inputs notice.

**Expected size and time** (an estimate; the actual counts and wall-clock times are recorded in the AT1 report): about 60–90 new backend tests and about 50–80 new frontend tests. The targeted files should take a few seconds, the full backend suite about 10–15 s, the full frontend suite about 45–55 s, plus the production build.

**Commands:** targeted files first, then `cd backend && npm test`, then `cd frontend && npm test && npm run build`. Stop on any failure.

### 15.15 Human acceptance (live, with the real reference and canon)

The real world data validates the generic mechanism. Nothing here is encoded in code.

**Preconditions.** The Imperial City reference layer is visible. The intended inner and outer ring features are traced (with the §4.1 circle constructor where the evidence is circular) and **accepted**. Record their ids and revisions.

1. **Select inputs.** Open RADIAL CONSTRUCT, then pick the inner and outer rings on the map. Both show as eligible accepted features with their revisions. A draft feature is not offered.
2. **Center.** Use "center of" the inner ring's circle construction, or place the center by click or entry. Both rings report the center inside.
3. **Exact divisions.** Set `N` to the number of radial divisions visible in the raster. Use Aim spoke 0 on one raster radial wall, then fine-tune `θ₀`. Every preview spoke lies over its raster radial wall, and zooming in shows each endpoint on the inner and outer rings.
4. **Deterministic offset.** Change `θ₀` by +5°: every spoke rotates by 5°. Revert: the preview is identical to before. Set `θ₀ + 360/N`: the same lines appear with the indices shifted.
5. **Failure reporting.** Move the center outside the inner ring: Create is disabled with a clear reason. Restore the center.
6. **Persist as drafts.** Create. N DRAFT-styled spokes appear. A city-scope `/query` (via `curl` or dev tools) does not contain them. The inner and outer rings still show their original revisions.
7. **Inspect and edit.** Open a spoke: the construction record is shown. Edit one draft's endpoint in the tracer: its record is cleared. Delete that draft, or recreate it.
8. **Explicit accept.** Tick the spokes, choose Accept selected, and confirm the count. They are accepted at revision 1, `/query` now contains them, and the digest changed. Lock one spoke.
9. **Persistence.** Reload the browser and restart the backend. Drafts, accepted spokes, and the lock are unchanged.
10. **Input change without rewriting.** Revise the outer ring slightly and accept it. Every spoke is unchanged, and the inspector shows the stale-inputs notice. Reconstruct in revision mode: it is refused while one spoke is locked, and the refusal names that spoke. Unlock it, then reconstruct: draft revisions appear. Accept them: same ids, revision 2.
11. **Input safety.** Throughout the procedure, no accepted input ring changes revision or geometry except through the editor's own explicit revise in step 10.
12. **Authorization.** As a player or temporary admin, the tool is absent and a direct `POST /constructions/radial` returns 403.

### 15.16 Non-goals

This slice does not plan or implement:

- procedural city generation, district generation, or automatic district, scope, or polygon creation from spokes;
- generation worksets/batches, district fulfillment ledgers, or density/intensity nodes;
- polygon clipping, boolean operations, or buffering (only ray/ring intersection);
- general CAD, parametric scripting, expressions, or dependency-driven regeneration;
- AI geometry generation;
- open-linestring or multi-ring boundaries, or non-radial pattern constructors;
- any WP7 work (import/export, legacy promotion, the initial register), or upstream CITY_NET synchronization.

### 15.17 Completion gate

AT1 is complete when all of the following hold:

- every §15.14 test passes, and both full suites and the production build pass;
- the live-preview timing is recorded (§15.5);
- human acceptance §15.15 steps 1–12 pass;
- a review finds no world-specific identifiers in code or tests, and no path by which construction writes non-draft state or modifies an input.

Then stop for human acceptance and commit authorization. WP7 follows unchanged.
