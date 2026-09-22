import { useEffect } from 'react';
import type * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import type { ReferenceLayer } from './types';
import { topDownFraming } from './calibration';
import { clippingPlanesForDistance } from '../../components/Camera';

/**
 * Put the camera straight above a reference layer, on request.
 *
 * The inherited world camera is free, and at a shallow angle a correctly calibrated
 * 12000-unit raster is a bright line near the horizon — persisted perfectly and impossible
 * to measure anything against. So calibration needs one deterministic way back to a
 * top-down view, and this is it.
 *
 * Deliberately not `CameraController`, the inherited zoom-to-POI mover. That one locks the
 * approach to an isometric direction and frames a single scalar radius over a two-second
 * arcing swoop — it is a flourish for visiting a building, and it can never look straight
 * down, which is the one thing needed here. What is reused is the layer below it: the
 * scene's `CameraControls`, already `makeDefault`, reached through `useThree().controls`
 * exactly as `CameraController` reaches it.
 *
 * `setLookAt` sets position and target absolutely, so where the camera was pointing before
 * does not matter, and it leaves the controls enabled — orbit, pan and dolly all work the
 * moment the move finishes.
 */

export interface ReferenceFrameRequest {
  layer: ReferenceLayer;
  /** Distinguishes one press from the next, so asking twice moves twice. */
  nonce: number;
}

export function ReferenceLayerFraming({
  request,
  onFramed,
}: {
  request: ReferenceFrameRequest | null;
  onFramed?: () => void;
}) {
  const { camera, controls, size } = useThree();

  useEffect(() => {
    if (!request) return;

    const fov = (camera as { fov?: number }).fov;
    const setLookAt = (controls as { setLookAt?: (...args: unknown[]) => unknown } | null)?.setLookAt;
    // An orthographic camera or a scene whose controls have not mounted yet: nothing to
    // do, and nothing worth throwing over. The button simply does not move the camera.
    if (typeof fov !== 'number' || typeof setLookAt !== 'function') return;

    const aspect = size.height > 0 ? size.width / size.height : 1;
    const { position, target } = topDownFraming(request.layer, fov, aspect);

    // Widen the depth range for where the camera is going before sending it there.
    // `AdaptiveClipping` maintains this every frame, but it runs after this effect, so
    // without it the first frame at the new distance would be drawn with the old planes —
    // and for a city-scale layer the old planes clip the entire world away.
    const perspective = camera as THREE.PerspectiveCamera;
    const distance = Math.abs(position[1] - target[1]);
    const { near, far } = clippingPlanesForDistance(distance);
    if (perspective.near !== near || perspective.far !== far) {
      perspective.near = near;
      perspective.far = far;
      perspective.updateProjectionMatrix?.();
    }

    // `true` animates, which keeps the move readable as a move rather than a teleport —
    // and, unlike a manual camera assignment, leaves the controls' own state consistent.
    setLookAt.call(controls, position[0], position[1], position[2], target[0], target[1], target[2], true);
    onFramed?.();
    // Keyed on the nonce so pressing the button again re-frames, while an unrelated
    // re-render does not yank the camera away from someone who has since moved it.
  }, [request?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}
