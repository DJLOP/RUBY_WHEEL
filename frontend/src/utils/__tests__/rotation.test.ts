import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { storedRotationOf, eulerFromStored, STORED_EULER_ORDER } from '../rotation';

/**
 * Rotation survives a save.
 *
 * The bug this pins: the editor rotates a THREE group, whose `.rotation` is an Euler in
 * the group's own order - 'XYZ', the default, which nothing had changed. Saving read those
 * three numbers straight out and stored them, and every read path reconstructs a structure
 * with 'YXZ'. The same figures in a different order are a different orientation, so a
 * structure came back at an angle nobody had chosen.
 *
 * It hid because the common case cannot show it. Spinning a building on Y alone round-trips
 * exactly; it takes a second axis before the two orders part company.
 */

/**
 * How far apart two orientations actually are, in degrees.
 *
 * Compared as orientations rather than as three numbers, because that is the thing that
 * has to survive - two different Euler triples can describe the same facing, and only the
 * quaternion says whether a structure ended up pointing where it was put.
 */
const apartInDegrees = (a: THREE.Quaternion, b: THREE.Quaternion): number =>
  (2 * Math.acos(Math.min(1, Math.abs(a.dot(b))))) * 180 / Math.PI;

/** What the editor hands to the save: a group the gizmo has turned. */
const turned = (x: number, y: number, z: number) => {
  const group = new THREE.Group();
  group.rotation.set(x, y, z);
  return group;
};

/** Save it, then draw it the way every read path does. */
const roundTrip = (group: THREE.Group) =>
  new THREE.Quaternion().setFromEuler(eulerFromStored(storedRotationOf(group)));

/**
 * Close enough that no one could see it.
 *
 * The trip runs orientation -> quaternion -> Euler -> quaternion, so a few millionths of a
 * degree of floating-point noise comes back at extreme angles. A ten-thousandth of a
 * degree is still far below anything a screen or a person can resolve, and it is four
 * orders of magnitude tighter than the 22 degrees this is here to catch.
 */
const INVISIBLE_DEGREES = 1e-4;

/**
 * What the save actually sends.
 *
 * Through JSON, because that is the trip the numbers really take and because a
 * decomposition can hand back negative zero - a real distinction in JavaScript and no
 * distinction at all by the time it reaches SQLite.
 */
const asSent = (object: Parameters<typeof storedRotationOf>[0]) =>
  JSON.parse(JSON.stringify(storedRotationOf(object)));

describe('a rotation survives being saved', () => {
  it('comes back exactly, on two axes', () => {
    // The case that was 22 degrees wrong: a tilt and a spin together.
    const group = turned(0.5, 0.8, 0.3);
    expect(apartInDegrees(group.quaternion, roundTrip(group))).toBeLessThan(INVISIBLE_DEGREES);
  });

  it('comes back exactly, on all three', () => {
    const group = turned(-1.1, 2.4, 0.7);
    expect(apartInDegrees(group.quaternion, roundTrip(group))).toBeLessThan(INVISIBLE_DEGREES);
  });

  it('comes back exactly however it was turned', () => {
    // Swept rather than sampled: an order mismatch is wrong almost everywhere, but a
    // handful of chosen angles can miss it, and gimbal-lock cases deserve a look too.
    for (let x = -Math.PI; x <= Math.PI; x += 0.7) {
      for (let y = -Math.PI; y <= Math.PI; y += 0.7) {
        for (let z = -Math.PI; z <= Math.PI; z += 0.7) {
          const group = turned(x, y, z);
          const off = apartInDegrees(group.quaternion, roundTrip(group));
          expect(off, `x=${x} y=${y} z=${z}`).toBeLessThan(INVISIBLE_DEGREES);
        }
      }
    }
  });

  it('still round-trips a plain spin, which always worked', () => {
    // The case that hid the bug. It has to keep working, and the stored Y has to stay the
    // angle a person set, or every existing structure would shift.
    const group = turned(0, 0.8, 0);
    const stored = storedRotationOf(group);
    expect(stored.rotation).toBeCloseTo(0.8, 10);
    expect(stored.rotation_x).toBeCloseTo(0, 10);
    expect(stored.rotation_z).toBeCloseTo(0, 10);
  });

  it('leaves an unrotated structure at zero', () => {
    expect(asSent(turned(0, 0, 0))).toEqual({ rotation: 0, rotation_x: 0, rotation_z: 0 });
  });
});

