/**
 * Canonical geometry: validation, normalization, bbox, predicates, area and length.
 *
 * Pure JS, no dependency, no database. Geometry is world X/Z only, in the `{x, z}` point
 * convention the inherited generator already uses (`frontend/src/cityGen/water.ts`), so
 * accepted canon can feed it later without translation:
 *
 *   point       {x, z}
 *   linestring  [{x, z}, …]              closed when first equals last
 *   polygon     {outer: [{x, z}, …], holes: [[{x, z}, …], …]}   rings stored open
 *
 * Normalization rounds every coordinate to 0.001 wu (~1.5 mm) so the stored form is
 * stable, stores rings open, and orients the outer ring counter-clockwise and holes
 * clockwise. "Counter-clockwise in X/Z" means a positive shoelace area with X as the
 * first axis and Z as the second: Σ (x_i · z_{i+1} − x_{i+1} · z_i) > 0.
 *
 * This is predicates only — point-in-polygon, segment intersection, bbox, intersects,
 * area/length. There is deliberately no union, difference, clipping or buffering (plan
 * §2.3); a multi-polygon extent is always handled as a set of polygons.
 *
 * See docs/CANONICAL_GEOGRAPHY_PLAN.md §3.2 and §4.1.
 */

/** Coordinates beyond ±this are almost certainly a unit mistake (~30 km; ~4.5× the wall span). */
const WORLD_LIMIT = 20000;
/** Total vertices per feature, across all rings. */
const MAX_VERTICES = 20000;
/** Stored coordinate resolution in world units. */
const COORDINATE_PRECISION_WU = 0.001;
/** Smallest acceptable polygon area (outer minus holes), in square world units. */
const MIN_POLYGON_AREA_WU2 = 1;

const GEOMETRY_TYPES = ['point', 'linestring', 'polygon'];

/** Which geometry types each feature class may carry (plan §4.1). */
const FEATURE_CLASS_GEOMETRY_TYPES = {
  land: ['polygon'],
  water: ['polygon'],
  route: ['linestring'],
  protected_region: ['polygon'],
  site: ['point', 'linestring', 'polygon'],
  scope_boundary: ['polygon'],
};

// Rounded coordinates are exact multiples of 1/SCALE, so topology is decided on these
// integers instead of their binary-fraction approximations. At ±WORLD_LIMIT the largest
// orientation product is (4e7)² = 1.6e15, inside the 2^53 exact-integer range.
const SCALE = Math.round(1 / COORDINATE_PRECISION_WU);

