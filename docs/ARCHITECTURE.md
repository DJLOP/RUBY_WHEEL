# RUBY_WHEEL Architecture

**Status:** Baseline architecture contract  
**Project:** RUBY_WHEEL  
**Upstream:** `over2take/CITY_NET`  
**Fork baseline:** `4fb2ecfb0b90c056d8f1f386aeb28e213f087405`

## 1. Architectural Goal

RUBY_WHEEL extends CITY_NET into a persistent Imperial City construction and world-management system.

The architecture must optimize first for:

> **safe, iterative, procedural completion of a canonical megacity around existing user-authored work.**

Existing VTT capability is inherited infrastructure.

City completion is the primary architectural driver.

# 2. Core Invariants

The following are architectural invariants.

Implementation plans may choose different technical mechanisms, but may not violate these rules without an explicit architecture decision.

## A-001 — One Canonical World

There is one canonical Imperial City.

Campaigns, sessions, users, and characters reference this world.

They do not own separate copies of it.

## A-002 — Authored and Canonical Content Outrank Disposable Generated Content

Authored, imported, accepted canonical, protected, and uncertain legacy content are non-replaceable by default.

Procedural systems adapt around non-replaceable content.

Automatic regeneration may replace only content explicitly designated replaceable or disposable.

## A-003 — Provenance Is Explicit

The application must not infer whether content is generated or authored from naming conventions.

World content that participates in procedural editing must be capable of carrying explicit provenance such as:

- imported;
- authored;
- generated.

Provenance describes origin. It does not determine whether content may be destroyed or regenerated.

Implementation may add more detailed provenance later.

## A-004 — Replacement and Protection Are Explicit and Separate

Objects participating in procedural regeneration must support an explicit replacement state.

Automatic procedural replacement is allowed only when content is explicitly marked replaceable or disposable.

Protection or lock state is a separate safeguard against accidental manual movement, deletion, or other destructive editing.

Unlocked content is not therefore automatically replaceable, and non-replaceable content need not be locked.

Existing pre-RUBY_WHEEL content whose replacement state is unknown must default conservatively to non-replaceable.

## A-005 — Generation Is Local

Generation and regeneration operate on bounded spatial regions.

The system must not require reconstruction of the whole Imperial City to modify one neighborhood.

## A-006 — Generation Is Deterministic

Procedural output must be reproducible from controlled inputs.

Generation runs must have access to a deterministic seed and sufficient version/context metadata to explain how output was produced.

## A-007 — Generation Semantics Are Data-Driven

Imperial City generation must not be implemented as a new collection of hard-coded district checks.

Core procedural geometry should consume structured profiles and archetypes.

Adding a new district style should ordinarily mean adding or editing data/configuration and reusable archetypes rather than editing core layout algorithms.

## A-008 — Persistent Geography Is First-Class

Districts, subregions, canonical water, protected generation areas, and other important planning geometry must exist as persisted world data.

Temporary drawing-tool state is not an acceptable long-term representation.

## A-009 — Urban Fabric Is Not Automatically a Gameplay Entity

Physical representation and semantic importance are separate concerns.

A building may exist visually without carrying the full cost and complexity of a gameplay location.

## A-010 — Megacity Scale Is Foundational

Performance strategy must be evaluated against the intended megacity rather than ordinary VTT-map scale.

Foundational persistence and rendering decisions must be benchmarked before large amounts of canonical city data depend on them.

## A-011 — Food Logistics Are Spatial Architecture

Urban agriculture, import interfaces, storage, processing, and distribution are structural parts of the city model.

They may later participate in simulation, but they must first exist as understandable physical geography and infrastructure.

## A-012 — Existing CITY_NET Capability Is Reused by Default

Working upstream capability should be extended rather than rebuilt unless an identified limitation justifies replacement.

## A-013 — Canonical World Mutations Require World-Editor Authorization

Mutations to canonical-world data must be authorized explicitly on the server.

