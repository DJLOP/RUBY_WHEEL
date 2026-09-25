import { memo, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from 'react';
import * as THREE from 'three';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import {
  SnapIndex, SNAP_RADIUS_PX, addPoint, beginTranslate, canCloseOnFirstVertex, canTranslate, closeRing, constructionPreview, deleteVertex,
  hitsTraceBody, insertVertex, isClick, moveVertex, resolveSnap, translateFrom, translateSnapshot,
  type SnapSource, type TracingSession, type TraceState, type TranslateSnapshot,
} from './tracing';
import { distance } from './geometry';
import type { WorldXZ } from './types';
import { CANONICAL_BAND_CEILING_Y, CANONICAL_POINT_Y } from './overlay';

/**
 * In-scene vertex tracing and editing for ONE canonical feature (plan §7.2, WP5).
 *
 * Mounted only while the app is in the `canonical_geo` view, in the world branch, so the
 * inherited drawing handlers (DistrictInteractions) are inactive and nothing here exists
 * under a battle map.
 *
 * Input model — click-based, never freehand:
 *
 * - A left click on the ground places a vertex (or the next constructor point). "Click"
 *   means the pointer moved at most CLICK_MAX_MOVE_PX between press and release; anything
 *   more is a drag and is left to the inherited left-button camera truck, so panning still
 *   works while tracing.
 * - Clicking the first vertex of an open ring closes it.
 * - Dragging a vertex handle moves it; the camera is held still through the same
 *   `isDragging` flag the inherited transform tools use. Alt-click deletes a vertex.
 * - Clicking an edge's midpoint handle inserts a vertex there (and it can be dragged on).
 * - Clicks and drags snap to saved vertices and edges within SNAP_RADIUS_PX, so shared
 *   shorelines coincide.
 * - Dragging the body of the geometry (inside a closed polygon, on a line, on a point)
 *   moves the whole shape by one world delta; its construction record moves with it, and
 *   UNDO restores the previous position. The press is taken in the capture phase, so the
 *   camera never starts panning — but never when it lands on a vertex or midpoint handle,
 *   which keep precedence. A press on the body that does not move stays an ordinary click.
 *   Only the trace session moves: accepted canon is edited only via a draft revision.
 *
 * The ground point is the Y=0 plane under the pointer — the inherited drawing tools' ray —
 * so the (non-raycast) reference raster never intercepts a click. The only raycastable
 * canonical objects anywhere are these handles, and only for the feature being edited; the
 * steady-state overlay stays merged and non-raycast (WP4).
 */

/** Drawn inside the canonical band: above the merged overlay, below the inherited overlays. */
export const TRACE_Y = (CANONICAL_POINT_Y + CANONICAL_BAND_CEILING_Y) / 2;
/** Handles are drawn at a constant on-screen size. */
const HANDLE_PX = 7;
const MIDPOINT_PX = 4.5;
/** Past this many vertices, per-vertex handles would cost more than they help; simplify first. */
export const MAX_HANDLES = 2000;
const TRACE_RENDER_ORDER = 1000;

const TRACE_COLOR = '#00ffd0';
const SELECTED_COLOR = '#ffea00';
const MIDPOINT_COLOR = '#00a0ff';

/** Where a screen point lands on the Y=0 ground plane, or null if the ray misses it. */
export function groundPoint(camera: THREE.Camera, element: HTMLElement, clientX: number, clientY: number): WorldXZ | null {
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, camera);
  const hit = new THREE.Vector3();
  if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) return null;
  return { x: hit.x, z: hit.z };
}

/** World units covered by `px` screen pixels around a screen point (snap reach, handle size). */
function worldPerPixels(camera: THREE.Camera, element: HTMLElement, clientX: number, clientY: number, px: number): number {
  const a = groundPoint(camera, element, clientX, clientY);
  const b = groundPoint(camera, element, clientX + px, clientY);
  return a && b ? Math.hypot(b.x - a.x, b.z - a.z) : 0;
}

function segmentPositions(points: WorldXZ[], closed: boolean): Float32Array {
  const out: number[] = [];
  const n = points.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    out.push(a.x, 0, a.z, b.x, 0, b.z);
  }
  return Float32Array.from(out);
}

