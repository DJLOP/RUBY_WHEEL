import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CanonicalGeographyData, RadialConstructRequest, RadialConstructResult, RadialMode } from './api';
import { canonicalApi } from './api';
import type { CanonicalFeature, WorldXZ } from './types';
import { CIRCLE_METHOD_POINTS, circleFromDefinition, lineLength, roundPoint, type CircleConstruction, type RadialBoundaryRecord } from './geometry';
import { CONSTRUCTOR_HINTS } from './tracing';
import { locateInRing } from './constraints';
import { CLASS_KINDS, FEATURE_CLASSES, describeIssue, emptyForm, formAttributes, formIssues } from './featureEditing';
import type { RadialMaterialize } from './api';
import type { FeatureClass } from './types';
import { formatLength, worldUnitsToMeters } from './physicalScale';
import {
  aimAngle, boundaryEligibility, boundaryRing, computeRadial, featureCenter, normalizeParams,
  type CenterSourceKind, type ConstructionError, type RadialReport,
} from './radialConstruction';
import { IDLE_RADIAL, isCirclePick, type RadialMapRequest, type RadialPickMode, type RadialSession } from './radialSession';
import type { PanelOps } from './panelUi';
import {
  DEFAULT_OUTPUT, constructionMembers, isRadialSpoke, outputSettings, revisionAvailability, type OutputForm, type RadialSpokeFeature,
} from './radialWorkflow';
import { confirmFrame, fieldStyle, kv, labelStyle, section, smallBtn, STATE_LABEL } from './panelStyles';

/**
 * RADIAL CONSTRUCT (plan §15.6, steps 2–12): exact radial spokes between two accepted
 * closed boundaries, previewed live and persisted only as drafts.
 *
 * - Preview is the client mirror, recomputed on every change; nothing reaches the server
 *   until Create. Closing the tool discards it.
 * - Create is one request; the server reloads the pinned inputs, recomputes, and inserts
 *   every spoke draft in one transaction or nothing, returning the full report.
 * - Any construction error or non-omitted invalid spoke disables Create with its reason;
 *   omission is explicit, never automatic.
 * - Acceptance stays per record: an explicit selection (nothing pre-ticked, no accept-all,
 *   no accept-and-lock) confirmed with its count, class, kind, strength and length, then
 *   the existing per-record accept calls, one at a time, stopping at the first refusal.
 * - Reconstruct pre-fills from a spoke's record. Revision mode may change only the center,
 *   the offset and the inputs; changing N or the omissions is a different set of spokes and
 *   needs new-drafts mode. The server re-checks all of it.
 *
 * The tool never creates scopes, boundaries, anchors, connections or memberships.
 */

const parseNumber = (text: string) => (text.trim() === '' ? NaN : Number(text));

// ── component ───────────────────────────────────────────────────────────────

export interface RadialPrefill {
  /** The spoke whose record is being reconstructed (or reviewed). */
  feature: RadialSpokeFeature;
  /** Open straight to the review list of its construction. */
  review?: boolean;
}

interface Props {
  data: CanonicalGeographyData;
  ops: PanelOps;
  session: RadialSession;
  /** Refetch canonical data (after a stale refusal or a partial batch). */
  refresh: () => void;
  prefill?: RadialPrefill | null;
  onInspectFeature: (id: number) => void;
  onClose: () => void;
}

type Chooser = { mode: RadialPickMode; items: { feature: CanonicalFeature; ok: boolean; reason?: string }[] } | null;
type Confirm = { kind: 'accept'; ids: number[] } | { kind: 'discard'; ids: number[] } | null;

const RING_LABEL = { inner: 'INNER BOUNDARY', outer: 'OUTER BOUNDARY' } as const;

type Role = 'inner' | 'outer';
/** A boundary is an existing accepted feature, or a circle constructed here with the shape creator's circle methods. */
type BoundaryKind = 'feature' | 'circle';
type CircleMethod = CircleConstruction['method'];
interface CircleDef { method: CircleMethod; points: WorldXZ[] }
/** The shape creator's circle modes, by the names its tracing panel uses. */
const CIRCLE_MODES: { method: CircleMethod; label: string; hint: string }[] = [
  { method: 'three_point', label: 'CIRCLE 3PT', hint: CONSTRUCTOR_HINTS.circle_3pt },
  { method: 'center_radius', label: 'CIRCLE C+R', hint: CONSTRUCTOR_HINTS.circle_center },
];
const EMPTY_CIRCLE: CircleDef = { method: 'three_point', points: [] };

/**
 * Whether Create also makes a constructed circle an ordinary canonical feature draft, and
 * with which ordinary semantics. Off by default, and never restored from a record: a
 * reconstruction materializes a new draft only when asked again.
 */
interface MaterializeForm { enabled: boolean; feature_class: FeatureClass; kind: string; constraint_strength: 'hard' | 'soft'; name: string; width_wu: string }
const NO_MATERIALIZE = (role: Role): MaterializeForm =>
  ({ enabled: false, feature_class: 'route', kind: '', constraint_strength: 'hard', name: `${role === 'inner' ? 'Inner' : 'Outer'} ring`, width_wu: '' });
/** The boundary as the tracing form sees a feature, so its attributes and issues come from the same rules. */
const asFeatureForm = (m: MaterializeForm) => ({ ...emptyForm(m.feature_class), kind: m.kind, width_wu: m.feature_class === 'route' ? m.width_wu : '' });
/** How the draft is stored: the shape creator's circle polygon, or a closed ring for a route (a wall, plan §4.4). */
const materializedShape = (c: FeatureClass) => (c === 'route' ? 'closed linestring' : 'polygon');
const materializeBody = (m: MaterializeForm): RadialMaterialize => {
  const body: RadialMaterialize = { feature_class: m.feature_class, kind: m.kind || null, constraint_strength: m.constraint_strength, name: m.name.trim() || null };
  const width = formAttributes(asFeatureForm(m))?.width_wu;
  if (width !== undefined) body.width_wu = width as number | string;
  return body;
};
const circleOf = (b: RadialBoundaryRecord | undefined): CircleDef | null =>
  (b && 'circle' in b ? { method: b.circle.method, points: b.circle.points.slice() } : null);
const featureIdOf = (b: RadialBoundaryRecord | undefined) => (b && 'feature_id' in b ? b.feature_id : null);
const bboxOf = (ring: WorldXZ[]) => ({
  min_x: Math.min(...ring.map(p => p.x)), min_z: Math.min(...ring.map(p => p.z)),
  max_x: Math.max(...ring.map(p => p.x)), max_z: Math.max(...ring.map(p => p.z)),
});
const fmt = (n: number, d = 3) => n.toFixed(d);

function featureLine(f: CanonicalFeature): string {
  return `#${f.id} ${f.name || '(unnamed)'} · ${f.feature_class}${f.kind ? `/${f.kind}` : ''} · ${f.geometry_type} · ${f.lifecycle_state === 'accepted' ? `r${f.revision}` : STATE_LABEL[f.lifecycle_state]}`;
}