Authentication alone is not sufficient authorization for canonical reference-layer transforms, geography editing, generation or regeneration, replacement/protection changes, destructive snapshot restore/clear operations, or equivalent world-authoring actions.

Until a richer role model is deliberately introduced, the primary administrator may act as the sole world editor.

## A-014 — Physical Scale Is Fixed

One RUBY_WHEEL world unit is 5 feet (1.524 meters). This is the canonical world-coordinate contract.

The Imperial City source artwork scale is 1 source pixel = 3 meters, so the reference calibration corresponding to source physical scale is `250/127 ≈ 1.968503937` world units per pixel.

The canonical exterior-wall span is 6,744 meters east–west and north–south (`2,248 px × 3 m/px`), approximately 4,425.20 world units in each direction.

UI measurement or display settings, including inherited scale controls, may change how distances are presented but must not silently redefine the physical size of canonical geometry.

## A-015 — Preserve Canon, Not Pixels

Raster reference layers are calibrated evidence, not authoritative fine geometry.

Procedural generation must not consume raw raster pixels as canonical spatial geometry. Hand-drawn, scanned, and editing artifacts and drawing conventions (stroke width, dirty or thick outlines, imperfect circles or wall alignment, anti-aliasing, cleanup colors, symbolic feature colors and marks) must not silently become canonical geometry.

Canonical spatial geometry is normalized and explicitly accepted before generators consume it. The raster may inform a feature's intended existence, approximate location, connectivity, role, or extent without its literal pixels becoming canonical.

A-002 protection applies to that canonical geometry once accepted; it does not convert reference pixels into protected geometry.

## A-016 — Canon Has Anchor Classes

Canonical constraints distinguish:

- **hard anchors** — location and/or geometry is established canon and must be preserved closely;
- **soft anchors** — the feature must exist in an appropriate place and role, but exact footprint and form remain free;
- **ordinary urban fabric** — streets, buildings, lots, alleys, and similar fabric that may be regenerated unless intentionally promoted into canon.

Appearance in the source raster does not by itself make ordinary buildings or streets canonical.

This classification does not override authored/accepted-content protection: ordinary fabric that has been authored, imported, or accepted into the canonical world remains non-replaceable unless explicitly designated replaceable.

## A-017 — Generation Is Hierarchical

Generation is conceptually layered:

```text
City strategy                         (persistent strategic planning)
  → District program                  (persistent strategic planning)
  → Generation workset / batch        (demand-created execution unit)
  → Island / land-piece morphology
  → Local block / quarter refinement
  → POI promotion / detailed authoring
```

The architecture separates four concerns that must not be collapsed into one tree:

1. **Persistent semantic geography/scopes** — accepted land (physical islands), water, districts, optional island groups, subregions, anchors, and connections (§7, §8). These describe the world.
2. **Persistent strategic planning** — city strategy and district programs, which attach to semantic scopes by reference (§8).
3. **Demand-created generation worksets/batches** — execution constructs that select land to generate together under district planning (A-018). They are not canonical geography.
4. **Lower-level morphology/detail** — island/land-piece, block, lot, building, and POI work (§9).

Island groups are an optional semantic scope (§8), not a mandatory generation tier. The earlier model in which island-group/island-chain allocation was a required stage between district program and island morphology is superseded.

Higher levels allocate roles, constraints, obligations, budgets, relationships, ranges, weights, and priorities. Lower levels produce geometry and detail.

Lower-level feasibility must be able to feed back upward rather than forcing geometrically impossible allocations.

This is an architectural direction, not a mandate to implement all levels at once or to build a single framework spanning them.

## A-018 — Generation Worksets Are Execution Constructs

Routine generation executes through demand-created generation worksets (batches). A workset is a planning/execution construct, not a canonical geographic entity: creating, discarding, or re-forming a workset never creates, alters, or retires canonical geography.

