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

## Immediate Objective

Establish the inherited local execution baseline, then plan the first RUBY_WHEEL-specific capability:

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

## Before Planning the Reference-Layer Capability

Verify the inherited application locally:

Frontend:
- install from lockfile;
- run tests;
- run production build.

Backend:
- install from lockfile;
- run tests.

Then launch the inherited application once and confirm the current baseline is usable on localhost.

Record any baseline failures before changing code.

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

After the inherited baseline is verified:

1. ensure `main` is clean and current;
2. create a bounded planning effort for the reference-layer capability;
3. inspect the minimum relevant frontend/backend/persistence surfaces;
4. produce an executable plan with explicit non-goals and validation;
5. commit the approved planning baseline to `main`;
6. create a dedicated implementation branch;
7. implement and verify only the approved capability.

No implementation should begin on `main`.
