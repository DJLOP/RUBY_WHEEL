# RUBY_WHEEL Requirements

**Status:** Baseline  
**Project:** RUBY_WHEEL  
**Upstream:** `over2take/CITY_NET`  
**Fork baseline:** `4fb2ecfb0b90c056d8f1f386aeb28e213f087405`

## 1. Purpose

RUBY_WHEEL is a fork of CITY_NET whose primary purpose is to complete, maintain, and use a persistent reinterpretation of the Imperial City as a very large, geographically complex fantasy megacity.

The project's principal objective is:

> **Procedurally complete the existing partially authored Imperial City while preserving canonical user-authored geography, structures, waterways, and other protected work.**

RUBY_WHEEL is a city-building and persistent-world system first.

Its inherited VTT capabilities remain valuable and must continue to function, but new tabletop mechanics are subordinate to the immediate goal of finishing the Imperial City.

The Imperial City represented by RUBY_WHEEL is the campaign's own established interpretation. The application must not silently normalize its geography, architecture, culture, scale, or infrastructure toward vanilla Elder Scrolls depictions.

## 2. Priority Order

Development priorities are ordered as follows.

### Priority 1 — Complete the Imperial City

The system must make it practical to turn existing authored material into a complete megacity by combining protected canonical geography with procedural urban generation.

This includes:

- land and islands;
- waterways and canals;
- streets and lanes;
- bridges;
- blocks and lots;
- ordinary residential fabric;
- commercial buildings;
- workshops and industry;
- civic and religious structures;
- plazas and open space;
- docks, quays, piers, and waterfront infrastructure;
- warehouses and freight areas;
- urban agriculture;
- food import, storage, processing, and distribution infrastructure;
- named landmarks and other meaningful points of interest.

### Priority 2 — Make the finished city usable as a persistent world

The city must support meaningful locations, lore, NPCs, state changes, editing, history, and other persistent world information.

### Priority 3 — Support multiple campaigns in one shared city

Campaigns must operate within one canonical Imperial City rather than independent copies of it.

### Priority 4 — Adapt and extend VTT mechanics for UESRPG

Existing tabletop capabilities should be preserved and later adapted where useful for UESRPG.

UESRPG expansion must not delay city-completion work unless a particular VTT capability is required to validate the world model.

# 3. Canonical City Requirements

## R-001 — One Canonical Imperial City

RUBY_WHEEL must represent one canonical Imperial City.

The city is not regenerated from scratch for each campaign and is not duplicated into campaign-specific maps.

Changes accepted into the canonical city become part of the common world.

## R-002 — Existing Authored Work Is Authoritative

Existing user-authored city work must be treated as authoritative unless the user explicitly marks it as replaceable.

Procedural systems must never silently overwrite, remove, move, or substantially alter authored, imported, accepted, protected, or otherwise canonical work unless that content has been explicitly designated replaceable.

Provenance describes where content came from; it does not by itself make content eligible for replacement. Existing pre-RUBY_WHEEL content whose provenance or replacement state is uncertain must default conservatively to non-replaceable until the user explicitly changes that state.

This applies to, at minimum:

- island shapes;
- major waterways;
- district boundaries;
- major roads;
- bridges;
- landmarks;
- buildings;
- protected development;
- manually edited generated content.

## R-003 — Existing City Artwork Must Be Importable as a Reference

The system must support importing the current Imperial City artwork as a persistent reference layer.

At minimum, an imported reference layer must support:

- image upload or selection;
- world-space position;
- scale;
- rotation;
- opacity;
- visibility toggle;
- lock state;
- persistence across restart/reload.

The reference layer must be usable as a tracing and alignment aid without becoming procedural geometry itself.

Initial support should include common raster formats such as PNG and JPEG.

## R-004 — Reference Material Must Be Calibratable

The user must be able to align imported city artwork with RUBY_WHEEL world coordinates.

Calibration must be repeatable and persistent.

A persisted reference layer must define a deterministic mapping from source-image coordinates into canonical RUBY_WHEEL X/Z world space. The stored calibration must not depend solely on transient renderer or UI state.

The eventual workflow must allow existing artwork and generated geometry to remain spatially aligned.

# 4. Persistent Geography Requirements

## R-010 — Geography Must Be First-Class Persistent Data

The following may not exist solely as temporary drawing-tool state:

- districts;
- subregions or neighborhoods;
- canonical waterways;
- protected regions;
- major transportation corridors;
- other generation-control regions.

Their geometry must persist.

## R-011 — Districts Must Have Geography

A district must be able to own one or more persistent geographic polygons.

A district is more than a name and color.