A workset may contain arbitrary selected land appropriate to generate together, including whole islands and derived district/island land pieces (A-019). It:

- inherits the requirements and program constraints of the district(s) its land lies in;
- reads previously generated and accepted state in those districts;
- reads which district requirements remain unfulfilled, so later batches do not duplicate facilities or roles already satisfied by earlier batches.

This implies a conceptual, read-side **district requirement/fulfillment state** derived from, or maintained alongside, the district program and accepted generated output. Its persistence schema is intentionally undecided (§31).

Worksets remain subject to A-005 (bounded/local), A-006 (deterministic from controlled inputs, including the district state they read), A-002/A-004 (canon protection), and A-017 feasibility feedback.

## A-019 — Districts and Islands Are Independent Geometries

Physical islands are accepted land polygons; the land polygon itself is the island's identity. Districts are persistent drawn spatial regions. Neither is defined in terms of the other.

- A district boundary may cut through an island, and one island may intersect several districts.
- There is no strict District → Island ownership hierarchy. Explicit whole-island district membership is metadata/convenience only and never defines authoritative district spatial extent.
- A district's authoritative spatial extent is its accepted drawn boundary. A district with no accepted boundary has no authoritative spatial extent.
- Any member-polygon extent that current canonical query/validation code resolves for a boundaryless scope is a legacy query/selection convenience only. It is not canonical district geometry, future district planning/generation must not interpret it as authoritative district extent, and it must not recreate a District → Island ownership model.
- Later generation may derive `island geometry ∩ district geometry` land pieces at planning/generation time, only from authoritative district geometry, instead of requiring manually authored split-island features. Derived pieces are not canonical features unless separately and explicitly accepted. Deriving them will require a polygon clipping capability, which is a dependency decision for the slice that first needs it (§3).

## A-020 — Parametric Canonical Construction Is Authoring, Not Generation

Deterministic parametric construction of canonical geometry — such as a radial/spoke-wall constructor that casts `N` rays from a canonical center at `θₙ = θ₀ + n · (360° / N)` and intersects each with the actual inner and outer boundaries (accepted canonical geometry, or deterministic rings constructed from explicit, recorded parameters) — is a canonical-geometry **authoring aid**.

It is not procedural city generation, requires no AI, consumes only accepted canonical inputs and explicit parameters, and produces ordinary draft canonical geometry (with its construction parameters recorded) that must be explicitly accepted like any other authored geometry (A-015). It does not bypass lifecycle, lock, or protection rules.

# 3. Technology Baseline

RUBY_WHEEL inherits CITY_NET's existing technology stack and should preserve it by default.

The inherited baseline includes the existing frontend, backend, realtime, persistence, deployment, build, test, and CI mechanisms present in the fork baseline. In broad terms this includes:

- React and TypeScript on the frontend;
- Three.js / React Three Fiber for the 3D map;
- Node.js and Express on the backend;
- Socket.IO for realtime synchronization;
- SQLite for persistence;
- Docker and nginx for deployment;
- the existing package manifests, lockfiles, automated tests, and CI workflows.

Repository package manifests and lockfiles are the authoritative definitions of exact dependency versions.

New frameworks, databases, rendering engines, geometry libraries, GIS systems, or other major dependencies must solve a demonstrated RUBY_WHEEL need. They must not be introduced merely because an implementation agent prefers them or because they are newer.

Major dependency additions, replacements, or technology-stack changes should be recorded as explicit architecture decisions.

No current requirement assumes that SQLite, Three.js, the existing Node backend, or another inherited technology must be replaced. Such a change requires evidence from implementation constraints or benchmarking.

# 4. High-Level Domain Model

RUBY_WHEEL should evolve into several related but separable domains.

