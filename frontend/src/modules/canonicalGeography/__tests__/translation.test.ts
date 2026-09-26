/**
 * Whole-shape translation of the geometry being edited (WP6 live-acceptance remediation):
 * every coordinate moves by one delta, construction records stay consistent, and UNDO
 * restores the previous position.
 */

import { describe, it, expect } from 'vitest';
import {
  IDLE_TRACE, addPoint, beginTrace, beginTranslate, closeRing, hitsTraceBody, moveVertex, setMode, traceStartFromGeometry, translateConstruction,
  translateFrom, translateSnapshot, undoLast, type TraceState,
} from '../tracing';
import type { CircleConstruction, EllipseConstruction, RadialSpokeConstruction, RectConstruction } from '../geometry';

const square = (): TraceState => closeRing([[0, 0], [10, 0], [10, 10], [0, 10]]
  .reduce((s, [x, z]) => addPoint(s, { x, z }), beginTrace(IDLE_TRACE, { geometryType: 'polygon' })));

const move = (s: TraceState, dx: number, dz: number) => translateFrom(beginTranslate(s), translateSnapshot(s), dx, dz);

describe('translateFrom', () => {
  it('moves every polygon vertex (and hole) by the same delta, preserving shape', () => {
    const s = { ...square(), holes: [[{ x: 2, z: 2 }, { x: 2, z: 4 }, { x: 4, z: 4 }]] };
    const t = move(s, 5.5, -3);
    expect(t.vertices).toEqual([{ x: 5.5, z: -3 }, { x: 15.5, z: -3 }, { x: 15.5, z: 7 }, { x: 5.5, z: 7 }]);
    expect(t.holes[0]).toEqual([{ x: 7.5, z: -1 }, { x: 7.5, z: 1 }, { x: 9.5, z: 1 }]);
    expect(t.closed).toBe(true);
  });

  it('moves lines and points', () => {
    const line = [[0, 0], [5, 5], [9, 0]].reduce((s, [x, z]) => addPoint(s, { x, z }), beginTrace(IDLE_TRACE, { geometryType: 'linestring' }));
    expect(move(line, 1, 2).vertices).toEqual([{ x: 1, z: 2 }, { x: 6, z: 7 }, { x: 10, z: 2 }]);
    const pt = addPoint(beginTrace(IDLE_TRACE, { geometryType: 'point' }), { x: 3, z: 4 });
    expect(move(pt, -3, 1).vertices).toEqual([{ x: 0, z: 5 }]);
  });

  it('keeps a 3-point circle a circle: centre moves, radius unchanged, ring moves with it', () => {
    let s = setMode(beginTrace(IDLE_TRACE, { geometryType: 'polygon' }), 'circle_3pt');
    for (const p of [{ x: 10, z: 0 }, { x: 0, z: 10 }, { x: -10, z: 0 }]) s = addPoint(s, p);
    const c = s.construction as CircleConstruction;
    const t = move(s, 100, 50);
    const moved = t.construction as CircleConstruction;
    expect(moved).toMatchObject({ type: 'circle', radius: c.radius, segments: c.segments, method: 'three_point' });
    expect(moved.center.x).toBeCloseTo(c.center.x + 100, 3);
    expect(moved.center.z).toBeCloseTo(c.center.z + 50, 3);
    for (const v of t.vertices) expect(Math.hypot(v.x - moved.center.x, v.z - moved.center.z)).toBeCloseTo(c.radius, 1);
  });

  it('keeps ellipse and rotated-rectangle records consistent: centre moves, sizes and rotation do not', () => {
    let e = setMode(beginTrace(IDLE_TRACE, { geometryType: 'polygon' }), 'ellipse');
    for (const p of [{ x: 0, z: 0 }, { x: 20, z: 5 }, { x: -2, z: 8 }]) e = addPoint(e, p);
    const ec = e.construction as EllipseConstruction;
    expect(move(e, 7, 7).construction).toEqual({ ...ec, center: { x: ec.center.x + 7, z: ec.center.z + 7 } });

    let r = setMode(beginTrace(IDLE_TRACE, { geometryType: 'polygon' }), 'rect');
    for (const p of [{ x: 0, z: 0 }, { x: 10, z: 10 }, { x: 5, z: 20 }]) r = addPoint(r, p);
    const rc = r.construction as RectConstruction;
    const moved = move(r, -4, 2).construction as RectConstruction;
    expect(moved).toMatchObject({ type: 'rect', width: rc.width, height: rc.height, rotation_rad: rc.rotation_rad });
    expect(moved.center.x).toBeCloseTo(rc.center.x - 4, 3);
    expect(moved.center.z).toBeCloseTo(rc.center.z + 2, 3);
  });

  it('computes from the drag start, so many pointer moves do not accumulate', () => {
    const s = square();
    const base = translateSnapshot(s);
    let t = beginTranslate(s);
    for (let i = 1; i <= 50; i++) t = translateFrom(t, base, i * 0.1, 0);
    expect(t.vertices[0]).toEqual({ x: 5, z: 0 });
  });
});

