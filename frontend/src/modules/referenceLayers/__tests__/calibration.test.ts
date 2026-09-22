/**
 * The mapping from a source pixel to a world coordinate.
 *
 * This is the one piece of the feature that cannot be checked by looking at it. A layer
 * rotated the wrong way, or mirrored, still renders as a plausible city map — it is only
 * wrong once somebody measures against it, by which time the calibration has been
 * "corrected" to compensate and the error is baked into the persisted numbers.
 *
 * So the convention is pinned here: +X is image-right, +Z is image-down at zero rotation,
 * matching the top-down orientation the inherited exporter already uses. The Three.js Y
 * angle is checked against a real Object3D rather than re-derived on paper, because the
 * sign of a rotation about Y is exactly the kind of thing that reads correctly and is not.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  sourceToWorld,
  worldToSource,
  planeDimensions,
  worldBounds,
  threeRotationY,
  referencePlaneProps,
  topDownFraming,
  framingDistance,
  FRAME_MARGIN,
  REFERENCE_LAYER_Y,
  REFERENCE_LAYER_Y_STEP,
  type Calibration,
} from '../calibration';
import type { ReferenceLayer } from '../types';

const calibration = (over: Partial<Calibration> = {}): Calibration => ({
  source_width_px: 100,
  source_height_px: 50,
  world_center_x: 0,
  world_center_z: 0,
  world_units_per_pixel: 1,
  rotation_rad: 0,
  ...over,
});

const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 9);

describe('sourceToWorld at zero rotation', () => {
  it('puts the image centre on the persisted world centre', () => {
    const c = calibration({ world_center_x: -30, world_center_z: 12 });
    const p = sourceToWorld(c, { u: 50, v: 25 });
    near(p.x, -30);
    near(p.z, 12);
  });

  it('maps image-right to +X and image-down to +Z', () => {
    const c = calibration();
    const right = sourceToWorld(c, { u: 60, v: 25 });
    const down = sourceToWorld(c, { u: 50, v: 35 });
    expect(right.x).toBeGreaterThan(0);
    near(right.z, 0);
    expect(down.z).toBeGreaterThan(0);
    near(down.x, 0);
  });

  it('places the four corners at the expected bounds', () => {
    const c = calibration({ world_center_x: 200, world_center_z: -100, world_units_per_pixel: 2 });

    near(sourceToWorld(c, { u: 0, v: 0 }).x, 200 - 100);
    near(sourceToWorld(c, { u: 0, v: 0 }).z, -100 - 50);
    near(sourceToWorld(c, { u: 100, v: 50 }).x, 200 + 100);
    near(sourceToWorld(c, { u: 100, v: 50 }).z, -100 + 50);

    expect(worldBounds(c)).toEqual({ minX: 100, maxX: 300, minZ: -150, maxZ: -50 });
  });

  it('scales distance by world units per pixel without moving the centre', () => {
    const c = calibration({ world_units_per_pixel: 0.25 });
    near(sourceToWorld(c, { u: 90, v: 25 }).x, 10);
    near(sourceToWorld(c, { u: 50, v: 25 }).x, 0);
  });
});

describe('sourceToWorld under rotation', () => {
  // Clockwise seen from above, where +Z points down the image: image-right swings to +Z.
  it('turns image-right onto +Z at a quarter turn', () => {
    const c = calibration({ rotation_rad: Math.PI / 2 });
    const right = sourceToWorld(c, { u: 100, v: 25 });
    near(right.x, 0);
    near(right.z, 50);
  });

  it('turns image-down onto -X at a quarter turn', () => {
    const c = calibration({ rotation_rad: Math.PI / 2 });
    const down = sourceToWorld(c, { u: 50, v: 50 });
    near(down.x, -25);
    near(down.z, 0);
  });

  it('inverts both axes at a half turn', () => {
    const c = calibration({ rotation_rad: Math.PI });
    const corner = sourceToWorld(c, { u: 100, v: 50 });
    near(corner.x, -50);
    near(corner.z, -25);
  });

  it('rotates about the persisted centre, not the origin', () => {
    const c = calibration({ world_center_x: 500, world_center_z: 500, rotation_rad: Math.PI / 2 });
    const centre = sourceToWorld(c, { u: 50, v: 25 });
    near(centre.x, 500);
    near(centre.z, 500);
  });

  it('preserves distance from the centre whatever the angle', () => {
    const base = calibration({ world_units_per_pixel: 1.5 });
    const point = { u: 90, v: 10 };
    const at = (rotation_rad: number) => {
      const c = calibration({ world_units_per_pixel: 1.5, rotation_rad });
      const p = sourceToWorld(c, point);
      return Math.hypot(p.x - c.world_center_x, p.z - c.world_center_z);
    };
    const expected = at(0);
    expect(expected).toBeGreaterThan(0);
    for (const angle of [0.3, 1, Math.PI / 2, 2.5, -1.2]) near(at(angle), expected);
    // The forward transform at zero rotation still agrees with plain arithmetic.
    near(expected, Math.hypot(40 * 1.5, 15 * 1.5));
    expect(base.rotation_rad).toBe(0);
  });
});

describe('worldToSource', () => {
  it('round-trips every corner and the centre, off-origin and rotated', () => {
    const c = calibration({
      source_width_px: 6032,
      source_height_px: 4584,
      world_center_x: -412.75,
      world_center_z: 963.5,
      world_units_per_pixel: 0.37,
      rotation_rad: 0.91,
    });

    for (const point of [
      { u: 0, v: 0 },
      { u: 6032, v: 0 },
      { u: 6032, v: 4584 },
      { u: 0, v: 4584 },
      { u: 3016, v: 2292 },
      { u: 1234.5, v: 777.25 },
    ]) {
      const back = worldToSource(c, sourceToWorld(c, point));
      expect(back.u).toBeCloseTo(point.u, 6);
      expect(back.v).toBeCloseTo(point.v, 6);
    }
  });

  it('round-trips in the other direction too', () => {
    const c = calibration({ world_center_x: 20, world_center_z: -5, world_units_per_pixel: 3, rotation_rad: -0.4 });
    for (const point of [{ x: 0, z: 0 }, { x: 140, z: -90 }, { x: -12.5, z: 33.25 }]) {
      const back = sourceToWorld(c, worldToSource(c, point));
      expect(back.x).toBeCloseTo(point.x, 6);
      expect(back.z).toBeCloseTo(point.z, 6);
    }
  });
});

describe('planeDimensions', () => {
  it('derives world size from the source pixels and the scale', () => {
    expect(planeDimensions(calibration({ source_width_px: 6032, source_height_px: 4584, world_units_per_pixel: 0.5 })))
      .toEqual({ width: 3016, height: 2292 });
  });

  it('preserves the source aspect ratio at any scale', () => {
    const c = calibration({ source_width_px: 6032, source_height_px: 4584 });
    for (const world_units_per_pixel of [0.01, 1, 7.5]) {
      const { width, height } = planeDimensions({ ...c, world_units_per_pixel });
      expect(width / height).toBeCloseTo(6032 / 4584, 12);
    }
  });
});

describe('threeRotationY', () => {
  // Re-derived from Three.js itself: a persisted clockwise angle must move a point the
  // same way the calibration says it does, once the scene has applied the Y rotation.
  it('turns a world-space point the way the calibration does', () => {
    for (const rotation_rad of [0, 0.3, Math.PI / 2, -1.1, 2.4]) {
      const c = calibration({ rotation_rad });
      const source = { u: 90, v: 40 };

      const object = new THREE.Object3D();
      object.rotation.set(0, threeRotationY(rotation_rad), 0);
      object.updateMatrixWorld(true);

      // Where the plane puts the pixel before any world rotation: image-right along +X,
      // image-down along +Z, offset from the image centre.
      const unrotated = new THREE.Vector3(
        (source.u - c.source_width_px / 2) * c.world_units_per_pixel,
        0,
        (source.v - c.source_height_px / 2) * c.world_units_per_pixel,
      );
      const rotated = unrotated.clone().applyMatrix4(object.matrixWorld);
      const expected = sourceToWorld(c, source);

      expect(rotated.x).toBeCloseTo(expected.x, 9);
      expect(rotated.z).toBeCloseTo(expected.z, 9);
    }
  });

  it('is the negation of the persisted angle', () => {
    expect(threeRotationY(Math.PI / 2)).toBeCloseTo(-Math.PI / 2, 12);
    expect(threeRotationY(0)).toBe(-0);
  });
});

describe('referencePlaneProps', () => {
  const layer = (over: Partial<ReferenceLayer> = {}): ReferenceLayer => ({
    id: 1,
    name: 'Imperial City',
    asset_id: 1,
    asset_url: '/uploads/reference_layers/abc.png',
    original_name: 'city.png',
    format: 'png',
    source_width_px: 6032,
    source_height_px: 4584,
    world_center_x: 0,
    world_center_z: 0,
    world_units_per_pixel: 1,
    rotation_rad: 0,
    opacity: 1,
    is_visible: true,
    is_locked: false,
    provenance: 'imported',
    replacement_state: 'non_replaceable',
    ...over,
  });

  it('derives position and rotation from persisted fields alone', () => {
    const props = referencePlaneProps(layer({ world_center_x: 12, world_center_z: -34, rotation_rad: 1 }));
    expect(props.position[0]).toBe(12);
    expect(props.position[2]).toBe(-34);
    expect(props.position[1]).toBe(REFERENCE_LAYER_Y);
    expect(props.rotation).toEqual([0, threeRotationY(1), 0]);
  });

  it('separates stacked layers by a deterministic step, without persisting a height', () => {
    expect(referencePlaneProps(layer(), 0).position[1]).toBe(REFERENCE_LAYER_Y);
    expect(referencePlaneProps(layer(), 1).position[1]).toBe(REFERENCE_LAYER_Y + REFERENCE_LAYER_Y_STEP);
    expect(referencePlaneProps(layer(), 2).position[1]).toBe(REFERENCE_LAYER_Y + 2 * REFERENCE_LAYER_Y_STEP);
  });

  // Under the grid lines (0.01), water (0.035) and roads (0.05): a reference layer is
  // what the city gets drawn over, not something drawn on top of it.
  it('sits below every inherited world overlay', () => {
    expect(referencePlaneProps(layer(), 5).position[1]).toBeLessThan(0.01);
    expect(REFERENCE_LAYER_Y).toBeGreaterThan(0);
  });

  it('hits nothing when raycast', () => {
    expect(referencePlaneProps(layer()).raycast()).toBeNull();
  });
});

describe('topDownFraming', () => {
  // The artwork this feature exists for, at the scale human verification was using:
  // 6032 x 4584 source at 2 world units per pixel is a 12064 x 9168 plane.
  const imperial = (over: Partial<ReferenceLayer> = {}): ReferenceLayer => ({
    id: 1,
    name: 'Imperial City',
    asset_id: 1,
    asset_url: '/uploads/reference_layers/abc.png',
    original_name: 'city.png',
    format: 'png',
    source_width_px: 6032,
    source_height_px: 4584,
    world_center_x: 0,
    world_center_z: 0,
    world_units_per_pixel: 2,
    rotation_rad: 0,
    opacity: 1,
    is_visible: true,
    is_locked: false,
    provenance: 'imported',
    replacement_state: 'non_replaceable',
    ...over,
  });

  const FOV = 50;
  const WIDE = 16 / 9;

  /** Half-extents of what a perspective camera sees at a given distance. */
  const visibleHalfExtents = (distance: number, fov: number, aspect: number) => {
    const halfHeight = distance * Math.tan((fov * Math.PI) / 180 / 2);
    return { halfHeight, halfWidth: halfHeight * aspect };
  };

  /** The four corners of the plane in world X/Z, through the persisted calibration. */
  const corners = (layer: ReferenceLayer) => [
    { u: 0, v: 0 },
    { u: layer.source_width_px, v: 0 },
    { u: layer.source_width_px, v: layer.source_height_px },
    { u: 0, v: layer.source_height_px },
  ].map(p => sourceToWorld(layer, p));

  it('sits directly above the persisted centre', () => {
    const layer = imperial({ world_center_x: -412.5, world_center_z: 963 });
    const { position, target } = topDownFraming(layer, FOV, WIDE);

    expect(position[0]).toBe(-412.5);
    expect(position[2]).toBe(963);
    expect(target[0]).toBe(-412.5);
    expect(target[2]).toBe(963);
  });

  it('looks straight down: only the height differs between eye and target', () => {
    const { position, target } = topDownFraming(imperial(), FOV, WIDE);
    expect(position[0]).toBe(target[0]);
    expect(position[2]).toBe(target[2]);
    expect(position[1]).toBeGreaterThan(target[1]);
  });

  it('targets the plane itself rather than the ground grid', () => {
    expect(topDownFraming(imperial(), FOV, WIDE).target[1]).toBe(REFERENCE_LAYER_Y);
  });

  it('gets far enough above the 12064 x 9168 target to contain every corner', () => {
    const layer = imperial();
    const { position } = topDownFraming(layer, FOV, WIDE);
    const { halfWidth, halfHeight } = visibleHalfExtents(position[1] - REFERENCE_LAYER_Y, FOV, WIDE);
    const shortest = Math.min(halfWidth, halfHeight);

    for (const corner of corners(layer)) {
      const distance = Math.hypot(corner.x - layer.world_center_x, corner.z - layer.world_center_z);
      expect(distance).toBeLessThan(shortest);
    }
  });

  it('contains every corner on a tall viewport too, where the width is the binding axis', () => {
    const layer = imperial();
    const tall = 9 / 16;
    const { position } = topDownFraming(layer, FOV, tall);
    const { halfWidth, halfHeight } = visibleHalfExtents(position[1] - REFERENCE_LAYER_Y, FOV, tall);
    const shortest = Math.min(halfWidth, halfHeight);

    for (const corner of corners(layer)) {
      expect(Math.hypot(corner.x, corner.z)).toBeLessThan(shortest);
    }
  });

  // A rectangle turned 37 degrees is inscribed in the same circle as one turned none, so
  // the framing must not care — and must not depend on how the camera's up vector happens
  // to resolve when it is pointed straight down a parallel axis.
  it('frames a rotated layer identically to an unrotated one', () => {
    const flat = topDownFraming(imperial({ rotation_rad: 0 }), FOV, WIDE);
    for (const rotation_rad of [0.3, Math.PI / 4, Math.PI / 2, 2.4, -1.1]) {
      expect(topDownFraming(imperial({ rotation_rad }), FOV, WIDE)).toEqual(flat);
    }
  });

  it('still contains every corner of a rotated layer', () => {
    const layer = imperial({ rotation_rad: Math.PI / 4, world_center_x: 200, world_center_z: -50 });
    const { position } = topDownFraming(layer, FOV, WIDE);
    const { halfWidth, halfHeight } = visibleHalfExtents(position[1] - REFERENCE_LAYER_Y, FOV, WIDE);
    const shortest = Math.min(halfWidth, halfHeight);

    for (const corner of corners(layer)) {
      const distance = Math.hypot(corner.x - layer.world_center_x, corner.z - layer.world_center_z);
      expect(distance).toBeLessThan(shortest);
    }
  });

  it('pulls back further for a larger scale, in proportion', () => {
    const near = topDownFraming(imperial({ world_units_per_pixel: 1 }), FOV, WIDE);
    const far = topDownFraming(imperial({ world_units_per_pixel: 2 }), FOV, WIDE);
    expect(far.position[1] - REFERENCE_LAYER_Y).toBeCloseTo((near.position[1] - REFERENCE_LAYER_Y) * 2, 6);
  });

  it('leaves a margin rather than fitting the layer flush to the edge', () => {
    const layer = imperial();
    const radius = Math.hypot(12064, 9168) / 2;
    const flush = framingDistance(radius, FOV, WIDE) / FRAME_MARGIN;
    expect(FRAME_MARGIN).toBeGreaterThan(1);
    expect(topDownFraming(layer, FOV, WIDE).position[1] - REFERENCE_LAYER_Y).toBeGreaterThan(flush);
  });

  // Framing is a camera action. A person who frames a locked layer to check it must get
  // back exactly the numbers they had.
  it('reads the layer without altering it', () => {
    const layer = imperial({ world_center_x: -412.5, world_center_z: 963, rotation_rad: 0.91 });
    const before = JSON.stringify(layer);
    topDownFraming(layer, FOV, WIDE);
    expect(JSON.stringify(layer)).toBe(before);
  });
});

describe('framingDistance', () => {
  it('needs more distance for a bigger radius', () => {
    expect(framingDistance(200, 50, 1.6)).toBeGreaterThan(framingDistance(100, 50, 1.6));
  });

  it('needs more distance for a narrower field of view', () => {
    expect(framingDistance(100, 30, 1.6)).toBeGreaterThan(framingDistance(100, 60, 1.6));
  });

  it('backs off further as the viewport narrows, and not as it widens past square', () => {
    const square = framingDistance(100, 50, 1);
    expect(framingDistance(100, 50, 0.5)).toBeGreaterThan(square);
    expect(framingDistance(100, 50, 2)).toBe(square);
  });

  it('returns zero rather than infinity for a degenerate camera or empty layer', () => {
    expect(framingDistance(0, 50, 1.6)).toBe(0);
    expect(framingDistance(100, 0, 1.6)).toBe(0);
  });

  it('treats a missing aspect as square instead of producing NaN', () => {
    expect(framingDistance(100, 50, Number.NaN)).toBe(framingDistance(100, 50, 1));
    expect(framingDistance(100, 50, 0)).toBe(framingDistance(100, 50, 1));
  });
});
