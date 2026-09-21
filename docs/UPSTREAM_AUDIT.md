# RUBY_WHEEL Upstream Audit

**Status:** Baseline audit record  
**Upstream:** `over2take/CITY_NET`  
**Audited baseline:** `4fb2ecfb0b90c056d8f1f386aeb28e213f087405`  
**Purpose:** Preserve the technical findings that justified forking CITY_NET so later agents do not repeatedly rediscover the same repository facts.

This document records findings about the inherited baseline. It is not a product-requirements document. Where product direction is concerned, `docs/REQUIREMENTS.md` and `docs/ARCHITECTURE.md` are authoritative.

## 1. Executive Conclusion

CITY_NET is a viable foundation for RUBY_WHEEL and should be forked rather than rewritten.

The most reusable inherited capability is the procedural city-generation and 3D map stack.

The principal missing work for RUBY_WHEEL is not basic geometry generation. It is:

- importing and protecting canonical authored Imperial City material;
- replacing Cyberpunk-specific semantic assumptions with data-driven profiles/archetypes;
- representing persistent geography;
- adding explicit provenance/protection;
- supporting Imperial waterfront, canal, agricultural, and food-logistics morphology;
- proving the persistence/rendering model at megacity scale;
- later adding persistent shared-world/campaign knowledge and state.

## 2. Generator Architecture Is Worth Preserving

The city generator is substantially isolated from React and persistence.

The generation flow already supports the useful pattern:

- accept generation inputs;
- generate blocks/roads/buildings/water/overpasses;
- return output;
- let callers persist it.

This is a strong seam for RUBY_WHEEL.

Known reusable layout strategies include:

- BSP;
- GRID;
- SUPERBLOCK;
- RING;
- VORONOI;
- PERIMETER.

The perimeter/lot-generation machinery is especially relevant to dense old-city morphology.

### Implication

Do not replace the generator wholesale.

RUBY_WHEEL should preserve geometry algorithms where practical and refactor the semantic inputs that currently encode Cyberpunk zoning assumptions.

## 3. Bounded Region Generation Already Exists

CITY_NET can generate within rectangular or hand-drawn polygon boundaries.

The inherited region-purge workflow already contains important preservation behavior:

- bounded deletion;
- preservation of authored/named structures under current heuristics;
- exclusion of tokens/battle-map content;
- generated-water distinction;
- removal of children belonging to deleted generated roots;
- action-history capture for undo/recovery.

### Weakness

Authored/generated status is partly inferred from naming/category conventions.

That is too fragile for RUBY_WHEEL.

### RUBY_WHEEL direction

Use explicit provenance and protection metadata, consistent with `docs/ARCHITECTURE.md`.

## 4. No First-Class Canonical Reference-Layer System

The audited baseline contains upload systems for specialized assets such as battle maps, portraits, fonts, and music, but not a dedicated calibrated world-map reference layer suitable for the user’s existing Imperial City artwork.

### RUBY_WHEEL direction

The first project-specific capability should introduce persistent world-space reference layers with:

- source image;
- position;
- scale;
- rotation;
- opacity;
- visibility;
- lock state.

Reference layers should remain conceptually distinct from battle maps and from canonical procedural geometry.

## 5. Water Support Is Useful but Incomplete for the Imperial City

Inherited procedural water categories are oriented around generic forms such as:

- none;
- river;
- coast;
- lake.

Water polygons already participate in useful behavior including:

- building avoidance;
- road clipping;
- shoreline relationships;
- bridge placement.

Shoreline-road logic is also reusable.

### Missing for RUBY_WHEEL

The audited baseline does not provide a first-class Imperial-style system for:

- canal networks;
- quays;
- embankments;
- differentiated docks;
- freight landings;
- grain landings;
- ferry/passenger landings;
- ship basins.

### RUBY_WHEEL direction

Major canonical waterways should generally be authored/imported and protected.

Procedural systems may later add minor canals and waterfront infrastructure according to district/subregion profiles.

## 6. Cyberpunk Coupling Is Concentrated in Semantics

The underlying geometry is more reusable than the current zoning vocabulary suggests.

The inherited zoning/building-selection flow encodes socioeconomic Cyberpunk categories such as:

- CORPO;
- URBAN;
- SLUMS;
- INDUSTRIAL;
- MARKETS;
- LANDMARK.

The generator also contains assumptions about radial socioeconomic patterns and height/density tendencies.

### RUBY_WHEEL direction

Do not merely rename CORPO to NOBLES or SLUMS to another Elder Scrolls label.

Introduce data-driven district/neighborhood profiles and reusable building archetypes while preserving the current Cyberpunk behavior as inherited compatibility behavior until intentionally retired.

## 7. Current District Model Is Too Thin

The inherited district concept is primarily identity/display metadata such as name and color.

Structures may carry district-related fields, but districts are not yet robust persistent planning polygons with morphology.

### RUBY_WHEEL direction

Districts must become first-class geographic/planning entities capable of carrying or referencing:

- persistent geometry;
- lore/description;
- generation profile;
- subregion overrides.

A district specialization must not imply monoculture.

## 8. Building Archetypes Should Become a Reusable Layer

Imperial City building generation should not be implemented as district-specific conditional chains.

A reusable archetype layer is appropriate for forms such as:

- canal tenement;
- merchant counting house;
- bonded warehouse;
- courtyard residence;
- granary;
- temple hospice;
- artisan workshop;
- bathhouse;
- urban villa;
- covered market.

Archetypes should be selected from context such as lot geometry, land use, wealth, waterfront access, and architectural palette.

## 9. Rendering Is Better Positioned for Scale Than Persistence

The inherited renderer already distinguishes simple/background structures from richer interactive structures.

Simple structures can use Three.js instancing, which is a useful foundation for dense urban fabric.

