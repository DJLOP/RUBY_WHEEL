/**
 * The reusable land multi-selection (WP6): accepted land polygons are the islands, a
 * selection is local working state, and "inside a boundary" is a one-off proposal —
 * never a membership, never a rule.
 */

import { describe, it, expect } from 'vitest';
import {
  EMPTY_SELECTION, addLand, clearSelection, createLandSelection, landAt, landInBox, landInsideBoundary, pruneSelection, removeLand,
  selectableLand, setSelection, toggleLand,
} from '../landSelection';
import { boundaryFeature, land, square } from './wp6Fixtures';

describe('selectable land', () => {
  it('is every accepted land polygon, with no separate island declaration', () => {
    const features = [
      land(1, 0), land(2, 20, 0, 10, { lifecycle_state: 'draft' }), land(3, 40, 0, 10, { feature_class: 'water' }),
      land(4, 60), boundaryFeature(5, 0, 0, 100),
    ];
    expect(selectableLand(features).map(f => f.id)).toEqual([1, 4]);
    // No island flag or island record exists to consult: the land row itself is the island.
    expect(Object.keys(features[0])).not.toContain('is_island');
  });
});

describe('selection edits', () => {
  it('toggles, adds, removes and clears, always sorted and de-duplicated', () => {
    let s = toggleLand(EMPTY_SELECTION, 5);
    s = addLand(s, [3, 5, 9]);
    expect(s.ids).toEqual([3, 5, 9]);
    s = toggleLand(s, 5);
    expect(s.ids).toEqual([3, 9]);
    s = removeLand(s, [9]);
    expect(s.ids).toEqual([3]);
    expect(setSelection(s, [7, 1, 7]).ids).toEqual([1, 7]);
    expect(clearSelection({ ...s, proposal: { scopeId: 1, boundaryFeatureId: 2, inside: [3], straddling: [] } })).toMatchObject({ ids: [], proposal: null });
  });

  it('prunes ids that are no longer accepted land, and is a no-op otherwise', () => {
    const s = setSelection(EMPTY_SELECTION, [1, 2, 3]);
    expect(pruneSelection(s, new Set([1, 3])).ids).toEqual([1, 3]);
    expect(pruneSelection(s, new Set([1, 2, 3]))).toBe(s);
  });

  it('notifies subscribers only on change', () => {
    const store = createLandSelection();
    let n = 0;
    store.subscribe(() => { n++; });
    store.update(s => toggleLand(s, 1));
    store.update(s => s);
    expect(store.getState().ids).toEqual([1]);
    expect(n).toBe(1);
  });
});

describe('picking', () => {
  const islands = [land(1, 0), land(2, 20), land(3, 100, 100, 5)];

  it('finds the island under a click, or none over water', () => {
    expect(landAt(islands, { x: 5, z: 5 })?.id).toBe(1);
    expect(landAt(islands, { x: 25, z: 2 })?.id).toBe(2);
    expect(landAt(islands, { x: 15, z: 5 })).toBeNull();
  });

  it('box-selects islands wholly inside the box, in either drag direction', () => {
    expect(landInBox(islands, { x: -1, z: -1 }, { x: 31, z: 11 })).toEqual([1, 2]);
    expect(landInBox(islands, { x: 31, z: 11 }, { x: -1, z: -1 })).toEqual([1, 2]);
    expect(landInBox(islands, { x: -1, z: -1 }, { x: 25, z: 11 })).toEqual([1]); // island 2 only partly inside
  });
});

describe('select land inside a boundary', () => {
  const boundary = boundaryFeature(9, -5, -5, 40);
  const b = boundary.geometry as ReturnType<typeof square>;

  it('proposes islands wholly inside and lists crossing ones separately', () => {
    const islands = [land(1, 0), land(2, 20), land(3, 30, 0, 20), land(4, 200)];
    expect(landInsideBoundary(islands, b, boundary.bbox)).toEqual({ inside: [1, 2], straddling: [3] });
  });

  it('counts an island touching the boundary (boundary snapped to its shoreline) as inside', () => {
    const snapped = [land(1, -5, -5, 10)];
    expect(landInsideBoundary(snapped, b, boundary.bbox).inside).toEqual([1]);
  });

  it('treats a boundary that cuts into an island as crossing it', () => {
    // A notched boundary whose vertex pokes into island 1.
    const notched = { outer: [{ x: -5, z: -5 }, { x: 35, z: -5 }, { x: 35, z: 35 }, { x: 5, z: 35 }, { x: 5, z: 5 }, { x: -5, z: 5 }], holes: [] };
    const res = landInsideBoundary([land(1, 0, 0, 10)], notched, { min_x: -5, min_z: -5, max_x: 35, max_z: 35 });
    expect(res).toEqual({ inside: [], straddling: [1] });
  });

  it('is a pure answer: it neither changes the selection nor describes membership', () => {
    const res = landInsideBoundary([land(1, 0)], b, boundary.bbox);
    expect(Object.keys(res).sort()).toEqual(['inside', 'straddling']);
  });
});
