/**
 * The camera's depth range, and the black screen it used to cause.
 *
 * The canonical-world camera is declared as `<PerspectiveCamera makeDefault position={...} />`
 * with no `near` or `far`, so it takes Three's constructor defaults of 0.1 and 2000. That
 * is right for CITY_NET and wrong for a reference drawing of the Imperial City: at the
 * calibration being used for tracing the plane is 12064 x 9168 world units and has to be
 * viewed from about 17500 units up, which is nearly nine times past the far plane. Every
 * fragment is clipped and the canvas goes black — and because the controls have no
 * distance limit, an ordinary wheel notch could walk the camera across that boundary from
 * a view that still worked.
 *
 * These tests pin the contract that replaced it, including the two properties that make it
 * safe to apply to a project that spends most of its time at close range: the inherited
 * planes are unchanged in the inherited working range, and the far/near ratio never gets
 * worse than the one CITY_NET already shipped.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import * as THREE from 'three';
import CameraControls from 'camera-controls';

const frameCallbacks: ((state: any) => void)[] = [];
const threeState: any = {
  camera: null as any,
  controls: null as any,
  size: { width: 1600, height: 900 },
};

vi.mock('@react-three/fiber', () => ({
  useFrame: (fn: (state: any) => void) => { frameCallbacks.push(fn); },
  useThree: () => threeState,
}));

import {
  AdaptiveClipping,
  clippingPlanesForDistance,
  NEAR_MIN,
  FAR_MIN,
  FAR_DISTANCE_MULTIPLE,
  MAX_DEPTH_RATIO,
} from '../Camera';
import { topDownFraming } from '../../modules/referenceLayers/calibration';
import type { ReferenceLayer } from '../../modules/referenceLayers/types';

/** The real artwork at the calibration human verification was tracing with. */
const imperial = (world_units_per_pixel = 2): ReferenceLayer => ({
  id: 1, name: 'Imperial City', asset_id: 1,
  asset_url: '/uploads/reference_layers/abc.png', original_name: 'city.png', format: 'png',
  source_width_px: 6032, source_height_px: 4584,
  world_center_x: 0, world_center_z: 0,
  world_units_per_pixel, rotation_rad: 0,
  opacity: 1, is_visible: true, is_locked: false,
  provenance: 'imported', replacement_state: 'non_replaceable',
});

beforeEach(() => { frameCallbacks.length = 0; });

describe('the inherited working range is untouched', () => {
  // Three's PerspectiveCamera constructor defaults, which is what App.tsx gets today.
  it('matches the inherited planes exactly for a default Three camera', () => {
    const stock = new THREE.PerspectiveCamera();
    expect(stock.near).toBe(NEAR_MIN);
    expect(stock.far).toBe(FAR_MIN);
  });

  // The declared camera sits at [0, 200, 250], about 320 units from the origin it looks at.
  it('leaves the planes alone at the distance the app opens at', () => {
    expect(clippingPlanesForDistance(320)).toEqual({ near: 0.1, far: 2000 });
  });

  it('leaves them alone everywhere CITY_NET normally works', () => {
    for (const distance of [1, 25, 120, 320, 499.9, 500]) {
      expect(clippingPlanesForDistance(distance), String(distance)).toEqual({ near: 0.1, far: 2000 });
    }
  });

  it('is continuous where the floors give way, so dollying through it does not pop', () => {
    const below = clippingPlanesForDistance(499.999);
    const above = clippingPlanesForDistance(500.001);
    expect(above.far - below.far).toBeLessThan(0.05);
    expect(above.near - below.near).toBeLessThan(0.0001);
  });
});

describe('depth precision is never traded away', () => {
  it('holds the far/near ratio at or under the inherited one at every distance', () => {
    for (const distance of [0.5, 10, 320, 500, 2000, 17547, 100000, 1e6]) {
      const { near, far } = clippingPlanesForDistance(distance);
      expect(far / near, String(distance)).toBeLessThanOrEqual(MAX_DEPTH_RATIO + 1e-9);
    }
  });

  it('uses the inherited pair as the definition of that ratio', () => {
    expect(MAX_DEPTH_RATIO).toBe(FAR_MIN / NEAR_MIN);
    expect(MAX_DEPTH_RATIO).toBe(20000);
  });

  it('never pushes the near plane past anything a person could be looking at', () => {
    // At the widest city view the near plane is a few units — nothing is that close to a
    // camera 17km up, so pulling it forward costs nothing visible.
    expect(clippingPlanesForDistance(17547).near).toBeLessThan(5);
  });
});

describe('a city-scale view is inside the frustum', () => {
  // The regression itself. Against the inherited far of 2000 this fails by 8.8x.
  it('contains the framing distance for the 12064 x 9168 reference plane', () => {
    const { position, target } = topDownFraming(imperial(2), 50, 16 / 9);
    const distance = position[1] - target[1];

    expect(distance).toBeGreaterThan(FAR_MIN); // the view the old far could not hold
    expect(distance).toBeLessThan(clippingPlanesForDistance(distance).far);
  });

  it('contains it at every calibration a person might be working at', () => {
    for (const upp of [0.25, 0.5, 1, 2, 5]) {
      const { position, target } = topDownFraming(imperial(upp), 50, 16 / 9);
      const distance = position[1] - target[1];
      expect(distance, `upp ${upp}`).toBeLessThan(clippingPlanesForDistance(distance).far);
    }
  });

  it('keeps headroom past the target rather than ending exactly on it', () => {
    const { far } = clippingPlanesForDistance(17547);
    expect(far / 17547).toBe(FAR_DISTANCE_MULTIPLE);
  });
});

