/**
 * The tracing session: vertex add/undo/close/drag/insert/delete, constructors, snapping and
 * the click-versus-drag rule (plan §7.2, §10 "Tracing tool").
 */

import { describe, it, expect, vi } from 'vitest';
import {
  CLICK_MAX_MOVE_PX, IDLE_TRACE, SnapIndex, addPoint, beginTrace, closeRing, createTracingSession, deleteVertex, insertVertex,
  isClick, moveVertex, resolveSnap, setMode, simplifyTrace, traceGeometry, traceStartFromGeometry, undoLast, type TraceState,
} from '../tracing';

const start = (geometryType: TraceState['geometryType'] = 'polygon') => beginTrace(IDLE_TRACE, { geometryType });
const clicks = (s: TraceState, pts: [number, number][]) => pts.reduce((acc, [x, z]) => addPoint(acc, { x, z }), s);

describe('click versus drag', () => {
  it('treats small pointer movement as a click and larger movement as a camera drag', () => {
    expect(isClick({ x: 100, y: 100 }, { x: 100, y: 100 })).toBe(true);
    expect(isClick({ x: 100, y: 100 }, { x: 103, y: 104 })).toBe(true); // exactly 5 px
    expect(isClick({ x: 100, y: 100 }, { x: 100 + CLICK_MAX_MOVE_PX + 1, y: 100 })).toBe(false);
  });
});

describe('vertex editing', () => {
  it('adds vertices, rounds them to the stored grid, and ignores a repeated click', () => {
    let s = clicks(start(), [[0, 0], [10.00049, 0], [10.00049, 0]]);
    expect(s.vertices).toEqual([{ x: 0, z: 0 }, { x: 10, z: 0 }]);
    s = addPoint(s, { x: 10, z: 10 });
    expect(s.selectedVertex).toBe(2);
  });

  it('closes a ring only with three vertices, and a closed ring takes no more clicks', () => {
    let s = clicks(start(), [[0, 0], [10, 0]]);
    expect(closeRing(s).closed).toBe(false);
    expect(closeRing(s).message).toMatch(/at least 3/);
    s = closeRing(addPoint(s, { x: 10, z: 10 }));
    expect(s.closed).toBe(true);
    const after = addPoint(s, { x: 50, z: 50 });
    expect(after.vertices).toHaveLength(3);
    expect(after.message).toMatch(/closed/);
    expect(traceGeometry(s)).toEqual({ outer: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }], holes: [] });
  });

  it('undoes the closure first, then the last vertex', () => {
    const s = closeRing(clicks(start(), [[0, 0], [10, 0], [10, 10]]));
    const reopened = undoLast(s);
    expect(reopened.closed).toBe(false);
    expect(reopened.vertices).toHaveLength(3);
    expect(undoLast(reopened).vertices).toHaveLength(2);
    expect(undoLast(start())).toEqual(start());
  });

  it('drags, inserts on an edge (including the closing edge) and deletes', () => {
    let s = closeRing(clicks(start(), [[0, 0], [10, 0], [10, 10], [0, 10]]));
    s = moveVertex(s, 2, { x: 12, z: 12 });
    expect(s.vertices[2]).toEqual({ x: 12, z: 12 });
    s = insertVertex(s, 3, { x: 0, z: 5 }); // closing edge 3 → 0
    expect(s.vertices).toEqual([{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 12, z: 12 }, { x: 0, z: 10 }, { x: 0, z: 5 }]);
    expect(s.selectedVertex).toBe(4);
    s = deleteVertex(s, 4);
    expect(s.vertices).toHaveLength(4);
    // Out-of-range edits change nothing.
    expect(moveVertex(s, 9, { x: 1, z: 1 })).toBe(s);
    expect(insertVertex(s, 9, { x: 1, z: 1 })).toBe(s);
  });

  it('refuses to delete a closed ring below a triangle', () => {
    const s = closeRing(clicks(start(), [[0, 0], [10, 0], [10, 10]]));
    const after = deleteVertex(s, 0);
    expect(after.vertices).toHaveLength(3);
    expect(after.message).toMatch(/at least 3/);
  });

  it('keeps one point for point geometry and emits linestrings with closure repeated', () => {
    const p = clicks(start('point'), [[1, 1], [2, 2]]);
    expect(traceGeometry(p)).toEqual({ x: 2, z: 2 });
    const line = clicks(start('linestring'), [[0, 0], [10, 0], [10, 10]]);
    expect(traceGeometry(line)).toEqual([{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }]);
    expect(traceGeometry(closeRing(line))).toEqual([{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 0 }]);
    expect(traceGeometry(clicks(start(), [[0, 0], [1, 0], [1, 1]]))).toBeNull(); // open polygon is incomplete
  });

  it('round-trips saved geometry into a session, keeping holes', () => {
    const hole = [{ x: 2, z: 2 }, { x: 2, z: 4 }, { x: 4, z: 4 }];
    const poly = beginTrace(IDLE_TRACE, traceStartFromGeometry('polygon', { outer: [{ x: 0, z: 0 }, { x: 9, z: 0 }, { x: 9, z: 9 }], holes: [hole] }, 7));
    expect(poly).toMatchObject({ featureId: 7, closed: true, holes: [hole] });
    expect(traceGeometry(poly)).toEqual({ outer: [{ x: 0, z: 0 }, { x: 9, z: 0 }, { x: 9, z: 9 }], holes: [hole] });
    const loop = traceStartFromGeometry('linestring', [{ x: 0, z: 0 }, { x: 5, z: 0 }, { x: 5, z: 5 }, { x: 0, z: 0 }], 8);
    expect(loop).toMatchObject({ closed: true, vertices: [{ x: 0, z: 0 }, { x: 5, z: 0 }, { x: 5, z: 5 }] });
  });

  it('simplifies with a tolerance in metres and reports what it removed', () => {
    const wobbly = closeRing(clicks(start(), [[0, 0], [50, 0.01], [100, 0], [100, 100], [0, 100]]));
    const s = simplifyTrace(wobbly, 0.5);
    expect(s.vertices).toHaveLength(4);
    expect(s.message).toMatch(/1 vertex/);
  });
});

