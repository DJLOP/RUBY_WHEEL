# Persistent Calibrated Reference Layers — Implementation Plan

## 1. Goal and completion criteria

Deliver the first RUBY_WHEEL-specific capability: a primary administrator can add an Imperial City raster image to the canonical world, calibrate it deterministically into world X/Z coordinates, adjust its display, lock it against accidental destructive edits, and see the same result after browser reload and backend restart.

The actual target Imperial City artwork is **6032 × 4584 pixels**. That known size is acceptable for a single texture on a single horizontal plane for this first slice; tiled/chunked reference rendering is not required.

The capability is complete when:

- PNG and JPEG source assets can be uploaded or selected from previously uploaded reference-layer assets.
- More than one reference layer can exist, and every client can load the persisted list.
- Each layer's persisted source-to-world calibration reproduces the same mapping independently of React/Three.js object state.
- Position, scale, rotation, opacity, visibility, and lock state are editable through a dedicated world-editor UI.
- The backend, not merely hidden frontend controls, permits canonical-world mutations only to the primary administrator.
- Locking prevents mutable name/calibration changes and deletion until a separate unlock action; opacity and visibility remain usable display controls. Source identity is immutable regardless of lock state.
- Reference layers render only in the canonical world scene, do not receive pointer hits, and do not enter battle-map, collision, selection, purge, or procedural-generation data.
- Mutations are visible to other connected clients through the inherited realtime refresh mechanism.
- Existing CITY_NET behavior and its full frontend/backend test suites and frontend production build remain valid.

This plan implements a reference-layer subsystem, not a generic world-object abstraction.

## 2. Relevant inherited implementation surfaces

### Backend and persistence

- `backend/db.js` opens `DB_PATH`, initializes SQLite in a single serialized startup block, and currently mixes table creation with repeated best-effort `ALTER TABLE` calls. It exports the live `sqlite3.Database` directly and `backend/server.js` begins listening without an explicit schema-ready promise.
- `backend/server.js` constructs the shared `emitUpdate` helper, mounts feature routers, exposes `/uploads` with the hardened upload response headers, and initializes Socket.IO.
- `backend/middleware/auth.js` verifies JWTs and revocation of temporary elevation, but `authenticate` alone does not distinguish the primary administrator from a player or temporary administrator. The primary-admin JWT created by `backend/routes/admin.js` has `role: 'admin'` and `isTemporary: false`.
- `backend/routes/battle_maps.js` is a useful asset-handling comparison: streamed disk upload, temporary-file cleanup, SHA-256 content naming, extension allowlisting, reuse of existing assets, reference-count-aware deletion, and `emitUpdate`. Its location/floor semantics, video support, fixed 200-unit scene plane, and battle-map session behavior must not be reused as the reference-layer domain model.
- `backend/middleware/uploadConstraints.js` centralizes upload sizes and consistent Multer error responses. `backend/middleware/uploadHeaders.js` applies `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff` to unauthenticated static uploads.
- `backend/routes/maps.js` and `frontend/src/components/CityDatabase.tsx` implement legacy saved-map save/load/clear behavior. These rows are incomplete logical snapshots, not backups. The current Docker deployment persists the database and uploads in separate bind mounts (`backend/data` and `backend/uploads`).
- `backend/__tests__/helpers/testDb.js` builds the shared in-memory schema used by route tests. `backend/__tests__/battle_maps.test.js`, `backend/__tests__/upload_constraints.test.js`, and `backend/__tests__/admin.test.js` show the applicable Supertest, JWT, real-upload, and authorization test patterns.

### Coordinates and rendering