```text
IMPERIAL CITY
│
├── World Geography
│   ├── reference layers
│   ├── land / islands
│   ├── water
│   ├── districts
│   ├── subregions
│   ├── roads
│   ├── bridges
│   └── protected geometry
│
├── World Generation
│   ├── generation profiles
│   ├── archetypes
│   ├── seeds
│   ├── generation runs
│   ├── generated urban fabric
│   └── provenance / protection
│
├── World Knowledge
│   ├── lore
│   ├── notes
│   ├── files
│   ├── canon status
│   └── visibility
│
├── Campaigns
│   ├── campaigns
│   ├── memberships
│   ├── sessions
│   └── provenance
│
├── World State
│   ├── events
│   ├── state variables
│   └── history
│
└── VTT / Rules
    ├── character sheets
    ├── dice
    ├── combat
    ├── battle maps
    └── UESRPG support
```

The first implementation program should primarily change **World Geography** and **World Generation**.

# 5. Upstream Systems to Preserve and Exploit

RUBY_WHEEL should deliberately reuse several existing CITY_NET architectural strengths.

These include:

- pure city-generation functions separated from persistence;
- polygon-bounded generation;
- multiple street-layout strategies;
- lot and perimeter-block generation;
- water-aware placement;
- shoreline-road behavior;
- bridge generation;
- seeded random generation;
- spatial hashing for placement;
- GPU instancing of simple buildings;
- distinction between simple and interactive structures;
- region-scoped regeneration;
- realtime update infrastructure;
- Docker deployment;
- multi-system character-sheet foundation.

The architecture should isolate Cyberpunk-specific assumptions from these reusable mechanisms rather than replacing the mechanisms themselves.

# 6. Reference Layer Architecture

The first RUBY_WHEEL-specific capability should be a persistent reference-layer subsystem.

A reference layer represents authored source material used to align or trace world geometry.

Conceptually, a reference layer requires:

```text
ReferenceLayer
    identity
    source asset
    source-to-world calibration
    opacity
    visibility
    lock state
```

Exact schema and UI are intentionally deferred.

The persisted calibration must define a deterministic mapping from source-image coordinates into canonical RUBY_WHEEL X/Z world space. Renderer-specific position, scale, rotation, pivot, plane dimensions, or texture orientation may be derived from that mapping, but transient renderer/UI state must not be the only source of truth.

Reference layers should:

- render in the world;
- survive reload/restart;
- be visually adjustable;
- be lockable against accidental movement;
- not participate in collision or procedural generation; reference content reaches world geometry only as normalized, explicitly accepted canonical geometry (A-015), never as raw pixels;
- remain conceptually separate from battle maps.

The initial system should support the user's existing Imperial City raster artwork.

# 7. Canonical Geography Architecture

Reference artwork is not itself canonical geometry.

Canonical world geometry must be represented separately.

Examples include:

- water polygons;
- district polygons;
- subregion polygons;
- roads;
- bridges;
- major landmarks;
- protected areas.

This separation permits:

- replacing or hiding the underlying reference image later;
- procedural systems to consume structured geometry;
- independent editing;
- more than one reference layer;
- gradual tracing/import rather than all-or-nothing conversion.

Geometry established from reference artwork is normalized and explicitly accepted (A-015) and classified by anchor strength (A-016). It is expressed in the canonical physical scale (A-014).

Canonical geography is persistent semantic geography. Physical land (islands) and administrative/planning regions (districts, optional island groups, subregions) are independent geometries (A-019). Semantic scopes may carry a parent/rank relationship for organization and query context, but that rank does not by itself define a generation stage (A-017).

Canonical geometry may be produced by manual tracing, by import, by explicit accepted proposals, or by deterministic parametric construction aids such as a radial/spoke constructor (A-020). All paths end in the same explicit acceptance.

# 8. District and Subregion Architecture

The current lightweight district concept must evolve without making the district table itself a universal object store.

A district should conceptually have:

```text
District
    identity
    persistent geography
    lore/description
    default generation profile
```

Subregions may overlay or partition district geography and provide more specific generation behavior.

Example:

