/**
 * The ground grid at strategic scale.
 *
 * Seen from a few hundred units the inherited `city-grid` is what a person navigates and
 * calibrates by. Seen from the altitude a whole reference layer needs, it stops being a
 * grid at all: drei's `Grid` computes line coverage from `fwidth` of the grid coordinate,
 * so once a cell falls below a pixel the coverage term approaches 1 for every fragment
 * rather than only the ones on a line, and the lattice fills in as a solid dark slab with
 * a hard circular edge where `fadeDistance` discards the rest.
 *
 * So the grid has to know how big it is on screen. The measure is the spacing of the
 * *section* lines rather than the cells: at the default camera the 1-unit cells are already
 * only about 3px apart and read as a haze, while the 10-unit sections are what carry the
 * structure.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { act } from 'react';

const frameCallbacks: ((state: any) => void)[] = [];
const threeState: any = {
  camera: { fov: 50, position: { length: () => 320 } },
  size: { width: 1600, height: 900 },
};

vi.mock('@react-three/fiber', () => ({
  useFrame: (fn: (state: any) => void) => { frameCallbacks.push(fn); },
  useThree: () => threeState,
}));

vi.mock('@react-three/drei', () => ({
  Grid: (props: any) => <div data-testid="grid" data-name={props.name} data-cellsize={String(props.cellSize)} />,
}));

import {
  WorldGrid,
  CloseRangeOnly,
  sectionPixelSpacing,
  nextGridVisibility,
  SECTION_PIXELS_HIDE,
  SECTION_PIXELS_SHOW,
  SECTION_SIZE,
} from '../WorldGrid';

/** Drive the frame loop the way R3F would, then let React flush the visibility flip. */
const tick = (distance: number) => act(() => {
  frameCallbacks.forEach(fn => fn({ controls: { distance } }));
});

beforeEach(() => {
  frameCallbacks.length = 0;
  threeState.camera = { fov: 50, position: { length: () => 320 } };
  threeState.size = { width: 1600, height: 900 };
});

describe('sectionPixelSpacing', () => {
  it('reports roughly 30px between sections at the distance the app opens at', () => {
    // 320 units away, 50 degree fov, 900px tall: the view spans ~298 world units.
    expect(sectionPixelSpacing(320, 50, 900)).toBeCloseTo(30.2, 1);
  });

  it('collapses to well under a pixel at whole-city altitude', () => {
    expect(sectionPixelSpacing(17546.9, 50, 900)).toBeLessThan(1);
  });

  it('shrinks in proportion to distance', () => {
    expect(sectionPixelSpacing(640, 50, 900)).toBeCloseTo(sectionPixelSpacing(320, 50, 900) / 2, 6);
  });

  it('grows with a taller viewport, because a world unit covers more pixels', () => {
    expect(sectionPixelSpacing(320, 50, 1800)).toBeCloseTo(sectionPixelSpacing(320, 50, 900) * 2, 6);
  });

  it('takes the section size it is given', () => {
    expect(sectionPixelSpacing(320, 50, 900, SECTION_SIZE * 2))
      .toBeCloseTo(sectionPixelSpacing(320, 50, 900) * 2, 6);
  });

  it('reports an unusable view rather than NaN for degenerate input', () => {
    expect(sectionPixelSpacing(0, 50, 900)).toBe(Infinity);
    expect(sectionPixelSpacing(320, 0, 900)).toBe(Infinity);
    expect(sectionPixelSpacing(320, 50, 0)).toBe(Infinity);
  });
});

describe('nextGridVisibility', () => {
  it('hides a visible grid only once its sections are too close together', () => {
    expect(nextGridVisibility(SECTION_PIXELS_HIDE + 0.1, true)).toBe(true);
    expect(nextGridVisibility(SECTION_PIXELS_HIDE - 0.1, true)).toBe(false);
  });

  // Without the gap, holding a dolly at the boundary flickers the grid on and off, which
  // is worse than either state.
  it('needs more room to come back than it needed to stay', () => {
    expect(SECTION_PIXELS_SHOW).toBeGreaterThan(SECTION_PIXELS_HIDE);
    const between = (SECTION_PIXELS_HIDE + SECTION_PIXELS_SHOW) / 2;
    expect(nextGridVisibility(between, true)).toBe(true);
    expect(nextGridVisibility(between, false)).toBe(false);
  });

  it('brings a hidden grid back once the sections are clearly legible again', () => {
    expect(nextGridVisibility(SECTION_PIXELS_SHOW + 0.1, false)).toBe(true);
  });
});