- World geometry consistently uses horizontal X/Z and vertical Y. Roads persist `x1/z1/x2/z2`; water persists `{x,z}` points; editing raycasts against the Y=0 plane in `frontend/src/components/MapElements.tsx`; structure transforms persist X/Y/Z plus Euler rotations.
- `frontend/src/App.tsx` renders the canonical world and battle-map scene as separate branches of one React Three Fiber `Canvas`. The world branch uses a perspective camera, ground grid at Y=0, roads and water slightly above it, then structures. The battle-map branch delegates to `frontend/src/BattleMapScene.tsx` and must not render reference layers.
- `frontend/src/hooks/useMapExport.ts` establishes the top-down orientation used by the inherited world: +X is image-right and -Z is image-up (therefore +Z is image-down). That orientation is the basis for the calibration convention below.
- `frontend/src/BattleMapScene.tsx` demonstrates texture-backed horizontal planes but derives their size from an arbitrary 200-unit height. Reference layers instead need persisted source dimensions and canonical calibration.
- `frontend/src/components/MapElements.tsx` demonstrates non-interactive world overlays, Y offsets, and X/Z-to-Three.js shape conversion.

### Frontend data, realtime, and editing UI

- `frontend/src/hooks/useMapData.ts` owns canonical map collections and their fetch functions. `fetchAll` provides the initial bulk refresh seam.
- `frontend/src/hooks/useSocket.ts` listens for the generic `dataUpdated` event and refetches map collections. A reference-layer callback can join this path without a new event or socket mutation API.
- `frontend/src/types.ts` contains the shared frontend data interfaces.
- `frontend/src/components/AdminPanel.tsx` is the existing world-editing entry point. It already receives `isPrimaryAdmin`; adding one launcher is appropriate, but the reference-layer form and behavior should live in a dedicated module rather than enlarge this component.
- `frontend/src/components/__tests__/AdminPanel.test.tsx`, `frontend/src/__tests__/BattleMapScene.test.tsx`, and hook/component tests under `frontend/src/**/__tests__` demonstrate the current Vitest, Testing Library, and mocked React Three Fiber patterns.

## 3. Proposed design

### 3.1 Persistence model and schema evolution

Create distinct `reference_assets` and `reference_layers` tables rather than extending `locations` or `battle_maps`. Asset metadata must be first-class so the same stored source cannot acquire conflicting pixel dimensions when selected for multiple layers.

`reference_assets` contains:

| Column | Meaning and constraints |
| --- | --- |
| `id` | Integer primary key. |
| `content_hash` | Required unique SHA-256 digest used for enforced content-identity deduplication. |
| `asset_url` | Required unique server-owned `/uploads/reference_layers/<sha256>.<ext>` path. |
| `original_name` | Sanitized display-only upload name; never used as a filesystem path. |
| `format` | Required server-derived canonical raster format (`png` or `jpeg`). |
| `source_width_px` / `source_height_px` | Required positive integer intrinsic pixel dimensions verified from the uploaded bytes by the server. |
| `created_at` | Asset creation timestamp. |

`reference_layers` contains:

| Column | Meaning and constraints |
| --- | --- |
| `id` | Integer primary key. |
| `name` | Required user-facing name, trimmed and length-limited. |
| `asset_id` | Required reference to `reference_assets`; immutable for a layer. |
| `world_center_x` / `world_center_z` | Finite world coordinates of the source-image center. |
| `world_units_per_pixel` | Finite value greater than zero; uniform scale preserves source aspect ratio. |
| `rotation_rad` | Finite top-down clockwise rotation in radians. |
| `opacity` | Finite value in `[0,1]`. |
| `is_visible` | SQLite integer boolean. |
| `is_locked` | SQLite integer boolean, separate from replacement state. |
| `provenance` | Required value `imported` for this slice. |
| `replacement_state` | Required value `non_replaceable` for this slice. It is not inferred from provenance or lock state and has no UI that makes it replaceable yet. |
| `created_at` / `updated_at` | Audit timestamps maintained by writes. |

Use a database `UNIQUE` constraint/index on `reference_assets.content_hash`, plus SQLite `CHECK` constraints for numeric ranges and the initial fixed format/provenance/replacement vocabularies where SQLite supports them. Retain equivalent request validation so invalid input receives a useful 400 response rather than a raw database error.

Introduce an ordered migration seam (`backend/migrations/index.js` plus a first reference-layer migration) backed by a `schema_migrations` table. Attach a `ready` promise to the existing exported database and make `server.listen` wait for it. This preserves the current database object interface while ensuring routes cannot run against a partially migrated schema. Do not convert all inherited startup DDL in this slice.

