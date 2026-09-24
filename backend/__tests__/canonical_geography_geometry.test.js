import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const geo = require_('../canonicalGeography/geometry.js');
const {
  WORLD_LIMIT, MAX_VERTICES, validateGeometry, normalizeGeometry, GeometryError,
  isGeometryTypeAllowedForClass, computeBBox, bboxesIntersect, segmentsIntersect, pointOnSegment,
  locatePointInPolygon, pointInPolygon, polygonsIntersect, linestringIntersectsPolygon,
  geometryIntersectsPolygon, ringSignedArea, polygonArea, linestringLength, ringPerimeter,
  polygonPerimeter,
} = geo;

const P = (x, z) => ({ x, z });
const ring = (...pairs) => pairs.map(([x, z]) => P(x, z));
const square = (x0, z0, s) => ring([x0, z0], [x0 + s, z0], [x0 + s, z0 + s], [x0, z0 + s]);
const poly = (outer, holes = []) => ({ outer, holes });
const codes = (result) => (result.ok ? [] : result.issues.map(i => i.code));

describe('geometry validity fixtures', () => {
  const cases = [
    // [label, type, geometry, expected issue code or null for valid]
    ['square polygon', 'polygon', poly(square(0, 0, 10)), null],
    ['concave (L-shaped) polygon', 'polygon', poly(ring([0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10])), null],
    ['polygon with a hole', 'polygon', poly(square(0, 0, 10), [square(2, 2, 3)]), null],
    ['polygon with two disjoint holes', 'polygon', poly(square(0, 0, 20), [square(2, 2, 3), square(10, 10, 3)]), null],
    ['explicitly closed outer ring', 'polygon', poly([...square(0, 0, 10), P(0, 0)]), null],
    ['self-intersecting bow-tie', 'polygon', poly(ring([0, 0], [10, 10], [10, 0], [0, 10])), 'self_intersection'],
    ['ring pinched at a repeated vertex', 'polygon', poly(ring([0, 0], [5, 5], [10, 0], [10, 10], [5, 5], [0, 10])), 'self_intersection'],
    ['spike folding back along an edge', 'polygon', poly(ring([0, 0], [10, 0], [5, 0], [5, 5])), 'self_intersection'],
    ['hole outside the outer ring', 'polygon', poly(square(0, 0, 10), [square(20, 20, 3)]), 'hole_not_inside'],
    ['hole touching the outer ring', 'polygon', poly(square(0, 0, 10), [square(0, 2, 3)]), 'hole_not_inside'],
    ['hole crossing the outer ring', 'polygon', poly(square(0, 0, 10), [square(8, 2, 5)]), 'hole_not_inside'],
    ['overlapping holes', 'polygon', poly(square(0, 0, 20), [square(2, 2, 5), square(4, 4, 5)]), 'holes_overlap'],
    ['hole nested in another hole', 'polygon', poly(square(0, 0, 20), [square(2, 2, 10), square(4, 4, 2)]), 'holes_overlap'],
    ['consecutive duplicate vertex', 'polygon', poly(ring([0, 0], [10, 0], [10, 0], [10, 10], [0, 10])), 'zero_length_edge'],
    ['duplicates rounding together', 'polygon', poly(ring([0, 0], [10, 0], [10.0001, 0.0002], [10, 10], [0, 10])), 'zero_length_edge'],
    ['fewer than three distinct vertices', 'polygon', poly(ring([0, 0], [10, 0], [0, 0])), 'too_few_vertices'],
    ['collinear (zero-area) ring', 'polygon', poly(ring([0, 0], [5, 0], [10, 0])), 'self_intersection'],
    ['area below 1 wu²', 'polygon', poly(square(0, 0, 0.5)), 'area_too_small'],
    ['NaN coordinate', 'polygon', poly(ring([0, 0], [NaN, 0], [10, 10])), 'non_finite'],
    ['Infinity coordinate', 'point', P(Infinity, 0), 'non_finite'],
    ['string coordinate', 'point', { x: '1', z: 2 }, 'invalid_structure'],
    ['missing z', 'point', { x: 1, y: 2 }, 'invalid_structure'],
    ['beyond WORLD_LIMIT', 'point', P(WORLD_LIMIT + 1, 0), 'out_of_bounds'],
    ['polygon vertex beyond WORLD_LIMIT', 'polygon', poly(ring([0, 0], [-WORLD_LIMIT - 0.5, 0], [0, 10])), 'out_of_bounds'],
    ['exactly at WORLD_LIMIT', 'point', P(WORLD_LIMIT, -WORLD_LIMIT), null],
    ['polygon as a bare array', 'polygon', square(0, 0, 10), 'invalid_structure'],
    ['holes not an array', 'polygon', { outer: square(0, 0, 10), holes: {} }, 'invalid_structure'],
    ['open linestring', 'linestring', ring([0, 0], [10, 0], [10, 10]), null],
    ['two-vertex linestring', 'linestring', ring([0, 0], [10, 0]), null],
    ['closed linestring (wall ring)', 'linestring', ring([0, 0], [10, 0], [10, 10], [0, 10], [0, 0]), null],
    ['self-crossing linestring', 'linestring', ring([0, 0], [10, 10], [10, 0], [0, 10]), 'self_intersection'],
    ['linestring ending on itself (not at start)', 'linestring', ring([0, 0], [10, 0], [10, 10], [5, 0]), 'self_intersection'],
    ['linestring doubling back', 'linestring', ring([0, 0], [10, 0], [4, 0]), 'self_intersection'],
    ['closed linestring through two points', 'linestring', ring([0, 0], [10, 0], [0, 0]), 'too_few_vertices'],
    ['single-vertex linestring', 'linestring', ring([0, 0]), 'too_few_vertices'],
    ['linestring zero-length segment', 'linestring', ring([0, 0], [0, 0], [10, 0]), 'zero_length_edge'],
    ['unknown geometry type', 'multipolygon', poly(square(0, 0, 10)), 'invalid_type'],
  ];

  it.each(cases)('%s', (_label, type, geometry, expected) => {
    const result = validateGeometry(type, geometry);
    if (expected === null) {
      expect(result.ok, JSON.stringify(result.issues)).toBe(true);
    } else {
      expect(result.ok).toBe(false);
      expect(codes(result)).toContain(expected);
    }
  });

  it('reports every structural issue at once', () => {
    const result = validateGeometry('polygon', poly(ring([NaN, 0], [0, WORLD_LIMIT * 2], [1, 1]), [ring([Infinity, 0])]));
    expect(codes(result)).toEqual(['non_finite', 'out_of_bounds', 'non_finite']);
    expect(result.issues.map(i => i.path)).toEqual(['geometry.outer[0]', 'geometry.outer[1]', 'geometry.holes[0][0]']);
  });

  it('rejects a feature over the vertex cap, counting holes', () => {
    const n = MAX_VERTICES - 2;
    const big = Array.from({ length: n }, (_, i) => P(1000 * Math.cos((2 * Math.PI * i) / n), 1000 * Math.sin((2 * Math.PI * i) / n)));
    expect(validateGeometry('polygon', poly(big)).ok).toBe(true);
    expect(codes(validateGeometry('polygon', poly(big, [square(0, 0, 1)])))).toEqual(['too_many_vertices']);
    expect(codes(validateGeometry('linestring', Array.from({ length: MAX_VERTICES + 1 }, (_, i) => P(i, 0))))).toEqual(['too_many_vertices']);
  });

  it('normalizeGeometry throws a GeometryError carrying the issues', () => {
    let err;
    try { normalizeGeometry('polygon', poly(ring([0, 0], [10, 10], [10, 0], [0, 10]))); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GeometryError);
    expect(err.issues[0].code).toBe('self_intersection');
  });
});

