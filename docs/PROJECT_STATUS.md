# RUBY_WHEEL Project Status

**Status date:** 2026-09-25  
**Current implementation branch:** `feature/canonical-geography`  
**Latest pushed accepted implementation commit:** `59ca91d` — Add canonical geography anchors scopes and connections (WP6)  
**Post-WP6 architecture amendment commit:** `1dd443b` — Reconcile post-WP6 generation architecture (documentation only; pushed)\
**Canonical-geography plan baseline commit:** `2eaff3e` — Approve canonical geography implementation plan  
**Requirements/architecture baseline commit:** `8f02ed4` — Define generation hierarchy and canonical city scale  
**Imperial City generation bible commit:** `2b446c2` — Add Imperial City generation bible  
**Reference-layer plan baseline commit:** `eb47959` — Plan persistent calibrated reference layers  
**Upstream baseline:** `4fb2ecfb0b90c056d8f1f386aeb28e213f087405`  
**Baseline tag:** `city-net-baseline-4fb2ecf`

## Current State

- `DJLOP/RUBY_WHEEL` is a fork of `over2take/CITY_NET`.
- Local `origin` is RUBY_WHEEL; local `upstream` is CITY_NET.
- The working project requirements are in `docs/REQUIREMENTS.md`.
- The architecture contract is in `docs/ARCHITECTURE.md`.
- The inherited CITY_NET audit is recorded in `docs/UPSTREAM_AUDIT.md`.
- The GM-accepted human-readable world specification and initial must-exist hard-anchor set are in `docs/IMPERIAL_CITY_GENERATION_BIBLE.md`.
- `AGENTS.md` is the canonical model-agnostic agent operating guide.
- `CLAUDE.md` is only a thin bootstrap pointing Claude to `AGENTS.md`.
- The persistent calibrated reference-layer slice is complete, human-accepted, merged to `main`, and pushed.
- `docs/CANONICAL_GEOGRAPHY_PLAN.md` is approved and committed (`2eaff3e`).
- Canonical Geography WP1–WP6 are complete, reviewed, human-accepted, committed, and pushed on `feature/canonical-geography`. WP6 — anchors, connections, scopes, map selection, context inspection, and recoverable retirement — is commit `59ca91d` (`Add canonical geography anchors scopes and connections`).
- The documentation-only post-WP6 architecture amendment is complete, committed and pushed as `1dd443b`, and accepted as the current architectural baseline.
- The human owner chose to insert a small canonical-geometry authoring-tools slice before WP7 (option B below). That slice, **AT1 — deterministic radial construction**, is planned in `docs/CANONICAL_GEOGRAPHY_PLAN.md` §15 and has not started.
- WP7 has not started.

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

The accepted reference-layer implementation is recorded across WP1–WP5 commits `574ba14`, `59dcf73`, `ec39b5f`, `7b68369`, `c3a2e68`, plus human-acceptance remediation commit `1097e70`.

## Verification of Accepted Reference-Layer Slice

Automated verification recorded during reference-layer WP5 and acceptance remediation:

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

One inherited unrelated Socket.IO timing test (`sockets.deathsave.test.js`) failed once during reference-layer validation and could not be reproduced in repeated isolated/full-suite runs. It remains inherited technical debt, not a reference-layer defect.

## Active Slice — Canonical Geography

The approved capability establishes a governed, versioned canonical spatial substrate between reference evidence and future procedural generation.

### Accepted implementation progress

- **WP1 — Schema, geometry core, physical scale:** complete and accepted; commit `ab250ad` (`Add canonical geography foundation`).
- **WP2 — Lifecycle REST and protection:** complete and accepted; commit `461f225` (`Add canonical geography lifecycle and protection`).
- **WP3 — Query seam and scale measurement:** complete and accepted.
- **WP4 — Data wiring and rendering:** complete and accepted.
- **WP3–WP4 pushed checkpoint:** commit `7e91644` (`Add canonical geography query and rendering`).
- **WP5 — Tracing and feature editing:** complete, human-accepted, Sol-reviewed, committed and pushed as `0882790` (`Add canonical geography tracing and editing`).
- **WP6 — Anchors, connections, scopes UI:** complete, human-accepted, Sol-reviewed clean, committed and pushed as `59ca91d` (`Add canonical geography anchors scopes and connections`).
- **Pre-WP7 slice AT1 — Deterministic radial construction (R-014, A-020):** planned (`docs/CANONICAL_GEOGRAPHY_PLAN.md` §15), pending human review; not started.
- **WP7 — Import/export, legacy promotion, Bible-derived initial register, final verification:** not started; scope unchanged.

### Canonical-geography capability now available through WP6