```text
MARKET DISTRICT
    default profile: dense mixed mercantile

    SUBREGION:
        Grain Quays
        profile override: freight + granary + warehouse

    SUBREGION:
        Counting House Quarter
        profile override: wealthy commercial

    SUBREGION:
        Temple Precinct
        profile override: institutional / protected
```

The implementation must support useful local variation without requiring proliferation of top-level districts.

## District geography versus island geography

A district's persistent geography is a drawn spatial region, not a list of islands (A-019). Its authoritative spatial extent is its accepted drawn boundary; without one it has none. Island membership in a district is optional metadata and never defines district extent, including when current query code falls back to member polygons for a boundaryless scope (A-019). Where a district boundary cuts an island, planning and generation work with the part of the island inside the district, derived when needed rather than stored as manually split canonical land.

## Optional island groups

Where the world has a genuine named grouping (for example, an island chain), it may be persisted as an `island_group` semantic scope. Island groups are optional context for naming, lore, query, and planning references. They are not a required planning or generation layer, and districts need not be partitioned into island groups.

## District program and fulfillment state

A district program is persistent strategic planning attached to a district scope by reference. It expresses the district's required roles, facilities, obligations, budgets, and weights.

Generation worksets (A-018) read district planning downward and read district state sideways: what previously generated and accepted work in the district already provides, and which program requirements remain unfulfilled. This read-side fulfillment state is a conceptual architectural requirement. Whether it is stored, derived on demand from accepted output, or both, is undecided (§31).

## Spatially varying district intensity

District planning must not assume one flat district-wide density/intensity scalar. It must permit spatially varying intensity, such as:

- multiple density/intensity nodes, each with a falloff;
- a citywide center pull coexisting with district-specific centers (for example, an administrative compound);
- later, barriers and connectivity (water, walls, crossings) affecting how intensity propagates.

The representation, falloff functions, and combination rules are undecided and belong to the district-planning slice.

# 9. Generator Refactor Boundary

The current CITY_NET geometry pipeline should remain largely intact initially.

The primary refactor boundary is the semantic step that currently maps spatial position into Cyberpunk zone categories and then into building-generation behavior.

The target conceptual pipeline is:

```text
Canonical Geography
        +
Generation Workset (selected land / derived district-island pieces)
        +
District Profile / Program (incl. spatial intensity)
        +
District Fulfillment State (already provided / still required)
        +
Subregion Overrides
        +
Existing Obstacles
        +
Seed
        ↓
Urban Morphology
        ↓
Street / Block / Lot Layout
        ↓
Archetype Selection
        ↓
Generated Urban Fabric
```

Core layout algorithms should not need to know what "Market District" or "Nobles District" means.

This pipeline corresponds to the lower, geometry-producing levels of the A-017 hierarchy; higher levels supply its roles, constraints, and budgets.

It runs once per generation workset (A-018), not once per island group. The workset's land may be whole islands or derived district/island pieces (A-019). The workset's inputs — canonical digest, district program and fulfillment state read, profile versions, and seed — are what make its output reproducible (A-006).

# 10. Generation Profile Architecture

A generation profile should describe urban behavior rather than a specific hard-coded district name.

Potential dimensions include:

```text
density / intensity (may be spatially varying; see §8)
height distribution
street regularity
block scale
lot frontage
lot depth
setback
courtyard tendency
open-space tendency
wealth / construction quality

land-use weights
    residential
    retail
    workshop
    warehouse
    religious
    civic
    agricultural
    military
    hospitality

waterfront behavior
agricultural behavior
architecture palette
special infrastructure weights
```

The initial implementation may support only a subset.

The interface must remain extensible. In particular, density/intensity must be able to become a spatial field (multiple nodes with falloff) rather than only a single profile-wide scalar, without redesigning the geometry pipeline.

# 11. Building Archetype Architecture

Building generation should evolve toward a registry or equivalent profile-driven system.

An archetype describes a reusable building family, not one canonical named POI.

Examples:

```text
merchant_counting_house
canal_tenement
courtyard_residence
bonded_warehouse
urban_granary
artisan_workshop
covered_market
temple_hospice
```

An archetype may specify or influence:

- allowed lot shapes/sizes;
- width/depth ranges;
- floors;
- footprint coverage;
- frontage relationship;
- courtyard behavior;
- waterfront eligibility;
- roof/building components;
- socioeconomic range;
- compatible land uses;
- architecture palette.

The architecture must permit additional archetypes without modifying unrelated district logic.

# 12. Urban Fabric Versus Semantic POIs

RUBY_WHEEL must model two distinct concepts.

## Urban Fabric

Ordinary built environment used to make the megacity physically complete.

Examples:

- anonymous residences;
- generic workshops;
- ordinary warehouses;
- background sheds;
- repetitive block frontage.

## Semantic POI

A location the game knows about as an individual thing.

Examples:

- named inn;
- noble estate;
- temple;
- guild office;
- strategic granary;
- house headquarters.

The architecture must permit urban fabric to use a lightweight representation.

An ordinary generated building should be promotable into a POI later.

Promotion must preserve spatial identity.

# 13. Urban Fabric Persistence Is Intentionally Undecided

The existing CITY_NET model persists generated structures as location rows.

RUBY_WHEEL must not assume this approach scales to the complete Imperial City.

Before committing to the final model, the project must benchmark realistic generation loads.

Candidate approaches include:

### Full Materialization

Every procedural structure is persisted independently.

### Deterministic Fabric Chunks

A region stores:

```text
geometry/profile reference
seed
generator version
exceptions
```

and ordinary fabric is reconstructed.

### Hybrid

Important or edited structures are materialized while disposable background fabric remains chunk-based.

No option is selected by this architecture contract.

Benchmark evidence will determine the choice.

# 14. Generation Run and Provenance Architecture

Procedural output should be attributable to a generation run.

Conceptually, a generation run may eventually record:

```text
region
seed
profile
profile version
generator version
timestamp
result status
```

Generated objects should be traceable back to that run where useful.

This supports:

- reproducibility;
- troubleshooting;
- selective regeneration;
- auditability;
- future profile migration.

# 15. Generated Content Lifecycle

The architecture should support a lifecycle equivalent to:

```text
GENERATED / DRAFT
        ↓
ACCEPTED / CANONICAL
        ↓
PROTECTED / LOCKED
```

Exact terminology is not yet fixed.

The important invariants are:

- generated draft content may be disposable;
- accepted content becomes canonical and is non-replaceable by default;
- accepted content may additionally be protected/locked against accidental manual destructive editing;
- only an explicit user action may make accepted canonical content replaceable again.

Manual modification may automatically or explicitly change protection state depending on final UX design.

# 16. Water and Canal Architecture

Existing water polygons should remain useful as physical constraints.

Canonical major water geometry should normally come from authored/imported data.

Procedural water generation remains useful for appropriate secondary features.

RUBY_WHEEL should eventually add concepts appropriate to the Imperial City, including:

- canals;
- quays;
- embankments;
- docks;
- freight landings;
- passenger landings;
- ship basins.

Waterfront infrastructure must be capable of responding to:

- water geometry;
- adjacent land use;
- district profile;
- transport function.

# 17. Food-System Architecture

Food security begins as a spatial infrastructure model, not as an economy simulator.

The city should eventually expose identifiable categories of capacity.

Conceptually:

```text
Food Support
│
├── Production
│   ├── market gardens
│   ├── orchards
│   ├── livestock
│   └── fisheries
│
├── Import
│   ├── grain docks
│   ├── cargo quays
│   ├── road gates
│   └── canal/river interfaces
│
├── Storage
│   ├── granaries
│   └── warehouses
│
├── Processing
│   ├── mills
│   ├── bakeries
│   ├── slaughter yards
│   └── preservation facilities
│
└── Distribution
    ├── wholesale markets
    └── neighborhood markets
```