/** Thrown by `normalizeGeometry`; `issues` lists every problem found, not just the first. */
class GeometryError extends Error {
  constructor(issues) {
    super(issues.map(i => i.message).join('; '));
    this.name = 'GeometryError';
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------------------
// Topology on the exact 0.001-wu grid.
//
// Canonical coordinates are multiples of 0.001 wu, but 0.001 has no exact binary form, so
// a floating-point determinant over world coordinates can call exactly collinear sloped
// edges "not collinear" — and two islands sharing part of a shoreline "not touching".
// Every topology decision is therefore made on coordinates scaled by 1000 to integers,
// where orientation is exact (see SCALE). The `g*` functions take grid points; the
// exported predicates take world points and move them onto the grid first. No epsilon.
// ---------------------------------------------------------------------------------------

const toGrid = (p) => ({ x: Math.round(p.x * SCALE), z: Math.round(p.z * SCALE) });
const ringToGrid = (ring) => ring.map(toGrid);
const polygonToGrid = (polygon) => ({ outer: ringToGrid(polygon.outer), holes: (polygon.holes || []).map(ringToGrid) });

/** Twice the signed area of grid triangle a-b-c: > 0 counter-clockwise, < 0 clockwise, 0 collinear. */
const gOrient = (a, b, c) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);

const between = (v, p, q) => Math.min(p, q) <= v && v <= Math.max(p, q);

function gPointOnSegment(p, a, b) {
  return gOrient(a, b, p) === 0 && between(p.x, a.x, b.x) && between(p.z, a.z, b.z);
}

function gSegmentsIntersect(a, b, c, d) {
  const o1 = gOrient(a, b, c);
  const o2 = gOrient(a, b, d);
  const o3 = gOrient(c, d, a);
  const o4 = gOrient(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) {
    return true;
  }
  return (o1 === 0 && gPointOnSegment(c, a, b))
    || (o2 === 0 && gPointOnSegment(d, a, b))
    || (o3 === 0 && gPointOnSegment(a, c, d))
    || (o4 === 0 && gPointOnSegment(b, c, d));
}

/** Whether collinear grid segments a-b and c-d overlap along a positive length, not just a point. */
function gCollinearOverlap(a, b, c, d) {
  if (gOrient(a, b, c) !== 0 || gOrient(a, b, d) !== 0) return false;
  const useX = Math.abs(b.x - a.x) >= Math.abs(b.z - a.z);
  const [p0, p1] = useX ? [a.x, b.x] : [a.z, b.z];
  const [q0, q1] = useX ? [c.x, d.x] : [c.z, d.z];
  return Math.min(Math.max(p0, p1), Math.max(q0, q1)) > Math.max(Math.min(p0, p1), Math.min(q0, q1));
}

/**
 * Grid ray cast. Whether edge a-b crosses the ray running +x from p is decided by the sign
 * of gOrient(a, b, p) against the edge's z direction — the same exact determinant, rather
 * than a divided crossing coordinate.
 */
function gLocatePointInRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j];
    const b = ring[i];
    if (gPointOnSegment(p, a, b)) return 'boundary';
    if ((a.z > p.z) !== (b.z > p.z)) {
      const o = gOrient(a, b, p);
      if (b.z > a.z ? o > 0 : o < 0) inside = !inside;
    }
  }
  return inside ? 'inside' : 'outside';
}

function gLocatePointInPolygon(p, polygon) {
  const outer = gLocatePointInRing(p, polygon.outer);
  if (outer !== 'inside') return outer;
  for (const hole of polygon.holes) {
    const h = gLocatePointInRing(p, hole);
    if (h === 'boundary') return 'boundary';
    if (h === 'inside') return 'outside';
  }
  return 'inside';
}

/** Whether world point `p` lies on the closed segment a-b, decided on the 0.001-wu grid. */
const pointOnSegment = (p, a, b) => gPointOnSegment(toGrid(p), toGrid(a), toGrid(b));

/**
 * Whether closed world segments a-b and c-d share at least one point, decided on the grid.
 * Crossing, endpoint touching and collinear overlap all count; only true separation does not.
 */
const segmentsIntersect = (a, b, c, d) => gSegmentsIntersect(toGrid(a), toGrid(b), toGrid(c), toGrid(d));

/** 'inside' | 'boundary' | 'outside' for world point `p` against a ring (open or closed). */
const locatePointInRing = (p, ring) => gLocatePointInRing(toGrid(p), ringToGrid(ring));

/** 'inside' | 'boundary' | 'outside' for `p` against a polygon; a hole's interior is outside. */
const locatePointInPolygon = (p, polygon) => gLocatePointInPolygon(toGrid(p), polygonToGrid(polygon));

/** Whether `p` lies in the polygon's interior or on its boundary. */
const pointInPolygon = (p, polygon) => locatePointInPolygon(p, polygon) !== 'outside';

// ---------------------------------------------------------------------------------------
// Bounding boxes.
// ---------------------------------------------------------------------------------------

function bboxOfPoints(points) {
  let minX = Infinity; let minZ = Infinity; let maxX = -Infinity; let maxZ = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { min_x: minX, min_z: minZ, max_x: maxX, max_z: maxZ };
}

/**
 * The `{min_x, min_z, max_x, max_z}` of a geometry, in the column names the table uses.
 * A polygon's holes lie inside its outer ring, so the outer ring alone bounds it.
 */
function computeBBox(geometryType, geometry) {
  switch (geometryType) {
    case 'point': return { min_x: geometry.x, min_z: geometry.z, max_x: geometry.x, max_z: geometry.z };
    case 'linestring': return bboxOfPoints(geometry);
    case 'polygon': return bboxOfPoints(geometry.outer);
    default: throw new TypeError(`unknown geometry type: ${geometryType}`);
  }
}