function Segments({ name, points, closed, color, opacity = 1 }:
  { name: string; points: WorldXZ[]; closed: boolean; color: string; opacity?: number }) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(segmentPositions(points, closed), 3));
    return g;
  }, [points, closed]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <lineSegments name={name} geometry={geometry} position={[0, TRACE_Y, 0]} renderOrder={TRACE_RENDER_ORDER}
      raycast={() => null} frustumCulled={false}>
      <lineBasicMaterial color={color} transparent opacity={opacity} depthTest={false} depthWrite={false} toneMapped={false} />
    </lineSegments>
  );
}

interface Props {
  session: TracingSession;
  /** Saved features to snap to (accepted and working set). */
  features: SnapSource[];
  /** The inherited camera gate: true holds the camera still while a handle is dragged. */
  setIsDragging: (dragging: boolean) => void;
}

export function TracingTool({ session, features, setIsDragging }: Props) {
  const { camera, gl } = useThree();
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const index = useMemo(() => new SnapIndex(features, state.featureId), [features, state.featureId]);

  const down = useRef<{ x: number; y: number } | null>(null);
  const drag = useRef<number | null>(null);
  /** A handle took this press; the release must not also place a vertex. */
  const handled = useRef(false);
  /**
   * A press on the first vertex's handle while the ring can close: a click there closes the
   * ring, and only movement beyond the click threshold turns it into a drag. Without this
   * the handle's drag path (which ignores close intent) let pointer jitter snap vertex 0
   * onto a neighbouring feature instead of closing.
   */
  const pendingClose = useRef<{ x: number; y: number } | null>(null);
  /** A press on the geometry's body: a whole-shape move once it passes the click threshold. */
  const body = useRef<{ screen: { x: number; y: number }; start: WorldXZ; base: TranslateSnapshot; moving: boolean } | null>(null);
  const handleGroup = useRef<THREE.Group>(null);

  // Everything the DOM listeners need, current without re-binding them per render.
  const live = useRef({ camera, index, setIsDragging });
  useLayoutEffect(() => { live.current = { camera, index, setIsDragging }; });

  useEffect(() => {
    const el = gl.domElement;
    const pick = (e: PointerEvent, allowClose = true) => {
      const { camera: cam, index: idx } = live.current;
      const raw = groundPoint(cam, el, e.clientX, e.clientY);
      if (!raw) return null;
      const tolerance = worldPerPixels(cam, el, e.clientX, e.clientY, SNAP_RADIUS_PX);
      return resolveSnap(session.getState(), raw, idx, tolerance, { allowClose });
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      down.current = { x: e.clientX, y: e.clientY };
    };
    /** Whether the press lands on a vertex or edge-midpoint handle (which keep precedence). */
    const onHandle = (s: TraceState, p: WorldXZ, perPx: number) => {
      if (s.vertices.length > MAX_HANDLES || s.geometryType === 'point') return false;
      if (s.vertices.some(v => distance(v, p) <= (HANDLE_PX + 2) * perPx)) return true;
      const n = s.vertices.length;
      for (let i = 0; i < (s.closed ? n : n - 1); i++) {
        const a = s.vertices[i];
        const b = s.vertices[(i + 1) % n];
        if (distance({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }, p) <= (MIDPOINT_PX + 2) * perPx) return true;
      }
      return false;
    };
    // Capture phase: a press on the shape's body is ours before the camera (or R3F) sees it.
    const onDownCapture = (e: PointerEvent) => {
      const s = session.getState();
      if (e.button !== 0 || e.target !== el || !canTranslate(s) || s.mode !== 'vertex') return;
      const { camera: cam } = live.current;
      const p = groundPoint(cam, el, e.clientX, e.clientY);
      if (!p) return;
      const perPx = worldPerPixels(cam, el, e.clientX, e.clientY, 1);
      if (onHandle(s, p, perPx)) return;
      if (!hitsTraceBody(s, p, (s.geometryType === 'point' ? HANDLE_PX + 2 : SNAP_RADIUS_PX / 2) * perPx)) return;
      e.stopPropagation();
      down.current = { x: e.clientX, y: e.clientY };
      body.current = { screen: { x: e.clientX, y: e.clientY }, start: p, base: translateSnapshot(s), moving: false };
    };
    const onMove = (e: PointerEvent) => {
      const b = body.current;
      if (b) {
        if (!b.moving) {
          if (isClick(b.screen, { x: e.clientX, y: e.clientY })) return;
          b.moving = true;
          live.current.setIsDragging(true);
          session.update(beginTranslate);
        }
        const p = groundPoint(live.current.camera, el, e.clientX, e.clientY);
        if (p) session.update(s => translateFrom(s, b.base, p.x - b.start.x, p.z - b.start.z));
        return;
      }
      if (drag.current !== null) {
        if (pendingClose.current) {
          if (isClick(pendingClose.current, { x: e.clientX, y: e.clientY })) return;
          pendingClose.current = null; // moved past the threshold: an ordinary vertex drag
        }
        const hit = pick(e, false);
        const index = drag.current;
        if (hit) session.update(s => moveVertex(s, index, hit.point));
        return;
      }
      if (e.target !== el || !session.getState().active) return;
      const hit = pick(e);
      session.update(s => ({ ...s, hover: hit ? hit.point : null, hoverSnap: hit ? hit.kind : null }));
    };
    const onUp = (e: PointerEvent) => {
      const b = body.current;
      body.current = null;
      if (b?.moving) {
        down.current = null;
        live.current.setIsDragging(false);
        return;
      }
      const start = down.current;
      down.current = null;
      if (drag.current !== null) {
        const closes = pendingClose.current !== null && isClick(pendingClose.current, { x: e.clientX, y: e.clientY });
        drag.current = null;
        pendingClose.current = null;
        live.current.setIsDragging(false);
        handled.current = false;
        if (closes) session.update(closeRing);
        return;
      }
      if (handled.current) { handled.current = false; return; }
      if (e.button !== 0 || !start || e.target !== el || !session.getState().active) return;
      if (!isClick(start, { x: e.clientX, y: e.clientY })) return;
      const hit = pick(e);
      if (!hit) return;
      session.update(s => (hit.closes ? closeRing(s) : addPoint(s, hit.point)));
    };
    const onLeave = () => session.update(s => (s.hover ? { ...s, hover: null, hoverSnap: null } : s));

    window.addEventListener('pointerdown', onDownCapture, { capture: true });
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerleave', onLeave);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointerdown', onDownCapture, { capture: true });
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (drag.current !== null || body.current?.moving) live.current.setIsDragging(false);
    };
  }, [gl, session]);

  // Delete / Backspace removes the selected vertex, unless the user is typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const t = document.activeElement as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const sel = session.getState().selectedVertex;
      if (sel === null) return;
      e.preventDefault();
      session.update(s => deleteVertex(s, sel));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session]);

  // Constant on-screen handle size, whatever the zoom.
  useFrame(() => {
    const group = handleGroup.current;
    if (!group) return;
    const el = gl.domElement;
    const rect = el.getBoundingClientRect();
    const scale = worldPerPixels(camera, el, rect.left + rect.width / 2, rect.top + rect.height / 2, 1);
    if (!scale) return;
    for (const child of group.children) {
      const px = child.userData.px as number;
      child.scale.setScalar(scale * px);
    }
  });

  const startDrag = (e: ThreeEvent<PointerEvent>, index: number) => {
    e.stopPropagation();
    handled.current = true;
    if (e.nativeEvent.altKey) {
      session.update(s => deleteVertex(s, index));
      return;
    }
    pendingClose.current = index === 0 && canCloseOnFirstVertex(session.getState())
      ? { x: e.nativeEvent.clientX, y: e.nativeEvent.clientY } : null;
    session.update(s => ({ ...s, selectedVertex: index }));
    drag.current = index;
    setIsDragging(true);
  };

  const startInsert = (e: ThreeEvent<PointerEvent>, edgeStart: number, at: WorldXZ) => {
    e.stopPropagation();
    handled.current = true;
    session.update(s => insertVertex(s, edgeStart, at));
    drag.current = edgeStart + 1;
    setIsDragging(true);
  };

  if (!state.active) return null;
  return <TraceScene state={state} handleGroup={handleGroup} onVertexDown={startDrag} onMidpointDown={startInsert} />;
}