describe('normalization constructors in the session', () => {
  it('replaces the ring with a clean circle after three clicks and records construction', () => {
    let s = setMode(start(), 'circle_3pt');
    s = clicks(s, [[10, 0], [0, 10]]);
    expect(s.constructionPoints).toHaveLength(2);
    expect(s.vertices).toEqual([]);
    s = addPoint(s, { x: -10, z: 0 });
    expect(s.mode).toBe('vertex');
    expect(s.closed).toBe(true);
    expect(s.construction).toMatchObject({ type: 'circle', radius: 10, center: { x: 0, z: 0 } });
    expect(traceGeometry(s)).not.toBeNull();
  });

  it('drops the construction record once a vertex is edited by hand', () => {
    const circle = clicks(setMode(start(), 'circle_center'), [[0, 0], [10, 0]]);
    expect(circle.construction).not.toBeNull();
    expect(moveVertex(circle, 0, { x: 11, z: 0 }).construction).toBeNull();
  });

  it('reports collinear constructor clicks and starts the constructor over', () => {
    const s = clicks(setMode(start(), 'circle_3pt'), [[0, 0], [1, 1], [2, 2]]);
    expect(s.constructionPoints).toEqual([]);
    expect(s.message).toMatch(/collinear/);
    expect(s.vertices).toEqual([]);
  });

  it('offers constructors for polygons only', () => {
    expect(setMode(start('linestring'), 'rect').mode).toBe('vertex');
  });

  it('undo removes a pending constructor point first', () => {
    const s = clicks(setMode(start(), 'rect'), [[0, 0], [10, 0]]);
    expect(undoLast(s).constructionPoints).toHaveLength(1);
  });
});

describe('snapping', () => {
  const island = { id: 1, geometry_type: 'polygon' as const, geometry: { outer: [{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 100, z: 100 }, { x: 0, z: 100 }], holes: [] } };
  const route = { id: 2, geometry_type: 'linestring' as const, geometry: [{ x: 200, z: 0 }, { x: 300, z: 0 }] };

  it('prefers a vertex within reach, then an edge, then nothing', () => {
    const idx = new SnapIndex([island, route]);
    expect(idx.query({ x: 99, z: 98 }, 3)).toEqual({ point: { x: 100, z: 100 }, kind: 'vertex', featureId: 1 });
    expect(idx.query({ x: 50, z: 1.5 }, 3)).toEqual({ point: { x: 50, z: 0 }, kind: 'edge', featureId: 1 });
    expect(idx.query({ x: 250, z: -2 }, 3)).toEqual({ point: { x: 250, z: 0 }, kind: 'edge', featureId: 2 });
    expect(idx.query({ x: 50, z: 50 }, 3)).toBeNull();
  });

  it('snaps along the shared shoreline of a neighbouring island, including the closing edge', () => {
    const idx = new SnapIndex([island]);
    expect(idx.query({ x: 1.2, z: 60 }, 2)).toEqual({ point: { x: 0, z: 60 }, kind: 'edge', featureId: 1 });
  });

  it('never snaps a feature to itself', () => {
    const idx = new SnapIndex([island], 1);
    expect(idx.query({ x: 99, z: 98 }, 3)).toBeNull();
  });

  it('closes the ring when the first vertex is clicked, and honours the snap toggle', () => {
    const idx = new SnapIndex([island]);
    const open = clicks(start(), [[10, 10], [60, 10], [60, 60]]);
    expect(resolveSnap(open, { x: 10.5, z: 10.5 }, idx, 2)).toMatchObject({ closes: true, point: { x: 10, z: 10 } });
    expect(resolveSnap(open, { x: 10.5, z: 10.5 }, idx, 2, { allowClose: false }).closes).toBe(false);
    expect(resolveSnap(open, { x: 99, z: 99 }, idx, 2)).toMatchObject({ kind: 'vertex', point: { x: 100, z: 100 } });
    expect(resolveSnap({ ...open, snapping: false }, { x: 99, z: 99 }, idx, 2)).toMatchObject({ kind: null, point: { x: 99, z: 99 } });
  });
});

describe('session store', () => {
  it('notifies subscribers only when an edit changes the state', () => {
    const session = createTracingSession();
    const listener = vi.fn();
    const off = session.subscribe(listener);
    session.update(s => beginTrace(s, { geometryType: 'polygon' }));
    session.update(s => s);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    session.update(s => addPoint(s, { x: 1, z: 1 }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(session.getState().vertices).toEqual([{ x: 1, z: 1 }]);
  });

  it('keeps the snap preference across sessions', () => {
    const s = beginTrace({ ...IDLE_TRACE, snapping: false }, { geometryType: 'polygon' });
    expect(s.snapping).toBe(false);
  });
});