/** Whether two closed bboxes share at least one point. */
const bboxesIntersect = (a, b) =>
  a.min_x <= b.max_x && b.min_x <= a.max_x && a.min_z <= b.max_z && b.min_z <= a.max_z;

// ---------------------------------------------------------------------------------------
// Segment sets and geometry-vs-polygon intersection (grid inside, world at the edges).
// ---------------------------------------------------------------------------------------

/** Segments of a ring, including the closing edge. */
const ringSegments = (ring) => ring.map((a, i) => [a, ring[(i + 1) % ring.length]]);

/** Segments of a linestring as written (a closed one already repeats its first vertex). */
const lineSegments = (line) => line.slice(1).map((b, i) => [line[i], b]);

const polygonSegments = (polygon) =>
  [polygon.outer, ...polygon.holes].flatMap(ringSegments);

const segmentBox = ([a, b]) => ({
  min_x: Math.min(a.x, b.x), max_x: Math.max(a.x, b.x),
  min_z: Math.min(a.z, b.z), max_z: Math.max(a.z, b.z),
});

/** Whether any grid segment of `left` touches any grid segment of `right` (bbox-prefiltered sweep). */
function gAnySegmentsIntersect(left, right) {
  const tag = (segs, side) => segs.map(s => ({ s, side, box: segmentBox(s) }));
  const items = [...tag(left, 0), ...tag(right, 1)].sort((p, q) => p.box.min_x - q.box.min_x);
  for (let m = 0; m < items.length; m++) {
    const a = items[m];
    for (let k = m + 1; k < items.length && items[k].box.min_x <= a.box.max_x; k++) {
      const b = items[k];
      if (a.side === b.side) continue;
      if (b.box.max_z < a.box.min_z || b.box.min_z > a.box.max_z) continue;
      if (gSegmentsIntersect(a.s[0], a.s[1], b.s[0], b.s[1])) return true;
    }
  }
  return false;
}

function gPolygonsIntersect(a, b) {
  if (!bboxesIntersect(bboxOfPoints(a.outer), bboxOfPoints(b.outer))) return false;
  if (gAnySegmentsIntersect(polygonSegments(a), polygonSegments(b))) return true;
  // No boundary contact: one is either wholly inside the other or wholly apart.
  return gLocatePointInPolygon(a.outer[0], b) !== 'outside'
    || gLocatePointInPolygon(b.outer[0], a) !== 'outside';
}

function gLinestringIntersectsPolygon(line, polygon) {
  if (!bboxesIntersect(bboxOfPoints(line), bboxOfPoints(polygon.outer))) return false;
  if (gAnySegmentsIntersect(lineSegments(line), polygonSegments(polygon))) return true;
  return gLocatePointInPolygon(line[0], polygon) !== 'outside';
}

/**
 * Whether two polygons share at least one point (interior or boundary), decided on the
 * grid — so a partially shared sloped edge counts as touching. A polygon lying wholly
 * inside the other's hole does not intersect it.
 */
const polygonsIntersect = (a, b) => gPolygonsIntersect(polygonToGrid(a), polygonToGrid(b));

/** Whether a linestring shares at least one point with a polygon, decided on the grid. */
const linestringIntersectsPolygon = (line, polygon) =>
  gLinestringIntersectsPolygon(ringToGrid(line), polygonToGrid(polygon));

/** Whether a normalized geometry of any type shares at least one point with a polygon. */
function geometryIntersectsPolygon(geometryType, geometry, polygon) {
  switch (geometryType) {
    case 'point': return pointInPolygon(geometry, polygon);
    case 'linestring': return linestringIntersectsPolygon(geometry, polygon);
    case 'polygon': return polygonsIntersect(geometry, polygon);
    default: throw new TypeError(`unknown geometry type: ${geometryType}`);
  }
}

