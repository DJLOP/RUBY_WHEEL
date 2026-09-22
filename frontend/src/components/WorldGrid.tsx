import { useRef, useState, type ReactNode } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Grid } from '@react-three/drei';

/**
 * The ground grid, and the editor helpers drawn on it, shown only at scales where they
 * mean something.
 *
 * The grid is drei's `Grid`: an infinite shader-drawn lattice whose lines are produced by
 * `getGrid`, which measures a cell against `fwidth` — the screen-space derivative of the
 * grid coordinate. That is what makes it antialias correctly at working distances, and it
 * is also what makes it fail at altitude. Once a cell is smaller than a pixel, `fwidth`
 * grows past the cell size, the computed line coverage approaches 1 for every fragment
 * rather than just the ones on a line, and the whole lattice fills in. The result is not a
 * faint grid, it is a solid dark slab — with a hard circular edge at `fadeDistance`, where
 * the shader's `d` term reaches zero and the fragments are discarded.
 *
 * Both symptoms are the same object seen from too far away, so the fix is to stop drawing
 * it once it has stopped being a grid.
 *
 * The test is the on-screen spacing of the *section* lines, not the cells. At the default
 * camera the 1-unit cells are already only about 3px apart and read as a haze; what a
 * person actually navigates by is the 10-unit sections, roughly 30px apart. So sections
 * are what has to stay legible, and cells come along with them.
 *
 * This is measured from the camera, never from whether some panel is open: the question is
 * "can these lines still be told apart", and only the view can answer it.
 */

/** Below this many pixels between section lines the grid has become a dark mass. */
export const SECTION_PIXELS_HIDE = 6;
/**
 * And above this it is legible again. The gap between the two is deliberate — a single
 * threshold makes the grid flicker on and off while somebody holds a dolly at the
 * boundary, which is worse than either state.
 */
export const SECTION_PIXELS_SHOW = 10;

/** The inherited grid's section spacing, in world units. */
export const SECTION_SIZE = 10;

/**
 * How many screen pixels apart the section lines are, for a camera `distance` away.
 *
 * Straight perspective: the world height visible at that distance is `2*d*tan(fov/2)`, so
 * a pixel is worth that divided by the viewport height.
 */
export function sectionPixelSpacing(
  distance: number,
  fovDegrees: number,
  viewportHeightPx: number,
  sectionSize = SECTION_SIZE,
): number {
  if (!(distance > 0) || !(fovDegrees > 0) || !(viewportHeightPx > 0)) return Infinity;
  const visibleWorldHeight = 2 * distance * Math.tan((fovDegrees * Math.PI) / 180 / 2);
  if (!(visibleWorldHeight > 0)) return Infinity;
  return (sectionSize / visibleWorldHeight) * viewportHeightPx;
}

/** Whether the grid should be drawn, given where it was a moment ago. */
export function nextGridVisibility(spacingPx: number, wasVisible: boolean): boolean {
  if (wasVisible) return spacingPx >= SECTION_PIXELS_HIDE;
  return spacingPx >= SECTION_PIXELS_SHOW;
}

/**
 * Tracks whether the view is still close enough for ground-level reference lines.
 *
 * Returns a boolean and only re-renders when it flips, so holding a dolly does not cost a
 * render per frame.
 */
export function useCloseRangeView(): boolean {
  const { camera, size } = useThree();
  const [closeRange, setCloseRange] = useState(true);
  const closeRangeRef = useRef(true);

  useFrame(({ controls }) => {
    const fov = (camera as { fov?: number }).fov;
    if (typeof fov !== 'number') return;

    const distance = (controls as unknown as { distance?: number } | null)?.distance;
    const working = typeof distance === 'number' && Number.isFinite(distance)
      ? distance
      : camera.position.length();

    const spacing = sectionPixelSpacing(working, fov, size.height);
    const next = nextGridVisibility(spacing, closeRangeRef.current);
    if (next !== closeRangeRef.current) {
      closeRangeRef.current = next;
      setCloseRange(next);
    }
  });

  return closeRange;
}

/**
 * The inherited `city-grid`, drawn only while its lines can be told apart.
 *
 * Every prop the canonical scene passed to `Grid` is passed straight through, so at the
 * scales where it renders at all it is the grid CITY_NET has always had — the plan's
 * close-range calibration checks are unaffected.
 */
export function WorldGrid(props: Record<string, unknown>) {
  const closeRange = useCloseRangeView();
  if (!closeRange) return null;
  return <Grid {...props} />;
}

/**
 * Editor helpers that only make sense at working distances.
 *
 * Same rule as the grid, and deliberately the same signal: these are fixed-length guides
 * drawn through the world origin, so at a city-wide view they neither span what is being
 * looked at nor line up with anything on it — they are just dark streaks across the
 * drawing somebody is trying to read.
 */
export function CloseRangeOnly({ children }: { children: ReactNode }) {
  const closeRange = useCloseRangeView();
  if (!closeRange) return null;
  return <>{children}</>;
}