The generator should be capable of placing appropriate food infrastructure through district/subregion profiles.

Future world-state simulation may consume coarse capacities derived from these physical systems.

The architecture must not require exact per-person calorie accounting.

# 18. Food Security and World State

The architecture should permit a future citywide model conceptually similar to:

```text
available food support
=
local production
+ effective imports
+ accessible reserves
- disruption
```

This is a future simulation interface, not an initial implementation formula.

The important architectural rule is:

> A food-security crisis should be able to point to physical causes in the city.

Examples:

- grain quay destroyed;
- river traffic blocked;
- warehouse district burned;
- harvest reduced;
- granaries seized;
- distribution canals closed.

# 19. Megacity Performance Architecture

The full Imperial City is outside ordinary VTT-map scale.

The project must therefore test scale deliberately.

Representative benchmarks must eventually include:

- a dense generated neighborhood;
- a district-scale generation;
- a synthetic multi-district/city-scale dataset.

Measure:

- generator runtime;
- DB write time;
- DB size;
- API response size;
- initial map load;
- browser memory;
- rendering frame time;
- selection/interactivity;
- realtime update behavior.

No persistence model should be considered final until this evidence exists.

# 20. Rendering Architecture

Existing Three.js instancing should be preserved and extended where useful.

Background urban fabric should preferentially use techniques appropriate to large repeated geometry.

Rich interactive entities may use more expensive individual representations.

The renderer should not force semantic POI cost onto every ordinary structure.

# 21. Database Architecture

SQLite remains acceptable unless measured requirements demonstrate otherwise.

New RUBY_WHEEL concepts should not be appended indiscriminately to the existing `locations` table.

Distinct concepts deserve distinct persistence models, particularly:

- reference layers;
- geographic regions;
- generation profiles;
- generation runs;
- provenance/protection;
- campaigns;
- world events;
- knowledge/visibility.

Schema changes should move toward explicit, ordered migrations rather than an indefinitely growing collection of ad hoc startup alterations.

# 22. Snapshot and Backup Architecture

RUBY_WHEEL distinguishes logical snapshots from independent backups.

A **snapshot** is versioned logical world state used for rollback, restore, or historical capture.

RUBY_WHEEL snapshots must eventually:

- carry a format/schema version;
- preserve all relevant fields;
- restore generated/authored provenance and replacement/protection state correctly;
- round-trip world data without silent loss.

A **backup** is an independently recoverable copy of canonical persistent data and required external runtime assets.

An in-database or same-volume snapshot does not by itself constitute a backup against storage loss or corruption.

Existing CITY_NET saved maps should be treated as legacy snapshot behavior, not authoritative canonical backup, until their known round-trip limitations are repaired.

Campaigns must never be implemented by loading different snapshots into the same world.

# 23. Frontend Architecture

RUBY_WHEEL should not begin with a wholesale rewrite of the existing frontend.

However, new major capabilities should be implemented in dedicated components/hooks/modules rather than expanding `App.tsx` and `AdminPanel.tsx` indefinitely.

Likely isolated capabilities include:

- reference-layer management;
- district profile editing;
- generation controls;
- world knowledge;
- campaign administration.

Refactoring should be incremental and driven by concrete feature seams.

# 24. Authorization Architecture

RUBY_WHEEL has two distinct authorization concerns:

1. canonical-world authoring;
2. future restricted campaign/knowledge data.

Canonical-world mutations require explicit server-side world-editor authorization as defined by A-013. Existing generic `authenticate` behavior is not, by itself, an adequate authorization boundary for privileged world-authoring routes.

Future campaign secrets and restricted files also require server-side authorization.

A frontend-hidden button is not an authorization boundary.

The architecture must eventually distinguish:

- authentication;
- world-editor authority;
- global role;
- campaign membership;
- resource visibility.

Existing authentication behavior may be reused, but routes handling privileged RUBY_WHEEL data must enforce authorization explicitly on the server.

