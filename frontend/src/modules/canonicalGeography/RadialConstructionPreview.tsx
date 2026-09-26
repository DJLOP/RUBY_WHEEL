import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import type { CanonicalFeature, WorldXZ } from './types';
import { featuresAt } from './mapPick';
import { SNAP_RADIUS_PX, SnapIndex, isClick } from './tracing';
import { groundPoint, TRACE_Y } from './TracingTool';
import { rayToBBox, requestRadialPick, type RadialSession } from './radialSession';

/**
 * In-scene preview of a radial construction (plan §15.6 step 7), plus the Y=0 map clicks
 * the constructor asks for (boundary, center, center feature, aim spoke 0).
 *
 * Mounted in the world branch only, beside the other canonical scene tools, so nothing
 * renders under a battle map. Everything here is non-raycast and drawn in the canonical
 * overlay's Y band; it is preview only and never persisted — the panel sends the request
 * and the server computes the geometry.
 *
 * Styles are deliberately unlike accepted (solid class colour), draft (dashed, DRAFT) and
 * proposed (magenta) canon: an amber PREVIEW line, spoke 0 in bright yellow with endpoint
 * markers, an invalid spoke as a red ray from the center to the outer ring's bbox with its
 * contact point marked, an omitted spoke dimmed, and the hovered table row in white.
 *
 * A click is taken only while the panel waits for one (a pick mode is set), and only a
 * click — a drag beyond the click threshold stays the inherited camera truck.
 */

export const PREVIEW_COLOR = '#ffb000';
export const SPOKE0_COLOR = '#fff200';
export const INVALID_COLOR = '#ff3333';
export const OMITTED_COLOR = '#8a8a8a';
export const HOVER_COLOR = '#ffffff';
/** An inline circle boundary: a construction input, not canon. */
export const CIRCLE_INPUT_COLOR = '#b2ff59';
/** An inline circle that Create will also make a canonical draft. */
export const CIRCLE_DRAFT_COLOR = '#18ffff';
export const PREVIEW_LABEL = 'PREVIEW';
export const RADIAL_RENDER_ORDER = 1010;
const MARKER_PX = 8;

type Segment = [WorldXZ, WorldXZ];

function segmentPositions(segments: Segment[]): Float32Array {
  const out = new Float32Array(segments.length * 6);
  segments.forEach(([a, b], i) => out.set([a.x, 0, a.z, b.x, 0, b.z], i * 6));
  return out;
}

function Segments({ name, segments, color, opacity = 1, order }: { name: string; segments: Segment[]; color: string; opacity?: number; order: number }) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(segmentPositions(segments), 3));
    return g;
  }, [segments]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  if (!segments.length) return null;
  return (
    <lineSegments name={name} geometry={geometry} position={[0, TRACE_Y, 0]} renderOrder={order} raycast={() => null} frustumCulled={false}
      userData={{ radialPreview: PREVIEW_LABEL }}>
      <lineBasicMaterial color={color} transparent opacity={opacity} depthTest={false} depthWrite={false} toneMapped={false} />
    </lineSegments>
  );
}