The migration is additive and idempotent. A clean or existing CITY_NET database gains two empty tables and no inferred legacy layers. Existing locations, water, roads, battle maps, and settings are unchanged. Route transactions must enforce asset/layer integrity explicitly rather than relying only on SQLite foreign-key cascades, because the inherited connection does not currently enable `PRAGMA foreign_keys` globally and changing that setting for every legacy table is outside this slice.

### 3.2 Deterministic calibration representation

Persist a renderer-independent, uniform 2D similarity transform rather than Three.js plane position/scale/pivot state. Source coordinates use pixels with origin at the image's top-left, `u` increasing right and `v` increasing down. Canonical world coordinates use X/Z. For image dimensions `W,H`, center `Cx,Cz`, scale `s`, and clockwise rotation `theta`:

```text
du = u - W / 2
dv = v - H / 2

X = Cx + s * (du * cos(theta) - dv * sin(theta))
Z = Cz + s * (du * sin(theta) + dv * cos(theta))
```

At zero rotation, image-right maps to +X and image-down maps to +Z, matching the inherited top-down convention. The inverse transform should live beside the forward transform for future tracing/picking and for round-trip tests, even if the first UI only needs forward rendering.

This representation directly covers world position, uniform scale, and rotation; preserves the raster aspect ratio; can map every source pixel repeatably; and does not depend on Three.js texture flipping, plane geometry dimensions, a transform-control pivot, or component state. The renderer derives a plane of `W*s` by `H*s`, centered at `[Cx, fixedReferenceY, Cz]`. Because a Three.js plane rotated flat maps its local positive Y toward -Z, the renderer uses the documented sign conversion from persisted clockwise `theta` to its Y Euler rotation. Unit tests, not visual intuition, pin that conversion.

The management UI edits canonical fields (center X, center Z, world units per pixel, rotation shown in degrees but converted to radians at the API boundary). It may show derived world width/height for feedback. Do not persist both width/height and scale, or both degrees and radians, because duplicate sources of truth can drift.

### 3.3 Asset handling

- Store files under `backend/uploads/reference_layers/`. The existing `/uploads` static mount, security headers, Vite proxy, nginx proxy, Docker bind mount, and repository exclusions already cover this directory.
- Accept actual PNG and JPEG rasters initially. Add a `reference_layer` limit to `uploadConstraints.js`; reuse the battle-map 250 MB ceiling initially so the known Imperial artwork is not prematurely excluded, while keeping disk-streaming behavior.
- The frontend may decode a selected file (`createImageBitmap` or an image element fallback) for fast rejection and preview, but client-reported MIME type, extension, width, and height are not canonical metadata.
- After streaming the upload to a private `.tmp` directory, the backend uses a focused image-metadata dependency (for example, `image-size`) to inspect the bytes without introducing a general image-processing stack. It must reject corrupt data and any decoded format other than PNG/JPEG, and take authoritative intrinsic width, height, and canonical format from that inspection.
- Hash the verified bytes in chunks, use the database-unique SHA-256 digest for deduplication, and derive the final `.png` or `.jpg` storage extension from the server-detected format rather than the uploader's filename. Rename to `<sha256>.<canonical-ext>`, remove rejected/failed temporary files, and sweep abandoned temporary files only within that temp directory.
- A duplicate upload resolves to the existing `reference_assets` row under the unique hash. Its stored server-verified format and dimensions remain authoritative; uploader-provided metadata cannot alter them.
- `GET /api/reference-layers/assets` lists asset-table records for a primary world editor; it does not infer domain state by scanning arbitrary files in the directory. Creating from an existing asset submits its integer asset ID.
- Deleting a layer removes its asset row and file only when no other reference-layer row uses the asset ID. File cleanup failure must not roll back a successful database transaction; it leaves a safe unlisted orphan that can be reported/logged. Do not share or search the battle-map directory.

The database row and uploaded file together are persistent runtime data. Neither is committed to Git. This is persistence, not an independent backup: an operator backup must copy both the database storage and uploads storage to independent media. No backup implementation is included in this slice.