# 25. Campaign Architecture

Campaigns are metadata/provenance within one world.

Conceptually:

```text
Campaign
    identity
    members
    sessions

Session
    campaign
    date/time metadata

World Event
    source campaign
    source session
    public representation
    private truth
    state effects
```

Campaigns do not own geometry.

# 26. Knowledge Architecture

Future lore/notes/files must separate three concerns.

## Truth / Canon Status

Examples:

- established canon;
- strong working model;
- open design question;
- GM-only secret;
- legacy/shelved.

## Provenance

Where the information originated or was encountered.

## Visibility

Who may access it.

These must not be collapsed into one field.

A fact may be established canon and still GM-only.

A rumor may be publicly known while not representing objective world truth.

# 27. Asset and Repository Architecture

RUBY_WHEEL's public source repository must remain separate from private runtime content where practical.

Private or bulky content should not have to be committed to Git.

Examples include:

- campaign database;
- secrets;
- player information;
- map artwork;
- private notes;
- uploaded documents.

Persistent runtime storage must remain deployable through the existing containerized architecture or a compatible successor.

# 28. Upstream Relationship

RUBY_WHEEL is a fork rather than a disconnected rewrite.

Architecture decisions should preserve the ability to understand upstream changes.

Where practical:

- avoid unnecessary rewrites of unchanged upstream subsystems;
- isolate RUBY_WHEEL-specific features;
- document intentional divergence;
- preserve upstream license obligations.

No requirement exists to remain automatically merge-compatible with every future CITY_NET release.

RUBY_WHEEL's own architectural integrity takes precedence once deliberate divergence is necessary.

**Inherited CITY_NET code is not evidence of current RUBY_WHEEL product requirements. `docs/REQUIREMENTS.md` and this architecture contract are authoritative for project intent.**

# 29. Testing Architecture

New city-building systems require automated tests at the lowest practical level.

Priority areas include:

- deterministic generation;
- protected-content preservation;
- polygon/regional behavior;
- profile interpretation;
- archetype selection;
- reference-layer persistence;
- snapshot round-trip;
- authorization boundaries;
- scale regressions where automatable.

Existing upstream tests should continue to pass unless an intentional behavior change is documented.

# 30. Initial Architecture Boundary

The first RUBY_WHEEL implementation should **not modify the semantic city generator yet**.

The first capability is:

> persistent calibrated reference layers.

This isolates the first fork-specific feature from the generator and establishes the coordinate framework required for all later city-building work.

Only after authored source material can coexist reliably with CITY_NET world coordinates should the project move into persistent geography and Imperial generation profiles.

That first capability is complete. The next implementation-facing capability is expected to concern normalized canonical macro geography and hard-anchor establishment/import. It must not become full-raster vectorization, computer-vision reconstruction of every street or building, direct procedural generation from raw pixels, or whole-city generation in one step.

# 31. Known Open Decisions

The following are intentionally unresolved and must not be treated as settled architecture:

1. Exact persistence strategy for large-scale ordinary urban fabric.
2. Exact population of the Imperial City.
3. Exact food-capacity metric.
4. Exact representation of minor canal networks.
5. Whether district/subregion polygons use existing map primitives or a new geographic-region abstraction.
6. Exact generated-content lifecycle terminology.
7. Whether manual editing automatically locks generated content.
8. Best import method for geometry beyond raster reference layers.
9. Exact mechanism for promoting urban fabric into semantic POIs.
10. Exact synchronization rules for campaigns operating at different in-world dates.
11. Persistence form of district requirement/fulfillment state read by generation worksets (stored, derived, or hybrid) (A-018).
12. Representation and combination rules for spatially varying district density/intensity nodes and falloff (§8).
13. The polygon clipping capability needed to derive district/island intersection pieces (A-019).

These decisions should be resolved through bounded design work, prototypes, or measurement rather than assumption.