- first-class canonical features, anchors, connections, scopes, and revision history;
- explicit draft/proposed/accepted/retired lifecycle;
- world-editor-only mutation boundary;
- revise → explicit accept workflow with stale-revision protection;
- lock/unlock, replacement-state protection, retire/restore, and history;
- exact 0.001-wu integer-grid topology;
- accepted land non-overlap/non-touch rules;
- required-scope, connection, membership, and dependent validation;
- isolated canonical SQLite transaction connection;
- accepted-only generator-facing canonical query with digest, metrics, readiness, hierarchy chain, water semantics, and crossing obligations;
- exact route/water and route/land-exit classification;
- frontend canonical constraints adapter independent of raster state;
- scalable merged canonical rendering above reference evidence and below inherited overlays;
- interactive canonical tracing/editing against reference evidence;
- client normalization aids and physical/source-coordinate readouts;
- explicit draft save, accept confirmation, revise, lock, retire, replacement, and history workflow.

### WP5 verification

Latest recorded WP5 automated validation:

- WP5 focused frontend tests: **113 passed**.
- Canonical-geography frontend tests: **186 passed, 1 skipped**.
- Full frontend suite: **144 files / 3,061 passed, 1 skipped**.
- Frontend production build passed.
- Latest full backend WP5 gate before the final frontend-only readout regressions: **103 files / 2,512 passed**; no backend files changed afterward.
- Sol review reported no material WP5 defects and judged WP5 safe to accept and WP6 safe to begin.

WP5 human acceptance passed, including:

- tracing a real island against the calibrated Imperial City raster;
- click-versus-drag behavior and ordinary camera movement;
- snapping and ring closure;
- normalization workflow;
- source-pixel and metric readout;
- draft persistence and explicit accept;
- lock/unlock, revise, revision history, and draft-from-history;
- reload/restart persistence.

Two useful live acceptance findings were resolved:

1. External snapping could steal click-to-close intent near the polygon's first vertex. Ring-close intent now takes priority.
2. The reference layer had been stored at `1 wu/px`, which made a correct pixel readout reveal that the raster itself was physically underscaled. The layer was recalibrated to the canonical Imperial City source scale `250/127 ≈ 1.968503937 wu/px`, and the metric/source-pixel check was re-run successfully.

### WP6 verification and human acceptance

WP6 automated validation remained green through implementation and live-remediation rounds.

Recorded validation before the final recoverability fix included:

- WP6 targeted frontend tests: **174 passed**.
- Canonical-geography frontend tests: **328 passed, 1 skipped**.
- Full frontend suite: **3,203 passed, 1 skipped** (about 41 s).
- Frontend production build passed.
- Backend canonical tests: **394 passed**.
- Full backend suite: **2,526 passed** (about 10 s).

The final anchor/scope/connection retirement-recoverability remediation also passed its focused, WP6, canonical-geography, full-frontend, and build gates. No final post-remediation aggregate test count was recorded here.

Human browser acceptance verified, among other things:

- district scopes are drawn spatial regions rather than sets of whole islands;
- district boundaries may split islands and still query intersecting land correctly;
- whole-island district membership is optional;
- feature/map picking opens the relevant inspector/context instead of requiring lookup in a long list;
- selected district context, explicit feature selection, and row-hover highlights remain visually distinct;
- district context-pane contents are interactable;
- draft/revision geometry can be translated by dragging the whole shape;
- anchor placement and placed/unplaced behavior work in the UI;
- retired canon is hidden from normal work but remains recoverable through archive/restore.

A final Sol review found one HIGH blocker: retired anchors, scopes, and connections could become unreachable in the UI. That was remediated with archive/restore access matching the feature recoverability model. Sol's bounded recheck closed the finding and reported WP6 safe to accept, commit, and proceed to the documentation amendment. WP6 was then committed and pushed as `59ca91d`.


## Post-Reference-Layer Design Direction

These decisions are recorded authoritatively as R-006, R-007, R-011, R-013, R-014, R-025, R-026, R-031 in `docs/REQUIREMENTS.md` and A-015–A-020 in `docs/ARCHITECTURE.md` (baseline `8f02ed4`, amended post-WP6); those documents govern if this summary differs.

Generation-facing work must preserve the following decisions:

- **Preserve canon, not pixels.**
- The raster is calibrated reference evidence, not canonical fine geometry.
- Raw raster pixels must never be fed directly into procedural generation as authoritative geometry.
- Hand-drawn/scan/GIMP artifacts — including thick or dirty coastlines, imperfect circles, stroke width, anti-aliasing, color edits, and drawing irregularities — must not silently become canonical world geometry.
- Canonical spatial constraints should be normalized and explicitly accepted before generators consume them.
- Distinguish:
  - **hard anchors** — identity/presence and established spatial/functional relationships are protected; exact part geometry may still be soft unless independently fixed;
  - **soft anchors** — existence/role matters, exact footprint may be generated;
  - **ordinary urban fabric** — freely procedural unless intentionally promoted to canon.