describe('undo', () => {
  it('UNDO reverses a translation, including its construction record', () => {
    let s = setMode(beginTrace(IDLE_TRACE, { geometryType: 'polygon' }), 'circle_center');
    s = addPoint(addPoint(s, { x: 0, z: 0 }), { x: 5, z: 0 });
    const t = move(s, 30, 30);
    const back = undoLast(t);
    expect(back.vertices).toEqual(s.vertices);
    expect(back.construction).toEqual(s.construction);
    expect(back.closed).toBe(true);
  });

  it('two moves undo one at a time; a later vertex edit returns UNDO to its per-vertex meaning', () => {
    const s = square();
    const a = move(s, 1, 0);
    const b = move(a, 1, 0);
    expect(undoLast(b).vertices).toEqual(a.vertices);
    expect(undoLast(undoLast(b)).vertices).toEqual(s.vertices);
    const edited = moveVertex(b, 0, { x: -5, z: -5 });
    expect(edited.translateUndo).toEqual([]);
    expect(undoLast(edited).closed).toBe(false); // the ordinary undo: reopen the ring
  });
});

describe('radial spoke records (plan §15.8)', () => {
  const record: RadialSpokeConstruction = {
    type: 'radial_spoke', version: 1, construction_id: 'c1', center: { x: 0, z: 0 }, center_source: { kind: 'coordinate' },
    inner: { feature_id: 1, revision: 1 }, outer: { feature_id: 2, revision: 1 }, count: 4, offset_deg: 0, omit_indices: [],
    index: 0, angle_deg: 0, angle_convention: 'deg_from_+x_toward_+z',
  };
  const draftSpoke = () => beginTrace(IDLE_TRACE, traceStartFromGeometry('linestring', [{ x: 50, z: 0 }, { x: 200, z: 0 }], 7, record));

  it('translating a radial spoke clears its record rather than shifting its center', () => {
    expect(translateConstruction(record, 5, 5)).toBeNull();
    const s = draftSpoke();
    expect(s.construction).toEqual(record);
    const t = move(s, 5, 0);
    expect(t.vertices).toEqual([{ x: 55, z: 0 }, { x: 205, z: 0 }]);
    expect(t.construction).toBeNull();
  });

  it('undoing the move restores the record together with the geometry', () => {
    const t = move(draftSpoke(), 5, 0);
    const back = undoLast(t);
    expect(back.vertices).toEqual([{ x: 50, z: 0 }, { x: 200, z: 0 }]);
    expect(back.construction).toEqual(record);
  });

  it('vertex-editing a radial spoke clears its record', () => {
    expect(moveVertex(draftSpoke(), 1, { x: 210, z: 0 }).construction).toBeNull();
  });

  it('circle, ellipse and rectangle records still move with their geometry', () => {
    const c: CircleConstruction = { type: 'circle', center: { x: 1, z: 1 }, radius: 3, method: 'center_radius', segments: 8, max_chord_error_m: 0.25 };
    expect(translateConstruction(c, 2, 3)).toEqual({ ...c, center: { x: 3, z: 4 } });
  });
});

describe('hitsTraceBody', () => {
  it('is inside a closed polygon or near its edges; near a line; on a point', () => {
    expect(hitsTraceBody(square(), { x: 5, z: 5 }, 0.5)).toBe(true);
    expect(hitsTraceBody(square(), { x: 10.3, z: 5 }, 0.5)).toBe(true);
    expect(hitsTraceBody(square(), { x: 12, z: 5 }, 0.5)).toBe(false);
    const line = [[0, 0], [10, 0]].reduce((s, [x, z]) => addPoint(s, { x, z }), beginTrace(IDLE_TRACE, { geometryType: 'linestring' }));
    expect(hitsTraceBody(line, { x: 5, z: 0.3 }, 0.5)).toBe(true);
    expect(hitsTraceBody(line, { x: 5, z: 3 }, 0.5)).toBe(false);
    const pt = addPoint(beginTrace(IDLE_TRACE, { geometryType: 'point' }), { x: 3, z: 3 });
    expect(hitsTraceBody(pt, { x: 3.2, z: 3 }, 0.5)).toBe(true);
  });
});