describe('dollying out cannot cross the far plane', () => {
  it('keeps far ahead of the distance however far out the wheel goes', () => {
    let distance = 320;
    for (let notch = 0; notch < 40; notch++) {
      distance *= 1.2;
      expect(distance, `notch ${notch}`).toBeLessThan(clippingPlanesForDistance(distance).far);
    }
    expect(distance).toBeGreaterThan(1e5);
  });

  /**
   * The same thing through the real control library rather than arithmetic, because the
   * failure was a property of how `CameraControls` dollies: `maxDistance` is unbounded, so
   * nothing stopped the camera walking past a fixed far plane.
   */
  it('survives repeated real dolly-out with the real controls', () => {
    CameraControls.install({ THREE });
    const camera = new THREE.PerspectiveCamera();
    camera.aspect = 16 / 9;
    camera.updateProjectionMatrix();
    const controls = new CameraControls(camera, document.createElement('div'));

    const { position, target } = topDownFraming(imperial(2), camera.fov, camera.aspect);
    controls.setLookAt(position[0], position[1], position[2], target[0], target[1], target[2], false);
    controls.update(0);

    const apply = () => {
      const { near, far } = clippingPlanesForDistance(controls.distance);
      camera.near = near;
      camera.far = far;
      camera.updateProjectionMatrix();
    };
    apply();
    expect(controls.distance).toBeLessThan(camera.far);

    for (let notch = 0; notch < 12; notch++) {
      controls.dolly(-controls.distance * 0.2, false);
      controls.update(0);
      apply();
      expect(controls.distance, `notch ${notch}`).toBeLessThan(camera.far);
      expect(camera.far / camera.near).toBeLessThanOrEqual(MAX_DEPTH_RATIO + 1e-6);
    }

    controls.dispose();
  });

  it('still contains the scene when dollying back in to close range', () => {
    let distance = 50000;
    for (let notch = 0; notch < 40; notch++) {
      distance /= 1.2;
      const { near, far } = clippingPlanesForDistance(distance);
      expect(distance, `notch ${notch}`).toBeLessThan(far);
      expect(near).toBeGreaterThanOrEqual(NEAR_MIN);
    }
    // And lands back on exactly the inherited planes.
    expect(clippingPlanesForDistance(distance)).toEqual({ near: 0.1, far: 2000 });
  });
});

describe('degenerate input', () => {
  it('falls back to the inherited planes rather than producing NaN', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(clippingPlanesForDistance(bad as number)).toEqual({ near: 0.1, far: 2000 });
    }
  });
});

describe('AdaptiveClipping', () => {
  const mountWith = (distance: number | null) => {
    const camera = new THREE.PerspectiveCamera();
    threeState.camera = camera;
    const controls = distance === null ? null : { distance };
    render(<AdaptiveClipping />);
    frameCallbacks.forEach(fn => fn({ controls }));
    return camera;
  };

  it('renders nothing', () => {
    threeState.camera = new THREE.PerspectiveCamera();
    const { container } = render(<AdaptiveClipping />);
    expect(container.firstChild).toBeNull();
  });

  it('widens the depth range once the camera is working far out', () => {
    const camera = mountWith(17546.9);
    expect(camera.far).toBeCloseTo(17546.9 * FAR_DISTANCE_MULTIPLE, 3);
    expect(camera.far / camera.near).toBeCloseTo(MAX_DEPTH_RATIO, 6);
  });

  it('leaves a close-range camera on the inherited planes', () => {
    const camera = mountWith(320);
    expect(camera.near).toBe(0.1);
    expect(camera.far).toBe(2000);
  });

  it('follows the controls as they dolly', () => {
    const camera = new THREE.PerspectiveCamera();
    threeState.camera = camera;
    render(<AdaptiveClipping />);

    const controls = { distance: 320 };
    frameCallbacks.forEach(fn => fn({ controls }));
    expect(camera.far).toBe(2000);

    controls.distance = 17546.9;
    frameCallbacks.forEach(fn => fn({ controls }));
    expect(camera.far).toBeGreaterThan(17546.9);
  });

  it('falls back to the camera position before the controls have mounted', () => {
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 20000, 0);
    threeState.camera = camera;
    render(<AdaptiveClipping />);
    frameCallbacks.forEach(fn => fn({ controls: null }));
    expect(camera.far).toBeGreaterThan(20000);
  });

  it('does not rebuild the projection matrix when nothing changed', () => {
    const camera = new THREE.PerspectiveCamera();
    threeState.camera = camera;
    render(<AdaptiveClipping />);
    frameCallbacks.forEach(fn => fn({ controls: { distance: 320 } }));

    const spy = vi.spyOn(camera, 'updateProjectionMatrix');
    frameCallbacks.forEach(fn => fn({ controls: { distance: 320 } }));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('leaves an orthographic camera alone', () => {
    const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    threeState.camera = ortho;
    render(<AdaptiveClipping />);
    frameCallbacks.forEach(fn => fn({ controls: { distance: 17546.9 } }));
    expect(ortho.far).toBe(1000);
  });
});