### 3.4 Backend/API

Add a dedicated router mounted at `/api/reference-layers`:

- `GET /` — public read of all layers in stable `id` order, with SQLite booleans normalized to JSON booleans and numeric fields normalized to numbers.
- `GET /assets` — world-editor-only inventory for the asset picker.
- `POST /upload` — world-editor-only multipart upload plus name and initial calibration/display fields; verifies raster format/dimensions from the bytes, stores or reuses the asset, and creates one layer atomically from the client's perspective.
- `POST /` — world-editor-only creation from a validated existing reference asset ID.
- `PATCH /:id` — world-editor-only partial update of name, calibration, opacity, visibility, and lock state. Asset identity and source dimensions are immutable; changing sources means creating a new layer.
- `DELETE /:id` — world-editor-only deletion plus unreferenced-asset cleanup.

All write responses return the normalized resulting layer where applicable. Every successful mutation calls the existing `emitUpdate` once. Use parameterized SQL and a transaction for row mutations that require a read/check/write sequence.

Lock behavior is enforced server-side:

- A locked layer rejects name or calibration changes and deletion with 409.
- A locked layer may change opacity or visibility and may be unlocked.
- A request may not unlock and alter calibration/delete in one operation; unlocking is a deliberate first request.
- `asset_id` and source dimensions are immutable for both locked and unlocked layers. Using another source always creates a new layer.

No reference-layer endpoint creates a location, battle map, water polygon, road, collision object, or generator input.

### 3.5 Authorization

Add a reusable `requireWorldEditor` middleware in `backend/middleware/auth.js`. It runs after `authenticate` and permits only a verified JWT with `role === 'admin'` and `isTemporary === false`. This implements the current primary-administrator boundary without inventing a larger role system.

Apply `authenticate, requireWorldEditor` to every mutation and to the asset inventory. Public `GET /api/reference-layers` remains readable because the world scene is shared and the referenced assets are already served publicly. Frontend `isPrimaryAdmin` controls whether management UI is shown, but is never treated as the security boundary.

Do not broaden this work into retrofitting all inherited world-mutating routes. Record route-level authorization tests for this new privileged surface.

### 3.6 Frontend state and rendering

Create a cohesive `frontend/src/modules/referenceLayers/` feature containing:

- `types.ts` for `ReferenceLayer` and write payloads (or export the public type through `frontend/src/types.ts` if required by `App.tsx`);
- `calibration.ts` for forward/inverse source↔world math and renderer-derived dimensions/rotation;
- `ReferenceLayers.tsx` for texture lifecycle and non-interactive planes;
- `ReferenceLayerManager.tsx` for list, upload/select-existing, calibration/display editing, lock/unlock, and delete confirmation.

Extend `useMapData` with `referenceLayers`, its setter, `fetchReferenceLayers`, and inclusion in `fetchAll`. Extend `useSocket` with `onFetchReferenceLayers` and call it from the existing `dataUpdated` listener. Keep the current generic broadcast; reference-layer mutations are infrequent, so a new event and patch-merging protocol add no value in this slice.

`App.tsx` should make only integration changes: receive the new collection/hook callback, render `<ReferenceLayers>` inside the canonical-world branch, own the manager-open flag, and pass one launcher callback to `AdminPanel`. The AdminPanel CITY tab shows `REFERENCE_LAYERS` only to `isPrimaryAdmin`; the full UI is not implemented inline there.

Rendering rules:

- Render only when `is_visible` is true and only in the world branch, never under `BattleMapScene`.
- Derive plane size and transform solely from persisted calibration via `calibration.ts`.
- Render each layer as one texture on one plane. The known 6032 × 4584 target artwork is accepted evidence for this initial path; do not add tiling/chunking in this slice.
- Place planes at a small fixed Y below world overlays and separate multiple layers by a deterministic tiny offset/order to prevent z-fighting. Do not persist Y.
- Use transparent unlit materials with persisted opacity, disable depth writes as needed for predictable overlay composition, disable raycasting, and attach no physics/collision or selection handlers.
- Load textures in an effect with a failure state and dispose texture/material resources on unmount so a missing/corrupt asset does not take down the whole Canvas.

