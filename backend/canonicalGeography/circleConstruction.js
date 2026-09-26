/**
 * Circle construction, server mirror of the canonical shape creator's circle aids
 * (`frontend/src/modules/canonicalGeography/geometry.ts`: `circleFromDefinition`,
 * `circleThroughPoints`, `circleFromCenter`, `circlePolygon`, `segmentsForRadius`).
 *
 * Pure: no database, no Express. Formula for formula and rounding for rounding the same as
 * the client, held together by the shared radial fixture and a cross-module parity test, so
 * a circle definition — method plus its grid-rounded defining clicks — yields the same
 * centre, radius, segment count and ring on either side.
 *
 * The server uses it to recompute an inline circle boundary of a radial construction
 * (plan §15.3.1) from its definition; it never trusts client-computed geometry.
 */

const { metersToWorldUnits } = require('./physicalScale');

/** The largest gap between a true curve and its polygon approximation (plan §4.1). */
const MAX_CHORD_ERROR_M = 0.25;
const MIN_CURVE_SEGMENTS = 8;
const MAX_CURVE_SEGMENTS = 4096;
const COORDINATE_PRECISION_WU = 0.001;
const CIRCLE_METHODS = ['three_point', 'center_radius'];
/** Clicks each circle method takes: three rim points, or the centre then a rim point. */
const CIRCLE_METHOD_POINTS = { three_point: 3, center_radius: 2 };

// Exactly the client's `roundPoint` (trims float noise such as 1.0000000002).
const round = (v) => Math.round(v / COORDINATE_PRECISION_WU) * COORDINATE_PRECISION_WU;
const roundPoint = (p) => ({ x: +round(p.x).toFixed(3), z: +round(p.z).toFixed(3) });
const distance = (a, b) => Math.hypot(b.x - a.x, b.z - a.z);

function segmentsForRadius(radiusWu, maxChordErrorM = MAX_CHORD_ERROR_M) {
  const e = metersToWorldUnits(maxChordErrorM);
  if (!(radiusWu > e)) return MIN_CURVE_SEGMENTS;
  const n = Math.ceil(Math.PI / Math.acos(1 - e / radiusWu));
  return Math.max(MIN_CURVE_SEGMENTS, Math.min(MAX_CURVE_SEGMENTS, n));
}

/** The circle through three points, or null when they are (nearly) collinear. */
function circleFromThreePoints(a, b, c) {
  const d = 2 * (a.x * (b.z - c.z) + b.x * (c.z - a.z) + c.x * (a.z - b.z));
  const scale = Math.max(distance(a, b), distance(b, c), distance(a, c));
  if (!scale || Math.abs(d) < 1e-9 * scale * scale) return null;
  const a2 = a.x * a.x + a.z * a.z;
  const b2 = b.x * b.x + b.z * b.z;
  const c2 = c.x * c.x + c.z * c.z;
  const center = {
    x: (a2 * (b.z - c.z) + b2 * (c.z - a.z) + c2 * (a.z - b.z)) / d,
    z: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d,
  };
  return { center, radius: distance(center, a) };
}

/** The client's `ellipseRing` with equal radii and no rotation. */
function circleRing(center, radius, segments) {
  const cos = Math.cos(0);
  const sin = Math.sin(0);
  const ring = [];
  for (let i = 0; i < segments; i++) {
    const t = (2 * Math.PI * i) / segments;
    const ex = radius * Math.cos(t);
    const ez = radius * Math.sin(t);
    ring.push(roundPoint({ x: center.x + ex * cos - ez * sin, z: center.z + ex * sin + ez * cos }));
  }
  return ring;
}

function circlePolygon(center, radius, method) {
  if (!(radius > 0) || !Number.isFinite(radius)) return null;
  const segments = segmentsForRadius(radius);
  const c = roundPoint(center);
  return {
    ring: circleRing(c, radius, segments),
    construction: { type: 'circle', center: c, radius: +radius.toFixed(3), method, segments, max_chord_error_m: MAX_CHORD_ERROR_M },
  };
}

/**
 * A circle from its definition, as the shape creator builds one: each click on the grid,
 * then the method's constructor. Returns `{ ring, construction }`, or null when the points
 * do not define a circle (collinear, coincident, zero radius).
 */
function circleFromDefinition(method, points) {
  if (!CIRCLE_METHODS.includes(method) || !Array.isArray(points) || points.length !== CIRCLE_METHOD_POINTS[method]) return null;
  const p = points.map(roundPoint);
  if (method === 'three_point') {
    const circle = circleFromThreePoints(p[0], p[1], p[2]);
    return circle ? circlePolygon(circle.center, circle.radius, 'three_point') : null;
  }
  return circlePolygon(p[0], distance(p[0], p[1]), 'center_radius');
}

module.exports = {
  MAX_CHORD_ERROR_M,
  CIRCLE_METHODS,
  CIRCLE_METHOD_POINTS,
  roundPoint,
  segmentsForRadius,
  circleFromThreePoints,
  circlePolygon,
  circleFromDefinition,
};
