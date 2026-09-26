/**
 * Radial construction (plan §15): exact straight spokes cast from a center at
 * θₙ = θ₀ + n · (360° / N), each running from where the ray last leaves an inner closed
 * ring to where it first leaves an outer closed ring.
 *
 * Pure: no database, no Express. It knows only a center, two closed rings, N, θ₀ and the
 * explicitly omitted indices; it attaches no meaning to what the rings or spokes are. The
 * frontend mirror (`frontend/src/modules/canonicalGeography/radialConstruction.ts`) uses
 * the same constants and formulas for live preview; this module is the authority for
 * persisted geometry, and the two are held together by shared fixtures.
 *
 * The only new geometric capability is one ray against one closed ring (§15.5). There is
 * no clipping, no boolean operation and no dependency. Input rings are never modified.
 */

const { locatePointInRing, validateGeometry } = require('./geometry');
const { worldUnitsToMeters } = require('./physicalScale');

/** Perpendicular distance at which a ring vertex counts as lying on the ray (one grid step). */
const CONTACT_TOLERANCE_WU = 0.001;
/** Shortest spoke persisted. */
const MIN_SPOKE_LENGTH_WU = 1;
const MAX_SPOKE_COUNT = 360;
const ANGLE_CONVENTION = 'deg_from_+x_toward_+z';

const SCALE = 1000;
const roundCoordinate = (v) => {
  const r = Math.round(v * SCALE) / SCALE;
  return r === 0 ? 0 : r;
};
/** A point on the stored 0.001-wu grid. */
const roundPoint = (p) => ({ x: roundCoordinate(p.x), z: roundCoordinate(p.z) });

// ── parameters (§15.3.3, §15.4) ──────────────────────────────────────────────

/** θ₀ normalized to [0, 360) at 1e-6° resolution, exactly as the frontend mirror does it. */
function normalizeOffset(deg) {
  let o = ((deg % 360) + 360) % 360;
  o = Math.round(o * 1e6) / 1e6;
  if (o >= 360 || o === 0) o = 0;
  return o;
}

/** θₙ in degrees, evaluated in exactly this order in both mirrors. */
function spokeAngle(offset, n, count) {
  const step = 360 / count;
  const raw = offset + n * step;
  return raw >= 360 ? raw - 360 : raw;
}

/** Unit direction for θ degrees, exact on the axes. */
function direction(theta) {
  if (theta === 0) return { x: 1, z: 0 };
  if (theta === 90) return { x: 0, z: 1 };
  if (theta === 180) return { x: -1, z: 0 };
  if (theta === 270) return { x: 0, z: -1 };
  const r = (theta * Math.PI) / 180;
  return { x: Math.cos(r), z: Math.sin(r) };
}

/**
 * Validate the spoke parameters. Returns `{ ok: true, count, offset_deg, omit_indices }`
 * or `{ ok: false, issues }`. Nothing is rounded into validity: a non-integer N, a
 * non-finite offset, or an unsorted/duplicated/out-of-range omission is refused.
 */
function normalizeParams({ count, offset_deg: offset, omit_indices: omit }) {
  const issues = [];
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > MAX_SPOKE_COUNT) {
    issues.push({ code: 'invalid_count', message: `count must be an integer from 1 to ${MAX_SPOKE_COUNT}` });
  }
  if (typeof offset !== 'number' || !Number.isFinite(offset)) {
    issues.push({ code: 'invalid_offset', message: 'offset_deg must be a finite number of degrees' });
  }
  let omitted = [];
  if (omit !== undefined && omit !== null) {
    if (!Array.isArray(omit) || !omit.every(i => typeof i === 'number' && Number.isInteger(i))) {
      issues.push({ code: 'invalid_omit_indices', message: 'omit_indices must be an array of integer spoke indices' });
    } else {
      omitted = omit;
      if (omit.some((v, k) => k > 0 && v <= omit[k - 1])) {
        issues.push({ code: 'invalid_omit_indices', message: 'omit_indices must be sorted ascending with no repeats' });
      }
      if (!issues.length && omit.some(i => i < 0 || i >= count)) {
        issues.push({ code: 'invalid_omit_indices', message: `omit_indices must lie in [0, ${count})` });
      }
      if (!issues.length && omit.length >= count) {
        issues.push({ code: 'all_omitted', message: 'at least one spoke must remain; not every index can be omitted' });
      }
    }
  }
  if (issues.length) return { ok: false, issues };
  return { ok: true, count, offset_deg: normalizeOffset(offset), omit_indices: omitted.slice() };
}