describe('WorldGrid', () => {
  it('draws the inherited grid at the distance the app opens at', () => {
    const { queryByTestId } = render(<WorldGrid name="city-grid" cellSize={1} sectionSize={10} />);
    tick(320);
    expect(queryByTestId('grid')).not.toBeNull();
  });

  it('passes every inherited prop straight through', () => {
    const { getByTestId } = render(<WorldGrid name="city-grid" cellSize={1} sectionSize={10} />);
    tick(320);
    expect(getByTestId('grid').getAttribute('data-name')).toBe('city-grid');
    expect(getByTestId('grid').getAttribute('data-cellsize')).toBe('1');
  });

  // The defect: at whole-map altitude this rendered as a dense dark slab with a circular
  // edge, over the drawing somebody was trying to read.
  it('stops drawing at whole-city altitude', () => {
    const { queryByTestId } = render(<WorldGrid name="city-grid" cellSize={1} sectionSize={10} />);
    tick(17546.9);
    expect(queryByTestId('grid')).toBeNull();
  });

  it('comes back when the camera returns to a working distance', () => {
    const { queryByTestId } = render(<WorldGrid name="city-grid" cellSize={1} sectionSize={10} />);
    tick(17546.9);
    expect(queryByTestId('grid')).toBeNull();
    tick(320);
    expect(queryByTestId('grid')).not.toBeNull();
  });

  it('stays drawn through the close-range calibration work the plan calls for', () => {
    const { queryByTestId } = render(<WorldGrid name="city-grid" cellSize={1} sectionSize={10} />);
    for (const distance of [5, 50, 200, 320, 800]) {
      tick(distance);
      expect(queryByTestId('grid'), `distance ${distance}`).not.toBeNull();
    }
  });

  // The signal is the view, so the same camera behaves the same way whatever panel the
  // person happens to have open.
  it('decides from the camera alone', () => {
    const { queryByTestId } = render(<WorldGrid name="city-grid" />);
    tick(17546.9);
    const hiddenAtAltitude = queryByTestId('grid');
    tick(320);
    const shownUpClose = queryByTestId('grid');
    expect(hiddenAtAltitude).toBeNull();
    expect(shownUpClose).not.toBeNull();
  });

  it('accounts for the viewport, not just the distance', () => {
    // A distance whose section spacing straddles the threshold as the viewport changes.
    // The size object is mutated rather than replaced because `useThree` hands the same
    // object to the component, exactly as R3F does between resizes.
    threeState.size.height = 300;
    const { queryByTestId } = render(<WorldGrid name="city-grid" />);
    tick(1200);
    expect(queryByTestId('grid')).toBeNull();

    threeState.size.height = 2400;
    tick(1200);
    expect(queryByTestId('grid')).not.toBeNull();
  });

  it('falls back to the camera position before the controls have mounted', () => {
    threeState.camera = { fov: 50, position: { length: () => 17546.9 } };
    const { queryByTestId } = render(<WorldGrid name="city-grid" />);
    act(() => { frameCallbacks.forEach(fn => fn({ controls: null })); });
    expect(queryByTestId('grid')).toBeNull();
  });
});

describe('CloseRangeOnly', () => {
  // `city-ref-lines`: four fixed 2000-unit bars through the world origin, drawn for admins
  // as an alignment aid. At a city-wide view they neither span what is being looked at nor
  // line up with anything on it.
  it('draws its children at working distances', () => {
    const { queryByTestId } = render(<CloseRangeOnly><div data-testid="ref-lines" /></CloseRangeOnly>);
    tick(320);
    expect(queryByTestId('ref-lines')).not.toBeNull();
  });

  it('stops drawing them at whole-city altitude', () => {
    const { queryByTestId } = render(<CloseRangeOnly><div data-testid="ref-lines" /></CloseRangeOnly>);
    tick(17546.9);
    expect(queryByTestId('ref-lines')).toBeNull();
  });

  it('uses the same threshold as the grid, so the two never disagree', () => {
    const grid = render(<WorldGrid name="city-grid" />);
    const helpers = render(<CloseRangeOnly><div data-testid="ref-lines" /></CloseRangeOnly>);
    for (const distance of [100, 320, 1000, 1500, 2000, 17546.9]) {
      tick(distance);
      const gridDrawn = grid.queryByTestId('grid') !== null;
      const helpersDrawn = helpers.queryByTestId('ref-lines') !== null;
      expect(helpersDrawn, `distance ${distance}`).toBe(gridDrawn);
    }
  });
});
