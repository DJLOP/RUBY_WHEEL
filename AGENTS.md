# RUBY_WHEEL Agent Instructions

This file is the canonical repository-wide operating guide for coding and planning agents working on RUBY_WHEEL.

RUBY_WHEEL is model-agnostic. Do not assume Claude, Codex, or any other model is the permanent planner, implementer, or reviewer.

## 1. Read Order and Authority

Before planning or modifying the repository, read the minimum authoritative material needed for the task.

Authority order:

1. The human owner’s current explicit instructions.
2. `docs/REQUIREMENTS.md` — product requirements and priority order.
3. `docs/ARCHITECTURE.md` — architectural invariants and boundaries.
4. The active approved plan for the current work, if one exists.
5. `docs/PROJECT_STATUS.md` — current repository state and immediate objective.
6. `docs/UPSTREAM_AUDIT.md` — known facts about inherited CITY_NET behavior and technical debt.
7. Current code, tests, diffs, runtime behavior, and command output.

Do not treat inherited CITY_NET code, comments, README prose, Cyberpunk terminology, or old upstream planning documents as evidence of current RUBY_WHEEL product intent when they conflict with RUBY_WHEEL requirements or architecture.

Do not duplicate or re-summarize the authoritative documents in prompts, plans, or reports unless a task specifically requires changing them. Reference them by path and read them.

## 2. Project Priority

RUBY_WHEEL is first and foremost an Imperial City construction system.

The primary objective is to procedurally complete the existing partially authored Imperial City while preserving canonical authored work.

Tabletop/VTT features, shared-campaign systems, and UESRPG support are important but subordinate to the city-completion priority unless an approved plan says otherwise.

## 3. Repository Relationship

RUBY_WHEEL is derived from:

- Upstream repository: `over2take/CITY_NET`
- Preserved baseline tag: `city-net-baseline-4fb2ecf`
- Upstream baseline commit: `4fb2ecfb0b90c056d8f1f386aeb28e213f087405`

Local Git convention:

- `origin` = `DJLOP/RUBY_WHEEL`
- `upstream` = `over2take/CITY_NET`

Do not merge upstream wholesale without an explicit task and review. Prefer deliberate inspection and selective adoption of useful upstream fixes after RUBY_WHEEL begins to diverge.

## 4. Git and Branch Discipline

`main` is the accepted project baseline.

Planning may inspect the repository from a clean `main`, but implementation must not begin on `main`.

Before implementation:

1. Ensure the approved plan or execution contract is committed to `main`.
2. Ensure the working tree is clean.
3. Create and switch to a dedicated branch from current `main`.
4. Implement only the approved bounded scope.

Do not modify the same worktree concurrently with multiple implementation agents.

Do not rewrite history, force-push, delete branches, or perform broad repository cleanup unless explicitly authorized.

## 5. Planning Discipline

Plans must be bounded and executable.

A good plan:

- references existing repository documents rather than rehashing them;
- identifies the concrete code/data surfaces to inspect or change;
- states explicit non-goals;
- defines validation;
- identifies architecture decisions or uncertainties that genuinely require resolution;
- does not expand into unrelated cleanup;
- does not silently reinterpret settled requirements.

If the repository already answers a question, use the repository answer instead of rediscovering or restating it.

If a plan conflicts with `docs/REQUIREMENTS.md` or `docs/ARCHITECTURE.md`, stop and surface the conflict rather than choosing a new direction unilaterally.

## 6. Implementation Discipline

Prefer the smallest compatible change that satisfies the approved work.

Preserve existing CITY_NET behavior unless:

- the approved plan intentionally changes it; or
- current evidence shows it is defective and the defect is in scope.

Do not perform opportunistic rewrites.

Do not replace inherited technologies, frameworks, the database, rendering stack, or major dependencies merely because another option is newer or preferred. Follow the technology-baseline rules in `docs/ARCHITECTURE.md`.

Keep new RUBY_WHEEL-specific capabilities modular. Avoid making `App.tsx`, `AdminPanel.tsx`, or the existing `locations` model universal dumping grounds.

## 7. Evidence-First Reporting

Verify repository and execution claims from current evidence.

Acceptable evidence includes:

- current files;
- Git diffs/status/logs;
- exact commands and outputs;
- automated tests;
- build output;
- runtime observation;
- authoritative repository documentation.

Clearly distinguish:

- **verified fact**;
- **inference**;
- **expectation/proposal**.

Do not claim a test passed, a feature works, a file changed, or a branch is clean without evidence.

Reports should lead with:

1. what changed or what was found;
2. validation performed and results;
3. remaining risks or open decisions;
4. exact current status.

Avoid long narrative restatements of repository context.

## 8. Validation Expectations

Use targeted validation first, then the broader suite appropriate to the changed surface.

Current inherited validation entry points include:

Frontend:
- `cd frontend`
- `npm test`
- `npm run build`

Backend:
- `cd backend`
- `npm test`

Use the package manifests and CI workflows as the authoritative source for exact commands when they change.

For interactive UI work, automated tests are not sufficient by themselves. Perform an appropriate live/runtime verification when practical.

Stop on failed validation. Do not report a work package as complete while known required validation is failing.

## 9. City-Building Safety Rules

For work involving procedural city generation:

- authored/protected content outranks generated content;
- provenance and protection must be explicit, not inferred from names;
- generation must remain bounded/local;
- deterministic behavior must be preserved where required;
- canonical geography must not be silently overwritten;
- do not assume every visual building is a heavyweight semantic POI;
- do not make megacity-scale persistence decisions without measurement when the architecture marks them as unresolved.

## 10. Scope Control

Do not begin work on later priorities merely because relevant code is nearby.

In particular, unless the active plan requires it, do not expand a city-building task into:

- UESRPG rules implementation;
- campaign knowledge/visibility systems;
- economic simulation;
- wholesale frontend refactoring;
- database replacement;
- removal of inherited CITY_NET game systems;
- broad Cyberpunk terminology cleanup.

Legacy-looking code is not automatically dead code.

## 11. Documentation Updates

Update documentation when the task changes durable project truth.

Use:

- `docs/REQUIREMENTS.md` for product requirements;
- `docs/ARCHITECTURE.md` for architectural invariants/decisions;
- the active plan for execution details;
- `docs/PROJECT_STATUS.md` for current state and next objective;
- `docs/UPSTREAM_AUDIT.md` only when new evidence changes an audit conclusion.

Do not create competing sources of truth.

## 12. Human Authority

The human owner makes product and acceptance decisions.

Agents may recommend, analyze, plan, implement, and verify, but must not silently resolve material product ambiguities by inventing requirements.

When a bounded task can proceed safely from existing repository authority, proceed without unnecessary ceremony.