describe('the old way, kept here so the bug stays legible', () => {
  it('was wrong by more than twenty degrees on a two-axis turn', () => {
    const group = turned(0.5, 0.8, 0.3);
    // Reading .x/.y/.z off an XYZ Euler and storing them as YXZ - what the save used to do.
    const asItWas = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      group.rotation.x, group.rotation.y, group.rotation.z, STORED_EULER_ORDER,
    ));
    expect(apartInDegrees(group.quaternion, asItWas)).toBeGreaterThan(20);
  });

  it('was right on a plain spin, which is why nobody caught it', () => {
    const group = turned(0, 0.8, 0);
    const asItWas = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      group.rotation.x, group.rotation.y, group.rotation.z, STORED_EULER_ORDER,
    ));
    expect(apartInDegrees(group.quaternion, asItWas)).toBeLessThan(INVISIBLE_DEGREES);
  });
});

describe('the storage order is one decision, in one place', () => {
  it('is what the readers use', () => {
    // Buildings.tsx, App.tsx and the editor all construct 'YXZ'. If that ever changes,
    // this is the constant that has to change with it.
    expect(STORED_EULER_ORDER).toBe('YXZ');
    expect(eulerFromStored({ rotation: 1 }).order).toBe('YXZ');
  });

  it('reads a missing axis as no rotation rather than as nothing', () => {
    const euler = eulerFromStored({ rotation: 0.4 });
    expect([euler.x, euler.y, euler.z]).toEqual([0, 0.4, 0]);
    expect(eulerFromStored({}).y).toBe(0);
  });
});

describe('however the caller is holding the rotation', () => {
  /**
   * The editor hands over a real THREE.Group; the placement flow hands over a plain
   * { position, rotation, scale } stand-in with no quaternion at all. Three call sites
   * build the latter, and the first version of this fix crashed on all of them - caught by
   * the token-control tests rather than by this file, which is why the case is pinned here
   * now.
   */
  it('reads a real Object3D through its quaternion', () => {
    const group = turned(0.5, 0.8, 0.3);
    expect(apartInDegrees(group.quaternion, roundTrip(group))).toBeLessThan(INVISIBLE_DEGREES);
  });

  it('reads the plain stand-in the placement flow builds', () => {
    const standIn = { position: new THREE.Vector3(), rotation: new THREE.Euler(), scale: new THREE.Vector3(1, 1, 1) };
    expect(asSent(standIn)).toEqual({ rotation: 0, rotation_x: 0, rotation_z: 0 });
  });

  it('respects a stand-in Euler that is not in the default order', () => {
    // The principle the whole bug came down to: never assume an order, read the one the
    // source is using.
    const asYxz = new THREE.Euler(0.5, 0.8, 0.3, 'YXZ');
    const stored = storedRotationOf({ rotation: asYxz });
    const back = new THREE.Quaternion().setFromEuler(eulerFromStored(stored));
    const wanted = new THREE.Quaternion().setFromEuler(asYxz);
    expect(apartInDegrees(wanted, back)).toBeLessThan(INVISIBLE_DEGREES);
  });

  it('survives an object holding no rotation at all', () => {
    expect(asSent({})).toEqual({ rotation: 0, rotation_x: 0, rotation_z: 0 });
  });

  it('survives the bare shape the tests mock, with plain numbers', () => {
    expect(asSent({ rotation: { x: 0, y: 0, z: 0 } }))
      .toEqual({ rotation: 0, rotation_x: 0, rotation_z: 0 });
  });
});