function TraceScene({ state, handleGroup, onVertexDown, onMidpointDown }: {
  state: TraceState;
  handleGroup: RefObject<THREE.Group | null>;
  onVertexDown: (e: ThreeEvent<PointerEvent>, index: number) => void;
  onMidpointDown: (e: ThreeEvent<PointerEvent>, edgeStart: number, at: WorldXZ) => void;
}) {
  const { vertices, closed, hover, mode, geometryType } = state;
  const rubberBand = useMemo(
    () => (mode === 'vertex' && !closed && hover && vertices.length && geometryType !== 'point'
      ? [vertices[vertices.length - 1], hover] : null),
    [mode, closed, hover, vertices, geometryType]);
  const preview = useMemo(() => constructionPreview(state), [state]);
  return (
    <group name="canonical-tracing">
      {vertices.length > 1 && <Segments name="trace-outline" points={vertices} closed={closed} color={TRACE_COLOR} />}
      {state.holes.map((h, i) => <Segments key={`hole-${i}`} name="trace-hole" points={h} closed color={TRACE_COLOR} opacity={0.5} />)}
      {rubberBand && <Segments name="trace-rubber-band" points={rubberBand} closed={false} color={TRACE_COLOR} opacity={0.5} />}
      {preview && <Segments name="trace-construction-preview" points={preview} closed color={SELECTED_COLOR} opacity={0.7} />}
      {state.constructionPoints.map((p, i) => (
        <mesh key={`cp-${i}`} name="trace-construction-point" position={[p.x, TRACE_Y, p.z]} rotation={[-Math.PI / 2, 0, 0]}
          renderOrder={TRACE_RENDER_ORDER + 1} raycast={() => null} scale={0.6}>
          <circleGeometry args={[1, 12]} />
          <meshBasicMaterial color={SELECTED_COLOR} depthTest={false} depthWrite={false} toneMapped={false} />
        </mesh>
      ))}
      <Handles handleGroup={handleGroup} vertices={vertices} closed={closed} geometryType={geometryType}
        selectedVertex={state.selectedVertex} onVertexDown={onVertexDown} onMidpointDown={onMidpointDown} />
    </group>
  );
}