The manager keeps form drafts locally. While a selected layer is being edited, its local draft calibration and display values may override that layer in the local renderer so the world view previews adjustments immediately; all other clients and the canonical map-data state continue to use persisted values. `Apply` sends one commit through the API, after which canonical state is replaced/refetched and the server emits the inherited update. Cancel/discard clears the preview and returns rendering to persisted values without an API request or Socket.IO event. This preview does not require TransformControls, on-canvas dragging, or another realtime protocol.

On API failure the manager retains the draft and local preview and shows the server message. Locked rows disable name/calibration/delete controls but retain visibility, opacity, and Unlock controls. Source selection is never offered for an existing layer, whether locked or unlocked. This UI behavior mirrors, but does not replace, the backend enforcement.

### 3.7 State synchronization

Realtime synchronization is needed so multiple connected viewers see committed canonical visibility, opacity, lock, and calibration changes without reload. The minimal mechanism is the existing server-wide `dataUpdated` emission and client refetch path. Local draft previews remain client-only and emit nothing. Do not send image bytes or draft/gizmo movement over Socket.IO, and do not add collaborative calibration cursors.

### 3.8 Legacy snapshots and backups

Do not add reference-layer blobs or asset files to `saved_maps` in this slice. The inherited save/load code has known unrelated round-trip loss and is explicitly legacy snapshot behavior; partially presenting it as a complete RUBY_WHEEL snapshot would be misleading. Reference-layer rows remain canonical and are not deleted or replaced by legacy map load/clear operations. Add a regression test for that preservation boundary.

This means legacy saved maps are not a rollback mechanism for reference-layer edits. A future bounded snapshot-fidelity package must version the complete logical snapshot and include reference-layer metadata. Even then, external assets remain separate: a true backup must independently copy both database and required upload files. The manager and documentation must not label an in-database save as a reference-layer backup.

## 4. Ordered implementation work packages

### WP1 — Establish authorization and ordered schema startup

1. Add `requireWorldEditor` and focused middleware tests for missing, player, temporary-admin, and primary-admin credentials.
2. Add the minimal ordered migration runner and `schema_migrations` ledger.
3. Add the reference-layer migration and database-ready promise; wait for it before the server listens.
4. Test migration against both an empty database and a representative pre-feature database, including idempotent second startup and preservation of existing rows.

Exit criterion: the server cannot accept requests before the additive schema exists, and only the primary administrator passes the reusable world-editor boundary.

### WP2 — Implement reference assets and REST persistence

1. Add the upload constraint, focused raster-metadata dependency, and dedicated `uploads/reference_layers` lifecycle.
2. Implement server-side byte/format/dimension verification, canonical extension selection, unique-hash deduplication, normalized row serialization, request validation, lock rules, CRUD/from-existing/upload endpoints, and safe unreferenced-file cleanup.
3. Mount the router and emit one inherited `dataUpdated` event after each successful mutation.
4. Add backend route/upload tests, including direct attempts to bypass frontend lock and authorization controls.

Exit criterion: API tests prove persistence, validation, authorization, lock semantics, asset reuse, and cleanup without touching other world tables.

### WP3 — Add calibration math and world rendering

1. Add the reference-layer types and pure forward/inverse calibration helpers.
2. Unit-test center/corners, zero and quarter-turn rotations, inverse round trips, and derived Three.js rotation sign.
3. Add the texture-backed, resource-disposing, raycast-disabled `ReferenceLayers` renderer.
4. Wire reference-layer loading into `useMapData`, `App.tsx`, and the world-only scene branch.

Exit criterion: persisted fixtures render at their mathematically expected X/Z bounds and the battle-map branch remains unchanged.

### WP4 — Add the dedicated management workflow

