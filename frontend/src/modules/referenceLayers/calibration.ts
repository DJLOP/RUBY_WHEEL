import type { ReferenceLayer } from './types';

/**
 * Source pixels to world coordinates, and back.
 *
 * The whole value of a reference layer is that a pixel of the drawing lands at a known
 * world coordinate and stays there. So the mapping is defined here, as arithmetic over the
 * persisted fields, and nowhere else — not in a plane's dimensions, not in a transform
 * gizmo's pivot, not in component state. Anything derived from mutable renderer state
 * would map the same pixel to different places in two sessions, which is the one failure
 * this feature cannot have.
 *
 * Source coordinates are pixels with the origin at the image's top-left: `u` increases
 * right, `v` increases down. World coordinates are the inherited horizontal X/Z pair, and
 * the orientation is the one `useMapExport` already established for the top-down view —
 * +X is image-right, +Z is image-down. At zero rotation the two agree exactly.
 *
 * For image dimensions W,H, centre Cx,Cz, scale s and clockwise rotation t:
 *
 *   du = u - W/2
 *   dv = v - H/2
 *   X  = Cx + s * (du*cos(t) - dv*sin(t))
 *   Z  = Cz + s * (du*sin(t) + dv*cos(t))
 */

export interface Calibration {
  source_width_px: number;
  source_height_px: number;
  world_center_x: number;
  world_center_z: number;
  world_units_per_pixel: number;
  rotation_rad: number;
}

export interface SourcePoint { u: number; v: number; }
export interface WorldPoint { x: number; z: number; }

/** Where a source pixel lands in the world. */
export function sourceToWorld(c: Calibration, point: SourcePoint): WorldPoint {
  const du = point.u - c.source_width_px / 2;
  const dv = point.v - c.source_height_px / 2;
  const cos = Math.cos(c.rotation_rad);
  const sin = Math.sin(c.rotation_rad);
  return {
    x: c.world_center_x + c.world_units_per_pixel * (du * cos - dv * sin),
    z: c.world_center_z + c.world_units_per_pixel * (du * sin + dv * cos),
  };
}

/**
 * Which source pixel a world position falls on.
 *
 * Nothing in this slice's UI needs it — the first renderer only goes forwards. It lives
 * beside the forward transform anyway, because tracing and picking will need it and
 * because a round trip through both is the cheapest proof that the forward one is right.
 */
export function worldToSource(c: Calibration, point: WorldPoint): SourcePoint {
  const dx = (point.x - c.world_center_x) / c.world_units_per_pixel;
  const dz = (point.z - c.world_center_z) / c.world_units_per_pixel;
  const cos = Math.cos(c.rotation_rad);
  const sin = Math.sin(c.rotation_rad);
  return {
    u: dx * cos + dz * sin + c.source_width_px / 2,
    v: -dx * sin + dz * cos + c.source_height_px / 2,
  };
}

/** The world-space size of the plane that carries the raster. Aspect is preserved. */
export function planeDimensions(c: Calibration): { width: number; height: number } {
  return {
    width: c.source_width_px * c.world_units_per_pixel,
    height: c.source_height_px * c.world_units_per_pixel,
  };
}

/** The world X/Z bounds of the layer at zero rotation, for feedback and for tests. */
export function worldBounds(c: Calibration) {
  const corners = [
    sourceToWorld(c, { u: 0, v: 0 }),
    sourceToWorld(c, { u: c.source_width_px, v: 0 }),
    sourceToWorld(c, { u: c.source_width_px, v: c.source_height_px }),
    sourceToWorld(c, { u: 0, v: c.source_height_px }),
  ];
  return {
    minX: Math.min(...corners.map(p => p.x)),
    maxX: Math.max(...corners.map(p => p.x)),
    minZ: Math.min(...corners.map(p => p.z)),
    maxZ: Math.max(...corners.map(p => p.z)),
  };
}

/**
 * The persisted clockwise rotation, as the Y Euler angle the scene needs.
 *
 * It is the negation, and the sign is the easiest thing in this feature to get backwards.
 * Three.js is right-handed with Y up, so a positive rotation about Y turns +X towards -Z —
 * the opposite of the top-down clockwise convention the calibration is written in, where
 * +Z is image-down. A 90-degree turn in the wrong direction still looks like a plausible
 * map, which is why this is one named function pinned by a test against a real Object3D
 * rather than a minus sign inlined in JSX.
 */
export function threeRotationY(rotationRad: number): number {
  return -rotationRad;
}