Its geography must be usable for:

- display;
- generation;
- filtering;
- editing;
- lore association;
- generation-profile assignment.

## R-012 — Subregions Must Override District Defaults

A district must be capable of containing smaller planning or generation regions.

Examples include:

- warehouse waterfront;
- old Nibenese quarter;
- noble enclave;
- temple precinct;
- market garden;
- military compound;
- no-build region.

Subregions must be able to override appropriate district generation settings without requiring a new district.

# 5. Procedural Urban Completion Requirements

## R-020 — Generation Must Operate Locally

The user must be able to procedurally generate or regenerate a selected portion of the city rather than the entire city.

Selectable generation areas must support irregular polygonal regions.

Useful generation scales should include:

- individual block;
- shoreline;
- island;
- neighborhood;
- district subsection;
- district.

## R-021 — Generation Must Build Around Existing Work

Existing protected structures and geography must act as constraints and obstacles for procedural generation.

Generated development must adapt around them rather than overwrite them.

## R-022 — Generation Must Be Reproducible

Procedural generation must support deterministic seeds.

Given equivalent:

- canonical inputs;
- generation profile;
- generator version;
- seed;

the system should reproduce equivalent procedural output.

## R-023 — Generation Must Be Iterative

The user must be able to:

- generate;
- inspect;
- reject;
- regenerate;
- manually edit;
- accept;
- protect;

procedural output.

City completion is expected to be iterative rather than one-click generation of the entire megacity.

## R-024 — Accepted Procedural Work Must Become Canonical

Procedural output must have a lifecycle that distinguishes temporary/generated work from accepted canonical work.

Accepted output becomes canonical and must no longer be eligible for automatic procedural replacement unless the user explicitly marks it replaceable again.

Accepted output must also be capable of becoming protected or locked against accidental manual movement, deletion, or other destructive editing.

# 6. District and Urban Profile Requirements

## R-030 — Generator Semantics Must Be Data-Driven

RUBY_WHEEL must not replace CITY_NET's Cyberpunk hard-coding with equivalent Imperial City hard-coding.

District and neighborhood behavior must be expressed through data-driven generation profiles and reusable generation rules.

## R-031 — Profiles Must Describe Urban Form

Generation profiles should be capable of describing, at minimum:

- development density;
- typical building height;
- street regularity;
- block size;
- lot size;
- frontage width;
- setback;
- courtyard frequency;
- open-space frequency;
- wealth or construction quality;
- land-use mixture;
- waterfront behavior;
- agricultural behavior;
- architecture/archetype palette.

Not every field must exist in the first implementation, but the architecture must permit these concepts without redesigning the generator.

## R-032 — Profiles Must Support Mixed-Use Districts

A district specialization must not imply monoculture.

For example, Market District may have strong commercial and warehousing functions while still containing:

- housing;
- workshops;
- temples;
- inns;
- civic functions;
- service structures.

Profiles must therefore support weighted mixtures rather than one building type per district.

# 7. Building Archetype Requirements

## R-040 — Building Forms Must Be Extensible

Buildings must be generated from reusable archetypes or equivalent configurable rules.

Examples may eventually include:

- canal tenement;
- courtyard residence;
- merchant townhouse;
- counting house;
- bonded warehouse;
- granary;
- temple hospice;
- bathhouse;
- artisan workshop;
- urban villa;
- covered market;
- dockside inn.

The set must be extensible without rewriting the core city-generation pipeline.

## R-041 — Archetypes Must Be Context-Sensitive

An archetype may be restricted or weighted based on conditions such as:

- district;
- subregion;
- wealth;
- waterfront access;
- road frontage;
- lot dimensions;
- land-use profile;
- architectural palette.

# 8. Waterfront, Canal, and Port Requirements

## R-050 — Canonical Water Must Shape Development

Canonical water geometry must influence:

- street generation;
- building placement;
- block formation;
- bridges;
- shoreline treatment.

Procedural systems must respect manually authored water.

## R-051 — The City Must Support Canal Infrastructure

RUBY_WHEEL must eventually support urban canals beyond generic river/lake generation.

Canal-related urban form may include:

- minor canals;
- service canals;
- bridge crossings;
- quays;
- embankments;
- waterside lanes;
- cargo access.

Major canonical waterways should normally be imported or authored rather than procedurally reinvented.

## R-052 — Waterfront Infrastructure Must Be Distinguishable

The system must eventually be able to represent differing waterfront functions such as:

- freight quay;
- grain landing;
- passenger landing;
- fishing dock;
- military quay;
- private landing;
- ship basin;
- warehouse wharf.