describe('normalization', () => {
  it('orients the outer ring counter-clockwise and holes clockwise in X/Z, keeping the first vertex', () => {
    const cwOuter = [...square(0, 0, 10)].reverse(); // starts at (0,10), clockwise
    const ccwHole = square(2, 2, 3);
    const g = normalizeGeometry('polygon', poly(cwOuter, [ccwHole]));
    expect(ringSignedArea(g.outer)).toBeGreaterThan(0);
    expect(ringSignedArea(g.holes[0])).toBeLessThan(0);
    expect(g.outer[0]).toEqual(cwOuter[0]);
    expect(g.holes[0][0]).toEqual(ccwHole[0]);
  });

  it('stores rings open', () => {
    const g = normalizeGeometry('polygon', poly([...square(0, 0, 10), P(0, 0)], [[...square(2, 2, 3), P(2, 2)]]));
    expect(g.outer).toHaveLength(4);
    expect(g.holes[0]).toHaveLength(4);
  });

  it('keeps the closure point of a closed linestring', () => {
    const g = normalizeGeometry('linestring', ring([0, 0], [10, 0], [10, 10], [0, 0]));
    expect(g).toHaveLength(4);
    expect(g[3]).toEqual(g[0]);
  });

  it('rounds to 0.001 wu, drops extra keys and never stores -0', () => {
    expect(normalizeGeometry('point', { x: 1.23449, z: -0.0001, y: 99 })).toEqual({ x: 1.234, z: 0 });
    expect(Object.is(normalizeGeometry('point', P(-0.0004, 0)).x, 0)).toBe(true);
    expect(normalizeGeometry('point', P(1.2346, -1.2346))).toEqual({ x: 1.235, z: -1.235 });
  });

  it('defaults holes to an empty list', () => {
    expect(normalizeGeometry('polygon', { outer: square(0, 0, 10) }).holes).toEqual([]);
  });

  it('is idempotent and stable through a JSON round trip', () => {
    const noisy = poly(
      ring([0.00049, 0.1234567], [100.98765, -3.33333], [120.5555, 80.12344], [-4.4444, 60.6666]).reverse(),
      [ring([10.0001, 10.0001], [30.3333, 10.1111], [20.2222, 40.4444])],
    );
    const once = normalizeGeometry('polygon', noisy);
    const twice = normalizeGeometry('polygon', JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('does not mutate its input', () => {
    const input = poly([...square(0, 0, 10)].reverse());
    const copy = JSON.parse(JSON.stringify(input));
    normalizeGeometry('polygon', input);
    expect(input).toEqual(copy);
  });

  it('returns a bbox with the table column names', () => {
    const r = validateGeometry('polygon', poly(ring([-5.5, 2], [7.25, -3], [1, 9.0004])));
    expect(r.bbox).toEqual({ min_x: -5.5, min_z: -3, max_x: 7.25, max_z: 9 });
  });
});

describe('bbox', () => {
  it('computes bboxes for every geometry type', () => {
    expect(computeBBox('point', P(3, -4))).toEqual({ min_x: 3, min_z: -4, max_x: 3, max_z: -4 });
    expect(computeBBox('linestring', ring([0, 5], [-2, 1], [4, 3]))).toEqual({ min_x: -2, min_z: 1, max_x: 4, max_z: 5 });
    expect(computeBBox('polygon', poly(square(1, 2, 3), [square(1.5, 2.5, 1)]))).toEqual({ min_x: 1, min_z: 2, max_x: 4, max_z: 5 });
    expect(() => computeBBox('circle', P(0, 0))).toThrow(TypeError);
  });

  it('treats touching bboxes as intersecting', () => {
    const a = { min_x: 0, min_z: 0, max_x: 1, max_z: 1 };
    expect(bboxesIntersect(a, { min_x: 1, min_z: 1, max_x: 2, max_z: 2 })).toBe(true);
    expect(bboxesIntersect(a, { min_x: 1.001, min_z: 0, max_x: 2, max_z: 1 })).toBe(false);
  });
});

describe('predicates', () => {
  const donut = poly(square(0, 0, 10), [square(3, 3, 4)]);

  it('segment intersection counts crossing, touching and collinear overlap', () => {
    expect(segmentsIntersect(P(0, 0), P(10, 10), P(0, 10), P(10, 0))).toBe(true);
    expect(segmentsIntersect(P(0, 0), P(10, 0), P(10, 0), P(10, 5))).toBe(true);
    expect(segmentsIntersect(P(0, 0), P(10, 0), P(5, 0), P(15, 0))).toBe(true);
    expect(segmentsIntersect(P(0, 0), P(10, 0), P(11, 0), P(15, 0))).toBe(false);
    expect(segmentsIntersect(P(0, 0), P(10, 0), P(0, 1), P(10, 1))).toBe(false);
  });

  it('locates points inside, on the boundary, outside and in a hole', () => {
    expect(locatePointInPolygon(P(1, 1), donut)).toBe('inside');
    expect(locatePointInPolygon(P(0, 5), donut)).toBe('boundary');
    expect(locatePointInPolygon(P(3, 5), donut)).toBe('boundary');
    expect(locatePointInPolygon(P(5, 5), donut)).toBe('outside');
    expect(locatePointInPolygon(P(-1, 5), donut)).toBe('outside');
    expect(pointInPolygon(P(10, 10), donut)).toBe(true);
    expect(pointInPolygon(P(5, 5), donut)).toBe(false);
  });

  it('polygon intersection: overlap, containment, touching, disjoint and inside a hole', () => {
    expect(polygonsIntersect(poly(square(0, 0, 10)), poly(square(5, 5, 10)))).toBe(true);
    expect(polygonsIntersect(poly(square(0, 0, 10)), poly(square(2, 2, 1)))).toBe(true);
    expect(polygonsIntersect(poly(square(2, 2, 1)), poly(square(0, 0, 10)))).toBe(true);
    expect(polygonsIntersect(poly(square(0, 0, 10)), poly(square(10, 0, 10)))).toBe(true);
    expect(polygonsIntersect(poly(square(0, 0, 10)), poly(square(20, 0, 10)))).toBe(false);
    expect(polygonsIntersect(donut, poly(square(4, 4, 2)))).toBe(false);
    expect(polygonsIntersect(poly(square(4, 4, 2)), donut)).toBe(false);
  });

  it('linestring and point intersection with polygons', () => {
    expect(linestringIntersectsPolygon(ring([-5, 5], [15, 5]), donut)).toBe(true);
    expect(linestringIntersectsPolygon(ring([1, 1], [2, 1]), donut)).toBe(true);
    expect(linestringIntersectsPolygon(ring([4, 4], [6, 6]), donut)).toBe(false);
    expect(linestringIntersectsPolygon(ring([20, 0], [30, 0]), donut)).toBe(false);
    expect(geometryIntersectsPolygon('point', P(1, 1), donut)).toBe(true);
    expect(geometryIntersectsPolygon('point', P(5, 5), donut)).toBe(false);
    expect(geometryIntersectsPolygon('linestring', ring([-1, -1], [1, 1]), donut)).toBe(true);
    expect(geometryIntersectsPolygon('polygon', poly(square(9, 9, 5)), donut)).toBe(true);
  });

  it('knows which geometry types each feature class allows', () => {
    expect(isGeometryTypeAllowedForClass('land', 'polygon')).toBe(true);
    expect(isGeometryTypeAllowedForClass('land', 'point')).toBe(false);
    expect(isGeometryTypeAllowedForClass('route', 'linestring')).toBe(true);
    expect(isGeometryTypeAllowedForClass('route', 'polygon')).toBe(false);
    expect(['point', 'linestring', 'polygon'].every(t => isGeometryTypeAllowedForClass('site', t))).toBe(true);
    expect(isGeometryTypeAllowedForClass('scope_boundary', 'polygon')).toBe(true);
    expect(isGeometryTypeAllowedForClass('island', 'polygon')).toBe(false);
    expect(isGeometryTypeAllowedForClass('toString', 'polygon')).toBe(false);
  });
});

describe('area and length in world units', () => {
  it('computes signed ring area and polygon area net of holes', () => {
    expect(ringSignedArea(square(0, 0, 10))).toBe(100);
    expect(ringSignedArea([...square(0, 0, 10)].reverse())).toBe(-100);
    expect(polygonArea(poly(square(0, 0, 10), [square(3, 3, 4)]))).toBe(84);
    expect(polygonArea(poly(ring([0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10])))).toBe(64);
  });

  it('keeps precision far from the origin', () => {
    expect(polygonArea(poly(square(19000, -19990, 1.5)))).toBeCloseTo(2.25, 9);
  });

  it('computes linestring length and perimeters including holes', () => {
    expect(linestringLength(ring([0, 0], [3, 4], [3, 10]))).toBe(11);
    expect(linestringLength(ring([0, 0], [10, 0], [10, 10], [0, 10], [0, 0]))).toBe(40);
    expect(ringPerimeter(square(0, 0, 10))).toBe(40);
    expect(polygonPerimeter(poly(square(0, 0, 10), [square(3, 3, 4)]))).toBe(56);
  });
});

describe('topology on the exact 0.001-wu grid (sloped, far-from-origin coordinates)', () => {
  // Points on a sloped line, built from exact thousandths: A + n·D (+ an offset), so every
  // point is a valid canonical coordinate and the collinear ones are exactly collinear on
  // the grid. These particular lines were found by search: the float determinant over the
  // world coordinates is non-zero for them, which is what used to hide the contact.
  const LINES = [
    { A: [-9589062, -4448027], D: [77350, 52067] },
    { A: [-12499028, -13433589], D: [11335, 38659] },
  ];
  const at = ({ A, D }, n, off = [0, 0]) => P((A[0] + n * D[0] + off[0]) / 1000, (A[1] + n * D[1] + off[1]) / 1000);
  const floatOrient = (a, b, c) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);

  it.each(LINES)('these fixtures really defeat a floating-point determinant (line %#)', (line) => {
    expect(floatOrient(at(line, 0), at(line, 3), at(line, 1))).not.toBe(0);
  });

  it.each(LINES)('partially overlapping collinear sloped segments intersect (line %#)', (line) => {
    const [a, b, c, d] = [at(line, 0), at(line, 3), at(line, 1), at(line, 5)];
    expect(segmentsIntersect(a, b, c, d)).toBe(true);
    expect(segmentsIntersect(c, d, a, b)).toBe(true);
  });

  it.each(LINES)('the same segments 0.001 wu apart do not (line %#)', (line) => {
    const [a, b] = [at(line, 0), at(line, 3)];
    expect(segmentsIntersect(a, b, at(line, 1, [0, 1]), at(line, 5, [0, 1]))).toBe(false);
    expect(segmentsIntersect(a, b, at(line, 1, [-1, 0]), at(line, 5, [-1, 0]))).toBe(false);
  });

  it.each(LINES)('keeps endpoint touching and crossing distinct from separation (line %#)', (line) => {
    const [a, b] = [at(line, 0), at(line, 3)];
    const perp = [-line.D[1], line.D[0]];
    // Shares only the endpoint b, heading off perpendicular.
    expect(segmentsIntersect(a, b, b, at(line, 3, perp))).toBe(true);
    // Crosses a-b at its interior vertex-on-grid at(line, 2).
    expect(segmentsIntersect(a, b, at(line, 2, perp), at(line, 2, [-perp[0], -perp[1]]))).toBe(true);
    // Collinear but beyond b: separated along the line.
    expect(segmentsIntersect(a, b, at(line, 4), at(line, 5))).toBe(false);
  });

  it.each(LINES)('a grid point on a sloped segment is on it; one 0.001 wu off is not (line %#)', (line) => {
    const [a, b] = [at(line, 0), at(line, 3)];
    expect(pointOnSegment(at(line, 1), a, b)).toBe(true);
    expect(pointOnSegment(at(line, 2), a, b)).toBe(true);
    expect(pointOnSegment(at(line, 1, [0, 1]), a, b)).toBe(false);
    expect(pointOnSegment(at(line, 4), a, b)).toBe(false);
    const ringA = [a, b, at(line, 3, [-line.D[1], line.D[0]]), at(line, 0, [-line.D[1], line.D[0]])];
    expect(geo.locatePointInRing(at(line, 1), ringA)).toBe('boundary');
    expect(locatePointInPolygon(at(line, 2), { outer: ringA, holes: [] })).toBe('boundary');
  });

  it.each(LINES)('polygons sharing part of a sloped edge touch; 0.001 wu apart they do not (line %#)', (line) => {
    const perp = [-line.D[1], line.D[0]];
    const neg = [-perp[0], -perp[1]];
    const add = (o, p) => [o[0] + p[0], o[1] + p[1]];
    // A sits on the +perp side of segment 0..3; B on the −perp side of 1..5, so they share
    // exactly the boundary stretch 1..3 and no interior.
    const A = normalizeGeometry('polygon', poly([at(line, 0), at(line, 3), at(line, 3, perp), at(line, 0, perp)]));
    const B = normalizeGeometry('polygon', poly([at(line, 1), at(line, 5), at(line, 5, neg), at(line, 1, neg)]));
    expect(polygonsIntersect(A, B)).toBe(true);
    expect(polygonsIntersect(B, A)).toBe(true);
    expect(geometryIntersectsPolygon('polygon', B, A)).toBe(true);

    // Move B one grid step further from A (dot(shift, perp) < 0).
    const away = [0, -Math.sign(perp[1])];
    const Bapart = normalizeGeometry('polygon', poly([
      at(line, 1, away), at(line, 5, away), at(line, 5, add(neg, away)), at(line, 1, add(neg, away)),
    ]));
    expect(polygonsIntersect(A, Bapart)).toBe(false);
    expect(polygonsIntersect(Bapart, A)).toBe(false);

    // A sloped linestring lying along the shared stretch touches A.
    expect(linestringIntersectsPolygon([at(line, 1), at(line, 2)], A)).toBe(true);
    expect(linestringIntersectsPolygon([at(line, 1, away), at(line, 2, away)], A)).toBe(false);
  });

  it.each(LINES)('validation rejects a sloped spike and a hole touching a sloped edge (line %#)', (line) => {
    const perp = [-line.D[1], line.D[0]];
    // Spike: edge 0→3 then straight back to 1 along the same sloped line.
    const spike = poly([at(line, 0), at(line, 3), at(line, 1), at(line, 1, perp)]);
    expect(codes(validateGeometry('polygon', spike))).toContain('self_intersection');
    // Hole whose edge lies on part of the outer ring's sloped edge.
    const half = [Math.trunc(perp[0] / 2), Math.trunc(perp[1] / 2)];
    const outer = [at(line, 0), at(line, 5), at(line, 5, perp), at(line, 0, perp)];
    const touching = poly(outer, [[at(line, 1), at(line, 3), at(line, 3, half), at(line, 1, half)]]);
    expect(codes(validateGeometry('polygon', touching))).toContain('hole_not_inside');
  });
});

describe('relateGeometryToPolygon (WP3 query classification)', () => {
  const { relateGeometryToPolygon } = geo;
  const target = poly(square(0, 0, 100), [square(40, 40, 20)]);

  it.each([
    ['a point in the interior', 'point', P(10, 10), 'inside'],
    ['a point on the outer edge', 'point', P(0, 50), 'boundary'],
    ['a point in a hole', 'point', P(50, 50), 'outside'],
    ['a point outside', 'point', P(200, 0), 'outside'],
    ['a line within the interior', 'linestring', ring([10, 10], [30, 10]), 'inside'],
    ['a line crossing the outer edge', 'linestring', ring([90, 10], [110, 10]), 'boundary'],
    ['a line touching a hole', 'linestring', ring([10, 40], [40, 40]), 'boundary'],
    ['a line outside', 'linestring', ring([200, 0], [210, 0]), 'outside'],
    ['a polygon within the interior', 'polygon', poly(square(5, 5, 10)), 'inside'],
    ['a polygon surrounding a hole without touching it', 'polygon', poly(square(30, 30, 40)), 'boundary'],
    ['a polygon covering the whole target', 'polygon', poly(square(-10, -10, 200)), 'boundary'],
    ['a polygon sharing an edge', 'polygon', poly(square(100, 0, 10)), 'boundary'],
    ['a polygon inside a hole', 'polygon', poly(square(45, 45, 5)), 'outside'],
    ['a polygon apart', 'polygon', poly(square(300, 300, 5)), 'outside'],
  ])('%s is %s', (_label, type, geometry, expected) => {
    expect(relateGeometryToPolygon(type, geometry, target)).toBe(expected);
  });
});
