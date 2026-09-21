# RUBY_WHEEL Project Status

**Status date:** 2026-09-21  
**Current branch baseline:** `main`  
**Requirements/architecture baseline commit:** `37ed890` — Add RUBY_WHEEL requirements and architecture baseline  
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
- No RUBY_WHEEL implementation code has been accepted yet.

## Primary Product Objective

Procedurally complete the existing partially authored Imperial City while preserving canonical authored work.

City completion remains higher priority than new tabletop mechanics, shared-campaign features, or UESRPG expansion.

## Baseline Verification

Inherited CITY_NET baseline verified locally on 2026-09-21.

- Frontend dependencies installed successfully from the lockfile.
- Frontend: 118 test files passed; 2,686 tests passed.
- Frontend production build passed.
- Backend dependencies installed successfully from the lockfile.
- Backend: 80 test files passed; 2,062 tests passed.
- Application launched successfully on `localhost:5000`.
- Backend startup sanity checks passed.
- Main application UI loaded and was interactable.

Inherited npm audit findings, dependency warnings, React/Three test warnings, and backend test stderr noise are baseline technical debt. They were not remediated during baseline establishment because doing so would alter the inherited baseline before RUBY_WHEEL implementation begins.

## Immediate Objective

Plan the first RUBY_WHEEL-specific capability:

> Persistent calibrated world-space reference layers for the existing Imperial City artwork.

That capability must support, at minimum:

- import/display;
- world-space position;
- scale;
- rotation;
- opacity;
- visibility;
- lock state;
- persistence across reload/restart;
- separation from battle maps and procedural geometry.

## Current Non-Goals

Do not begin implementation of:

- Imperial generator semantic refactoring;
- district-profile/archetype systems;
- large-scale canal generation;
- urban-fabric persistence redesign;
- campaign knowledge/visibility systems;
- UESRPG rules adaptation;
- broad CITY_NET cleanup/removal;
- database replacement.

These are later work unless a prerequisite investigation explicitly requires them.

## Next Planned Repository Step

1. Ensure `main` is clean and current.
2. Create a bounded planning branch for the reference-layer capability.
3. Inspect the minimum relevant frontend/backend/persistence surfaces.
4. Produce an executable plan with explicit non-goals and validation.
5. Review and approve the plan before implementation.
6. Commit the approved planning baseline to `main`.
7. Create a dedicated implementation branch.
8. Implement and verify only the approved capability.

No implementation should begin on `main`.