/**
 * How a normalized geometry sits against one polygon, decided on the grid:
 *
 *   'inside'   wholly within the polygon's interior — no boundary contact, and it covers
 *              none of the polygon's holes;
 *   'boundary' it shares points with the polygon and also touches or crosses its boundary,
 *              or it covers the polygon (or one of its holes) from outside;
 *   'outside'  no shared point.
 *
 * Used by the generator query to tell "inside the requested extent" from "straddling its
 * edge". Predicates only — nothing is clipped.
 */
function relateGeometryToPolygon(geometryType, geometry, polygon) {
  if (geometryType === 'point') {
    return locatePointInPolygon(geometry, polygon);
  }
  const target = polygonToGrid(polygon);
  let segments;
  let first;
  let asPolygon = null;
  if (geometryType === 'linestring') {
    const line = ringToGrid(geometry);
    if (!bboxesIntersect(bboxOfPoints(line), bboxOfPoints(target.outer))) return 'outside';
    segments = lineSegments(line);
    first = line[0];
  } else if (geometryType === 'polygon') {
    asPolygon = polygonToGrid(geometry);
    if (!bboxesIntersect(bboxOfPoints(asPolygon.outer), bboxOfPoints(target.outer))) return 'outside';
    segments = polygonSegments(asPolygon);
    first = asPolygon.outer[0];
  } else {
    throw new TypeError(`unknown geometry type: ${geometryType}`);
  }
  if (gAnySegmentsIntersect(segments, polygonSegments(target))) return 'boundary';
  // No boundary contact: the geometry is wholly inside, wholly outside, or (a polygon only)
  // wholly covers the target or one of its holes.
  if (gLocatePointInPolygon(first, target) === 'inside') {
    if (asPolygon && target.holes.some(h => gLocatePointInPolygon(h[0], asPolygon) !== 'outside')) return 'boundary';
    return 'inside';
  }
  if (asPolygon && gLocatePointInPolygon(target.outer[0], asPolygon) !== 'outside') return 'boundary';
  return 'outside';
}

// ---------------------------------------------------------------------------------------
// Exact linestring pieces: where a route is covered by which polygons.
//
// Sampling vertices and midpoints misses a narrow channel between samples or a brief exit
// through a concavity. Instead each segment is cut at every point where it meets the
// boundary of any given polygon. Between two consecutive cuts the open piece meets no
// boundary (or lies along one), so it is either wholly inside, wholly on the boundary of,
// or wholly outside each polygon — and locating one interior point of the piece decides it.
//
// Cuts are exact rationals along the segment. On the 0.001-wu grid every product used to
// build them stays below 2^53 (differences ≤ 4e7, products ≤ 3.2e15), so they are formed as
// integers and carried as BigInt fractions; the piece's interior point is then located
// with BigInt orientation, so no epsilon is ever involved.
// ---------------------------------------------------------------------------------------

const frac = (n, d) => (d < 0n ? { n: -n, d: -d } : { n, d });
const fracCompare = (a, b) => {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
};

/** Push the parameters along grid segment a-b at which it meets grid segment c-d. */
function gCutParameters(a, b, c, d, out) {
  if (!gSegmentsIntersect(a, b, c, d)) return;
  const rx = b.x - a.x;
  const rz = b.z - a.z;
  const sx = d.x - c.x;
  const sz = d.z - c.z;
  const denom = rx * sz - rz * sx;
  if (denom !== 0) {
    out.push(frac(BigInt((c.x - a.x) * sz - (c.z - a.z) * sx), BigInt(denom)));
    return;
  }
  // Collinear overlap: cut where c and d project onto a-b, when they fall within it.
  const len2 = rx * rx + rz * rz;
  for (const p of [c, d]) {
    const dot = (p.x - a.x) * rx + (p.z - a.z) * rz;
    if (dot >= 0 && dot <= len2) out.push(frac(BigInt(dot), BigInt(len2)));
  }
}

/**
 * 'inside' | 'boundary' | 'outside' for the rational point (px/den, pz/den) — BigInt
 * numerators over a common BigInt denominator — against a grid polygon. The same ray cast
 * as gLocatePointInRing, in BigInt so it stays exact.
 */