1. Add the primary-admin launcher to the AdminPanel CITY tab.
2. Implement layer listing and selection, client-side PNG/JPEG preview validation, upload, existing-asset selection for new layers, canonical calibration fields, derived dimensions, opacity/visibility, lock/unlock, and confirmed delete.
3. Keep canonical state in the map-data hook and local unsaved values in the manager draft; let that draft drive a client-only visual preview until Apply or Cancel, and surface server errors without silently discarding edits.
4. Add component tests for upload/preview behavior, API payload conversion, local preview Apply/Cancel behavior, locked-control behavior, permitted display controls, immutable source identity, and destructive confirmation.

Exit criterion: a primary administrator can complete the entire import→calibrate→display→lock workflow without using developer tools.

### WP5 — Realtime, legacy-boundary, and regression verification

1. Add reference-layer refetch to the existing `dataUpdated` handler and verify one client's committed change refreshes another client.
2. Add a backend regression proving legacy map load/clear leaves canonical reference layers intact; do not claim saved maps are reference-layer backups.
3. Run targeted tests, full backend/frontend suites, and the frontend production build.
4. Perform the human browser verification below, including restart persistence and unchanged generator/battle-map behavior.

Exit criterion: automated and live checks pass with no reference-layer-specific alternate world, snapshot, or socket model.

## 5. Testing and human verification

### Automated coverage

Backend tests should cover:

- ordered migration on new and existing databases, ledger/idempotency, and startup readiness;
- public list behavior and normalized response types;
- 401 for unauthenticated writes, 403 for player and elevated temporary-admin tokens, and success only for the primary-admin token;
- byte-verified PNG/JPEG acceptance, corrupt/disguised-file and other-format rejection regardless of filename/MIME claim, authoritative dimensions, canonical extension selection, size error shape, temp cleanup, database-enforced unique-hash deduplication, and asset inventory filtering;
- create-from-upload and create-from-existing, finite/range validation, immutable source metadata, PATCH semantics, and missing-row responses;
- locked transform/name/delete rejection, allowed visibility/opacity changes, separate unlock, and non-replaceable/imported defaults;
- shared-asset reference counting on delete and harmless orphan behavior on file-cleanup failure;
- one update emission per successful mutation and none for rejected writes;
- legacy saved-map load/clear preserving reference-layer rows.

Frontend tests should cover:

- source-pixel↔world mapping and inverse round-trip with non-origin centers and rotations;
- derived plane dimensions/orientation from persisted fields, with no reliance on mutable mesh state;
- hidden layers not rendering, opacity propagation, raycast disabled, resource disposal, and a failed texture load isolated to that layer;
- map-data initial fetch and socket-triggered refetch;
- manager file preview validation, radians/degrees conversion, create-from-existing, local draft preview with Apply/Cancel/error behavior, visibility/opacity, lock/unlock, immutable source controls, and confirmed delete;
- primary-admin-only management launcher while normal viewers still render public layers;
- the existing `BattleMapScene` path receiving no reference layer.

Required commands after implementation:

```text
cd backend
npm test

cd frontend
npm test
npm run build
```

### Human UI verification

1. Start with an existing CITY_NET database and confirm the app boots and the new layer list is empty without altering inherited map data.
2. As primary admin, upload one PNG and one JPEG, including the **6032 × 4584** Imperial City artwork. Confirm the server reports authoritative dimensions, the target renders as a single texture/plane, and neither asset appears in battle-map management.
3. Use an image with known marked pixels. At zero rotation verify center and corner positions against the world grid; repeat at 90 degrees and after changing scale. Confirm +X/right and +Z/down orientation. Adjust draft calibration and opacity repeatedly and verify the local world preview changes before Apply, Cancel restores persisted rendering, and another client sees nothing until Apply.
4. Reload the browser, restart the backend, and verify calibration, opacity, visibility, and lock state are unchanged.
5. Toggle visibility and opacity while locked. Confirm calibration/delete are disabled, then attempt the same mutations directly through the API and verify rejection. Unlock in a separate action, edit, relock, and verify success.
6. Open a second client and verify committed changes appear through realtime refresh without transmitting the raster over Socket.IO.
7. Confirm clicking/tracing/drawing over the image still reaches world editing tools and that city generation, purge selection, map export behavior, and battle-map entry remain unchanged. Reference imagery must not appear in generator obstacle data.
8. Create or load a legacy saved map and clear the inherited active map; verify reference layers remain intact and the UI does not describe that legacy snapshot as a backup of reference assets.
9. Delete one of two layers sharing an asset and confirm the other still renders; delete the final reference and confirm the asset is no longer offered.