// ── eligible boundaries (§15.3.1) ────────────────────────────────────────────

/**
 * The boundary ring of a stored geometry: a polygon's outer ring (holes ignored) or a
 * closed linestring without its repeated closing vertex. Returns `{ ok, ring }` or
 * `{ ok: false, reason }` for a point or an open linestring.
 */
function boundaryRing(geometryType, geometry) {
  if (geometryType === 'polygon') {
    const outer = geometry && Array.isArray(geometry.outer) ? geometry.outer : null;
    if (!outer || outer.length < 3) return { ok: false, reason: 'polygon has no usable outer ring' };
    return { ok: true, ring: outer };
  }
  if (geometryType === 'linestring') {
    const line = Array.isArray(geometry) ? geometry : [];
    const n = line.length;
    const closed = n > 3 && line[0].x === line[n - 1].x && line[0].z === line[n - 1].z;
    if (!closed) return { ok: false, reason: 'open linestring (only a closed linestring or a polygon is a boundary)' };
    return { ok: true, ring: line.slice(0, -1) };
  }
  return { ok: false, reason: `${geometryType} geometry is not a closed boundary` };
}

// ── one ray against one closed ring (§15.5) ──────────────────────────────────

/**
 * Where the ray from `c` along unit `d` meets `ring`, ahead of the center only
 * (t > CONTACT_TOLERANCE_WU):
 *
 *   crossings  [{t, point}] sorted by t — the ray passes from one side to the other;
 *   touches    [{t, point}] — a single on-ray vertex whose neighbours are on one side;
 *   overlaps   [{t_min, t_max, from, to}] — a run of two or more on-ray vertices (the ray
 *              runs along a boundary edge). These are reported, never classified.
 */
function rayRingContacts(c, d, ring) {
  const n = ring.length;
  const side = new Array(n);
  const along = new Array(n);
  for (let i = 0; i < n; i++) {
    const vx = ring[i].x - c.x;
    const vz = ring[i].z - c.z;
    const s = d.x * vz - d.z * vx;
    side[i] = Math.abs(s) <= CONTACT_TOLERANCE_WU ? 0 : s;
    along[i] = d.x * vx + d.z * vz;
  }
  const crossings = [];
  const touches = [];
  const overlaps = [];
  const forward = (t) => t > CONTACT_TOLERANCE_WU;

  const handleRun = (run, before, after) => {
    if (run.length === 1) {
      const i = run[0];
      if (!forward(along[i])) return;
      const contact = { t: along[i], point: { x: ring[i].x, z: ring[i].z } };
      if ((before > 0) !== (after > 0)) crossings.push(contact);
      else touches.push(contact);
      return;
    }
    if (!run.some(i => forward(along[i]))) return; // wholly at or behind the center
    let lo = run[0];
    let hi = run[0];
    for (const i of run) {
      if (along[i] < along[lo]) lo = i;
      if (along[i] > along[hi]) hi = i;
    }
    overlaps.push({
      t_min: along[lo], t_max: along[hi],
      from: { x: ring[lo].x, z: ring[lo].z }, to: { x: ring[hi].x, z: ring[hi].z },
    });
  };

  const start = side.findIndex(s => s !== 0);
  if (start === -1) {
    // Every vertex is on the ray line: one run (a degenerate ring; kept for completeness).
    handleRun([...Array(n).keys()], 0, 0);
  } else {
    let prev = start;
    let run = [];
    for (let step = 1; step <= n; step++) {
      const i = (start + step) % n;
      if (side[i] === 0) { run.push(i); continue; }
      if (run.length) {
        handleRun(run, side[prev], side[i]);
        run = [];
      } else if ((side[prev] > 0) !== (side[i] > 0)) {
        const a = ring[prev];
        const b = ring[i];
        const k = side[prev] / (side[prev] - side[i]);
        const point = { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k };
        const t = d.x * (point.x - c.x) + d.z * (point.z - c.z);
        if (forward(t)) crossings.push({ t, point });
      }
      prev = i;
    }
  }
  crossings.sort((p, q) => p.t - q.t);
  touches.sort((p, q) => p.t - q.t);
  overlaps.sort((p, q) => p.t_min - q.t_min);
  return { crossings, touches, overlaps };
}

