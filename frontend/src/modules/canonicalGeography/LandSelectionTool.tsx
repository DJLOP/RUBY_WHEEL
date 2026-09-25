import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import type { CanonicalFeature, CanonicalPolygon, WorldXZ } from './types';
import { addLand, landAt, landInBox, selectableLand, toggleLand, type LandSelectionStore } from './landSelection';
import { isClick } from './tracing';
import { groundPoint, TRACE_Y } from './TracingTool';

/**
 * In-scene selection of accepted land (WP6) — the one multi-select of islands.
 *
 * Mounted in the world branch while the canonical manager is open. It always draws the
 * current selection (and any "inside boundary" proposal) so the GM can see what an
 * assignment will touch; it takes pointer input only while `active` (the scene is in the
 * canonical view) and the selection is in picking mode, never while tracing.
 *
 * - A click (≤ CLICK_MAX_MOVE_PX of movement) on an island toggles it.
 * - Shift + left-drag draws a box and adds every island wholly inside it. The press is
 *   taken in the capture phase so the inherited camera truck never starts; a plain drag
 *   still pans.
 *
 * Nothing here is persisted and nothing here is membership: assigning a selection to a
 * scope is an explicit manager action followed by an explicit accept.
 */

const SELECTED_COLOR = '#ffea00';
const PROPOSED_COLOR = '#00e5ff';
const STRADDLING_COLOR = '#ff9933';
const BOX_COLOR = '#ffffff';
const RENDER_ORDER = 990;

function ringSegments(rings: WorldXZ[][]): Float32Array {
  const out: number[] = [];
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      out.push(a.x, 0, a.z, b.x, 0, b.z);
    }
  }
  return Float32Array.from(out);
}

function Outline({ name, rings, color }: { name: string; rings: WorldXZ[][]; color: string }) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(ringSegments(rings), 3));
    return g;
  }, [rings]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  if (!rings.length) return null;
  return (
    <lineSegments name={name} geometry={geometry} position={[0, TRACE_Y, 0]} renderOrder={RENDER_ORDER} raycast={() => null} frustumCulled={false}>
      <lineBasicMaterial color={color} depthTest={false} depthWrite={false} toneMapped={false} />
    </lineSegments>
  );
}

const outerRings = (features: CanonicalFeature[], ids: number[]) => {
  const want = new Set(ids);
  return features.filter(f => want.has(f.id) && f.geometry_type === 'polygon').map(f => (f.geometry as CanonicalPolygon).outer);
};

interface Props {
  selection: LandSelectionStore;
  features: CanonicalFeature[];
  /** The scene is in the canonical view (inherited drawing handlers are off). */
  active: boolean;
}

export function LandSelectionTool({ selection, features, active }: Props) {
  const { camera, gl } = useThree();
  const state = useSyncExternalStore(selection.subscribe, selection.getState);
  const land = useMemo(() => selectableLand(features), [features]);
  const [box, setBox] = useState<{ a: WorldXZ; b: WorldXZ } | null>(null);

  const live = useRef({ camera, land });
  useLayoutEffect(() => { live.current = { camera, land }; });

  const listening = active && state.picking;
  useEffect(() => {
    if (!listening) return;
    const el = gl.domElement;
    let down: { x: number; y: number } | null = null;
    let boxStart: WorldXZ | null = null;
    let boxEnd: WorldXZ | null = null;
    const ground = (e: PointerEvent) => groundPoint(live.current.camera, el, e.clientX, e.clientY);

    // Capture phase on window: a shift-press on the canvas is ours before the camera sees it.
    const onDownCapture = (e: PointerEvent) => {
      if (e.button !== 0 || e.target !== el) return;
      if (e.shiftKey) {
        const p = ground(e);
        if (!p) return;
        e.stopPropagation();
        e.preventDefault();
        boxStart = p;
        boxEnd = p;
        setBox({ a: p, b: p });
        return;
      }
      down = { x: e.clientX, y: e.clientY };
    };
    const onMove = (e: PointerEvent) => {
      if (!boxStart) return;
      const p = ground(e);
      if (!p) return;
      boxEnd = p;
      setBox({ a: boxStart, b: p });
    };
    const onUp = (e: PointerEvent) => {
      if (boxStart) {
        const a = boxStart;
        const b = boxEnd ?? a;
        boxStart = null;
        boxEnd = null;
        setBox(null);
        const ids = landInBox(live.current.land, a, b);
        selection.update(s => ({ ...addLand(s, ids), message: ids.length ? null : 'No accepted island lies wholly inside that box.' }));
        return;
      }
      const start = down;
      down = null;
      if (e.button !== 0 || !start || e.target !== el || !isClick(start, { x: e.clientX, y: e.clientY })) return;
      const p = ground(e);
      if (!p) return;
      const hit = landAt(live.current.land, p);
      selection.update(s => (hit ? toggleLand(s, hit.id) : { ...s, message: 'No accepted land here (only accepted land polygons are selectable).' }));
    };

    window.addEventListener('pointerdown', onDownCapture, { capture: true });
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointerdown', onDownCapture, { capture: true });
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setBox(null);
    };
  }, [listening, gl, selection]);

  const selectedRings = useMemo(() => outerRings(land, state.ids), [land, state.ids]);
  const proposedRings = useMemo(() => outerRings(land, state.proposal?.inside ?? []), [land, state.proposal]);
  const straddlingRings = useMemo(() => outerRings(land, state.proposal?.straddling ?? []), [land, state.proposal]);
  const boxRing = useMemo(() => (box ? [[
    { x: box.a.x, z: box.a.z }, { x: box.b.x, z: box.a.z }, { x: box.b.x, z: box.b.z }, { x: box.a.x, z: box.b.z },
  ]] : []), [box]);

  return (
    <group name="canonical-land-selection">
      <Outline name="land-selection" rings={selectedRings} color={SELECTED_COLOR} />
      <Outline name="land-proposal-inside" rings={proposedRings} color={PROPOSED_COLOR} />
      <Outline name="land-proposal-straddling" rings={straddlingRings} color={STRADDLING_COLOR} />
      <Outline name="land-selection-box" rings={boxRing} color={BOX_COLOR} />
    </group>
  );
}