### Important uncertainty

The persistence/API model currently tends toward treating generated building roots as location rows.

That may be too expensive for the complete Imperial City if the city contains very large numbers of structures.

### RUBY_WHEEL direction

Keep the distinction between:

- visual urban fabric; and
- semantic gameplay POIs.

Benchmark before deciding whether ordinary urban fabric should be fully materialized, reconstructed from deterministic chunks, or stored using a hybrid model.

## 10. Megacity Scale Is the Largest Technical Unknown

The intended Imperial City is far larger and denser than an ordinary VTT map.

The audit found no basis for assuming that loading and persisting every building as a rich location object will scale adequately.

Required future measurements include:

- database size;
- generation time;
- persistence time;
- API payload size;
- initial load time;
- browser memory;
- render performance;
- interaction performance;
- realtime synchronization behavior.

Do not settle the final urban-fabric persistence model before representative benchmarks.

## 11. Saved Maps Are Snapshots, Not Campaigns

The inherited saved-map flow serializes active map state and later replaces active world data when loading a saved map.

This is incompatible with the RUBY_WHEEL concept of multiple campaigns sharing one canonical Imperial City.

### RUBY_WHEEL direction

Treat saved maps/successor snapshots as backup/snapshot mechanisms.

Campaigns must become provenance and membership/state domains within one canonical world.

## 12. Saved-Map Round-Trip Fidelity Needs Repair

The audit found that save and load paths do not round-trip all newer schema fields consistently.

The water load path also risks losing generated/authored semantics because not every field is restored.

### RUBY_WHEEL direction

Before snapshots become important to canonical world safety:

- version the snapshot format;
- test round-trip fidelity;
- preserve provenance/protection fields;
- eliminate silent field loss.

## 13. SQLite Is Acceptable Until Evidence Says Otherwise

Nothing in the audit justified replacing SQLite immediately.

The current application is small-group/self-hosted software, and RUBY_WHEEL should not introduce a database migration merely on intuition.

### RUBY_WHEEL direction

Keep SQLite unless benchmarks or new requirements demonstrate a concrete need to change.

Do not append every new concept to the existing `locations` table.

Use distinct persistence models for concepts such as:

- reference layers;
- geographic regions;
- generation profiles;
- generation runs;
- campaigns;
- world events;
- knowledge/visibility.

Migration discipline should become more explicit as RUBY_WHEEL adds schema.

## 14. Authorization Must Be Hardened Before Secret Campaign Data

The inherited authentication middleware verifies token/session state, but the audit found inconsistent use of explicit role authorization across routes.

Some routes correctly add admin-role checks; other world/admin-style operations rely only on authentication.

### RUBY_WHEEL direction

Before storing GM-only notes, cross-campaign secrets, or protected attachments:

- enforce server-side authorization consistently;
- distinguish authentication from authorization;
- model global role, campaign membership, and resource visibility;
- never rely on hidden frontend controls as a security boundary.

## 15. Standalone World Knowledge Is Genuinely New Work

The audited baseline does not provide the standalone world-note/lore domain required by RUBY_WHEEL.

Existing note-like fields are primarily character/location-sheet content.

Generic private world attachments are also not a first-class system.

### RUBY_WHEEL direction

Future world knowledge should separate:

- canon/truth status;
- provenance;
- visibility.

Files requiring restricted access must be served through authorization-aware routes rather than an unauthenticated static upload path.

## 16. UESRPG Can Fit the Existing Multi-System Foundation

The frontend/backend already contain multiple game-system templates and system-specific behavior.

This makes UESRPG adaptation plausible without replacing the multi-system structure.

### RUBY_WHEEL direction

Decompose UESRPG work into bounded capabilities such as:

- sheet representation;
- rolls;
- derived statistics;
- equipment;
- combat;
- magic;
- advancement.

Do not make full UESRPG implementation a prerequisite for city completion.

## 17. Frontend Centralization Is a Risk, Not a Rewrite Trigger

The inherited application centralizes significant behavior in large components such as `App.tsx` and `AdminPanel.tsx`.

### RUBY_WHEEL direction

Do not begin with a heroic frontend rewrite.

New large capabilities should instead establish clearer module/component seams, such as:

- reference-layer management;
- persistent geography editing;
- profile/archetype editing;
- campaign administration;
- world knowledge.

Refactor incrementally where a real feature boundary justifies it.

## 18. Recommended City-Building Sequence

The audit supports the following dependency order:

1. Preserve the fork/upstream baseline.
2. Establish project requirements, architecture, agent guidance, and known upstream findings.
3. Prove the inherited app/test/build baseline.
4. Add persistent calibrated reference layers.
5. Add persistent canonical geography and protection/provenance.
6. Generalize generator semantics behind profiles/archetypes.
7. Implement one Imperial City district/subregion pilot.
8. Benchmark representative megacity scale.
9. Choose urban-fabric persistence strategy from evidence.
10. Expand canal, waterfront, agricultural, food-logistics, and architectural generation.

This sequence is directional architecture guidance, not an approved implementation plan.

## 19. Pilot Direction

A Market District subsection remains a strong future pilot because it can exercise:

- dense mixed-use fabric;
- roads and lots;
- protected canonical features;
- waterways;
- quays/docks;
- warehouses;
- commerce;
- ordinary residences;
- food-import and granary infrastructure.

Do not begin the pilot until the prerequisite reference-layer and persistent-geography capabilities are ready.

## 20. Audit Maintenance Rule

Do not turn this file into a second architecture document.

Update it only when new repository evidence changes a material conclusion about inherited CITY_NET behavior.

For product intent, use `docs/REQUIREMENTS.md`.

For architectural rules, use `docs/ARCHITECTURE.md`.