- Existing raster roads, bridges, walls, gates, docks/quays, and similar marks are evidence of intent unless specifically promoted to canonical normalized geometry.
- Ordinary streets/buildings visible in the raster are not canonical merely because they were hand-drawn.
- Generation remains hierarchical, amended after WP6 human use (R-011, R-013, R-025, R-026; A-017–A-019): city strategy and district program are persistent strategic layers; demand-created generation worksets/batches execute below them, inheriting district requirements and reading prior generated/accepted district state and unfulfilled requirements; `island_group` is an optional semantic scope, not a generation tier; districts and physical islands are independent geometries, with derived `island ∩ district` pieces where needed; island/block/building detail remains lower-level work.
- Higher levels should primarily produce roles, obligations, budgets, relationships, ranges, weights, and priorities; lower levels should produce geometry/detail.
- Lower-level feasibility must be able to feed back upward rather than forcing impossible allocations.
- District planning should later support multiple density/intensity nodes with falloff rather than one flat density value, including city-center pull and district-specific centers (R-031, ARCHITECTURE §8).
- Ordinary urban fabric should remain lightweight; selected structures may later be promoted into semantic POIs.
- A canonical-geometry authoring aid supports exact parametric radial/spoke geometry from a chosen center between accepted inner/outer boundaries. This is deterministic construction tooling, not procedural city generation (R-014, A-020), and is planned as pre-WP7 slice AT1 (`docs/CANONICAL_GEOGRAPHY_PLAN.md` §15).

## Known Physical Scale

The physical-scale contract is settled and recorded as R-005 / A-014:

- **1 world unit = 5 feet = 1.524 meters**;
- **1 source pixel = 3 meters**, so the source-scale reference calibration is `250/127 ≈ 1.968503937` world units per pixel;
- canonical exterior-wall span: **6,744 m** east–west and north–south (`2,248 px × 3 m/px`), approximately **4,425.20 world units**.

A UI measurement/display setting (such as the inherited `GLOBAL MAP SCALE (FT/UNIT)` control) must not silently redefine the physical size of canonical geometry.

The current Imperial City reference layer was explicitly corrected to the canonical `250/127` source calibration during WP5 human acceptance. Canonical geometry remains independent of later reference-layer recalibration.

## Immediate Objective

Implement **pre-WP7 slice AT1 — deterministic radial construction** as specified in `docs/CANONICAL_GEOGRAPHY_PLAN.md` §15, once the human owner has reviewed and approved that plan section.

AT1 is a small, generic canonical-geometry authoring tool that executes R-014 / A-020. Its parts:

- A center, two accepted closed boundaries, a spoke count `N`, and an angular offset `θ₀` produce a deterministic preview.
- Persisting creates one draft linestring feature per spoke, with a `radial_spoke` construction record, in one all-or-nothing transaction.
- Acceptance stays explicit and per record, through the existing lifecycle.
- Nothing rewrites accepted canon or inputs automatically.

AT1 contains no world-specific code, no district or scope creation, no clipping, and no generation.

WP7 comes immediately after AT1, with its scope unchanged. WP7 remains responsible for interchange import/export, legacy promotion, the Bible-derived `docs/canonical/initial_register.v1.json`, and final end-to-end verification.

The canonical-geography slice remains a constraint substrate. It does not yet implement the future generation-workset planner or district density model.

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

1. Human review of the AT1 plan (`docs/CANONICAL_GEOGRAPHY_PLAN.md` §15) and this status update.
2. Commit the plan update separately on `feature/canonical-geography`, only when the user authorizes the commit.
3. Implement AT1 on `feature/canonical-geography`, validate it per §15.14, run human acceptance per §15.15, and stop for acceptance and commit authorization.
4. Then proceed to WP7, with its scope unchanged.
5. Keep the noted CITY_NET upstream update parked. Evaluate upstream sync/contribution strategy only at a stable checkpoint.

The post-WP6 decision between proceeding directly to WP7 (A) and inserting the authoring-tools slice first (B) has been made: **B**.

Implementation must not move back to `main` mid-slice.

## Workflow Rule

Agents must **not commit on the user's behalf unless the user explicitly authorizes a commit**.

By default, implementation/planning/review agents should leave changes uncommitted, report validation and `git status`, and stop for human review.