## 6. Explicit non-goals

- Converting raster content into canonical geometry, obstacles, districts, water, roads, landmarks, or procedural inputs.
- Changing Imperial generator semantics, profiles, archetypes, urban-fabric persistence, canals, food systems, campaigns, UESRPG, or ordinary location provenance.
- Non-uniform, skewed, perspective, geospatial/CRS, or rubber-sheet calibration.
- Image editing, tiling, pyramids, automatic tracing, feature recognition, or remote-URL import.
- Video/SVG/TIFF reference layers or sharing battle-map asset records.
- Collaborative live dragging, per-user visibility, campaign-specific layers, or a new realtime protocol.
- A broad authentication/role redesign or authorization retrofit of unrelated inherited routes.
- Repairing/versioning the complete legacy saved-map snapshot format or implementing backup/export/restore of database and assets.
- Replacing SQLite, React Three Fiber, Three.js, the existing Canvas, or the generic `dataUpdated` mechanism.
- Refactoring `App.tsx` or `AdminPanel.tsx` beyond the narrow integration seams named above.

## 7. Risks or unresolved decisions

There is no blocking product or architecture decision for this slice.

Implementation risks to manage within the plan:

- The known target is 6032 × 4584 pixels and is accepted for single-texture/single-plane rendering in this slice. Texture failures must still be isolated to the affected layer. Tiling may be reconsidered only as a future fallback if substantially larger assets or measured deployment limits require it.
- Browser texture orientation and Three.js Y-rotation signs are easy to reverse. The persisted formula, conversion helper, unit fixtures, and marked-image verification are mandatory acceptance evidence.
- Database metadata and uploaded files occupy separate persistent paths. Deleting, moving, or backing up only one creates broken references; error rendering and clear operational wording must make that visible without pretending a same-volume snapshot is a backup.
- The inherited generic update event refetches several collections. This is acceptable for infrequent explicit Apply operations; do not PATCH continuously on every slider input. A targeted event is justified only if measurement later shows a problem.
- Legacy saved maps remain incomplete snapshots. Preserving reference layers across their destructive load/clear behavior is the conservative boundary for this slice, but it does not make those saved maps complete RUBY_WHEEL snapshots.

## 8. Expected files likely to change

Directional list for implementation; discovery may identify adjacent test fixtures or styles:

```text
backend/db.js
backend/server.js
backend/package.json
backend/package-lock.json
backend/middleware/auth.js
backend/middleware/uploadConstraints.js
backend/migrations/index.js
backend/migrations/001-reference-layers.js
backend/routes/reference_layers.js
backend/__tests__/helpers/testDb.js
backend/__tests__/reference_layers.test.js
backend/__tests__/migrations.test.js
backend/__tests__/maps.global.test.js (or a focused equivalent)

frontend/src/types.ts
frontend/src/hooks/useMapData.ts
frontend/src/hooks/useSocket.ts
frontend/src/App.tsx
frontend/src/components/AdminPanel.tsx
frontend/src/modules/referenceLayers/types.ts
frontend/src/modules/referenceLayers/calibration.ts
frontend/src/modules/referenceLayers/ReferenceLayers.tsx
frontend/src/modules/referenceLayers/ReferenceLayerManager.tsx
frontend/src/modules/referenceLayers/__tests__/calibration.test.ts
frontend/src/modules/referenceLayers/__tests__/ReferenceLayers.test.tsx
frontend/src/modules/referenceLayers/__tests__/ReferenceLayerManager.test.tsx
frontend/src/hooks/__tests__/useSocket.pendingRequests.test.ts (or a focused socket-refresh test)
```

No generator module, battle-map table/route/component, `locations` schema, Docker volume, requirements document, or architecture document should need modification for this capability.