/** Rings at a constant on-screen size, so the center and contact points are visible at any zoom. */
function Markers({ name, points, color, order }: { name: string; points: WorldXZ[]; color: string; order: number }) {
  const group = useRef<THREE.Group>(null);
  const { camera, gl } = useThree();
  useFrame(() => {
    const g = group.current;
    if (!g) return;
    const el = gl.domElement;
    const rect = el.getBoundingClientRect();
    const a = groundPoint(camera, el, rect.left + rect.width / 2, rect.top + rect.height / 2);
    const b = groundPoint(camera, el, rect.left + rect.width / 2 + 1, rect.top + rect.height / 2);
    const perPx = a && b ? Math.hypot(b.x - a.x, b.z - a.z) : 0;
    if (perPx) for (const child of g.children) child.scale.setScalar(perPx * MARKER_PX);
  });
  if (!points.length) return null;
  return (
    <group ref={group} name={name}>
      {points.map((p, i) => (
        <mesh key={i} name={`${name}-ring`} position={[p.x, TRACE_Y, p.z]} rotation={[-Math.PI / 2, 0, 0]}
          renderOrder={order} raycast={() => null} frustumCulled={false}>
          <ringGeometry args={[0.55, 1, 20]} />
          <meshBasicMaterial color={color} transparent opacity={1} depthTest={false} depthWrite={false} side={THREE.DoubleSide} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

interface Props {
  session: RadialSession;
  /** Canonical features for boundary/center picking and center snapping. */
  features: CanonicalFeature[];
  /** The scene is in the canonical view (inherited map handlers are off). */
  active: boolean;
}

export function RadialConstructionPreview({ session, features, active }: Props) {
  const { camera, gl } = useThree();
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const snapIndex = useMemo(() => new SnapIndex(features.filter(f => f.lifecycle_state !== 'retired')), [features]);

  const live = useRef({ camera, features, snapIndex });
  useLayoutEffect(() => { live.current = { camera, features, snapIndex }; });

  const listening = active && state.active && state.pickMode !== null;
  useEffect(() => {
    if (!listening) return;
    const el = gl.domElement;
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      down = e.button === 0 && e.target === el ? { x: e.clientX, y: e.clientY } : null;
    };
    const onUp = (e: PointerEvent) => {
      const start = down;
      down = null;
      if (!start || e.button !== 0 || e.target !== el || !isClick(start, { x: e.clientX, y: e.clientY })) return;
      const s = session.getState();
      if (!s.active || !s.pickMode) return;
      const cam = live.current.camera;
      const raw = groundPoint(cam, el, e.clientX, e.clientY);
      const q = groundPoint(cam, el, e.clientX + SNAP_RADIUS_PX, e.clientY);
      if (!raw) return;
      const tolerance = q ? Math.hypot(q.x - raw.x, q.z - raw.z) : 0;
      // Center and circle clicks snap to saved canonical vertices/edges, as tracing's constructor clicks do; an aim click is raw evidence.
      const snaps = s.pickMode === 'center' || s.pickMode === 'inner_circle' || s.pickMode === 'outer_circle';
      const snapped = snaps ? live.current.snapIndex.query(raw, tolerance)?.point ?? raw : raw;
      const ids = s.pickMode === 'inner' || s.pickMode === 'outer' || s.pickMode === 'center_feature'
        ? featuresAt(live.current.features, raw, tolerance) : [];
      session.update(st => requestRadialPick(st, snapped, ids));
    };
    el.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onUp);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
    };
  }, [listening, gl, session]);

  const preview = state.preview;
  const parts = useMemo(() => {
    const valid: Segment[] = [];
    const first: Segment[] = [];
    const invalid: Segment[] = [];
    const omitted: Segment[] = [];
    const hover: Segment[] = [];
    const errorPoints: WorldXZ[] = [];
    const firstEnds: WorldXZ[] = [];
    if (!preview?.center) return { valid, first, invalid, omitted, hover, errorPoints, firstEnds };
    const c = preview.center;
    for (const s of preview.spokes) {
      const g = s.geometry;
      const errorRay = () => {
        const end = preview.outerBBox ? rayToBBox(c, s.angle_deg, preview.outerBBox) : null;
        return end ? [c, end] as Segment : null;
      };
      const seg: Segment | null = g ? [g[0], g[1]] : errorRay();
      if (seg && s.index === state.hoverIndex) hover.push(seg);
      if (s.status === 'omitted') { if (seg) omitted.push(seg); continue; }
      if (s.status === 'invalid') {
        if (seg) invalid.push(seg);
        if (s.error?.point) errorPoints.push(s.error.point);
        if (s.error?.to) errorPoints.push(s.error.to);
        continue;
      }
      if (!g) continue;
      if (s.index === 0) { first.push(seg!); firstEnds.push(g[0], g[1]); } else valid.push(seg!);
    }
    return { valid, first, invalid, omitted, hover, errorPoints, firstEnds };
  }, [preview, state.hoverIndex]);

  if (!state.active || !preview) return null;
  const o = RADIAL_RENDER_ORDER;
  const ringSegments = (materialize: boolean): Segment[] => (preview.circles ?? []).filter(c => c.materialize === materialize)
    .flatMap(({ ring }) => ring.map((a, i) => [a, ring[(i + 1) % ring.length]] as Segment));
  const circleSegments = ringSegments(false);
  const draftCircleSegments = ringSegments(true);
  return (
    <group name="radial-construction-preview" userData={{ radialPreview: PREVIEW_LABEL }}>
      <Segments name="radial-preview-circles" segments={circleSegments} color={CIRCLE_INPUT_COLOR} opacity={0.85} order={o} />
      <Segments name="radial-preview-circle-drafts" segments={draftCircleSegments} color={CIRCLE_DRAFT_COLOR} order={o} />
      <Markers name="radial-preview-circle-points" points={preview.circlePoints ?? []} color={CIRCLE_INPUT_COLOR} order={o + 4} />
      <Segments name="radial-preview-omitted" segments={parts.omitted} color={OMITTED_COLOR} opacity={0.6} order={o} />
      <Segments name="radial-preview-spokes" segments={parts.valid} color={PREVIEW_COLOR} order={o + 1} />
      <Segments name="radial-preview-invalid" segments={parts.invalid} color={INVALID_COLOR} order={o + 2} />
      <Segments name="radial-preview-spoke0" segments={parts.first} color={SPOKE0_COLOR} order={o + 3} />
      <Markers name="radial-preview-spoke0-ends" points={parts.firstEnds} color={SPOKE0_COLOR} order={o + 4} />
      <Markers name="radial-preview-errors" points={parts.errorPoints} color={INVALID_COLOR} order={o + 5} />
      <Segments name="radial-preview-hover" segments={parts.hover} color={HOVER_COLOR} order={o + 6} />
      {preview.center && <Markers name="radial-preview-center" points={[preview.center]} color={PREVIEW_COLOR} order={o + 7} />}
    </group>
  );
}
