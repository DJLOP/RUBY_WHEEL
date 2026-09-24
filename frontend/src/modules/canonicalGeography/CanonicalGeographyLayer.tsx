import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import {
  buildOverlayGeometry, overlayStyle,
  CANONICAL_FILL_Y, CANONICAL_LINE_Y, CANONICAL_POINT_Y, CANONICAL_RENDER_ORDER, CANONICAL_NO_RAYCAST,
  type OverlayFeature,
} from './overlay';

/**
 * Canonical geography drawn into the world scene (plan §7.2, WP4) — and nowhere else: it is
 * mounted only in the world branch of `App.tsx`, never under `BattleMapScene`.
 *
 * Accepted canon draws solid; drafts dashed with a faint fill and a DRAFT label; software
 * proposals in their own dashed colour with a PROPOSED · generated badge. Retired canon is
 * not drawn. Everything is merged per (class, state) — see overlay.ts — so the number of
 * scene objects does not grow with the number of islands.
 *
 * It sits in a fixed Y band above the reference rasters and below the inherited overlays,
 * and nothing in it can be hit by a raycast or carries a pointer handler: the reference
 * layer beneath stays visible and adjustable, and inherited tools click straight through.
 * Editing handles for a selected feature are WP5's, not this layer's.
 */
export function CanonicalGeographyLayer({ features, visible }: { features: OverlayFeature[]; visible: boolean }) {
  const prepared = useMemo(() => (visible ? buildOverlayGeometry(features) : null), [features, visible]);

  // Buffer geometries hold GPU allocations garbage collection does not reach; each set is
  // disposed when it is replaced or the layer unmounts.
  const objects = useMemo(() => {
    if (!prepared) return null;
    const attribute = (positions: Float32Array) => new THREE.BufferAttribute(positions, 3);
    return {
      fills: prepared.fills.map((b) => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', attribute(b.positions));
        g.setIndex(new THREE.BufferAttribute(b.indices, 1));
        return { buffer: b, geometry: g };
      }),
      lines: prepared.lines.map((b) => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', attribute(b.positions));
        return { buffer: b, geometry: g };
      }),
      points: prepared.points.map((b) => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', attribute(b.positions));
        return { buffer: b, geometry: g };
      }),
    };
  }, [prepared]);

  useEffect(() => () => {
    if (!objects) return;
    for (const o of [...objects.fills, ...objects.lines, ...objects.points]) o.geometry.dispose();
  }, [objects]);

  if (!prepared || !objects) return null;

  return (
    <group name="canonical-geography">
      {objects.fills.map(({ buffer, geometry }) => {
        const s = overlayStyle(buffer.featureClass, buffer.state);
        return (
          <mesh key={buffer.key} name={`canonical-fill-${buffer.key}`} geometry={geometry}
            position={[0, CANONICAL_FILL_Y, 0]} raycast={CANONICAL_NO_RAYCAST} renderOrder={CANONICAL_RENDER_ORDER}
            frustumCulled={false}>
            <meshBasicMaterial color={s.fillColor} transparent opacity={s.fillOpacity} depthWrite={false}
              side={THREE.DoubleSide} toneMapped={false} />
          </mesh>
        );
      })}
      {objects.lines.map(({ buffer, geometry }) => {
        const s = overlayStyle(buffer.featureClass, buffer.state);
        return (
          <lineSegments key={buffer.key} name={`canonical-line-${buffer.key}`} geometry={geometry}
            position={[0, CANONICAL_LINE_Y, 0]} raycast={CANONICAL_NO_RAYCAST} renderOrder={CANONICAL_RENDER_ORDER + 1}
            frustumCulled={false}
            // Dashes need per-vertex distances along the lines.
            onUpdate={(self: THREE.LineSegments) => { if (s.dashed) self.computeLineDistances(); }}>
            {s.dashed
              ? <lineDashedMaterial color={s.lineColor} dashSize={s.dashSize} gapSize={s.gapSize} transparent
                  opacity={s.lineOpacity} depthWrite={false} toneMapped={false} />
              : <lineBasicMaterial color={s.lineColor} transparent opacity={s.lineOpacity} depthWrite={false} toneMapped={false} />}
          </lineSegments>
        );
      })}
      {objects.points.map(({ buffer, geometry }) => {
        const s = overlayStyle(buffer.featureClass, buffer.state);
        return (
          <points key={buffer.key} name={`canonical-points-${buffer.key}`} geometry={geometry}
            position={[0, CANONICAL_POINT_Y, 0]} raycast={CANONICAL_NO_RAYCAST} renderOrder={CANONICAL_RENDER_ORDER + 2}
            frustumCulled={false}>
            <pointsMaterial color={s.lineColor} size={7} sizeAttenuation={false} transparent opacity={s.lineOpacity}
              depthWrite={false} toneMapped={false} />
          </points>
        );
      })}
      {prepared.labels.map(l => (
        <Html key={`label-${l.featureId}`} position={[l.x, CANONICAL_POINT_Y, l.z]} center zIndexRange={[10, 0]}
          style={{ pointerEvents: 'none' }}>
          <div className={`canonical-label canonical-label-${l.state}`} data-feature-id={l.featureId}
            style={{
              pointerEvents: 'none', whiteSpace: 'nowrap', fontSize: '10px', fontFamily: 'monospace', padding: '1px 4px',
              border: `1px dashed ${l.state === 'proposed' ? '#ff3fd2' : '#f2dc9b'}`,
              color: l.state === 'proposed' ? '#ff3fd2' : '#f2dc9b', background: 'rgba(0,0,0,0.55)',
            }}>
            {l.text}
          </div>
        </Html>
      ))}
    </group>
  );
}