export function RadialConstructionPanel({ data, ops, session, refresh, prefill = null, onInspectFeature, onClose }: Props) {
  const rec = prefill?.feature.construction ?? null;
  const [innerId, setInnerId] = useState<number | null>(featureIdOf(rec?.inner));
  const [outerId, setOuterId] = useState<number | null>(featureIdOf(rec?.outer));
  const [kind, setKind] = useState<Record<Role, BoundaryKind>>({
    inner: circleOf(rec?.inner) ? 'circle' : 'feature', outer: circleOf(rec?.outer) ? 'circle' : 'feature',
  });
  const [materialize, setMaterialize] = useState<Record<Role, MaterializeForm>>({ inner: NO_MATERIALIZE('inner'), outer: NO_MATERIALIZE('outer') });
  const [createdBoundaries, setCreatedBoundaries] = useState<{ role: Role; feature: CanonicalFeature }[]>([]);
  const [circleDef, setCircleDef] = useState<Record<Role, CircleDef>>({
    inner: circleOf(rec?.inner) ?? EMPTY_CIRCLE, outer: circleOf(rec?.outer) ?? EMPTY_CIRCLE,
  });
  const [centerKind, setCenterKind] = useState<CenterSourceKind>(rec?.center_source.kind ?? 'coordinate');
  const [centerX, setCenterX] = useState(rec ? String(rec.center.x) : '');
  const [centerZ, setCenterZ] = useState(rec ? String(rec.center.z) : '');
  const [centerFeatureId, setCenterFeatureId] = useState<number | null>(rec && rec.center_source.kind !== 'coordinate' ? rec.center_source.feature_id : null);
  const [countText, setCountText] = useState(rec ? String(rec.count) : '8');
  const [offsetText, setOffsetText] = useState(rec ? String(rec.offset_deg) : '0');
  const [omit, setOmit] = useState<number[]>(rec?.omit_indices.slice() ?? []);
  const [output, setOutput] = useState<OutputForm>(() => {
    if (!prefill) return DEFAULT_OUTPUT;
    const f = prefill.feature;
    const width = (f.attributes as { width_wu?: unknown } | null)?.width_wu;
    return {
      feature_class: f.feature_class === 'site' ? 'site' : 'route', kind: f.kind ?? '', constraint_strength: f.constraint_strength,
      width_wu: typeof width === 'number' ? String(width) : '', name_prefix: (f.name ?? '').replace(/\s*#\d+$/, '') || 'Spoke',
    };
  });
  const reconstructing = rec?.construction_id ?? null;
  const [mode, setMode] = useState<RadialMode>(() =>
    (rec && revisionAvailability(data.features, rec.construction_id, rec.count, rec.omit_indices).enabled ? 'revision' : 'new_drafts'));
  const [phase, setPhase] = useState<'build' | 'review'>(prefill?.review ? 'review' : 'build');
  const [reviewId, setReviewId] = useState<string | null>(prefill?.review ? rec!.construction_id : null);
  const [created, setCreated] = useState<CanonicalFeature[]>([]);
  const [lastMode, setLastMode] = useState<RadialMode | null>(null);
  /** The last refusal, with the request it answered: shown only while the request is unchanged. */
  const [refusal, setRefusal] = useState<{ key: string; errors: ConstructionError[] } | null>(null);
  const [chooser, setChooser] = useState<Chooser>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [ticked, setTicked] = useState<number[]>([]);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const scene = useSyncExternalStore(session.subscribe, session.getState);

  // The tool owns the scene preview while open; closing it discards everything.
  useEffect(() => {
    session.update(s => ({ ...s, active: true }));
    return () => session.update(() => IDLE_RADIAL);
  }, [session]);

  const live = useMemo(() => data.features.filter(f => f.lifecycle_state !== 'retired'), [data.features]);
  const byId = useMemo(() => new Map(live.map(f => [f.id, f])), [live]);
  const inner = innerId !== null ? byId.get(innerId) ?? null : null;
  const outer = outerId !== null ? byId.get(outerId) ?? null : null;
  const centerFeature = centerFeatureId !== null ? byId.get(centerFeatureId) ?? null : null;

  const eligibleBoundaries = useMemo(() => live.filter(f => boundaryEligibility(f).eligible), [live]);
  const ineligibleBoundaries = useMemo(() => live.filter(f => f.geometry_type !== 'point' && !boundaryEligibility(f).eligible), [live]);
  const centerCandidates = useMemo(() => (centerKind === 'coordinate' ? []
    : live.filter(f => featureCenter(f, centerKind).ok)), [live, centerKind]);

  const ringOf = (f: CanonicalFeature | null) => {
    if (!f || !boundaryEligibility(f).eligible) return null;
    const r = boundaryRing(f.geometry_type, f.geometry);
    return r.ok ? r.ring : null;
  };
  // An inline circle is built exactly as the shape creator builds it, from its defining clicks.
  const builtInner = useMemo(() => (kind.inner === 'circle' ? circleFromDefinition(circleDef.inner.method, circleDef.inner.points) : null), [kind.inner, circleDef.inner]);
  const builtOuter = useMemo(() => (kind.outer === 'circle' ? circleFromDefinition(circleDef.outer.method, circleDef.outer.points) : null), [kind.outer, circleDef.outer]);
  const built = { inner: builtInner, outer: builtOuter };
  const innerRing = useMemo(() => (kind.inner === 'circle' ? builtInner?.ring ?? null : ringOf(inner)), [kind.inner, builtInner, inner]);
  const outerRing = useMemo(() => (kind.outer === 'circle' ? builtOuter?.ring ?? null : ringOf(outer)), [kind.outer, builtOuter, outer]);
  const sameFeature = kind.inner === 'feature' && kind.outer === 'feature' && !!inner && !!outer && inner.id === outer.id;
  const labelOf = (role: Role) => (kind[role] === 'circle' ? `${role} boundary (constructed circle)`
    : `${role} boundary (feature #${(role === 'inner' ? inner : outer)?.id})`);

  const center: WorldXZ | null = useMemo(() => {
    if (centerKind === 'coordinate') {
      const x = parseNumber(centerX);
      const z = parseNumber(centerZ);
      return Number.isFinite(x) && Number.isFinite(z) ? { x, z } : null;
    }
    if (!centerFeature) return null;
    const c = featureCenter(centerFeature, centerKind);
    return c.ok ? c.center : null;
  }, [centerKind, centerX, centerZ, centerFeature]);

  const params = useMemo(() => normalizeParams({ count: parseNumber(countText), offset_deg: parseNumber(offsetText), omit_indices: omit }),
    [countText, offsetText, omit]);

  const report: RadialReport | null = useMemo(() => {
    if (!innerRing || !outerRing || !center || !params.ok || sameFeature) return null;
    return computeRadial({
      center, inner: innerRing, outer: outerRing, count: params.count, offset_deg: params.offset_deg, omit_indices: params.omit_indices,
      labels: { inner: labelOf('inner'), outer: labelOf('outer') },
    });
    // labelOf reads only kind and the selected features.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [innerRing, outerRing, center, params, sameFeature, kind, inner, outer]);

  // Push the preview to the scene on every change.
  useEffect(() => {
    const circles = (['inner', 'outer'] as const).flatMap((r) => {
      const b = r === 'inner' ? builtInner : builtOuter;
      return b ? [{ ring: b.ring, materialize: materialize[r].enabled }] : [];
    });
    const circlePoints = (['inner', 'outer'] as const).flatMap(r => (kind[r] === 'circle' ? circleDef[r].points : []));
    const outerBBox = kind.outer === 'circle' ? (builtOuter ? bboxOf(builtOuter.ring) : null) : outer?.bbox ?? null;
    session.update(s => ({ ...s, preview: phase === 'build'
      ? { center: report?.normalized.center ?? center, spokes: report?.spokes ?? [], outerBBox, circles, circlePoints } : null }));
  }, [session, report, center, outer, phase, builtInner, builtOuter, kind, circleDef, materialize]);


  const revision = reconstructing ? revisionAvailability(data.features, reconstructing, params.ok ? params.count : null, params.ok ? params.omit_indices : omit) : null;
  const outputResult = outputSettings(output);

  // ── Create availability ──
  const blockers: string[] = [];
  for (const role of ['inner', 'outer'] as const) {
    if (kind[role] === 'circle') {
      const d = circleDef[role];
      const need = CIRCLE_METHOD_POINTS[d.method];
      if (d.points.length < need) blockers.push(`construct the ${role} circle (${d.points.length}/${need} points)`);
      else if (!built[role]) blockers.push(`the ${role} circle's points do not define a circle (collinear or coincident) — pick them again`);
      continue;
    }
    const f = role === 'inner' ? inner : outer;
    if (!f) blockers.push(`choose an ${role} boundary`);
    else if (!boundaryEligibility(f).eligible) blockers.push(`${role} boundary #${f.id} is ineligible`);
  }
  if (sameFeature) blockers.push('the inner and outer boundary must be different features');
  for (const role of ['inner', 'outer'] as const) {
    if (kind[role] === 'circle' && materialize[role].enabled) blockers.push(...formIssues(asFeatureForm(materialize[role])).map(i => `${role} boundary draft: ${i}`));
  }
  if (!center) blockers.push(centerKind === 'coordinate' ? 'enter or click a center' : 'choose the feature that supplies the center');
  if (!params.ok) blockers.push(...params.issues.map(i => i.message));
  if (report) blockers.push(...report.errors.map(e => e.message));
  const invalid = report?.spokes.filter(s => s.status === 'invalid') ?? [];
  if (invalid.length) {
    blockers.push(mode === 'revision'
      ? `spoke(s) ${invalid.map(s => s.index).join(', ')} invalid — in revision mode fix them through the offset, the center or the boundaries`
      : `spoke(s) ${invalid.map(s => s.index).join(', ')} invalid — tick Omit for each, or change the offset/count, or revise a boundary`);
  }
  if (mode === 'revision' && revision && !revision.enabled) blockers.push(`revision mode unavailable: ${revision.reason}`);
  if (mode === 'new_drafts' && !outputResult.ok) blockers.push(outputResult.reason);

  const request = (): RadialConstructRequest | null => {
    const source = (role: Role): RadialConstructRequest['inner'] | null => {
      if (kind[role] === 'circle') {
        const d = circleDef[role];
        if (d.points.length !== CIRCLE_METHOD_POINTS[d.method]) return null;
        return materialize[role].enabled
          ? { circle: { method: d.method, points: d.points }, materialize: materializeBody(materialize[role]) }
          : { circle: { method: d.method, points: d.points } };
      }
      const f = role === 'inner' ? inner : outer;
      return f ? { feature_id: f.id, expected_revision: f.revision } : null;
    };
    const innerSource = source('inner');
    const outerSource = source('outer');
    if (!innerSource || !outerSource || !params.ok || !center || (centerKind !== 'coordinate' && !centerFeature)) return null;
    const body: RadialConstructRequest = {
      inner: innerSource,
      outer: outerSource,
      count: params.count, offset_deg: params.offset_deg, omit_indices: params.omit_indices,
    };
    if (centerKind === 'coordinate') { body.center = center; body.center_source = { kind: 'coordinate' }; } else {
      body.center_source = { kind: centerKind, feature_id: centerFeature!.id, expected_revision: centerFeature!.revision };
    }
    if (mode === 'revision' && revision?.enabled) body.revises = revision.revises;
    else if (outputResult.ok) body.output = outputResult.output;
    return body;
  };

  const currentRequest = request();
  const boundaryCount = (['inner', 'outer'] as const).filter(r => kind[r] === 'circle' && materialize[r].enabled).length;
  const spokeCount = report ? report.spokes.filter(s => s.status === 'valid').length : 0;
  const spokeWords = mode === 'revision' ? 'SPOKE REVISIONS' : 'SPOKES';
  const createLabel = boundaryCount
    ? `CREATE ${boundaryCount + spokeCount} DRAFTS: ${boundaryCount} BOUNDARY + ${spokeCount} ${spokeWords}`
    : mode === 'revision' ? 'CREATE DRAFT REVISIONS' : `CREATE ${spokeCount} DRAFTS`;
  const serverErrors = refusal && currentRequest && refusal.key === JSON.stringify(currentRequest) ? refusal.errors : [];

  const create = () => {
    const body = currentRequest;
    if (!body || blockers.length) return;
    setMessage(null);
    void ops.run(() => canonicalApi.constructRadial(ops.token, body), (res: RadialConstructResult) => {
      setCreated(res.features);
      setCreatedBoundaries(res.boundary_features ?? []);
      setReviewId(res.construction_id);
      setLastMode(res.mode);
      setTicked([]);
      setPhase('review');
      const boundaryNote = res.boundary_features?.length
        ? ` Also created ${res.boundary_features.length} boundary draft(s): ${res.boundary_features.map(b => `#${b.feature.id} (${b.role})`).join(', ')} — independent ordinary drafts, not accepted.` : '';
      ops.notify((res.mode === 'revision'
        ? `Created ${res.features.length} draft revision(s) of construction ${res.construction_id.slice(0, 8)}. Canon is unchanged until each is accepted.`
        : `Created ${res.features.length} draft spoke(s), construction ${res.construction_id.slice(0, 8)}. Nothing is canon until accepted.`) + boundaryNote);
    }, (err) => {
      const errors = (Array.isArray(err.errors) ? err.errors : []) as ConstructionError[];
      setRefusal({ key: JSON.stringify(body), errors });
      if (errors.some(e => e.code === 'stale_input')) {
        refresh();
        setMessage('Preview refreshed from current canon; review it and create again.');
      }
    });
  };

  // ── map clicks ──
  const handleRequest = (r: RadialMapRequest) => {
    setChooser(null);
    setMessage(null);
    if (r.mode === 'inner_circle' || r.mode === 'outer_circle') {
      // The shape creator's constructor clicks: each on the grid, until the method has its points.
      const role: Role = r.mode === 'inner_circle' ? 'inner' : 'outer';
      const d = circleDef[role];
      const points = [...d.points, roundPoint(r.at)].slice(-CIRCLE_METHOD_POINTS[d.method]);
      setCircleDef(c => ({ ...c, [role]: { ...d, points } }));
      if (points.length >= CIRCLE_METHOD_POINTS[d.method]) {
        session.update(st => (st.pickMode === r.mode ? { ...st, pickMode: null } : st));
        if (!circleFromDefinition(d.method, points)) setMessage('Those points do not define a shape (collinear or coincident); try again.');
      }
      return;
    }
    if (r.mode === 'center') {
      setCenterKind('coordinate');
      setCenterX(fmt(r.at.x));
      setCenterZ(fmt(r.at.z));
      return;
    }
    if (r.mode === 'aim') {
      const a = center ? aimAngle(center, r.at) : null;
      if (a === null) setMessage('Set the center first, then aim spoke 0 at a point away from it.');
      else setOffsetText(String(a));
      return;
    }
    const items = r.ids.map(id => byId.get(id)).filter((f): f is CanonicalFeature => !!f).map((feature) => {
      if (r.mode === 'center_feature') {
        const c = featureCenter(feature, centerKind === 'coordinate' ? 'feature_point' : centerKind);
        return c.ok ? { feature, ok: true } : { feature, ok: false, reason: c.reason };
      }
      const e = boundaryEligibility(feature);
      return e.eligible ? { feature, ok: true } : { feature, ok: false, reason: e.reason };
    });
    const ok = items.filter(i => i.ok);
    const choose = (f: CanonicalFeature) => {
      if (r.mode === 'inner') setInnerId(f.id);
      else if (r.mode === 'outer') setOuterId(f.id);
      else setCenterFeatureId(f.id);
    };
    if (ok.length === 1) choose(ok[0].feature);
    else if (items.length) setChooser({ mode: r.mode, items });
    else setMessage(`No canonical geometry at ${fmt(r.at.x, 1)}, ${fmt(r.at.z, 1)}.`);
  };
  const handleRef = useRef(handleRequest);
  useEffect(() => { handleRef.current = handleRequest; });
  const handled = useRef(scene.request?.nonce ?? 0);
  useEffect(() => {
    const r = scene.request;
    if (!r || r.nonce === handled.current) return;
    handled.current = r.nonce;
    handleRef.current(r);
  }, [scene.request]);

  const pickOnMap = (m: RadialPickMode) => session.update(s => ({ ...s, pickMode: s.pickMode === m ? null : m }));
  /** Start (or cancel) picking an inline circle's defining clicks; a new pick starts from no points. */
  const pickCircle = (role: Role) => {
    const m: RadialPickMode = role === 'inner' ? 'inner_circle' : 'outer_circle';
    if (scene.pickMode !== m) setCircleDef(c => ({ ...c, [role]: { ...c[role], points: [] } }));
    pickOnMap(m);
  };
  const setCircleMethod = (role: Role, method: CircleMethod) => {
    setCircleDef(c => ({ ...c, [role]: { method, points: [] } }));
    session.update(st => (isCirclePick(st.pickMode) ? { ...st, pickMode: null } : st));
  };
  const pickLabel = (m: RadialPickMode, label: string) => (scene.pickMode === m ? 'CLICK THE MAP… (CANCEL)' : label);

  const nudge = (delta: number) => {
    const v = parseNumber(offsetText);
    setOffsetText(String(Math.round(((Number.isFinite(v) ? v : 0) + delta) * 1e6) / 1e6));
  };
  const toggleOmit = (n: number) => setOmit(o => (o.includes(n) ? o.filter(x => x !== n) : [...o, n].sort((a, b) => a - b)));

  // ── review list ──
  const reviewRows = useMemo(() => {
    if (!reviewId) return [];
    const rows = constructionMembers(live, reviewId);
    // Until the refetch after Create lands, show what the server returned. Once any created
    // row is in the loaded data, the data alone is authoritative (so a discarded draft never
    // reappears from this fallback).
    const landed = created.some(f => data.features.some(x => x.id === f.id));
    return landed ? rows : [...rows, ...created.filter((f): f is RadialSpokeFeature => !rows.some(r => r.id === f.id) && isRadialSpoke(f))];
  }, [reviewId, live, created, data.features]);
  const draftRows = reviewRows.filter(f => f.lifecycle_state === 'draft');
  const landed = created.some(f => data.features.some(x => x.id === f.id));
  /** Boundary drafts this construction created: from this Create, or recorded on its spokes. */
  const boundaryRows = useMemo(() => {
    const out: { role: Role; feature: CanonicalFeature; gone: boolean }[] = [];
    const seen = new Set<number>();
    const add = (role: Role, id: number, fallback?: CanonicalFeature) => {
      if (seen.has(id)) return;
      seen.add(id);
      const f = byId.get(id) ?? fallback;
      // A fresh Create response stands in until the refetch lands; after that only loaded data counts.
      if (f) out.push({ role, feature: f, gone: !byId.has(id) && (!fallback || landed) });
    };
    for (const b of createdBoundaries) add(b.role, b.feature.id, b.feature);
    for (const s of reviewRows) {
      for (const role of ['inner', 'outer'] as const) {
        const ref = s.construction[role];
        if ('circle' in ref && ref.materialized_feature_id) add(role, ref.materialized_feature_id);
      }
    }
    return out;
  }, [createdBoundaries, reviewRows, byId, landed]);
  const superseded = lastMode === 'new_drafts' && reconstructing && reconstructing !== reviewId
    ? constructionMembers(live, reconstructing).filter(f => f.lifecycle_state === 'accepted') : [];

  const acceptSelected = (ids: number[]) => {
    const rows = ids.map(id => byId.get(id)).filter((f): f is CanonicalFeature => !!f && f.lifecycle_state === 'draft');
    const accepted: number[] = [];
    void ops.run(async () => {
      for (const f of rows) {
        const res = await canonicalApi.accept<CanonicalFeature>(ops.token, 'features', f.id, f.draft_version);
        if (!res.ok) {
          return { ok: false as const, error: { ...res.error,
            error: `${accepted.length ? `Accepted ${accepted.map(i => `#${i}`).join(', ')}. ` : 'Nothing accepted. '}Stopped at #${f.id}: ${res.error.error}` } };
        }
        accepted.push(f.id);
      }
      return { ok: true as const, data: accepted };
    }, (done) => {
      setConfirm(null);
      setTicked([]);
      ops.notify(`Accepted ${done.length} spoke(s): ${done.map(i => `#${i}`).join(', ')}.`);
    }, () => { setConfirm(null); setTicked(t => t.filter(id => !accepted.includes(id))); refresh(); });
  };

  const discardDrafts = (ids: number[]) => {
    const rows = ids.map(id => byId.get(id)).filter((f): f is CanonicalFeature => !!f && f.lifecycle_state === 'draft');
    const removed: number[] = [];
    void ops.run(async () => {
      for (const f of rows) {
        const res = await canonicalApi.remove(ops.token, 'features', f.id);
        if (!res.ok) return { ok: false as const, error: { ...res.error, error: `Deleted ${removed.length}; stopped at #${f.id}: ${res.error.error}` } };
        removed.push(f.id);
      }
      return { ok: true as const, data: removed };
    }, (done) => {
      setConfirm(null);
      setTicked([]);
      setCreated(c => c.filter(f => !done.includes(f.id)));
      ops.notify(`Discarded ${done.length} draft spoke(s). Accepted spokes were not touched.`);
    }, () => { setConfirm(null); refresh(); });
  };

  const close = () => { session.update(() => IDLE_RADIAL); onClose(); };

  // ── render ──
  if (phase === 'review') {
    const tickable = new Set(draftRows.map(f => f.id));
    const chosen = ticked.filter(id => tickable.has(id));
    const chosenRows = chosen.map(id => byId.get(id)!).filter(Boolean);
    const summarize = (vals: (string | null)[]) => [...new Set(vals.map(v => v ?? 'unspecified'))].join(', ');
    return (
      <div style={section} aria-label="Radial construction review">
        <strong style={{ fontSize: '0.75rem' }}>CONSTRUCTION REVIEW · {reviewId?.slice(0, 8)}</strong>
        {boundaryRows.length > 0 && (
          <div aria-label="Boundary drafts" style={{ fontSize: '0.62rem', marginTop: '4px' }}>
            <strong>BOUNDARY DRAFTS ({boundaryRows.length})</strong> — ordinary features built from the constructed circle; independent of the spokes, accepted on their own.
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {boundaryRows.map(({ role, feature: f, gone }) => (
                <li key={f.id} data-boundary-draft={f.id}>
                  {role}: #{f.id} {f.name || '(unnamed)'} · {f.feature_class}{f.kind ? `/${f.kind}` : ''} · {f.geometry_type} · {gone ? 'no longer loaded' : STATE_LABEL[f.lifecycle_state]}
                  {!gone && <button className="utility-btn" style={{ ...smallBtn, marginTop: 0 }} onClick={() => onInspectFeature(f.id)}>OPEN</button>}
                </li>
              ))}
            </ul>
          </div>
        )}
        <strong style={{ fontSize: '0.65rem', display: 'block', marginTop: '4px' }}>SPOKES</strong>
        <div style={{ fontSize: '0.6rem', opacity: 0.8 }}>
          Drafts are not canon. Accept explicitly: tick the spokes to accept (nothing is pre-ticked). Open a row to edit, trace or delete it
          in the inspector; editing a spoke&apos;s geometry clears its construction record.
        </div>
        {superseded.length > 0 && (
          <div role="note" style={{ fontSize: '0.62rem', color: '#ffcc55', marginTop: '4px' }}>
            The earlier construction&apos;s accepted spokes {superseded.map(f => `#${f.id}`).join(', ')} remain canonical until you retire them
            explicitly (RETIRE in each one&apos;s inspector). Nothing is retired automatically.
          </div>
        )}
        <ul aria-label="Construction spokes" style={{ listStyle: 'none', padding: 0, margin: '4px 0 0', maxHeight: '220px', overflowY: 'auto', fontSize: '0.62rem' }}>
          {reviewRows.length === 0 && <li style={{ opacity: 0.6 }}>No live spokes of this construction.</li>}
          {reviewRows.map(f => (
            <li key={f.id} style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
              <input type="checkbox" aria-label={`Select spoke #${f.id}`} disabled={!tickable.has(f.id)} checked={chosen.includes(f.id)}
                onChange={() => setTicked(t => (t.includes(f.id) ? t.filter(x => x !== f.id) : [...t, f.id]))} />
              <span style={{ flex: 1 }}>
                #{f.id} {f.name || '(unnamed)'} · spoke {f.construction.index} · {fmt(f.construction.angle_deg)}° · {formatLength(lineLength(f.geometry as WorldXZ[]))}
                {' · '}{STATE_LABEL[f.lifecycle_state]}{f.lifecycle_state === 'accepted' ? ` r${f.revision}` : ''}{f.revises_id ? ` · revises #${f.revises_id}` : ''}{f.is_locked ? ' 🔒' : ''}
              </span>
              <button className="utility-btn" style={{ ...smallBtn, marginTop: 0 }} onClick={() => onInspectFeature(f.id)}>OPEN</button>
            </li>
          ))}
        </ul>
        {confirm?.kind === 'accept' && (
          <div role="alertdialog" aria-label="Confirm accept selected" style={confirmFrame}>
            <strong>ACCEPT {chosenRows.length} SPOKE(S) AS CANON?</strong>
            <div style={kv}>
              <span>COUNT</span><span data-confirm="count">{chosenRows.length}</span>
              <span>CLASS</span><span>{summarize(chosenRows.map(f => f.feature_class))}</span>
              <span>KIND</span><span>{summarize(chosenRows.map(f => f.kind))}</span>
              <span>STRENGTH</span><span>{summarize(chosenRows.map(f => f.constraint_strength))}</span>
              <span>TOTAL LENGTH</span><span>{formatLength(chosenRows.reduce((s, f) => s + lineLength(f.geometry as WorldXZ[]), 0))}</span>
            </div>
            <div style={{ fontSize: '0.6rem', opacity: 0.8 }}>Each is accepted by its own request at the draft version shown; the first refusal stops the batch.</div>
            <button className="utility-btn" style={smallBtn} disabled={ops.busy} onClick={() => acceptSelected(confirm.ids)}>ACCEPT {confirm.ids.length}</button>
            <button className="utility-btn" style={smallBtn} disabled={ops.busy} onClick={() => setConfirm(null)}>CANCEL</button>
          </div>
        )}
        {confirm?.kind === 'discard' && (
          <div role="alertdialog" aria-label="Confirm discard drafts" style={confirmFrame}>
            Discard {confirm.ids.length} draft spoke(s) of this construction? Drafts are removed permanently; accepted spokes are not touched.
            <div>
              <button className="utility-btn" style={smallBtn} disabled={ops.busy} onClick={() => discardDrafts(confirm.ids)}>DISCARD {confirm.ids.length}</button>
              <button className="utility-btn" style={smallBtn} disabled={ops.busy} onClick={() => setConfirm(null)}>CANCEL</button>
            </div>
          </div>
        )}
        <div>
          <button className="utility-btn" style={smallBtn} disabled={ops.busy || !chosen.length}
            onClick={() => setConfirm({ kind: 'accept', ids: chosen })}>ACCEPT SELECTED ({chosen.length})…</button>
          <button className="utility-btn" style={{ ...smallBtn, borderColor: '#ff5544', color: '#ff7766' }} disabled={ops.busy || !draftRows.length}
            onClick={() => setConfirm({ kind: 'discard', ids: draftRows.map(f => f.id) })}>DISCARD DRAFTS OF THIS CONSTRUCTION ({draftRows.length})…</button>
        </div>
        <div>
          <button className="utility-btn" style={smallBtn} onClick={() => { setPhase('build'); setConfirm(null); }}>BACK TO CONSTRUCTOR</button>
          <button className="utility-btn" style={smallBtn} onClick={close}>CLOSE</button>
        </div>
      </div>
    );
  }

  const ringStatus = (ring: WorldXZ[] | null) => (ring && center ? locateInRing(center.x, center.z, ring) : null);
  const statusWord = (s: string | null) => (s === null ? '—' : s === 'inside' ? 'inside' : s === 'boundary' ? 'ON the boundary' : 'OUTSIDE');
  const normalized = params.ok ? params.offset_deg : null;

  const circleBuilder = (role: Role) => {
    const d = circleDef[role];
    const need = CIRCLE_METHOD_POINTS[d.method];
    const b = built[role];
    const m: RadialPickMode = role === 'inner' ? 'inner_circle' : 'outer_circle';
    const Role = role === 'inner' ? 'Inner' : 'Outer';
    return (
      <div aria-label={`${Role} circle`} style={{ fontSize: '0.6rem' }}>
        {CIRCLE_MODES.map(c => (
          <button key={c.method} className="utility-btn" aria-pressed={d.method === c.method}
            style={{ ...smallBtn, ...(d.method === c.method ? { background: 'var(--dark-green)' } : {}) }}
            onClick={() => setCircleMethod(role, c.method)}>{c.label}</button>
        ))}
        <button className="utility-btn" style={smallBtn} onClick={() => pickCircle(role)}>
          {scene.pickMode === m ? `CLICK THE MAP… ${d.points.length}/${need} (CANCEL)` : `PICK ${need} POINTS ON MAP`}
        </button>
        <div>{CIRCLE_MODES.find(c => c.method === d.method)!.hint} ({d.points.length}/{need})</div>
        {b ? (
          <div data-circle={role}>
            Circle: centre ({b.construction.type === 'circle' ? `${b.construction.center.x}, ${b.construction.center.z}` : ''}),
            radius {b.construction.type === 'circle' ? formatLength(b.construction.radius) : ''} — {materialize[role].enabled
              ? 'construction input, and Create also makes it a canonical feature draft.'
              : 'construction input only, not a canonical feature.'}
          </div>
        ) : d.points.length ? <div>Points: {d.points.map(p => `(${p.x}, ${p.z})`).join(' ')}</div> : null}
        {materializeFields(role)}
      </div>
    );
  };

  const materializeFields = (role: Role) => {
    const m = materialize[role];
    const set = (patch: Partial<MaterializeForm>) => setMaterialize(x => ({ ...x, [role]: { ...x[role], ...patch } }));
    const Role = role === 'inner' ? 'Inner' : 'Outer';
    const kinds = CLASS_KINDS[m.feature_class] ?? [];
    return (
      <div aria-label={`${Role} boundary output`} style={{ marginTop: '3px' }}>
        <label>
          <input type="checkbox" aria-label={`Create ${role} boundary as canonical draft`} checked={m.enabled} onChange={() => set({ enabled: !m.enabled })} />
          {' '}CREATE THIS BOUNDARY AS CANONICAL DRAFT
        </label>
        {m.enabled && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
            <label style={{ ...labelStyle, flex: 1 }}>CLASS
              <select aria-label={`${Role} boundary class`} style={fieldStyle} value={m.feature_class}
                onChange={e => set({ feature_class: e.target.value as FeatureClass, kind: '', width_wu: e.target.value === 'route' ? m.width_wu : '' })}>
                {FEATURE_CLASSES.map(c => <option key={c} value={c}>{c} ({materializedShape(c)})</option>)}
              </select>
            </label>
            <label style={{ ...labelStyle, flex: 1 }}>KIND (optional)
              <select aria-label={`${Role} boundary kind`} style={fieldStyle} value={m.kind} disabled={!kinds.length} onChange={e => set({ kind: e.target.value })}>
                <option value="">unspecified</option>
                {kinds.map(k => <option key={k} value={k}>{k}</option>)}
              </select>
            </label>
            <label style={{ ...labelStyle, flex: 1 }}>STRENGTH
              <select aria-label={`${Role} boundary strength`} style={fieldStyle} value={m.constraint_strength}
                onChange={e => set({ constraint_strength: e.target.value as 'hard' | 'soft' })}>
                <option value="hard">hard</option><option value="soft">soft</option>
              </select>
            </label>
            {m.feature_class === 'route' && (
              <label style={{ ...labelStyle, flex: 1 }}>WIDTH wu (optional)
                <input aria-label={`${Role} boundary width`} style={fieldStyle} value={m.width_wu} onChange={e => set({ width_wu: e.target.value })} />
              </label>
            )}
            <label style={{ ...labelStyle, flex: 2 }}>NAME
              <input aria-label={`${Role} boundary name`} style={fieldStyle} value={m.name} onChange={e => set({ name: e.target.value })} />
            </label>
            <div style={{ fontSize: '0.58rem', opacity: 0.8 }}>
              Saved as an ordinary {m.feature_class} draft ({materializedShape(m.feature_class)}) of this exact circle, created with the spokes in one
              request. It is independent: editing or deleting it never changes the spokes, and it is accepted on its own.
            </div>
          </div>
        )}
      </div>
    );
  };

  const boundaryPicker = (role: 'inner' | 'outer', value: number | null, set: (id: number | null) => void) => {
    const f = value !== null ? byId.get(value) ?? null : null;
    const e = f ? boundaryEligibility(f) : null;
    const Role = role === 'inner' ? 'Inner' : 'Outer';
    return (
      <div style={{ marginTop: '4px' }}>
        <label style={labelStyle}>{RING_LABEL[role]} SOURCE
          <select aria-label={`${Role} boundary source`} style={fieldStyle} value={kind[role]}
            onChange={ev => {
              const next = ev.target.value as BoundaryKind;
              setKind(k => ({ ...k, [role]: next }));
              session.update(st => (st.pickMode === role || st.pickMode === `${role}_circle` ? { ...st, pickMode: null } : st));
            }}>
            <option value="feature">existing canonical boundary (accepted)</option>
            <option value="circle">constructed circle (shape creator circle tools)</option>
          </select>
        </label>
        {kind[role] === 'circle' ? circleBuilder(role) : <>
        <label style={labelStyle}>{RING_LABEL[role]} (accepted polygon, or closed linestring)
          <select aria-label={`${role === 'inner' ? 'Inner' : 'Outer'} boundary`} style={fieldStyle} value={value ?? ''}
            onChange={ev => set(ev.target.value === '' ? null : Number(ev.target.value))}>
            <option value="">choose…</option>
            {eligibleBoundaries.map(b => <option key={b.id} value={b.id}>{featureLine(b)}</option>)}
            {f && e && !e.eligible && <option value={f.id}>{featureLine(f)} — ineligible</option>}
          </select>
        </label>
        <button className="utility-btn" style={smallBtn} onClick={() => pickOnMap(role)}>{pickLabel(role, 'PICK ON MAP')}</button>
        {f && (
          <div data-boundary={role} style={{ fontSize: '0.6rem' }}>
            {featureLine(f)}{e && !e.eligible ? <span style={{ color: '#ff7766' }}> — ineligible: {e.reason}</span> : ''}
          </div>
        )}
        </>}
      </div>
    );
  };

  return (
    <div style={section} aria-label="Radial construction">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong style={{ fontSize: '0.75rem' }}>RADIAL CONSTRUCT{reconstructing ? ` · RECONSTRUCT ${reconstructing.slice(0, 8)}` : ''}</strong>
        <button className="utility-btn" style={smallBtn} onClick={close} aria-label="Close radial construct">CLOSE</button>
      </div>
      <div style={{ fontSize: '0.6rem', opacity: 0.8 }}>
        Exact straight spokes between two closed boundaries: accepted canonical boundaries, or circles constructed here with the
        shape creator&apos;s circle tools (construction inputs only, never saved as features). Preview is local; Create makes drafts only.
      </div>

      {boundaryPicker('inner', innerId, setInnerId)}
      {boundaryPicker('outer', outerId, setOuterId)}
      {ineligibleBoundaries.length > 0 && (
        <details style={{ fontSize: '0.6rem', marginTop: '3px' }}>
          <summary>{ineligibleBoundaries.length} feature(s) not offered as boundaries</summary>
          <ul aria-label="Ineligible boundaries" style={{ margin: '2px 0 0 12px', padding: 0, maxHeight: '100px', overflowY: 'auto' }}>
            {ineligibleBoundaries.slice(0, 50).map(f => {
              const e = boundaryEligibility(f);
              return <li key={f.id}>{featureLine(f)} — {e.eligible ? '' : e.reason}</li>;
            })}
          </ul>
        </details>
      )}

      <div style={{ marginTop: '6px' }}>
        <label style={labelStyle}>CENTER SOURCE
          <select aria-label="Center source" style={fieldStyle} value={centerKind} onChange={e => setCenterKind(e.target.value as CenterSourceKind)}>
            <option value="coordinate">coordinate (entry or map click)</option>
            <option value="feature_point">an accepted point feature</option>
            <option value="feature_construction_center">center of an accepted circle/ellipse construction</option>
          </select>
        </label>
        {centerKind === 'coordinate' ? (
          <div style={{ display: 'flex', gap: '4px', alignItems: 'end' }}>
            <label style={{ ...labelStyle, flex: 1 }}>X (wu)<input aria-label="Center X" style={fieldStyle} value={centerX} onChange={e => setCenterX(e.target.value)} /></label>
            <label style={{ ...labelStyle, flex: 1 }}>Z (wu)<input aria-label="Center Z" style={fieldStyle} value={centerZ} onChange={e => setCenterZ(e.target.value)} /></label>
            <button className="utility-btn" style={smallBtn} onClick={() => pickOnMap('center')}>{pickLabel('center', 'CLICK MAP')}</button>
          </div>
        ) : null}
        {centerKind === 'coordinate' ? (
          <div>
            {(['inner', 'outer'] as const).map(role => {
              const c = built[role]?.construction;
              return c && c.type === 'circle' ? (
                <button key={role} className="utility-btn" style={smallBtn}
                  onClick={() => { setCenterX(String(c.center.x)); setCenterZ(String(c.center.z)); }}>USE CENTER OF {role.toUpperCase()} CIRCLE</button>
              ) : null;
            })}
          </div>
        ) : (
          <div>
            <select aria-label="Center feature" style={fieldStyle} value={centerFeatureId ?? ''}
              onChange={e => setCenterFeatureId(e.target.value === '' ? null : Number(e.target.value))}>
              <option value="">choose…</option>
              {centerCandidates.map(f => <option key={f.id} value={f.id}>{featureLine(f)}</option>)}
              {centerFeature && !centerCandidates.includes(centerFeature) && <option value={centerFeature.id}>{featureLine(centerFeature)} — ineligible</option>}
            </select>
            {centerKind === 'feature_construction_center' && [inner, outer].filter((f): f is CanonicalFeature => !!f && featureCenter(f, 'feature_construction_center').ok).map(f => (
              <button key={f.id} className="utility-btn" style={smallBtn} onClick={() => setCenterFeatureId(f.id)}>USE CENTER OF #{f.id}</button>
            ))}
            <button className="utility-btn" style={smallBtn} onClick={() => pickOnMap('center_feature')}>{pickLabel('center_feature', 'PICK ON MAP')}</button>
            {centerFeature && !featureCenter(centerFeature, centerKind).ok && (
              <div style={{ fontSize: '0.6rem', color: '#ff7766' }}>#{centerFeature.id}: {(featureCenter(centerFeature, centerKind) as { reason: string }).reason}</div>
            )}
          </div>
        )}
        <div aria-label="Center readout" style={{ ...kv, marginTop: '3px', border: '1px solid var(--dark-green)', padding: '3px' }}>
          <span>CENTER X/Z</span><span data-readout="center">{center ? `${fmt(center.x)}, ${fmt(center.z)} wu` : '—'}</span>
          <span>CENTER (m)</span><span>{center ? `${fmt(worldUnitsToMeters(center.x), 2)}, ${fmt(worldUnitsToMeters(center.z), 2)} m` : '—'}</span>
          <span>VS INNER</span><span data-readout="inner-status">{statusWord(ringStatus(innerRing))}</span>
          <span>VS OUTER</span><span data-readout="outer-status">{statusWord(ringStatus(outerRing))}</span>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
        <label style={{ ...labelStyle, width: '70px' }}>SPOKES (N)
          <input aria-label="Spoke count" style={fieldStyle} value={countText} onChange={e => setCountText(e.target.value)} />
        </label>
        <label style={{ ...labelStyle, flex: 1 }}>OFFSET θ₀ (degrees)
          <input aria-label="Angular offset" style={fieldStyle} value={offsetText} onChange={e => setOffsetText(e.target.value)} />
        </label>
      </div>
      <div>
        {[-1, -0.1, 0.1, 1].map(d => (
          <button key={d} className="utility-btn" style={smallBtn} onClick={() => nudge(d)}>{d > 0 ? `+${d}` : d}°</button>
        ))}
        <button className="utility-btn" style={smallBtn} disabled={!center} onClick={() => pickOnMap('aim')}>{pickLabel('aim', 'AIM SPOKE 0')}</button>
      </div>
      <div style={{ fontSize: '0.58rem', opacity: 0.85 }} data-convention>
        Angles run from +X toward +Z (on an unrotated reference layer: 0° = image-right, 90° = image-down, so clockwise on screen). Not a compass
        bearing; independent of the camera. θₙ = θ₀ + n·360°/N. Spoke 0 is drawn in yellow.
        {normalized !== null && ` Normalized θ₀ = ${normalized}°.`}
      </div>

      {reconstructing && (
        <div style={{ marginTop: '6px', fontSize: '0.62rem' }} aria-label="Reconstruct mode">
          <label style={{ marginRight: '8px' }}>
            <input type="radio" name="radial-mode" aria-label="Revision mode" checked={mode === 'revision'} onChange={() => setMode('revision')} />
            {' '}REVISION MODE (draft revisions of the accepted spokes; same ids)
          </label>
          <label>
            <input type="radio" name="radial-mode" aria-label="New drafts mode" checked={mode === 'new_drafts'} onChange={() => setMode('new_drafts')} />
            {' '}NEW DRAFTS (a new construction; the old spokes stay as they are)
          </label>
          {revision && !revision.enabled && <div data-revision-reason style={{ color: '#ffcc55' }}>Revision mode unavailable: {revision.reason}</div>}
        </div>
      )}

      {report && report.errors.length > 0 && (
        <ul aria-label="Construction errors" style={{ fontSize: '0.62rem', color: '#ff7766', margin: '4px 0 0 14px', padding: 0 }}>
          {report.errors.map((e, i) => <li key={i}>{e.message}</li>)}
        </ul>
      )}

      {report && report.spokes.length > 0 && (
        <div style={{ maxHeight: '220px', overflowY: 'auto', marginTop: '4px' }}>
          <table aria-label="Spoke preview" style={{ width: '100%', fontSize: '0.6rem', borderCollapse: 'collapse' }}>
            <thead><tr><th>#</th><th>θₙ</th><th>LENGTH</th><th>STATUS</th><th>OMIT</th></tr></thead>
            <tbody>
              {report.spokes.map(s => (
                <tr key={s.index} data-spoke={s.index} data-status={s.status}
                  style={{ ...(s.index === 0 ? { color: '#fff200' } : {}), ...(scene.hoverIndex === s.index ? { background: '#333' } : {}) }}
                  onMouseEnter={() => session.update(st => ({ ...st, hoverIndex: s.index }))}
                  onMouseLeave={() => session.update(st => (st.hoverIndex === s.index ? { ...st, hoverIndex: null } : st))}>
                  <td>{s.index}</td>
                  <td>{fmt(s.angle_deg)}°</td>
                  <td>{s.length_m !== null ? `${fmt(s.length_m, 2)} m` : '—'}</td>
                  <td>
                    {s.status.toUpperCase()}
                    {s.error && <div style={{ color: s.status === 'invalid' ? '#ff7766' : '#aaa' }}>{s.error.message}</div>}
                    {s.warnings.map(w => <div key={w.code} style={{ color: '#ffcc55' }}>{w.message}</div>)}
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <input type="checkbox" aria-label={`Omit spoke ${s.index}`} checked={omit.includes(s.index)} onChange={() => toggleOmit(s.index)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {mode === 'new_drafts' && (
        <div style={{ marginTop: '6px' }} aria-label="Output settings">
          <strong style={{ fontSize: '0.65rem' }}>SPOKE OUTPUT</strong>
          <span style={{ fontSize: '0.58rem', opacity: 0.8 }}> — applies to the spoke drafts only; a materialized boundary has its own settings above.</span>
          <div style={{ display: 'flex', gap: '4px' }}>
            <label style={{ ...labelStyle, flex: 1 }}>CLASS
              <select aria-label="Output class" style={fieldStyle} value={output.feature_class}
                onChange={e => setOutput(o => ({ ...o, feature_class: e.target.value as 'route' | 'site', kind: '', width_wu: e.target.value === 'route' ? o.width_wu : '' }))}>
                <option value="route">route</option><option value="site">site</option>
              </select>
            </label>
            <label style={{ ...labelStyle, flex: 1 }}>KIND (optional)
              <select aria-label="Output kind" style={fieldStyle} value={output.kind} disabled={!(CLASS_KINDS[output.feature_class] ?? []).length}
                onChange={e => setOutput(o => ({ ...o, kind: e.target.value }))}>
                <option value="">unspecified</option>
                {(CLASS_KINDS[output.feature_class] ?? []).map(k => <option key={k} value={k}>{k}</option>)}
              </select>
            </label>
          </div>
          <div style={{ display: 'flex', gap: '4px' }}>
            <label style={{ ...labelStyle, flex: 1 }}>STRENGTH
              <select aria-label="Output strength" style={fieldStyle} value={output.constraint_strength}
                onChange={e => setOutput(o => ({ ...o, constraint_strength: e.target.value as 'hard' | 'soft' }))}>
                <option value="hard">hard</option><option value="soft">soft</option>
              </select>
            </label>
            {output.feature_class === 'route' && (
              <label style={{ ...labelStyle, flex: 1 }}>WIDTH wu (optional)
                <input aria-label="Output width" style={fieldStyle} value={output.width_wu} onChange={e => setOutput(o => ({ ...o, width_wu: e.target.value }))} />
              </label>
            )}
            <label style={{ ...labelStyle, flex: 1 }}>NAME PREFIX
              <input aria-label="Name prefix" style={fieldStyle} value={output.name_prefix} onChange={e => setOutput(o => ({ ...o, name_prefix: e.target.value }))} />
            </label>
          </div>
        </div>
      )}

      {chooser && (
        <div role="dialog" aria-label="Choose picked feature" style={{ border: '1px solid #ffb000', padding: '4px', marginTop: '6px', fontSize: '0.62rem' }}>
          <strong>{chooser.items.length} FEATURE(S) HERE</strong>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {chooser.items.map(({ feature, ok, reason }) => (
              <li key={feature.id}>
                <button className="utility-btn" style={{ ...smallBtn, width: '100%', textAlign: 'left' }} disabled={!ok} data-choice-id={feature.id}
                  onClick={() => {
                    if (chooser.mode === 'inner') setInnerId(feature.id);
                    else if (chooser.mode === 'outer') setOuterId(feature.id);
                    else setCenterFeatureId(feature.id);
                    setChooser(null);
                  }}>
                  {featureLine(feature)}{ok ? '' : ` — ineligible: ${reason}`}
                </button>
              </li>
            ))}
          </ul>
          <button className="utility-btn" style={smallBtn} onClick={() => setChooser(null)}>CANCEL</button>
        </div>
      )}
      {message && <div role="status" style={{ fontSize: '0.62rem', color: '#ffcc55', marginTop: '4px' }}>{message}</div>}
      {serverErrors.length > 0 && (
        <ul aria-label="Server refusal" style={{ fontSize: '0.62rem', color: '#ff7766', margin: '4px 0 0 14px', padding: 0 }}>
          {serverErrors.map((e, i) => <li key={i}>{describeIssue(e)}</li>)}
        </ul>
      )}

      {blockers.length > 0 && (
        <ul aria-label="Create blockers" style={{ fontSize: '0.6rem', color: '#ffcc55', margin: '4px 0 0 14px', padding: 0 }}>
          {blockers.map((b, i) => <li key={i}>{b}</li>)}
        </ul>
      )}
      <div style={{ marginTop: '6px' }}>
        <button className="utility-btn" style={smallBtn} disabled={ops.busy || blockers.length > 0} onClick={create}>
          {createLabel}
        </button>
      </div>
      <div style={{ fontSize: '0.58rem', opacity: 0.7 }}>
        Create writes drafts only, all or nothing. Inputs are only read. Nothing becomes canon until each spoke is accepted.
      </div>
    </div>
  );
}