function bLocatePointInPolygon(px, pz, den, polygon) {
  const ring = (r) => {
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const ax = BigInt(r[j].x) * den;
      const az = BigInt(r[j].z) * den;
      const bx = BigInt(r[i].x) * den;
      const bz = BigInt(r[i].z) * den;
      const o = (bx - ax) * (pz - az) - (bz - az) * (px - ax);
      if (o === 0n
        && (ax < bx ? ax <= px && px <= bx : bx <= px && px <= ax)
        && (az < bz ? az <= pz && pz <= bz : bz <= pz && pz <= az)) return 'boundary';
      if ((az > pz) !== (bz > pz) && (bz > az ? o > 0n : o < 0n)) inside = !inside;
    }
    return inside ? 'inside' : 'outside';
  };
  const outer = ring(polygon.outer);
  if (outer !== 'inside') return outer;
  for (const h of polygon.holes) {
    const r = ring(h);
    if (r === 'boundary') return 'boundary';
    if (r === 'inside') return 'outside';
  }
  return 'inside';
}

/**
 * Cut a normalized linestring into pieces against a set of polygons, exactly.
 *
 * Returns one entry per piece: `{ segment, from, to, within, interior }`, where `segment`
 * is the segment index, `from`/`to` are the piece's parameters along it (as numbers, for
 * reporting only), `within` lists the indices of the polygons whose closed region —
 * interior or boundary — contains the whole piece, and `interior` the subset whose open
 * interior does (a piece lying along a boundary is `within` but not `interior`; a piece in
 * a hole is neither). Every piece has positive length: a point contact is only a cut. A
 * piece that lies in no polygon is outside all of them along its entire open length.
 */
function linestringPieces(line, polygons) {
  const gridLine = ringToGrid(line);
  const grids = polygons.map(p => {
    const g = polygonToGrid(p);
    return { g, box: bboxOfPoints(g.outer), segments: polygonSegments(g) };
  });
  const pieces = [];
  for (let s = 0; s + 1 < gridLine.length; s++) {
    const a = gridLine[s];
    const b = gridLine[s + 1];
    const box = segmentBox([a, b]);
    const near = grids.map((p, i) => ({ ...p, i })).filter(p => bboxesIntersect(box, p.box));
    const cuts = [frac(0n, 1n), frac(1n, 1n)];
    for (const p of near) {
      for (const seg of p.segments) {
        if (bboxesIntersect(box, segmentBox(seg))) gCutParameters(a, b, seg[0], seg[1], cuts);
      }
    }
    cuts.sort(fracCompare);
    const unique = cuts.filter((t, k) => k === 0 || fracCompare(t, cuts[k - 1]) !== 0);
    for (let k = 0; k + 1 < unique.length; k++) {
      const t0 = unique[k];
      const t1 = unique[k + 1];
      // Interior point of the piece: the mean of its two cut parameters.
      const den = 2n * t0.d * t1.d;
      const tn = t0.n * t1.d + t1.n * t0.d;
      const px = BigInt(a.x) * den + tn * BigInt(b.x - a.x);
      const pz = BigInt(a.z) * den + tn * BigInt(b.z - a.z);
      const within = [];
      const interior = [];
      for (const p of near) {
        const where = bLocatePointInPolygon(px, pz, den, p.g);
        if (where !== 'outside') within.push(p.i);
        if (where === 'inside') interior.push(p.i);
      }
      pieces.push({ segment: s, from: Number(t0.n) / Number(t0.d), to: Number(t1.n) / Number(t1.d), within, interior });
    }
  }
  return pieces;
}

// ---------------------------------------------------------------------------------------
// Area and length, in world units. Convert with physicalScale.js, never map scale.
// ---------------------------------------------------------------------------------------

/** Signed ring area in wu²: positive counter-clockwise in X/Z. Taken about the first vertex to limit error. */
function ringSignedArea(ring) {
  if (ring.length < 3) return 0;
  const o = ring[0];
  let twice = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    twice += (a.x - o.x) * (b.z - o.z) - (b.x - o.x) * (a.z - o.z);
  }
  return twice / 2;
}

/** Polygon area in wu²: outer minus holes. */
const polygonArea = (polygon) =>
  Math.abs(ringSignedArea(polygon.outer))
  - (polygon.holes || []).reduce((sum, h) => sum + Math.abs(ringSignedArea(h)), 0);

