import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import type { CanonicalFeature, CanonicalPolygon, WorldXZ } from './types';
import { featuresAt, requestPick, type MapPickStore, type ScopeOverlay } from './mapPick';
import { SNAP_RADIUS_PX, isClick, type TracingSession } from './tracing';
import type { LandSelectionStore } from './landSelection';
import { groundPoint, TRACE_Y } from './TracingTool';

/**
 * Click canonical geometry to inspect it (WP6 remediation).
 *
 * The merged overlay stays non-raycast. A click is turned into its Y=0 world point (the
 * same ray the tracing tool uses) and resolved against feature geometry in `mapPick.ts`;
 * the manager then selects the feature, or offers a chooser when several overlap.
 *
 * Precedence, highest first — this tool takes a click only when none above applies:
 * 1. vertex/midpoint handles and tracing (a trace is active → this tool is idle);
 * 2. WP6 land multi-selection (picking on → this tool is idle);
 * 3. camera drag (movement beyond the click threshold is never a pick);
 * 4. map inspect (this tool), only in the canonical view with SELECT ON MAP on.
 *
 * It also outlines the feature the inspector shows, the row hovered in the context pane,
 * and the selected scope: a translucent fill over its extent, its boundary emphasized, and
 * the accepted land it spatially holds (wholly inside vs on/crossing the boundary). These
 * are a few small non-raycast objects for the current selection only, drawn alongside the
 * unchanged merged renderer; the spatial land sets are derived display, never membership.
 *
 * Three visual states, layered bottom to top and never overwriting each other:
 * 1. scope context: extent fill, spatial land outlines, scope boundary;
 * 2. the explicitly selected feature: magenta outline (+ on-screen markers for points/lines);
 * 3. the temporary hover from the context pane: white translucent fill (polygons), white
 *    outline and constant-size on-screen markers, so even a point or a thin route is visible
 *    at district zoom. When the hovered feature is the selected one, the outline keeps the
 *    selected colour and only the hover fill/markers are added, so nothing flickers.
 *
 * Every material here is in the three.js transparent pass. Transparent objects are drawn
 * after all opaque ones regardless of renderOrder, so mixing the translucent scope fill
 * with opaque lines let the fill paint over the hover; with one pass, renderOrder alone
 * fixes the stack.
 */

const HIGHLIGHT_COLOR = '#ff4fd8';
const HOVER_COLOR = '#ffffff';
const SCOPE_COLOR = '#00e5ff';
const INSIDE_COLOR = '#7dff6a';
const CROSSING_COLOR = '#ff9933';
const RENDER_ORDER = 995;
/** The stack, all in the transparent pass: scope fill < land outlines < scope outline < selected < hover. */
const OVERLAY_ORDER = {
  scopeFill: RENDER_ORDER - 2,
  scopeLand: RENDER_ORDER - 1,
  scopeOutline: RENDER_ORDER + 1,
  selected: RENDER_ORDER + 2,
  selectedMarker: RENDER_ORDER + 3,
  hoverFill: RENDER_ORDER + 6,
  hoverOutline: RENDER_ORDER + 7,
  hoverMarker: RENDER_ORDER + 8,
};
const ORDER = OVERLAY_ORDER;
/** On-screen radius of a highlight marker, in pixels (kept constant at any zoom). */
const MARKER_PX = 9;
/** Markers on at most this many line vertices (plus the end). */
const MAX_LINE_MARKERS = 64;
/** Half-size of the small diamond outline around a point, in world units (the on-screen ring carries visibility). */
const POINT_MARK = 3;

function highlightPositions(f: CanonicalFeature): Float32Array {
  const out: number[] = [];
  const path = (pts: WorldXZ[], closed: boolean) => {
    for (let i = 0; i < (closed ? pts.length : pts.length - 1); i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      out.push(a.x, 0, a.z, b.x, 0, b.z);
    }
  };
  if (f.geometry_type === 'point') {
    const p = f.geometry as WorldXZ;
    const m = POINT_MARK;
    path([{ x: p.x - m, z: p.z }, { x: p.x, z: p.z - m }, { x: p.x + m, z: p.z }, { x: p.x, z: p.z + m }], true);
  } else if (f.geometry_type === 'linestring') {
    path(f.geometry as WorldXZ[], false);
  } else {
    const poly = f.geometry as CanonicalPolygon;
    path(poly.outer, true);
    for (const h of poly.holes ?? []) path(h, true);
  }
  return Float32Array.from(out);
}