/**
 * Vertex and edge-midpoint handles — the only raycastable canonical objects, and only for
 * the feature being edited. Memoized apart from the rest of the scene so pointer movement
 * (hover, rubber band) does not rebuild hundreds of handles.
 */
const Handles = memo(function Handles({ handleGroup, vertices, closed, geometryType, selectedVertex, onVertexDown, onMidpointDown }: {
  handleGroup: RefObject<THREE.Group | null>;
  vertices: WorldXZ[];
  closed: boolean;
  geometryType: TraceState['geometryType'];
  selectedVertex: number | null;
  onVertexDown: (e: ThreeEvent<PointerEvent>, index: number) => void;
  onMidpointDown: (e: ThreeEvent<PointerEvent>, edgeStart: number, at: WorldXZ) => void;
}) {
  const showHandles = vertices.length <= MAX_HANDLES;
  const midpoints = useMemo(() => {
    if (!showHandles || geometryType === 'point') return [];
    const n = vertices.length;
    const out: { edge: number; at: WorldXZ }[] = [];
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = vertices[i];
      const b = vertices[(i + 1) % n];
      out.push({ edge: i, at: { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 } });
    }
    return out;
  }, [vertices, closed, geometryType, showHandles]);

  return (
      <group ref={handleGroup} name="trace-handles">
        {showHandles && vertices.map((p, i) => (
          <mesh key={`v-${i}`} name="trace-vertex-handle" userData={{ px: HANDLE_PX, index: i }}
            position={[p.x, TRACE_Y, p.z]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={TRACE_RENDER_ORDER + 2}
            onPointerDown={(e) => onVertexDown(e, i)}>
            <circleGeometry args={[1, 16]} />
            <meshBasicMaterial color={selectedVertex === i ? SELECTED_COLOR : TRACE_COLOR} depthTest={false}
              depthWrite={false} toneMapped={false} />
          </mesh>
        ))}
        {midpoints.map(m => (
          <mesh key={`m-${m.edge}`} name="trace-midpoint-handle" userData={{ px: MIDPOINT_PX, edge: m.edge }}
            position={[m.at.x, TRACE_Y, m.at.z]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={TRACE_RENDER_ORDER + 1}
            onPointerDown={(e) => onMidpointDown(e, m.edge, m.at)}>
            <circleGeometry args={[1, 12]} />
            <meshBasicMaterial color={MIDPOINT_COLOR} transparent opacity={0.8} depthTest={false} depthWrite={false} toneMapped={false} />
          </mesh>
        ))}
      </group>
  );
});