const dist = (a, b) => Math.hypot(b.x - a.x, b.z - a.z);

/** Linestring length in wu, as written. */
const linestringLength = (line) => lineSegments(line).reduce((sum, [a, b]) => sum + dist(a, b), 0);

/** Ring perimeter in wu, including the closing edge. */
const ringPerimeter = (ring) => ringSegments(ring).reduce((sum, [a, b]) => sum + dist(a, b), 0);

/** Total boundary length in wu: outer ring plus every hole (a hole's edge is shoreline too). */
const polygonPerimeter = (polygon) =>
  [polygon.outer, ...(polygon.holes || [])].reduce((sum, r) => sum + ringPerimeter(r), 0);

// ---------------------------------------------------------------------------------------
// Validation and normalization.
// ---------------------------------------------------------------------------------------

const roundCoordinate = (v) => {
  const r = Math.round(v * SCALE) / SCALE;
  return r === 0 ? 0 : r; // no -0 in stored JSON
};

const roundPoint = (p) => ({ x: roundCoordinate(p.x), z: roundCoordinate(p.z) });
const samePoint = (a, b) => a.x === b.x && a.z === b.z;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Shape, finiteness and bounds of one raw point; pushes issues and returns whether usable. */
function checkRawPoint(raw, path, issues) {
  if (!isPlainObject(raw) || typeof raw.x !== 'number' || typeof raw.z !== 'number') {
    issues.push({ code: 'invalid_structure', path, message: `${path} must be an object with numeric x and z` });
    return false;
  }
  if (!Number.isFinite(raw.x) || !Number.isFinite(raw.z)) {
    issues.push({ code: 'non_finite', path, message: `${path} has a non-finite coordinate` });
    return false;
  }
  if (Math.abs(raw.x) > WORLD_LIMIT || Math.abs(raw.z) > WORLD_LIMIT) {
    issues.push({ code: 'out_of_bounds', path, message: `${path} lies outside ±${WORLD_LIMIT} world units` });
    return false;
  }
  return true;
}

function checkRawPointList(raw, path, issues) {
  if (!Array.isArray(raw)) {
    issues.push({ code: 'invalid_structure', path, message: `${path} must be an array of points` });
    return false;
  }
  let ok = true;
  raw.forEach((p, i) => { ok = checkRawPoint(p, `${path}[${i}]`, issues) && ok; });
  return ok;
}

/**
 * The first pair of grid segments that touch where they must not, or null.
 *
 * `adjacent(i, j)` says which segment pairs legitimately share an endpoint; those are
 * rejected only if they fold back over each other along a positive length (a spike).
 * Every other pair must not touch at all — touching at a vertex is a pinch, and is invalid.
 */
function findSelfContact(segments, adjacent) {
  const items = segments
    .map((s, i) => ({ i, s, box: segmentBox(s) }))
    .sort((p, q) => p.box.min_x - q.box.min_x);
  for (let m = 0; m < items.length; m++) {
    const a = items[m];
    for (let k = m + 1; k < items.length && items[k].box.min_x <= a.box.max_x; k++) {
      const b = items[k];
      if (b.box.max_z < a.box.min_z || b.box.min_z > a.box.max_z) continue;
      const touching = adjacent(a.i, b.i)
        ? gCollinearOverlap(a.s[0], a.s[1], b.s[0], b.s[1])
        : gSegmentsIntersect(a.s[0], a.s[1], b.s[0], b.s[1]);
      if (touching) return [Math.min(a.i, b.i), Math.max(a.i, b.i)];
    }
  }
  return null;
}

/** Adjacency for the n edges of a closed ring: consecutive, plus last-with-first. */
const ringAdjacency = (n) => (i, j) => {
  const d = Math.abs(i - j);
  return d === 1 || d === n - 1;
};