These must not all reduce to generic decorative shoreline.

# 9. Urban Agriculture and Food Security Requirements

## R-060 — Food Support Must Be Part of Urban Form

The city must contain spatially represented infrastructure required to feed a megacity.

Food systems are not decorative lore only.

## R-061 — Local Food Production Must Be Representable

Appropriate city regions must support forms of food production such as:

- market gardens;
- intensive horticulture;
- orchards;
- vineyards where appropriate;
- temple or institutional gardens;
- livestock holding;
- fisheries;
- other setting-appropriate production.

Agricultural regions must generate differently from parks.

They may require:

- cultivation plots;
- irrigation access;
- farm lanes;
- sheds;
- walls;
- ponds;
- storage;
- animal enclosures.

## R-062 — External Food Import Must Be Spatially Represented

A city of this scale must depend materially on external food import.

Import infrastructure may include:

- grain quays;
- cargo docks;
- gates;
- canals;
- freight roads;
- river traffic interfaces.

Import dependency must be associated with identifiable physical infrastructure.

## R-063 — Food Storage and Processing Must Be Representable

The city must support food-related infrastructure including appropriate combinations of:

- granaries;
- warehouses;
- mills;
- bakeries;
- wholesale markets;
- livestock yards;
- slaughter facilities;
- smokehouses;
- salting facilities;
- distribution markets.

## R-064 — Famine Risk Must Be Grounded in the City

Future world-state systems must be able to relate food-security pressure to identifiable physical systems.

At minimum, the design must permit future representation of:

- local production capacity;
- import capacity;
- stored reserves;
- transport disruption;
- infrastructure loss.

Initial city-building work does **not** require a detailed calorie simulation.

The requirement is that famine risk have understandable geographic and logistical causes rather than exist only as an arbitrary GM status flag.

# 10. Urban Fabric and Points of Interest

## R-070 — Visual Urban Fabric and Semantic Locations Are Different

The system must distinguish between:

**urban fabric** — ordinary structures required to make the city physically believable;

and

**semantic locations / POIs** — places with gameplay-relevant identity or data.

Not every visual building must become a heavyweight gameplay record.

## R-071 — Ordinary Fabric Must Be Promotable

A generated ordinary building should be capable of later becoming a meaningful location without requiring the surrounding city to be regenerated.

Promotion may eventually attach:

- permanent identity;
- name;
- description;
- NPCs;
- lore;
- campaign history;
- ownership;
- files;
- other game data.

# 11. Megacity Scale Requirements

## R-080 — Megacity Scale Is a Core Requirement

RUBY_WHEEL must be designed for the actual Imperial City rather than a small demonstration neighborhood.

The target world is approximately city-scale over many kilometers and may visually contain tens of thousands or more structures.

## R-081 — Scale Must Be Measured Before Foundational Persistence Decisions

Before the project commits to storing every procedural building as an independent persistent gameplay object, representative scale testing must measure:

- database size;
- generation time;
- persistence time;
- API payload size;
- initial load time;
- browser memory;
- rendering performance;
- interaction performance;
- Socket.IO update behavior.

The final persistence strategy for ordinary urban fabric must be evidence-based.

## R-082 — Generated Fabric May Use a More Compact Representation

The architecture must permit ordinary generated fabric to use a more scalable representation than full semantic locations if benchmarking demonstrates the need.

Potential implementations may include deterministic chunks, instanced geometry, or equivalent techniques.

The exact persistence strategy is intentionally not decided by this requirements document.

# 12. Editing and Safety Requirements

## R-090 — Provenance Must Be Explicit

The system must explicitly distinguish content originating from categories such as:

- imported;
- manually authored;
- procedurally generated.

Authorship/provenance must not be inferred from object names.

## R-091 — Replacement and Protection State Must Be Explicit

World content that participates in procedural editing must have an explicit replacement state rather than deriving destructibility from provenance, naming, or absence of a lock.

Automatic procedural replacement is permitted only for content explicitly designated replaceable or disposable.

Imported, manually authored, accepted canonical, protected, and uncertain legacy content must default to non-replaceable unless the user explicitly changes that state.

Protection or lock state is a separate, stronger safeguard intended to prevent accidental manual movement, deletion, or other destructive editing. Non-replaceable content need not be locked, and unlocked content is not therefore automatically replaceable.

## R-092 — Destructive Operations Must Be Recoverable

Operations that remove or replace generated urban content should support recovery or undo where practical.

## R-093 — Canonical World Mutations Must Be Authorized

Mutations to canonical-world data must require explicit server-side world-editor authorization.

