/**
 * Reference layers: persistent calibrated raster underlays for the canonical world.
 *
 * Two tables rather than columns on `locations` or `battle_maps`. An asset is the stored
 * raster and the dimensions the server read out of its bytes; a layer is one placement of
 * an asset in world X/Z. Keeping them apart is what stops the same file acquiring two
 * conflicting pixel sizes when it is used by two layers — the dimensions belong to the
 * bytes, not to the placement.
 *
 * Additive only. A database that has never seen this feature gains two empty tables and
 * nothing else changes; no existing row is read, rewritten, or reinterpreted as a layer.
 */
module.exports = {
  name: '001-reference-layers',

  async up({ run }) {
    // `content_hash` is unique in the table, not merely checked before insert: the
    // deduplication rule is what keeps a 250MB ceiling from becoming a disk problem, and
    // a rule enforced only in a route is a rule two concurrent uploads can break.
    await run(`CREATE TABLE IF NOT EXISTS reference_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_hash TEXT NOT NULL UNIQUE,
      asset_url TEXT NOT NULL UNIQUE,
      original_name TEXT,
      format TEXT NOT NULL CHECK (format IN ('png', 'jpeg')),
      source_width_px INTEGER NOT NULL CHECK (source_width_px > 0),
      source_height_px INTEGER NOT NULL CHECK (source_height_px > 0),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_reference_assets_content_hash
               ON reference_assets(content_hash)`);

    // The calibration columns are a renderer-independent 2D similarity transform: where
    // the image centre sits in world X/Z, how many world units one source pixel is worth,
    // and a clockwise rotation. Nothing here is a Three.js plane size or a pivot, so the
    // same row maps the same pixel to the same place whatever draws it.
    //
    // `provenance` and `replacement_state` are stored rather than inferred. This slice
    // only ever writes 'imported' / 'non_replaceable', but a layer being replaceable is a
    // separate decision from where it came from or whether someone locked it, and reading
    // one off the other is how those three quietly become one.
    await run(`CREATE TABLE IF NOT EXISTS reference_layers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL CHECK (length(name) > 0 AND length(name) <= 120),
      asset_id INTEGER NOT NULL REFERENCES reference_assets(id),
      world_center_x REAL NOT NULL DEFAULT 0,
      world_center_z REAL NOT NULL DEFAULT 0,
      world_units_per_pixel REAL NOT NULL CHECK (world_units_per_pixel > 0),
      rotation_rad REAL NOT NULL DEFAULT 0,
      opacity REAL NOT NULL DEFAULT 1 CHECK (opacity >= 0 AND opacity <= 1),
      is_visible INTEGER NOT NULL DEFAULT 1 CHECK (is_visible IN (0, 1)),
      is_locked INTEGER NOT NULL DEFAULT 0 CHECK (is_locked IN (0, 1)),
      provenance TEXT NOT NULL DEFAULT 'imported' CHECK (provenance IN ('imported')),
      replacement_state TEXT NOT NULL DEFAULT 'non_replaceable'
        CHECK (replacement_state IN ('non_replaceable')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    await run(`CREATE INDEX IF NOT EXISTS idx_reference_layers_asset_id
               ON reference_layers(asset_id)`);
  },
};