/** Checks one rounded, open ring; pushes issues and returns whether topology checks passed. */
function checkRing(ring, path, issues) {
  const distinct = new Set(ring.map(p => `${p.x},${p.z}`)).size;
  if (distinct < 3) {
    issues.push({ code: 'too_few_vertices', path, message: `${path} needs at least 3 distinct vertices` });
    return false;
  }
  for (let i = 0; i < ring.length; i++) {
    if (samePoint(ring[i], ring[(i + 1) % ring.length])) {
      issues.push({ code: 'zero_length_edge', path, message: `${path} has a zero-length edge at vertex ${i}` });
      return false;
    }
  }
  const grid = ringToGrid(ring);
  const contact = findSelfContact(ringSegments(grid), ringAdjacency(grid.length));
  if (contact) {
    issues.push({ code: 'self_intersection', path, message: `${path} intersects itself (edges ${contact[0]} and ${contact[1]})` });
    return false;
  }
  return true;
}

/** Drops a repeated closing vertex so rings are stored open. */
const openRing = (ring) =>
  (ring.length > 1 && samePoint(ring[0], ring[ring.length - 1]) ? ring.slice(0, -1) : ring);

/** Reverses winding while keeping the same first vertex, so normalization is stable. */
const reverseRing = (ring) => [ring[0], ...ring.slice(1).reverse()];

function validatePoint(raw, issues) {
  if (!checkRawPoint(raw, 'geometry', issues)) return null;
  return roundPoint(raw);
}

function validateLinestring(raw, issues) {
  if (!checkRawPointList(raw, 'geometry', issues)) return null;
  if (raw.length > MAX_VERTICES) {
    issues.push({ code: 'too_many_vertices', path: 'geometry', message: `geometry has more than ${MAX_VERTICES} vertices` });
    return null;
  }
  const line = raw.map(roundPoint);
  const closed = line.length > 2 && samePoint(line[0], line[line.length - 1]);
  const distinct = new Set(line.map(p => `${p.x},${p.z}`)).size;
  const needed = closed ? 3 : 2;
  if (distinct < needed) {
    issues.push({ code: 'too_few_vertices', path: 'geometry', message: `${closed ? 'a closed' : 'a'} linestring needs at least ${needed} distinct vertices` });
    return null;
  }
  for (let i = 0; i + 1 < line.length; i++) {
    if (samePoint(line[i], line[i + 1])) {
      issues.push({ code: 'zero_length_edge', path: 'geometry', message: `geometry has a zero-length segment at vertex ${i}` });
      return null;
    }
  }
  const grid = ringToGrid(line);
  const n = grid.length - 1;
  const adjacent = closed ? ringAdjacency(n) : (i, j) => Math.abs(i - j) === 1;
  const contact = findSelfContact(lineSegments(grid), adjacent);
  if (contact) {
    issues.push({ code: 'self_intersection', path: 'geometry', message: `geometry crosses itself (segments ${contact[0]} and ${contact[1]})` });
    return null;
  }
  return line;
}