// ─── rendering ───────────────────────────────────────────────────────────────

/**
 * How high above the ground the rasters sit.
 *
 * Under everything: the grid is at Y=0, the editor reference lines at 0.01, water at
 * 0.035 and roads at 0.05. A reference layer is something to draw the city *over*, so it
 * goes below all of them and stays well clear of the lowest.
 */
export const REFERENCE_LAYER_Y = 0.002;

/** Enough separation to stop two stacked rasters from flickering against each other. */
export const REFERENCE_LAYER_Y_STEP = 0.0005;

/** A raycast that hits nothing, so drawing tools reach the world through the imagery. */
export const NO_RAYCAST = () => null;

/** How a reference raster is shaded. Returned as an object so it can be asserted. */
export function referenceMaterialProps(layer: ReferenceLayer) {
  return {
    /** Unlit, so a drawing looks the same whatever the scene lighting is doing. */
    toneMapped: false,
    transparent: true,
    opacity: layer.opacity,
    /**
     * Out of the depth buffer. Several rasters a fraction of a unit apart, all of them
     * transparent, otherwise composite in whatever order the renderer happens to sort
     * them — and the overlays above would be occluded by an image that is meant to sit
     * under everything.
     */
    depthWrite: false,
  };
}

/**
 * Everything the scene needs to place one layer, derived from persisted fields only.
 *
 * Returned as an object rather than written inline so the transform can be asserted
 * directly. `raycast` is the reason a person can still trace roads over a reference image:
 * without it the plane is a 6032-pixel-wide click target covering the whole city.
 */
export function referencePlaneProps(layer: ReferenceLayer, index = 0) {
  return {
    position: [
      layer.world_center_x,
      REFERENCE_LAYER_Y + index * REFERENCE_LAYER_Y_STEP,
      layer.world_center_z,
    ] as [number, number, number],
    rotation: [0, threeRotationY(layer.rotation_rad), 0] as [number, number, number],
    renderOrder: -1000 + index,
    raycast: NO_RAYCAST,
  };
}

// ─── top-down framing ────────────────────────────────────────────────────────

/**
 * How much room to leave around a framed layer. Enough to see its edges against the
 * world grid, which is the whole reason for looking at it from above.
 */
export const FRAME_MARGIN = 1.08;

/**
 * The distance a perspective camera needs to fit a circle of `radius` on screen.
 *
 * Both axes are checked and the larger wins. Fitting the vertical extent alone crops the
 * sides of a wide viewport, and fitting the horizontal alone crops the top and bottom of a
 * tall one — either way the person is calibrating against an edge they cannot see.
 */
export function framingDistance(radius: number, fovDegrees: number, aspect: number): number {
  const halfFov = (fovDegrees * Math.PI) / 180 / 2;
  const tan = Math.tan(halfFov);
  if (!(tan > 0) || !(radius > 0)) return 0;

  const safeAspect = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  const forHeight = radius / tan;
  const forWidth = radius / (tan * safeAspect);
  return Math.max(forHeight, forWidth) * FRAME_MARGIN;
}

/**
 * Where to put the camera to look straight down at one layer, and what to look at.
 *
 * The inherited free camera can sit at any angle, and at a shallow one a correctly placed
 * 12000-unit raster is a bright line across the horizon — persisted perfectly and
 * impossible to calibrate against. This is the deterministic way back: directly above the
 * centre, looking down, whatever the camera was doing before.
 *
 * The framed radius is half the diagonal of the plane rather than half its width or
 * height, which makes it the circle the rectangle is inscribed in. That is rotation
 * invariant — a layer turned 37 degrees is framed exactly like one turned none — so this
 * cannot depend on which way the camera's up vector happens to resolve when it is pointed
 * straight down a parallel axis.
 *
 * Read-only. It derives from `source_width_px`, `source_height_px`, the persisted centre
 * and the persisted scale, and writes nothing back: framing a layer must never be a way to
 * alter the calibration somebody is trying to check.
 */
export function topDownFraming(
  layer: ReferenceLayer,
  fovDegrees: number,
  aspect: number,
): { position: [number, number, number]; target: [number, number, number] } {
  const { width, height } = planeDimensions(layer);
  const radius = Math.hypot(width, height) / 2;
  const distance = framingDistance(radius, fovDegrees, aspect);

  return {
    position: [layer.world_center_x, REFERENCE_LAYER_Y + distance, layer.world_center_z],
    target: [layer.world_center_x, REFERENCE_LAYER_Y, layer.world_center_z],
  };
}