function Lines({ name, features, color, order = RENDER_ORDER }: { name: string; features: CanonicalFeature[]; color: string; order?: number }) {
  const geometry = useMemo(() => {
    const parts = features.map(highlightPositions);
    const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(all, 3));
    return g;
  }, [features]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  if (!features.length) return null;
  return (
    <lineSegments name={name} geometry={geometry} position={[0, TRACE_Y, 0]} renderOrder={order}
      raycast={() => null} frustumCulled={false}>
      <lineBasicMaterial color={color} transparent opacity={1} depthTest={false} depthWrite={false} toneMapped={false} />
    </lineSegments>
  );
}

/** Polygon rings as a flat ShapeGeometry (shape Y carries -Z; the mesh is rotated flat). */
function polygonFill(polys: CanonicalPolygon[]): THREE.ShapeGeometry | null {
  const shapes = polys.filter(p => p.outer.length >= 3).map((poly) => {
    const shape = new THREE.Shape(poly.outer.map(p => new THREE.Vector2(p.x, -p.z)));
    for (const h of poly.holes ?? []) shape.holes.push(new THREE.Path(h.map(p => new THREE.Vector2(p.x, -p.z))));
    return shape;
  });
  return shapes.length ? new THREE.ShapeGeometry(shapes) : null;
}

function Fill({ name, polys, color, opacity, order }: { name: string; polys: CanonicalPolygon[]; color: string; opacity: number; order: number }) {
  const geometry = useMemo(() => polygonFill(polys), [polys]);
  useEffect(() => () => geometry?.dispose(), [geometry]);
  if (!geometry) return null;
  return (
    <mesh name={name} geometry={geometry} rotation={[-Math.PI / 2, 0, 0]} position={[0, TRACE_Y, 0]}
      renderOrder={order} raycast={() => null} frustumCulled={false}>
      <meshBasicMaterial color={color} transparent opacity={opacity} depthTest={false} depthWrite={false} side={THREE.DoubleSide} toneMapped={false} />
    </mesh>
  );
}

/** Where on-screen markers go: a point; a line's vertices (capped); a polygon's bbox centre. */
function markerPoints(f: CanonicalFeature, forPolygons: boolean): WorldXZ[] {
  if (f.geometry_type === 'point') return [f.geometry as WorldXZ];
  if (f.geometry_type === 'linestring') {
    const line = f.geometry as WorldXZ[];
    if (line.length <= MAX_LINE_MARKERS) return line;
    const step = Math.ceil(line.length / MAX_LINE_MARKERS);
    return [...line.filter((_, i) => i % step === 0), line[line.length - 1]];
  }
  return forPolygons ? [{ x: (f.bbox.min_x + f.bbox.max_x) / 2, z: (f.bbox.min_z + f.bbox.max_z) / 2 }] : [];
}

/** Rings drawn at a constant on-screen size, so a point or thin route is visible at any zoom. */
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
          <ringGeometry args={[0.6, 1, 20]} />
          <meshBasicMaterial color={color} transparent opacity={1} depthTest={false} depthWrite={false} side={THREE.DoubleSide} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

/** State 2: the explicitly selected feature. */
function SelectedLayer({ feature }: { feature: CanonicalFeature }) {
  const points = useMemo(() => markerPoints(feature, false), [feature]);
  const features = useMemo(() => [feature], [feature]);
  return (
    <group name="canonical-selected-layer">
      <Lines name="canonical-selected-feature" features={features} color={HIGHLIGHT_COLOR} order={ORDER.selected} />
      <Markers name="canonical-selected-marker" points={points} color={HIGHLIGHT_COLOR} order={ORDER.selectedMarker} />
    </group>
  );
}

/**
 * State 3: the context-pane hover, on top of everything else. A hovered scope boundary is
 * filled more lightly, since it is as large as the district.
 */
