# RUBY_WHEEL Project Status

**Status date:** 2026-09-22  
**Current branch baseline:** `main`  
**Current accepted baseline commit:** `1097e70` — Fix reference layer acceptance issues  
**Requirements/architecture baseline commit:** `e19a6c5` — Clarify preservation authorization calibration and recovery contracts  
**Reference-layer plan baseline commit:** `eb47959` — Plan persistent calibrated reference layers  
**Upstream baseline:** `4fb2ecfb0b90c056d8f1f386aeb28e213f087405`  
**Baseline tag:** `city-net-baseline-4fb2ecf`

## Current State

- `DJLOP/RUBY_WHEEL` is a fork of `over2take/CITY_NET`.
- Local `origin` is RUBY_WHEEL; local `upstream` is CITY_NET.
- The working project requirements are in `docs/REQUIREMENTS.md`.
- The architecture contract is in `docs/ARCHITECTURE.md`.
- The inherited CITY_NET audit is recorded in `docs/UPSTREAM_AUDIT.md`.
- `AGENTS.md` is the canonical model-agnostic agent operating guide.
- `CLAUDE.md` is only a thin bootstrap pointing Claude to `AGENTS.md`.
- The first RUBY_WHEEL-specific implementation slice — persistent calibrated reference layers — is complete, human-accepted, merged to `main`, and pushed.
- The accepted reference-layer implementation is recorded across WP1–WP5 commits `574ba14`, `59dcf73`, `ec39b5f`, `7b68369`, `c3a2e68`, plus human-acceptance remediation commit `1097e70`.

## Primary Product Objective

Procedurally complete the existing partially authored Imperial City while preserving intentional canon.

The calibrated raster reference layer is infrastructure for that objective, not the end product. The eventual primary view should be the generated/accepted 3D city; the raster may later be hidden, archived, or discarded from the active world once it has served as reference evidence.

City completion remains higher priority than new tabletop mechanics, shared-campaign features, or UESRPG expansion.

## Completed Slice — Persistent Calibrated Reference Layers

The accepted capability supports:

- PNG/JPEG reference assets with server-verified dimensions/format;
- persistent source-to-world calibration;
- world-space position, scale, and rotation;
- opacity and visibility;
- lock/unlock behavior;
- world-editor authorization;
- persistence across reload and backend restart;
- separation from battle maps, canonical geometry, collision, selection, purge, and procedural-generation inputs;
- realtime refresh through the inherited `dataUpdated` path;
- local draft calibration preview before Apply;
- top-down/frame-selected-layer viewing;
- adaptive camera clipping for city-scale strategic views;
- scale-aware world-grid/reference-line visibility;
- preservation of reference-layer data across legacy saved-map load/clear behavior.

The target Imperial City PNG is **6032 × 4584 px** and renders successfully as a single reference texture.

## Verification of Accepted Slice

Automated verification recorded during WP5 and acceptance remediation:

- Backend full suite: **84 files / 2,132 tests passed, 0 failed**.
- Frontend full suite after acceptance remediation: **130 files / 2,875 tests passed, 0 failed**.
- Frontend production build passed.
- Targeted reference-layer, migration, authorization, socket-refresh, camera-clipping, grid, and legacy-boundary tests passed.
- Acceptance-remediation tests were mutation-checked against the pre-fix behavior.

Human browser verification passed, including:

- real Imperial City artwork rendering;
- top-down framing;
- repeated dolly-out without far-plane disappearance;
- grid/reference-line strategic-scale behavior;
- persistence across reload/restart;
- lock/unlock behavior;
- second-client refresh;
- legacy saved-map preservation boundary;
- reference imagery remaining separate from procedural/canonical world data.

One inherited unrelated Socket.IO timing test (`sockets.deathsave.test.js`) failed once during WP5 validation and could not be reproduced in repeated isolated/full-suite runs. It remains inherited technical debt, not a reference-layer defect.

## Post-Reference-Layer Design Direction

These decisions are now recorded authoritatively as R-006, R-007, R-025 in `docs/REQUIREMENTS.md` and A-015–A-017 in `docs/ARCHITECTURE.md` (amendment human-accepted and awaiting commit); those documents govern if this summary differs.

The next generation-facing work must preserve the following decisions before procedural generation begins:

- **Preserve canon, not pixels.**
- The raster is calibrated reference evidence, not canonical fine geometry.
- Raw raster pixels must never be fed directly into procedural generation as authoritative geometry.
- Hand-drawn/scan/GIMP artifacts — including thick or dirty coastlines, imperfect circles, stroke width, anti-aliasing, color edits, and drawing irregularities — must not silently become canonical world geometry.
- Canonical spatial constraints should be normalized and explicitly accepted before generators consume them.
- Distinguish:
  - **hard anchors** — exact location/shape matters;
  - **soft anchors** — existence/role matters, exact footprint may be generated;
  - **ordinary urban fabric** — freely procedural unless later promoted to canon.
- Existing raster roads, bridges, walls, gates, docks/quays, and similar marks are evidence of intent unless specifically promoted to canonical normalized geometry.
- Ordinary streets/buildings visible in the raster are not canonical merely because they were hand-drawn.
- Generation should be hierarchical:
  - city strategy;
  - district program;
  - island-group / island-chain allocation;
  - island morphology;
  - local block / quarter refinement;
  - POI promotion / detailed authoring.
- Higher levels should primarily produce roles, obligations, budgets, relationships, ranges, weights, and priorities; lower levels should produce geometry/detail.
- Lower-level feasibility must be able to feed back upward rather than forcing impossible allocations.
- Ordinary urban fabric should remain lightweight; selected structures may later be promoted into semantic POIs.

## Known Physical Scale

The physical-scale contract is settled and recorded as R-005 / A-014:

- **1 world unit = 5 feet = 1.524 meters**;
- **1 source pixel = 3 meters**, so the source-scale reference calibration is `250/127 ≈ 1.968503937` world units per pixel;
- canonical exterior-wall span: **6,744 m** east–west and north–south (`2,248 px × 3 m/px`), approximately **4,425.20 world units**.

A UI measurement/display setting (such as the inherited `GLOBAL MAP SCALE (FT/UNIT)` control) must not silently redefine the physical size of canonical geometry. No UI change has been made for this.

## Immediate Objective

The requirements/architecture amendment recording the post-reference-layer invariants, the physical-scale contract, and the raster-evidence boundary is human-accepted and awaiting commit to `main`.

After that commit, plan the next bounded implementation slice for **normalized canonical macro geography and hard-anchor establishment/import**, rather than full-raster vectorization, computer-vision reconstruction, direct generation from raw pixels, or whole-city procedural generation.

## Current Non-Goals

Do not yet implement:

- automatic full-raster vectorization;
- computer-vision reconstruction of every road/building;
- direct procedural generation from raster pixels;
- the complete six-level planning hierarchy in one project;
- whole-city one-shot generation;
- detailed economy or food-calorie simulation;
- campaign knowledge/visibility systems;
- UESRPG rules adaptation;
- broad CITY_NET cleanup/removal;
- database replacement.

## Next Planned Repository Step

1. Commit the accepted documentation amendment to `main`.
2. Plan the next bounded capability around normalized canonical macro geography and hard anchors.
3. Commit the approved plan before implementation.
4. Create a dedicated implementation branch for that next capability.

Implementation must not begin on `main`.

## Workflow Rule

Agents must **not commit on the user's behalf unless the user explicitly authorizes a commit**.

By default, implementation/planning/review agents should leave changes uncommitted, report validation and `git status`, and stop for human review.
