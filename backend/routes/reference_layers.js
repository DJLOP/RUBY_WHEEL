const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { imageSize } = require('image-size');
const { authenticate, requireWorldEditor } = require('../middleware/auth');
const { LIMITS, rejectFormat, uploadErrors } = require('../middleware/uploadConstraints');

/**
 * Reference layers: calibrated raster underlays for the canonical world.
 *
 * Deliberately not modelled on `battle_maps`, which this resembles only in that both
 * accept an image. A battle map is scenery for one location on a fixed 200-unit plane; a
 * reference layer is a measured drawing of the city, and its whole value is that a pixel
 * lands at a known world coordinate and stays there. So the calibration is persisted as a
 * renderer-independent transform, and the source's own dimensions are read out of its
 * bytes rather than taken from whatever the browser said.
 *
 * What the uploader claims — MIME type, extension, width, height — is a hint for the file
 * picker and nothing else. Every one of those is settable by the caller, and a layer whose
 * stored dimensions disagree with its pixels is a layer that maps every coordinate wrong.
 */

/** The two formats this slice renders. Held as canonical names, not as extensions. */
const FORMATS = {
  png: { ext: '.png', accepts: ['png'] },
  jpeg: { ext: '.jpg', accepts: ['jpg', 'jpeg'] },
};
const ALLOWED_UPLOAD_NAMES = ['.png', '.jpg', '.jpeg'];

/** Fixed for this slice. Stored per row rather than inferred; see the migration. */
const PROVENANCE = 'imported';
const REPLACEMENT_STATE = 'non_replaceable';

/** Calibration and identity: refused on a locked layer. */
const PROTECTED_FIELDS = ['name', 'world_center_x', 'world_center_z', 'world_units_per_pixel', 'rotation_rad'];
/** Display state: always editable, because hiding a layer is not editing the city. */
const DISPLAY_FIELDS = ['opacity', 'is_visible'];
/** Never writable through any route: the source is chosen once, at creation. */
const IMMUTABLE_FIELDS = ['asset_id', 'source_width_px', 'source_height_px', 'format', 'asset_url', 'content_hash'];

const NAME_MAX = 120;