function HoverLayer({ feature, alsoSelected }: { feature: CanonicalFeature; alsoSelected: boolean }) {
  const features = useMemo(() => [feature], [feature]);
  const polys = useMemo(() => (feature.geometry_type === 'polygon' ? [feature.geometry as CanonicalPolygon] : []), [feature]);
  const points = useMemo(() => markerPoints(feature, true), [feature]);
  return (
    <group name="canonical-hover-layer">
      <Fill name="canonical-hover-fill" polys={polys} color={HOVER_COLOR}
        opacity={feature.feature_class === 'scope_boundary' ? 0.12 : 0.35} order={ORDER.hoverFill} />
      <Lines name="canonical-hovered-feature" features={features} color={alsoSelected ? HIGHLIGHT_COLOR : HOVER_COLOR} order={ORDER.hoverOutline} />
      <Markers name="canonical-hover-marker" points={points} color={HOVER_COLOR} order={ORDER.hoverMarker} />
    </group>
  );
}

/** Translucent fill over a scope's extent polygons (holes respected), plus its outline. */
function ScopeOverlayLayer({ overlay, features }: { overlay: ScopeOverlay; features: CanonicalFeature[] }) {
  const byId = useMemo(() => new Map(features.map(f => [f.id, f])), [features]);
  const pick = (ids: number[]) => ids.map(id => byId.get(id)).filter((f): f is CanonicalFeature => !!f);
  const outline = useMemo(() => overlay.extent.map((poly, i) => ({
    id: -1 - i, geometry_type: 'polygon', geometry: poly,
  }) as unknown as CanonicalFeature), [overlay.extent]);
  const boundary = overlay.boundaryFeatureId !== null ? byId.get(overlay.boundaryFeatureId) : undefined;
  return (
    <group name="canonical-scope-overlay">
      <Fill name="scope-extent-fill" polys={overlay.extent} color={SCOPE_COLOR} opacity={0.14} order={ORDER.scopeFill} />
      <Lines name="scope-extent-outline" features={boundary ? [boundary] : outline} color={SCOPE_COLOR} order={ORDER.scopeOutline} />
      <Lines name="scope-land-inside" features={pick(overlay.inside)} color={INSIDE_COLOR} order={ORDER.scopeLand} />
      <Lines name="scope-land-crossing" features={pick(overlay.crossing)} color={CROSSING_COLOR} order={ORDER.scopeLand} />
    </group>
  );
}

interface Props {
  pick: MapPickStore;
  session: TracingSession;
  selection: LandSelectionStore;
  features: CanonicalFeature[];
  /** The scene is in the canonical view. */
  active: boolean;
}

export function CanonicalPickTool({ pick, session, selection, features, active }: Props) {
  const { camera, gl } = useThree();
  const pickState = useSyncExternalStore(pick.subscribe, pick.getState);
  const trace = useSyncExternalStore(session.subscribe, session.getState);
  const sel = useSyncExternalStore(selection.subscribe, selection.getState);

  const live = useRef({ camera, features });
  useLayoutEffect(() => { live.current = { camera, features }; });

  const listening = active && pickState.inspecting && !trace.active && !sel.picking;
  useEffect(() => {
    if (!listening) return;
    const el = gl.domElement;
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      down = e.button === 0 && e.target === el && !e.shiftKey ? { x: e.clientX, y: e.clientY } : null;
    };
    const onUp = (e: PointerEvent) => {
      const start = down;
      down = null;
      if (!start || e.button !== 0 || e.target !== el || !isClick(start, { x: e.clientX, y: e.clientY })) return;
      // Re-check at release: a trace or land picking started since the press takes precedence.
      if (session.getState().active || selection.getState().picking) return;
      const cam = live.current.camera;
      const p = groundPoint(cam, el, e.clientX, e.clientY);
      const q = groundPoint(cam, el, e.clientX + SNAP_RADIUS_PX, e.clientY);
      if (!p) return;
      const tolerance = q ? Math.hypot(q.x - p.x, q.z - p.z) : 0;
      pick.update(s => requestPick(s, p, featuresAt(live.current.features, p, tolerance)));
    };
    el.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onUp);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
    };
  }, [listening, gl, pick, session, selection]);

  const find = (id: number | null) => (id === null ? null : features.find(f => f.id === id && f.lifecycle_state !== 'retired') ?? null);
  const highlighted = find(pickState.highlightId);
  const hovered = find(pickState.hoverId);
  if (!highlighted && !hovered && !pickState.scopeOverlay) return null;
  return (
    <group name="canonical-pick">
      {pickState.scopeOverlay && <ScopeOverlayLayer overlay={pickState.scopeOverlay} features={features} />}
      {highlighted && <SelectedLayer feature={highlighted} />}
      {hovered && <HoverLayer feature={hovered} alsoSelected={hovered.id === highlighted?.id} />}
    </group>
  );
}