Authentication alone is not sufficient authorization for canonical reference-layer transforms, geography editing, generation or regeneration, replacement/protection changes, destructive snapshot restore/clear operations, or equivalent world-authoring actions.

The initial implementation may treat the primary administrator as the sole world editor; a richer role model is not required for the first city-building slice.

# 13. Snapshot and Backup Requirements

## R-100 — Canonical World Snapshots Must Round-Trip Correctly

A snapshot is versioned logical world state intended for rollback, restore, or historical capture.

Snapshot mechanisms must preserve all required world-state fields.

Snapshot formats must be versionable so schema evolution does not silently discard newer data.

Existing CITY_NET saved-map behavior may be reused only after its round-trip fidelity is brought in line with RUBY_WHEEL requirements.

## R-101 — Backups Must Be Independently Recoverable

A backup is an independently recoverable copy of canonical persistent data and any required external runtime assets.

A snapshot stored in the same database or storage volume as the live world does not by itself satisfy the backup requirement.

The initial reference-layer capability does not need to implement a complete backup system, but its persistence design must not assume that an in-database snapshot protects the database or referenced assets from storage loss.

# 14. Existing VTT Capability Requirements

## R-110 — Useful CITY_NET Capability Should Be Preserved

Existing capabilities should be retained unless there is a documented reason to replace them.

This includes useful foundations such as:

- interactive 3D map navigation;
- map editing;
- procedural layouts;
- water-aware generation;
- bridges;
- battle maps;
- authentication;
- character sheets;
- dice;
- realtime synchronization;
- Docker deployment.

City-building changes should avoid gratuitously rewriting these systems.

# 15. Shared-Campaign Requirements

These requirements are important but secondary to city completion.

## R-120 — Campaigns Share the Canonical City

Multiple campaigns must eventually operate against the same canonical Imperial City.

Campaigns must not be implemented as separate saved-map copies.

## R-121 — Campaign Is Provenance, Not Ownership of Reality

A campaign may be the source of:

- a world event;
- a note;
- a discovery;
- a rumor;
- a state change.

That does not make the resulting world information exclusive to that campaign.

Visibility is a separate concern.

# 16. UESRPG Requirements

UESRPG work is intentionally subordinate to city-building work.

## R-130 — UESRPG Must Fit the Existing Multi-System Framework

Where practical, UESRPG should be added as another supported game system rather than replacing the existing multi-system architecture.

## R-131 — UESRPG May Be Implemented Incrementally

UESRPG capabilities may be developed separately, including:

- sheet representation;
- dice/rolls;
- derived statistics;
- equipment;
- combat;
- magic;
- advancement.

No requirement states that all UESRPG systems must be completed before the city-building system is useful.

# 17. Data and Asset Separation

## R-140 — Private Campaign Data Must Not Need to Live in the Public Source Repository

RUBY_WHEEL source code must be usable without committing private campaign content, databases, secrets, or large authored map assets into the public Git repository.

The architecture should support external/persistent campaign data and assets.

## R-141 — Upstream License Obligations Must Be Preserved

RUBY_WHEEL is derived from AGPL-licensed CITY_NET source.

Required license and attribution obligations must be preserved.

# 18. Initial City-Building Non-Goals

The initial city-completion program is **not** required to:

- fully simulate the Imperial City economy;
- simulate individual households;
- calculate detailed calorie consumption;
- implement all UESRPG mechanics;
- complete the cross-campaign knowledge system;
- rebuild CITY_NET's frontend from scratch;
- generate every meaningful landmark procedurally;
- convert every generated building into a full gameplay entity;
- automatically infer perfect city geometry from a raster image;
- generate the entire Imperial City in one operation;
- replace canonical geography the user has already authored.

# 19. Initial User Workflow Target

The target city-building workflow is:

1. Import existing Imperial City artwork.
2. Calibrate it to world space.
3. Lock it as a reference layer.
4. Trace or import canonical geography.
5. Define persistent districts and subregions.
6. Mark protected authored work.
7. Assign generation profiles.
8. Select an unfinished area.
9. Procedurally generate urban fabric.
10. Inspect and edit.
11. Regenerate selected portions if needed.
12. Accept satisfactory output.
13. Protect accepted work.
14. Repeat until the city is complete.

# 20. First Capability Target

The first implementation capability after the documentation baseline should establish the prerequisite for all later city completion:

> **RUBY_WHEEL can import, display, calibrate, persist, toggle, and lock the user's existing Imperial City artwork as a world-space reference layer without changing existing CITY_NET procedural-generation behavior.**

Procedural Imperial City generation begins only after canonical authored material can be reliably placed in the application's world space.