module.exports = (db, io, { emitUpdate }) => {
  const router = express.Router();

  const uploadsDir = path.join(__dirname, '../uploads/reference_layers');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  const tmpDir = path.join(uploadsDir, '.tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  // ── database helpers ───────────────────────────────────────────────────────

  const run = (sql, params = []) => new Promise((resolve, reject) =>
    db.run(sql, params, function (err) { err ? reject(err) : resolve(this); }));
  const get = (sql, params = []) => new Promise((resolve, reject) =>
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
  const all = (sql, params = []) => new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));

  /**
   * Run `body` inside a transaction, rolling back if it throws.
   *
   * Every mutation here is a read, a check and a write — "is this layer locked, and is its
   * asset still used by anything else" — and a check that is not in the same transaction
   * as the write it guards is a check two requests can both pass.
   */
  const transact = async (body) => {
    await run('BEGIN IMMEDIATE');
    try {
      const result = await body();
      await run('COMMIT');
      return result;
    } catch (err) {
      try { await run('ROLLBACK'); } catch { /* the original failure is the one to report */ }
      throw err;
    }
  };

  // ── uploads ────────────────────────────────────────────────────────────────

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, tmpDir),
      // Renamed to its content hash once complete; a partial upload must never collide
      // with a finished one, so this name is deliberately meaningless.
      filename: (req, file, cb) => cb(null, `part_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`),
    }),
    limits: { fileSize: LIMITS.reference_layer },
    // Records the name only. The size limit aborts before any handler runs, and its error
    // carries a field name rather than a filename, so without this a person is told "that
    // file" is too large and not which one.
    fileFilter: (req, file, cb) => { req.uploadFilename = file.originalname; cb(null, true); },
  });

  const refUploadErrors = uploadErrors({ allowed: ALLOWED_UPLOAD_NAMES, maxBytes: LIMITS.reference_layer });

  const discard = (file) => { if (file && file.path) fs.unlink(file.path, () => {}); };

  /**
   * Whatever a killed process left in the temp directory, and nothing else.
   *
   * It reads `tmpDir` only. Stored layers live one directory up and are never enumerated,
   * whatever their age — this deletes files automatically, next to everyone's imports.
   */
  const sweepAbandonedUploads = (olderThanMs = 60 * 60 * 1000, now = Date.now()) => {
    let removed = 0;
    try {
      for (const name of fs.readdirSync(tmpDir)) {
        const p = path.join(tmpDir, name);
        try {
          if (now - fs.statSync(p).mtimeMs > olderThanMs) { fs.unlinkSync(p); removed++; }
        } catch { /* vanished under us, which is the outcome we wanted */ }
      }
    } catch { /* no temp directory yet */ }
    return removed;
  };
  sweepAbandonedUploads();

  const hashFile = (filepath) => new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const stream = fs.createReadStream(filepath);
    stream.on('data', (chunk) => h.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(h.digest('hex')));
  });

  /**
   * What the bytes actually are, or null.
   *
   * The returned format and dimensions are the only ones this feature ever stores. A file
   * named `.png` containing a JPEG is accepted as the JPEG it is and stored as `.jpg`;
   * a GIF named `.png` is refused, however the picker described it.
   */
  const inspectRaster = (filepath) => {
    let meta;
    try {
      meta = imageSize(fs.readFileSync(filepath));
    } catch {
      return null;
    }
    if (!meta || !Number.isInteger(meta.width) || !Number.isInteger(meta.height)) return null;
    if (meta.width <= 0 || meta.height <= 0) return null;
    const format = Object.keys(FORMATS).find(f => FORMATS[f].accepts.includes(String(meta.type).toLowerCase()));
    if (!format) return null;
    return { format, width: meta.width, height: meta.height };
  };

  // ── validation ─────────────────────────────────────────────────────────────

  class Invalid extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
  }

  const finite = (value, field) => {
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(n)) throw new Invalid(`${field} must be a finite number`);
    return n;
  };

  const boolish = (value, field) => {
    if (typeof value === 'boolean') return value;
    const s = String(value).trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
    throw new Invalid(`${field} must be true or false`);
  };

  const cleanName = (value) => {
    if (typeof value !== 'string') throw new Invalid('name is required');
    const trimmed = value.trim();
    if (!trimmed) throw new Invalid('name is required');
    if (trimmed.length > NAME_MAX) throw new Invalid(`name must be ${NAME_MAX} characters or fewer`);
    return trimmed;
  };

  const validators = {
    name: cleanName,
    world_center_x: (v) => finite(v, 'world_center_x'),
    world_center_z: (v) => finite(v, 'world_center_z'),
    rotation_rad: (v) => finite(v, 'rotation_rad'),
    world_units_per_pixel: (v) => {
      const n = finite(v, 'world_units_per_pixel');
      if (n <= 0) throw new Invalid('world_units_per_pixel must be greater than zero');
      return n;
    },
    opacity: (v) => {
      const n = finite(v, 'opacity');
      if (n < 0 || n > 1) throw new Invalid('opacity must be between 0 and 1');
      return n;
    },
    is_visible: (v) => boolish(v, 'is_visible'),
    is_locked: (v) => boolish(v, 'is_locked'),
  };

  const present = (body, field) => body[field] !== undefined && body[field] !== null && body[field] !== '';

  /** Reject any attempt to write a field that is immutable for the life of a layer. */
  const refuseImmutable = (body, { allowAssetId = false } = {}) => {
    for (const field of IMMUTABLE_FIELDS) {
      if (allowAssetId && field === 'asset_id') continue;
      if (body[field] !== undefined) {
        throw new Invalid(`${field} cannot be changed; create a new layer to use a different source`);
      }
    }
  };

  /** The calibration and display values for a brand-new layer, with documented defaults. */
  const readCreateFields = (body) => ({
    name: cleanName(body.name),
    world_center_x: present(body, 'world_center_x') ? validators.world_center_x(body.world_center_x) : 0,
    world_center_z: present(body, 'world_center_z') ? validators.world_center_z(body.world_center_z) : 0,
    world_units_per_pixel: present(body, 'world_units_per_pixel') ? validators.world_units_per_pixel(body.world_units_per_pixel) : 1,
    rotation_rad: present(body, 'rotation_rad') ? validators.rotation_rad(body.rotation_rad) : 0,
    opacity: present(body, 'opacity') ? validators.opacity(body.opacity) : 1,
    is_visible: present(body, 'is_visible') ? validators.is_visible(body.is_visible) : true,
    is_locked: present(body, 'is_locked') ? validators.is_locked(body.is_locked) : false,
  });

  // ── serialization ──────────────────────────────────────────────────────────

  const LAYER_SELECT = `
    SELECT l.id, l.name, l.asset_id,
           l.world_center_x, l.world_center_z, l.world_units_per_pixel, l.rotation_rad,
           l.opacity, l.is_visible, l.is_locked, l.provenance, l.replacement_state,
           l.created_at, l.updated_at,
           a.asset_url, a.original_name, a.format, a.source_width_px, a.source_height_px, a.content_hash
      FROM reference_layers l
      JOIN reference_assets a ON a.id = l.asset_id`;

  /**
   * One layer as JSON.
   *
   * SQLite hands back integers for booleans and, for a column whose value arrived as a
   * string, sometimes a string for a number. A renderer multiplying `"0.5"` by a width
   * gets a string back, so the normalisation happens once, here, rather than in every
   * client that reads a layer.
   */
  const serialize = (row) => ({
    id: Number(row.id),
    name: row.name,
    asset_id: Number(row.asset_id),
    asset_url: row.asset_url,
    original_name: row.original_name,
    format: row.format,
    source_width_px: Number(row.source_width_px),
    source_height_px: Number(row.source_height_px),
    world_center_x: Number(row.world_center_x),
    world_center_z: Number(row.world_center_z),
    world_units_per_pixel: Number(row.world_units_per_pixel),
    rotation_rad: Number(row.rotation_rad),
    opacity: Number(row.opacity),
    is_visible: !!row.is_visible,
    is_locked: !!row.is_locked,
    provenance: row.provenance,
    replacement_state: row.replacement_state,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });

  const serializeAsset = (row) => ({
    id: Number(row.id),
    asset_url: row.asset_url,
    original_name: row.original_name,
    format: row.format,
    source_width_px: Number(row.source_width_px),
    source_height_px: Number(row.source_height_px),
    content_hash: row.content_hash,
    created_at: row.created_at,
  });

  const loadLayer = (id) => get(`${LAYER_SELECT} WHERE l.id = ?`, [id]);

  /** Turn a thrown `Invalid` into its response, and anything else into a 500. */
  const fail = (res, err) => {
    if (err instanceof Invalid) return res.status(err.status).json({ error: err.message });
    return res.status(500).json({ error: err && err.message ? err.message : 'Unexpected error' });
  };

  // ── routes ─────────────────────────────────────────────────────────────────

  // Public: the world scene is shared, and the assets themselves are already served
  // without authentication from /uploads. Hiding the list would hide nothing.
  router.get('/', async (req, res) => {
    try {
      const rows = await all(`${LAYER_SELECT} ORDER BY l.id ASC`);
      res.json(rows.map(serialize));
    } catch (err) { fail(res, err); }
  });

  // The asset picker's inventory. This reads the table, not the directory: a file on disk
  // with no row is an orphan, and offering it would let a stale file become a layer.
  router.get('/assets', authenticate, requireWorldEditor, async (req, res) => {
    try {
      const rows = await all('SELECT * FROM reference_assets ORDER BY id ASC');
      res.json(rows.map(serializeAsset));
    } catch (err) { fail(res, err); }
  });

  /** Insert a layer against an asset id already known to exist. Caller owns the transaction. */
  const insertLayer = async (assetId, fields) => {
    const result = await run(
      `INSERT INTO reference_layers
         (name, asset_id, world_center_x, world_center_z, world_units_per_pixel, rotation_rad,
          opacity, is_visible, is_locked, provenance, replacement_state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [fields.name, assetId, fields.world_center_x, fields.world_center_z,
       fields.world_units_per_pixel, fields.rotation_rad, fields.opacity,
       fields.is_visible ? 1 : 0, fields.is_locked ? 1 : 0, PROVENANCE, REPLACEMENT_STATE]
    );
    return result.lastID;
  };

  // Upload a source and create a layer from it in one request.
  router.post('/upload', authenticate, requireWorldEditor, upload.single('image'), refUploadErrors, async (req, res) => {
    // From here on, every path out has a temporary file to clean up behind it.
    let fields;
    try {
      refuseImmutable(req.body);
      fields = readCreateFields(req.body);
    } catch (err) {
      discard(req.file);
      return fail(res, err);
    }

    if (!req.file) return res.status(400).json({ error: 'An image file is required' });

    const raster = inspectRaster(req.file.path);
    if (!raster) {
      discard(req.file);
      return rejectFormat(res, {
        file: req.file,
        allowed: ALLOWED_UPLOAD_NAMES,
        maxBytes: LIMITS.reference_layer,
      });
    }

    let hash;
    try {
      hash = await hashFile(req.file.path);
    } catch {
      discard(req.file);
      return res.status(500).json({ error: 'Could not read the uploaded file.' });
    }

    // The canonical extension comes from the detected format, never from the upload's
    // name: /uploads serves by the name on disk, so the name is a content-type decision.
    const filename = hash + FORMATS[raster.format].ext;
    const filepath = path.join(uploadsDir, filename);
    const assetUrl = '/uploads/reference_layers/' + filename;
    const originalName = path.basename(String(req.file.originalname || '')).slice(0, 255);

    let storedNewFile = false;
    try {
      const layerId = await transact(async () => {
        // Deduplicated by content hash, which is unique in the table. An upload of bytes
        // already here resolves to the existing asset, and its stored dimensions stay
        // authoritative — a second uploader cannot restate the size of the first's file.
        let asset = await get('SELECT * FROM reference_assets WHERE content_hash = ?', [hash]);
        if (!asset) {
          if (fs.existsSync(filepath)) {
            // A file with no row: the row is the record, so take the file over rather
            // than adopting whatever an interrupted earlier run left behind.
            fs.unlinkSync(filepath);
          }
          fs.renameSync(req.file.path, filepath);
          storedNewFile = true;
          const inserted = await run(
            `INSERT INTO reference_assets
               (content_hash, asset_url, original_name, format, source_width_px, source_height_px)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [hash, assetUrl, originalName, raster.format, raster.width, raster.height]
          );
          asset = { id: inserted.lastID };
        }
        return insertLayer(asset.id, fields);
      });

      discard(req.file);
      const layer = await loadLayer(layerId);
      emitUpdate();
      return res.status(201).json(layer ? serialize(layer) : null);
    } catch (err) {
      discard(req.file);
      // The transaction took the asset row back out, so the file it named is referenced by
      // nothing. Removing it here keeps a failed upload from leaving storage behind.
      if (storedNewFile) { try { fs.unlinkSync(filepath); } catch { /* already gone */ } }
      return fail(res, err);
    }
  });

  // Create a layer from a source already uploaded. The client submits the asset's id —
  // not a URL or a filename — so there is nothing here to point at an arbitrary file.
  router.post('/', authenticate, requireWorldEditor, express.json(), async (req, res) => {
    try {
      refuseImmutable(req.body, { allowAssetId: true });
      const assetId = Number(req.body.asset_id);
      if (!Number.isInteger(assetId) || assetId <= 0) throw new Invalid('asset_id is required');
      const fields = readCreateFields(req.body);

      const layerId = await transact(async () => {
        const asset = await get('SELECT id FROM reference_assets WHERE id = ?', [assetId]);
        if (!asset) throw new Invalid('Reference asset not found', 404);
        return insertLayer(asset.id, fields);
      });

      const layer = await loadLayer(layerId);
      emitUpdate();
      res.status(201).json(serialize(layer));
    } catch (err) { fail(res, err); }
  });

  /**
   * Partial update, with the lock enforced here rather than in the browser.
   *
   * A locked layer is the point of locking: the calibration someone spent an evening
   * getting right must survive a stray drag, and a control that is merely disabled in the
   * UI survives nothing — the request it would have sent can still be sent by hand.
   *
   * Unlocking is its own request. Accepting `is_locked: false` alongside a new centre
   * would make the lock a formality: one request would still move the layer.
   */
  router.patch('/:id', authenticate, requireWorldEditor, express.json(), async (req, res) => {
    try {
      refuseImmutable(req.body);

      const touched = [...PROTECTED_FIELDS, ...DISPLAY_FIELDS, 'is_locked'].filter(f => req.body[f] !== undefined);
      if (!touched.length) throw new Invalid('No editable fields supplied');

      const updates = {};
      for (const field of touched) updates[field] = validators[field](req.body[field]);

      const layerId = await transact(async () => {
        const row = await get('SELECT id, is_locked FROM reference_layers WHERE id = ?', [req.params.id]);
        if (!row) throw new Invalid('Reference layer not found', 404);

        const protectedTouched = touched.filter(f => PROTECTED_FIELDS.includes(f));
        if (row.is_locked && protectedTouched.length) {
          throw new Invalid(
            `This layer is locked. Unlock it before changing ${protectedTouched.join(', ')}.`, 409
          );
        }

        const assignments = touched.map(f => `${f} = ?`).join(', ');
        const values = touched.map(f => (
          f === 'is_visible' || f === 'is_locked' ? (updates[f] ? 1 : 0) : updates[f]
        ));
        await run(
          `UPDATE reference_layers SET ${assignments}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [...values, row.id]
        );
        return row.id;
      });

      const layer = await loadLayer(layerId);
      emitUpdate();
      res.json(serialize(layer));
    } catch (err) { fail(res, err); }
  });

  router.delete('/:id', authenticate, requireWorldEditor, async (req, res) => {
    try {
      const orphanedUrl = await transact(async () => {
        const row = await get('SELECT id, asset_id, is_locked FROM reference_layers WHERE id = ?', [req.params.id]);
        if (!row) throw new Invalid('Reference layer not found', 404);
        if (row.is_locked) throw new Invalid('This layer is locked. Unlock it before deleting.', 409);

        await run('DELETE FROM reference_layers WHERE id = ?', [row.id]);

        // Reference counted in the same transaction as the delete, because two layers can
        // share one source: removing the file while the other still draws it would break
        // a layer nobody touched.
        const remaining = await get('SELECT COUNT(*) AS c FROM reference_layers WHERE asset_id = ?', [row.asset_id]);
        if (remaining.c > 0) return null;

        const asset = await get('SELECT asset_url FROM reference_assets WHERE id = ?', [row.asset_id]);
        await run('DELETE FROM reference_assets WHERE id = ?', [row.asset_id]);
        return asset ? asset.asset_url : null;
      });

      // Outside the transaction, and deliberately not able to undo it. A delete that
      // succeeded in the database but failed to unlink leaves one unreferenced file that
      // nothing lists; a rollback would instead resurrect a layer the person deleted.
      if (orphanedUrl) {
        const filePath = path.join(uploadsDir, path.basename(orphanedUrl));
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (err) {
          console.warn(`[reference_layers] deleted asset row but could not remove ${filePath}: ${err.message}`);
        }
      }

      emitUpdate();
      res.json({ message: 'Reference layer deleted' });
    } catch (err) { fail(res, err); }
  });

  router.sweepAbandonedUploads = sweepAbandonedUploads;
  return router;
};
