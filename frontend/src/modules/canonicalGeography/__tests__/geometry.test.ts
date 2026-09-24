/**
 * Normalization aids and the validation mirror (plan §4.1, §10 "geometry.ts").
 *
 * A circle clicked on an imperfect raster circle must come out as a clean circle that says
 * how it was built; curve segment counts come from the fixed chord error, not a setting;
 * metres come from the canonical 1.524 m/wu.
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_CHORD_ERROR_M, circleFromCenter, circleFromThreePoints, circleThroughPoints, ellipseFromPoints, geometryIssues,
  lineLength, polygonArea, rectangleFromPoints, ringPerimeter, ringSignedArea, segmentsForRadius, simplifyLine, simplifyRing,
  distance, closestOnSegment,
} from '../geometry';
import { formatArea, formatLength, metersToWorldUnits, squareWorldUnitsToSquareMeters, worldUnitsToMeters } from '../physicalScale';

const sq = (s: number) => [{ x: 0, z: 0 }, { x: s, z: 0 }, { x: s, z: s }, { x: 0, z: s }];

describe('area and length in metres', () => {
  it('measures a 1,000 wu square as 1,524 m a side', () => {
    expect(worldUnitsToMeters(ringPerimeter(sq(1000)) / 4)).toBeCloseTo(1524, 9);
    expect(squareWorldUnitsToSquareMeters(polygonArea(sq(1000)))).toBeCloseTo(1524 * 1524, 3);
    expect(formatArea(polygonArea(sq(1000)))).toBe('232.26 ha');
    expect(formatLength(lineLength([{ x: 0, z: 0 }, { x: 100, z: 0 }]))).toBe('152.4 m');
  });

  it('subtracts holes and treats counter-clockwise X/Z as positive', () => {
    expect(ringSignedArea(sq(10))).toBe(100);
    expect(ringSignedArea(sq(10).reverse())).toBe(-100);
    const hole = [{ x: 2, z: 2 }, { x: 2, z: 4 }, { x: 4, z: 4 }, { x: 4, z: 2 }];
    expect(polygonArea(sq(10), [hole])).toBe(96);
  });
});

describe('circle normalization', () => {
  it('fits the circle through three rim points', () => {
    const c = circleFromThreePoints({ x: 15, z: 5 }, { x: 5, z: 15 }, { x: -5, z: 5 })!;
    expect(c.center.x).toBeCloseTo(5, 9);
    expect(c.center.z).toBeCloseTo(5, 9);
    expect(c.radius).toBeCloseTo(10, 9);
  });

  it('refuses collinear points', () => {
    expect(circleFromThreePoints({ x: 0, z: 0 }, { x: 1, z: 1 }, { x: 2, z: 2 })).toBeNull();
    expect(circleThroughPoints({ x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 })).toBeNull();
  });

  it('turns an imperfect raster circle into a clean one and records its construction', () => {
    // Three wobbly clicks near a radius-100 circle centred at (50, -20).
    const built = circleThroughPoints({ x: 150.4, z: -20 }, { x: 50, z: 79.6 }, { x: -49.8, z: -20.3 })!;
    const { construction, ring } = built;
    expect(construction.type).toBe('circle');
    if (construction.type !== 'circle') throw new Error('unreachable');
    expect(construction.method).toBe('three_point');
    expect(construction.segments).toBe(ring.length);
    // Every vertex lies on the fitted circle (to the stored 0.001 wu grid).
    for (const p of ring) expect(Math.abs(distance(p, construction.center) - construction.radius)).toBeLessThan(0.002);
    // Counter-clockwise, as stored.
    expect(ringSignedArea(ring)).toBeGreaterThan(0);
  });

  it('keeps every chord within the fixed chord error', () => {
    for (const r of [5, 100, 1000, 3000]) {
      const n = segmentsForRadius(r);
      const sagittaM = worldUnitsToMeters(r * (1 - Math.cos(Math.PI / n)));
      expect(sagittaM).toBeLessThanOrEqual(MAX_CHORD_ERROR_M + 1e-9);
      // …and does not wildly over-segment: one fewer segment would exceed it.
      if (n > 8) expect(worldUnitsToMeters(r * (1 - Math.cos(Math.PI / (n - 1))))).toBeGreaterThan(MAX_CHORD_ERROR_M);
    }
    expect(segmentsForRadius(metersToWorldUnits(0.1))).toBe(8);
  });

  it('builds from centre and a rim point', () => {
    const built = circleFromCenter({ x: 0, z: 0 }, { x: 30, z: 40 })!;
    expect(built.construction).toMatchObject({ type: 'circle', method: 'center_radius', radius: 50, center: { x: 0, z: 0 } });
  });
});

describe('ellipse and rectangle construction', () => {
  it('builds a rotated ellipse from centre, semi-axis end and extent', () => {
    const built = ellipseFromPoints({ x: 0, z: 0 }, { x: 0, z: 40 }, { x: 10, z: 5 })!;
    expect(built.construction).toMatchObject({ type: 'ellipse', radius_x: 40, radius_z: 10 });
    if (built.construction.type !== 'ellipse') throw new Error('unreachable');
    expect(built.construction.rotation_rad).toBeCloseTo(Math.PI / 2, 9);
    const xs = built.ring.map(p => p.x);
    const zs = built.ring.map(p => p.z);
    expect(Math.max(...zs)).toBeCloseTo(40, 2);
    expect(Math.max(...xs)).toBeCloseTo(10, 1);
    expect(ringSignedArea(built.ring)).toBeGreaterThan(0);
    // Inscribed polygon: slightly under the true area, within the chord-error budget.
    expect(polygonArea(built.ring)).toBeLessThan(Math.PI * 40 * 10);
    expect(polygonArea(built.ring) / (Math.PI * 40 * 10)).toBeGreaterThan(0.99);
  });

  it('builds a rotated rectangle from one edge and the opposite side', () => {
    const built = rectangleFromPoints({ x: 0, z: 0 }, { x: 30, z: 30 }, { x: -10, z: 10 })!;
    if (built.construction.type !== 'rect') throw new Error('unreachable');
    expect(built.construction.width).toBeCloseTo(Math.hypot(30, 30), 3);
    expect(built.construction.height).toBeCloseTo(Math.hypot(10, 10), 3);
    expect(built.construction.rotation_rad).toBeCloseTo(Math.PI / 4, 9);
    expect(built.construction.center.x).toBeCloseTo(10, 3);
    expect(built.construction.center.z).toBeCloseTo(20, 3);
    expect(built.ring).toHaveLength(4);
    expect(polygonArea(built.ring)).toBeCloseTo(Math.hypot(30, 30) * Math.hypot(10, 10), 2);
  });

  it('refuses degenerate input', () => {
    expect(ellipseFromPoints({ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 20, z: 0 })).toBeNull();
    expect(rectangleFromPoints({ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 5, z: 0 })).toBeNull();
  });
});

describe('simplification', () => {
  const noisy = Array.from({ length: 101 }, (_, i) => ({ x: i, z: (i % 2 ? 1 : -1) * metersToWorldUnits(0.1) }));

  it('drops vertices within the tolerance in metres, and keeps those beyond it', () => {
    expect(simplifyLine(noisy, 0.25)).toEqual([noisy[0], noisy[100]]);
    // At 0.15 m the 0.2 m zig-zag cannot be flattened, and no original vertex strays
    // further than the tolerance from the simplified line.
    const kept = simplifyLine(noisy, 0.15);
    expect(kept.length).toBeGreaterThan(2);
    const tol = metersToWorldUnits(0.15);
    for (const p of noisy) {
      const d = Math.min(...kept.slice(1).map((b, i) => distance(p, closestOnSegment(p, kept[i], b).point)));
      expect(d).toBeLessThanOrEqual(tol + 1e-12);
    }
    expect(simplifyLine(noisy, 0)).toHaveLength(101);
  });

  it('never collapses a ring below a triangle', () => {
    const dense = Array.from({ length: 64 }, (_, i) => ({ x: 100 * Math.cos((2 * Math.PI * i) / 64), z: 100 * Math.sin((2 * Math.PI * i) / 64) }));
    expect(simplifyRing(dense, 5).length).toBeLessThan(64);
    expect(simplifyRing(dense, 1e6).length).toBeGreaterThanOrEqual(3);
  });
});

describe('validation mirror', () => {
  it('accepts a valid square and a concave polygon', () => {
    expect(geometryIssues('polygon', sq(10), { closed: true })).toEqual([]);
    expect(geometryIssues('polygon', [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 5, z: 3 }, { x: 10, z: 10 }, { x: 0, z: 10 }], { closed: true })).toEqual([]);
  });

  it('reports an open ring, a bow-tie, coincident vertices, tiny area and out-of-range coordinates', () => {
    expect(geometryIssues('polygon', sq(10), { closed: false })).toContain('close the ring');
    expect(geometryIssues('polygon', [{ x: 0, z: 0 }, { x: 10, z: 10 }, { x: 10, z: 0 }, { x: 0, z: 10 }], { closed: true }))
      .toContain('the outline crosses itself');
    expect(geometryIssues('polygon', [{ x: 0, z: 0 }, { x: 0, z: 0 }, { x: 10, z: 0 }, { x: 0, z: 10 }], { closed: true }))
      .toContain('two consecutive vertices coincide');
    expect(geometryIssues('polygon', sq(0.5), { closed: true }).some(i => /area is below/.test(i))).toBe(true);
    expect(geometryIssues('point', [{ x: 25000, z: 0 }]).some(i => /beyond/.test(i))).toBe(true);
  });

  it('checks lines, including closed loops and self-crossing', () => {
    expect(geometryIssues('linestring', [{ x: 0, z: 0 }])).toContain('a line needs at least 2 vertices');
    expect(geometryIssues('linestring', [{ x: 0, z: 0 }, { x: 10, z: 0 }])).toEqual([]);
    expect(geometryIssues('linestring', sq(10), { closed: true })).toEqual([]);
    expect(geometryIssues('linestring', [{ x: 0, z: 0 }, { x: 10, z: 10 }, { x: 10, z: 0 }, { x: 0, z: 10 }]))
      .toContain('the line crosses itself');
  });
});
