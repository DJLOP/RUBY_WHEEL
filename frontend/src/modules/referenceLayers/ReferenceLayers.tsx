import { useEffect, useState } from 'react';
import * as THREE from 'three';
import type { ReferenceLayer } from './types';
import { planeDimensions, referencePlaneProps, referenceMaterialProps, NO_RAYCAST } from './calibration';

/**
 * Calibrated raster underlays, drawn in the canonical world scene and nowhere else.
 *
 * These are something to build the city *over*. They are not geometry, not obstacles and
 * not selectable: raycasting is disabled, so a plane the size of the Imperial City drawing
 * does not become a click target covering everything a person is trying to trace. Nothing
 * here attaches a pointer handler, a collision body or a selection id.
 *
 * Each layer loads its own texture and fails on its own. A missing or corrupt asset must
 * leave the rest of the world drawn, not take the whole Canvas down with it.
 */

interface TextureState {
  texture: THREE.Texture | null;
  failed: boolean;
}

/**
 * The texture for one asset, disposed when it is no longer wanted.
 *
 * A texture holds a GPU allocation that garbage collection does not reach, so dropping the
 * reference is not enough — repeatedly opening a world with several large rasters would
 * leak one upload per visit. The load is guarded against arriving after unmount, which
 * would otherwise dispose nothing and set state on a component that is gone.
 */
function useReferenceTexture(url: string): TextureState {
  const [state, setState] = useState<TextureState>({ texture: null, failed: false });

  useEffect(() => {
    let cancelled = false;
    let loaded: THREE.Texture | null = null;
    setState({ texture: null, failed: false });

    const loader = new THREE.TextureLoader();
    loader.load(
      url,
      (texture) => {
        if (cancelled) { texture.dispose(); return; }
        loaded = texture;
        texture.colorSpace = THREE.SRGBColorSpace;
        setState({ texture, failed: false });
      },
      undefined,
      () => { if (!cancelled) setState({ texture: null, failed: true }); },
    );

    return () => {
      cancelled = true;
      if (loaded) loaded.dispose();
    };
  }, [url]);

  return state;
}

function ReferenceLayerPlane({ layer, index }: { layer: ReferenceLayer; index: number }) {
  const { texture } = useReferenceTexture(layer.asset_url);
  const { width, height } = planeDimensions(layer);

  // Nothing is drawn until there is something to draw. A failed load renders no plane,
  // which is the same outcome and stays local to this layer.
  if (!texture) return null;

  return (
    // The group carries the world rotation on its own axis; the mesh only lies the plane
    // flat. Keeping them apart means the Y angle is a plain rotation about world Y rather
    // than one term of a combined Euler whose order has to be reasoned about.
    <group name={`reference-layer-${layer.id}`} {...referencePlaneProps(layer, index)}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={NO_RAYCAST} frustumCulled={false}>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial map={texture} side={THREE.DoubleSide} {...referenceMaterialProps(layer)} />
      </mesh>
    </group>
  );
}

export function ReferenceLayers({ layers }: { layers: ReferenceLayer[] }) {
  const visible = (layers || []).filter(l => l.is_visible);
  if (!visible.length) return null;

  return (
    <group name="reference-layers">
      {visible.map((layer, index) => (
        <ReferenceLayerPlane key={layer.id} layer={layer} index={index} />
      ))}
    </group>
  );
}