// ── spokes and the report ────────────────────────────────────────────────────

const fmtDeg = (a) => `${a.toFixed(3)}°`;
const fmtPt = (p) => `(${p.x.toFixed(3)}, ${p.z.toFixed(3)})`;
const RING_WORDS = { inner: 'inner boundary', outer: 'outer boundary' };
const REMEDY = 'Omit this spoke, change the offset, or revise a boundary.';

function spokeError(code, n, angle, extra, detail) {
  return { code, message: `Spoke ${n} (${fmtDeg(angle)}): ${detail} ${REMEDY}`, ...extra };
}

/** One spoke's geometry or its blocking error, from the two rings' contacts (§15.5 case table). */
function buildSpoke(center, index, angle, innerRing, outerRing) {
  const d = direction(angle);
  const inner = rayRingContacts(center, d, innerRing);
  const outer = rayRingContacts(center, d, outerRing);
  const out = { index, angle_deg: angle, warnings: [] };

  for (const [ring, contacts] of [['inner', inner], ['outer', outer]]) {
    const ov = contacts.overlaps[0];
    if (ov) {
      out.error = spokeError('collinear_overlap', index, angle,
        { ring, t_range: [ov.t_min, ov.t_max], from: ov.from, to: ov.to, point: ov.from },
        `the ray runs along the ${RING_WORDS[ring]} from ${fmtPt(ov.from)} to ${fmtPt(ov.to)} (collinear overlap).`);
      return out;
    }
  }
  for (const [ring, contacts] of [['inner', inner], ['outer', outer]]) {
    if (contacts.crossings.length % 2 === 0) {
      out.error = spokeError('ambiguous_ray', index, angle, { ring, count: contacts.crossings.length },
        `the ray crosses the ${RING_WORDS[ring]} ${contacts.crossings.length} times (an even count; the contact is ambiguous).`);
      return out;
    }
  }
  const start = inner.crossings[inner.crossings.length - 1];
  const end = outer.crossings[0];
  if (end.t <= start.t) {
    out.error = spokeError('invalid_radial_order', index, angle, { ring: 'outer', point: end.point },
      `outer boundary reached at ${fmtPt(end.point)} before leaving inner boundary at ${fmtPt(start.point)} — rings cross here.`);
    return out;
  }
  const innerGraze = inner.touches.find(h => h.t > start.t && h.t < end.t);
  if (innerGraze) {
    out.error = spokeError('grazes_inner', index, angle, { ring: 'inner', point: innerGraze.point },
      `the spoke would graze the inner boundary at ${fmtPt(innerGraze.point)}.`);
    return out;
  }
  const outerGraze = outer.touches.find(h => h.t < end.t);
  if (outerGraze) {
    out.error = spokeError('grazes_outer', index, angle, { ring: 'outer', point: outerGraze.point },
      `the spoke would graze the outer boundary at ${fmtPt(outerGraze.point)}.`);
    return out;
  }

  const a = roundPoint(start.point);
  const b = roundPoint(end.point);
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  out.length_wu = length;
  out.length_m = worldUnitsToMeters(length);
  if (length < MIN_SPOKE_LENGTH_WU) {
    out.error = spokeError('too_short', index, angle, { ring: null, point: a },
      `the spoke would be ${length.toFixed(3)} wu long, under the ${MIN_SPOKE_LENGTH_WU} wu minimum.`);
    return out;
  }
  const g = validateGeometry('linestring', [a, b]);
  if (!g.ok) {
    out.error = spokeError('invalid_geometry', index, angle, { ring: null, point: a },
      `the spoke is not a valid line (${g.issues.map(i => i.message).join('; ')}).`);
    return out;
  }
  out.geometry = g.geometry;
  if (inner.crossings.length > 1) out.warnings.push({ code: 'inner_multiple_crossings', count: inner.crossings.length,
    message: `Spoke ${index}: the ray crosses the inner boundary ${inner.crossings.length} times; the spoke starts at the outermost exit.` });
  if (outer.crossings.length > 1) out.warnings.push({ code: 'outer_multiple_crossings', count: outer.crossings.length,
    message: `Spoke ${index}: the ray crosses the outer boundary ${outer.crossings.length} times; the spoke ends at the first exit.` });
  return out;
}