function validatePolygon(raw, issues) {
  if (!isPlainObject(raw)) {
    issues.push({ code: 'invalid_structure', path: 'geometry', message: 'a polygon must be an object with an outer ring and optional holes' });
    return null;
  }
  const rawHoles = raw.holes === undefined ? [] : raw.holes;
  if (!Array.isArray(rawHoles)) {
    issues.push({ code: 'invalid_structure', path: 'geometry.holes', message: 'geometry.holes must be an array of rings' });
    return null;
  }
  let ok = checkRawPointList(raw.outer, 'geometry.outer', issues);
  rawHoles.forEach((h, i) => { ok = checkRawPointList(h, `geometry.holes[${i}]`, issues) && ok; });
  if (!ok) return null;

  const total = raw.outer.length + rawHoles.reduce((sum, h) => sum + h.length, 0);
  if (total > MAX_VERTICES) {
    issues.push({ code: 'too_many_vertices', path: 'geometry', message: `geometry has more than ${MAX_VERTICES} vertices` });
    return null;
  }

  const outer = openRing(raw.outer.map(roundPoint));
  const holes = rawHoles.map(h => openRing(h.map(roundPoint)));

  ok = checkRing(outer, 'geometry.outer', issues);
  holes.forEach((h, i) => { ok = checkRing(h, `geometry.holes[${i}]`, issues) && ok; });
  if (!ok) return null;

  // Holes strictly inside the outer ring and mutually disjoint: no boundary contact at all,
  // then a single vertex settles containment.
  const outerGrid = ringToGrid(outer);
  const holeGrids = holes.map(ringToGrid);
  const outerPoly = { outer: outerGrid, holes: [] };
  holeGrids.forEach((hole, i) => {
    const path = `geometry.holes[${i}]`;
    if (gAnySegmentsIntersect(ringSegments(hole), ringSegments(outerGrid))
      || gLocatePointInPolygon(hole[0], outerPoly) !== 'inside') {
      issues.push({ code: 'hole_not_inside', path, message: `${path} is not strictly inside the outer ring` });
    }
    for (let j = 0; j < i; j++) {
      const other = holeGrids[j];
      if (gAnySegmentsIntersect(ringSegments(hole), ringSegments(other))
        || gLocatePointInRing(hole[0], other) !== 'outside'
        || gLocatePointInRing(other[0], hole) !== 'outside') {
        issues.push({ code: 'holes_overlap', path, message: `geometry.holes[${j}] and ${path} overlap or touch` });
      }
    }
  });
  if (issues.length) return null;

  const polygon = {
    outer: ringSignedArea(outer) > 0 ? outer : reverseRing(outer),
    holes: holes.map(h => (ringSignedArea(h) < 0 ? h : reverseRing(h))),
  };

  if (polygonArea(polygon) < MIN_POLYGON_AREA_WU2) {
    issues.push({ code: 'area_too_small', path: 'geometry', message: `polygon area is below ${MIN_POLYGON_AREA_WU2} square world unit` });
    return null;
  }
  return polygon;
}

/**
 * Validate and normalize one geometry.
 *
 * Returns `{ ok: true, geometry, bbox }` with the normalized geometry and its bbox, or
 * `{ ok: false, issues }` listing every problem found. Normalization is idempotent:
 * validating an already-normalized geometry returns it unchanged.
 */
function validateGeometry(geometryType, raw) {
  const issues = [];
  let geometry = null;
  switch (geometryType) {
    case 'point': geometry = validatePoint(raw, issues); break;
    case 'linestring': geometry = validateLinestring(raw, issues); break;
    case 'polygon': geometry = validatePolygon(raw, issues); break;
    default:
      issues.push({ code: 'invalid_type', path: 'geometry_type', message: `geometry_type must be one of ${GEOMETRY_TYPES.join(', ')}` });
  }
  if (issues.length || !geometry) return { ok: false, issues };
  return { ok: true, geometry, bbox: computeBBox(geometryType, geometry) };
}

/** `validateGeometry`, returning the normalized geometry or throwing a `GeometryError`. */
function normalizeGeometry(geometryType, raw) {
  const result = validateGeometry(geometryType, raw);
  if (!result.ok) throw new GeometryError(result.issues);
  return result.geometry;
}

/** Whether a feature class may carry a geometry type (plan §4.1). */
const isGeometryTypeAllowedForClass = (featureClass, geometryType) =>
  Object.prototype.hasOwnProperty.call(FEATURE_CLASS_GEOMETRY_TYPES, featureClass)
  && FEATURE_CLASS_GEOMETRY_TYPES[featureClass].includes(geometryType);

module.exports = {
  WORLD_LIMIT,
  MAX_VERTICES,
  COORDINATE_PRECISION_WU,
  MIN_POLYGON_AREA_WU2,
  GEOMETRY_TYPES,
  FEATURE_CLASS_GEOMETRY_TYPES,
  GeometryError,
  validateGeometry,
  normalizeGeometry,
  isGeometryTypeAllowedForClass,
  computeBBox,
  bboxesIntersect,
  pointOnSegment,
  segmentsIntersect,
  locatePointInRing,
  locatePointInPolygon,
  pointInPolygon,
  polygonsIntersect,
  linestringIntersectsPolygon,
  geometryIntersectsPolygon,
  relateGeometryToPolygon,
  linestringPieces,
  ringSignedArea,
  polygonArea,
  linestringLength,
  ringPerimeter,
  polygonPerimeter,
};
