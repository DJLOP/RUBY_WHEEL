import * as THREE from 'three';

/**
 * The Euler order every stored rotation is written and read in.
 *
 * Not a preference. Euler angles only mean something alongside the order they are applied
 * in, and the whole app reconstructs a saved structure with 'YXZ' - Buildings.tsx, the map
 * in App.tsx, and the editor's own read of a part. So that is the order the three numbers
 * in the database ARE, and anything writing them has to say so.
 */
export const STORED_EULER_ORDER = 'YXZ' as const;

/**
 * A rotated object's orientation, in the form the database keeps.
 *
 * **Why this exists rather than reading `object.rotation.x/.y/.z` directly.** A THREE
 * Object3D's `.rotation` is an Euler in the object's OWN order, which is 'XYZ' unless
 * somebody changed it, and the editor's group never did. Taking those three numbers and
 * storing them as 'YXZ' silently reinterprets them: the same figures describe a different
 * orientation, and a structure comes back at an angle nobody chose.
 *
 * It only agrees when at most one axis is turned. Spinning a building on Y - which is
 * nearly everything anyone does - round-trips perfectly, which is why this survived: the
 * common case is exactly the case where the bug cannot show.
 *
 * Going through the quaternion is what makes it right. The quaternion is the orientation
 * itself, with no order to disagree about, so decomposing it in the storage order yields
 * three numbers that mean what the reader will take them to mean.
 */
export interface Rotatable {
  /** Present on a real Object3D. Absent on the plain stand-in the placement flow uses. */
  quaternion?: THREE.Quaternion;
  rotation?: { x: number; y: number; z: number; order?: string };
}

/**
 * The orientation itself, however the caller happens to hold it.
 *
 * `targetObject` is a real THREE.Group while a structure is being edited, and a plain
 * `{ position, rotation, scale }` stand-in while one is being placed - three call sites
 * build the latter. So this reads a quaternion when there is one and otherwise builds it
 * from the Euler IN THAT EULER'S OWN ORDER, which is the same principle either way: never
 * assume an order, read the one the source is actually using.
 */
const orientationOf = (object: Rotatable): THREE.Quaternion => {
  if (object.quaternion instanceof THREE.Quaternion) return object.quaternion;
  const r = object.rotation;
  if (!r) return new THREE.Quaternion();
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(r.x || 0, r.y || 0, r.z || 0, (r.order as THREE.EulerOrder) || 'XYZ'),
  );
};

export const storedRotationOf = (
  object: Rotatable,
): { rotation: number; rotation_x: number; rotation_z: number } => {
  const euler = new THREE.Euler().setFromQuaternion(orientationOf(object), STORED_EULER_ORDER);
  return { rotation: euler.y, rotation_x: euler.x, rotation_z: euler.z };
};

/** A stored rotation as an Euler again, for drawing it. The other half of the contract. */
export const eulerFromStored = (stored: {
  rotation?: number | null; rotation_x?: number | null; rotation_z?: number | null;
}): THREE.Euler => new THREE.Euler(
  stored.rotation_x || 0, stored.rotation || 0, stored.rotation_z || 0, STORED_EULER_ORDER,
);