/**
 * The full construction report (§15.11): construction-level errors, then one entry per
 * index — `valid` with its two-vertex geometry, `invalid` with its error, or `omitted`
 * (still evaluated, so the editor can see why it was omitted; never persisted).
 *
 * `labels` names the rings in messages (for example "inner boundary (feature #41)").
 * `ok` is true only when there is no construction error and every non-omitted spoke is
 * valid: all-or-nothing (§15.13).
 */
function computeRadial({ center: rawCenter, inner, outer, count, offset_deg: offsetDeg, omit_indices: omit = [], labels = {} }) {
  const center = roundPoint(rawCenter);
  const normalized = { center, count, offset_deg: offsetDeg, omit_indices: omit.slice() };
  const errors = [];
  for (const [ring, poly] of [['inner', inner], ['outer', outer]]) {
    const where = locatePointInRing(center, poly);
    if (where !== 'inside') {
      const label = labels[ring] || RING_WORDS[ring];
      errors.push({
        code: 'center_not_inside', ring, where,
        message: `Center ${fmtPt(center)} lies ${where === 'boundary' ? 'on' : 'outside'} the ${label}. Choose a center strictly inside both boundaries.`,
      });
    }
  }
  if (errors.length) return { ok: false, normalized, errors, spokes: [] };

  const omitted = new Set(omit);
  const spokes = [];
  for (let n = 0; n < count; n++) {
    const spoke = buildSpoke(center, n, spokeAngle(offsetDeg, n, count), inner, outer);
    const status = omitted.has(n) ? 'omitted' : spoke.error ? 'invalid' : 'valid';
    spokes.push({
      index: n,
      angle_deg: spoke.angle_deg,
      status,
      ...(spoke.geometry ? { geometry: spoke.geometry } : {}),
      length_wu: spoke.length_wu ?? null,
      length_m: spoke.length_m ?? null,
      warnings: spoke.warnings,
      ...(spoke.error ? { error: spoke.error } : {}),
    });
  }
  return { ok: spokes.every(s => s.status !== 'invalid'), normalized, errors, spokes };
}

module.exports = {
  CONTACT_TOLERANCE_WU,
  MIN_SPOKE_LENGTH_WU,
  MAX_SPOKE_COUNT,
  ANGLE_CONVENTION,
  normalizeOffset,
  spokeAngle,
  direction,
  normalizeParams,
  boundaryRing,
  rayRingContacts,
  computeRadial,
  roundPoint,
};
