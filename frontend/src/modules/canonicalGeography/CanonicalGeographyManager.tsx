import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import type { CanonicalGeographyData, CanonicalApiError, CanonicalResult, CanonicalRevision } from './api';
import { canonicalApi } from './api';
import type { CanonicalAnchor, CanonicalFeature, FeatureClass, GeometryType, GeoScope, LifecycleState, PartRole, WorldXZ } from './types';
import { formatArea, formatLength, squareWorldUnitsToHectares, worldUnitsToMeters } from './physicalScale';
import { distance, geometryIssues, lineLength, polygonArea, ringPerimeter, type Construction } from './geometry';
import {
  IDLE_TRACE, beginTrace, closeRing, deleteVertex, setMode, simplifyTrace, traceGeometry, traceStartFromGeometry, undoLast,
  CONSTRUCTOR_CLICKS, type TraceMode, type TraceState, type TracingSession,
} from './tracing';
import {
  CLASS_GEOMETRY_TYPES, CLASS_KINDS, FEATURE_CLASSES, describeIssue, draftBody, emptyForm, featureActions, formFromFeature,
  formIssues, geometryMetrics, type Availability, type EvidenceSnapshot, type FeatureForm,
} from './featureEditing';
import { worldToSource, type ReferenceLayer } from '../referenceLayers';
import { PART_ROLES, PART_ROLE_DEFAULTS } from './anchors';
import { createLandSelection, pruneSelection, selectableLand, type LandSelectionStore } from './landSelection';
import type { PanelOps } from './panelUi';
import { AnchorsPanel } from './AnchorsPanel';
import { ScopesPanel } from './ScopesPanel';
import { stageScopeChange } from './scopeRequests';
import { ConnectionsPanel } from './ConnectionsPanel';
import { scopeLabel } from './scopes';
import { createMapPickStore, type MapPickStore, type PickRequest } from './mapPick';
import { featureLabel } from './connections';
import { ContextPane } from './ContextPane';
import { NO_SPATIAL, spatialFromBundle, spatialPreview, type ScopeSpatial } from './scopeContents';
import type { ScopeOverlay } from './mapPick';

/**
 * The primary administrator's canonical-geography panel (plan §7.2): the feature list and
 * inspector, tracing/editing of one feature at a time, and the lifecycle actions of WP2 —
 * save draft, accept (with confirmation), revise, lock/unlock, retire/restore, replacement
 * state and revision history (WP5); and the anchor register, scopes with explicit land
 * membership, and required connections (WP6, in their own tabs). Import is WP7.
 *
 * Every action is one request to the lifecycle API, and nothing here invents a shortcut
 * around it:
 *
 * - Saving always produces a draft. The only way to canon is Accept, which opens a
 *   confirmation showing what will be accepted and sends the draft_version on screen.
 * - There is no accept-all. "Accept & lock" is an opt-in second request after the accept
 *   succeeds, never one merged state change.
 * - A locked row's revise/retire/replacement/edit controls are disabled; the server
 *   refuses them anyway.
 * - A refused request keeps the editor's unsaved trace and form on screen.
 *
 * Opened only for the primary admin; the server enforces the same boundary on every
 * mutation, so this is which panel is drawn, not who may change the city.
 */

interface Props {
  token: string;
  data: CanonicalGeographyData;
  /** Reference layers, as evidence for tracing and the source-pixel readout — never an input to canon. */
  referenceLayers: ReferenceLayer[];
  /** Refetch canonical geography after a committed change. */
  refresh: () => void;
  session: TracingSession;
  /** Whether the scene is in the tracing view (the tool is mounted). */
  tracingActive: boolean;
  onTracingChange: (active: boolean) => void;
  overlayVisible: boolean;
  onToggleOverlay: () => void;
  onClose: () => void;
  /**
   * The land multi-selection shared with the in-scene LandSelectionTool. Optional so the
   * panel can stand alone (tests); App passes the one the scene draws.
   */
  selection?: LandSelectionStore;
  /**
   * Click-to-inspect state shared with the in-scene CanonicalPickTool. Optional like
   * `selection`; App passes the one the scene uses.
   */
  pick?: MapPickStore;
}

type Tab = 'features' | 'anchors' | 'scopes' | 'connections';
const TABS: [Tab, string][] = [['features', 'FEATURES'], ['anchors', 'ANCHORS'], ['scopes', 'SCOPES'], ['connections', 'CONNECTIONS']];

// ── evidence and readout (the raster-aware part of this module) ─────────────

/**
 * Which source pixel a world point falls on, through the layer's persisted calibration —
 * the reference-layer module's own `worldToSource`, not a copy of its arithmetic.
 */
export const sourcePixelReadout = (layer: ReferenceLayer, p: WorldXZ) => worldToSource(layer, p);

/** What a draft records about the evidence it was traced over (plan §3.1). */
export function evidenceFromLayer(layer: ReferenceLayer, note = ''): EvidenceSnapshot {
  const snap: EvidenceSnapshot = {
    reference_layer_id: layer.id,
    calibration_snapshot: {
      world_center_x: layer.world_center_x,
      world_center_z: layer.world_center_z,
      world_units_per_pixel: layer.world_units_per_pixel,
      rotation_rad: layer.rotation_rad,
    },
  };
  if (note.trim()) snap.note = note.trim();
  return snap;
}

/** Whether a record's evidence snapshot still matches its layer (informational only, plan §8.5). */
export function evidenceStatus(evidence: Record<string, unknown> | null, layers: ReferenceLayer[]):
  'none' | 'matches' | 'differs' | 'layer_missing' {
  const id = evidence?.reference_layer_id;
  const snap = evidence?.calibration_snapshot as Record<string, number> | undefined;
  if (typeof id !== 'number') return 'none';
  const layer = layers.find(l => l.id === id);
  if (!layer) return 'layer_missing';
  if (!snap) return 'differs';
  const same = (['world_center_x', 'world_center_z', 'world_units_per_pixel', 'rotation_rad'] as const)
    .every(k => Math.abs((snap[k] ?? NaN) - layer[k]) <= 1e-9);
  return same ? 'matches' : 'differs';
}

// ── styles ─────────────────────────────────────────────────────────────────

const fieldStyle: CSSProperties = {
  width: '100%', background: '#111', color: 'var(--green)', border: '1px solid var(--dark-green)', padding: '3px', fontSize: '0.7rem',
};
const labelStyle: CSSProperties = { fontSize: '0.6rem', opacity: 0.75, display: 'block', marginTop: '5px' };
const smallBtn: CSSProperties = { fontSize: '0.62rem', padding: '2px 6px', marginRight: '4px', marginTop: '4px' };
const section: CSSProperties = { borderTop: '1px solid var(--dark-green)', marginTop: '8px', paddingTop: '6px' };
const kv: CSSProperties = { display: 'grid', gridTemplateColumns: '42% 58%', fontSize: '0.65rem', rowGap: '1px' };

const STATE_LABEL: Record<LifecycleState, string> = { accepted: 'ACCEPTED', draft: 'DRAFT', proposed: 'PROPOSED · generated', retired: 'RETIRED' };
const MODE_LABEL: Record<TraceMode, string> = {
  vertex: 'VERTICES', circle_3pt: 'CIRCLE 3PT', circle_center: 'CIRCLE C+R', ellipse: 'ELLIPSE', rect: 'RECT',
};
const MODE_HINT: Record<TraceMode, string> = {
  vertex: 'Click to place vertices; click the first vertex (or CLOSE) to close. Drag handles to move, click an edge midpoint to insert, Alt-click or Delete to remove. Left-drag still pans.',
  circle_3pt: 'Click 3 points on the circle’s rim.',
  circle_center: 'Click the centre, then a point on the rim.',
  ellipse: 'Click the centre, the end of one semi-axis, then a point at the other semi-axis’ extent.',
  rect: 'Click two corners along one edge, then a point on the opposite edge.',
};

function ActionButton({ label, availability, onClick, busy, danger }:
  { label: string; availability: Availability; onClick: () => void; busy: boolean; danger?: boolean }) {
  return (
    <button className="utility-btn" style={{ ...smallBtn, ...(danger ? { borderColor: '#ff5544', color: '#ff7766' } : {}) }}
      disabled={busy || !availability.enabled} title={availability.reason ?? ''} onClick={onClick}>
      {label}
    </button>
  );
}

// ── editing state ──────────────────────────────────────────────────────────

interface Editing {
  /** The draft being edited, or null for a new one. */
  feature: CanonicalFeature | null;
  form: FeatureForm;
  /** A new scope_boundary traced for this scope: on save it is linked to the scope's draft (never accepted). */
  boundaryFor?: GeoScope;
}

type Confirm =
  | { kind: 'accept'; feature: CanonicalFeature; lockAfter: boolean; violations: unknown[]; warnings: unknown[] }
  | { kind: 'retire'; feature: CanonicalFeature }
  | { kind: 'delete'; feature: CanonicalFeature }
  | { kind: 'replacement'; feature: CanonicalFeature }
  | { kind: 'discard' };

const isOpenState = (s: LifecycleState) => s === 'draft' || s === 'proposed';

export function CanonicalGeographyManager({
  token, data, referenceLayers, refresh, session, tracingActive, onTracingChange, overlayVisible, onToggleOverlay, onClose,
  selection: selectionProp, pick: pickProp,
}: Props) {
  const ownSelection = useMemo(() => createLandSelection(), []);
  const selection = selectionProp ?? ownSelection;
  const ownPick = useMemo(() => createMapPickStore(), []);
  const pick = pickProp ?? ownPick;
  const pickState = useSyncExternalStore(pick.subscribe, pick.getState);
  const [scopeSelectedId, setScopeSelectedId] = useState<number | null>(null);
  const [showArchive, setShowArchive] = useState(false);
  const [search, setSearch] = useState('');
  const [chooser, setChooser] = useState<PickRequest | null>(null);
  /**
   * What the left context pane shows: a scope (with its spatial contents) and/or a feature.
   * Keeping the scope while a feature is focused lets the pane go back to it.
   */
  const [ctx, setCtx] = useState<{ scopeId: number | null; featureId: number | null; focus: 'scope' | 'feature' } | null>(null);
  const [scopeBundle, setScopeBundle] = useState<{ scopeId: number; spatial: ScopeSpatial; error: string | null } | null>(null);
  const inspectorRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>('features');
  const [states, setStates] = useState<Record<LifecycleState, boolean>>({ accepted: true, draft: true, proposed: true, retired: false });
  const [classFilter, setClassFilter] = useState<FeatureClass | ''>('');
  const [retired, setRetired] = useState<CanonicalFeature[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [evidenceLayerId, setEvidenceLayerId] = useState<number | ''>(() => referenceLayers.find(l => l.is_visible)?.id ?? '');
  const [evidenceNote, setEvidenceNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CanonicalApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [history, setHistory] = useState<{ featureId: number; rows: CanonicalRevision[] } | null>(null);
  const [descriptive, setDescriptive] = useState<{ name: string; description: string; notes: string } | null>(null);

  const trace = useSyncExternalStore(session.subscribe, session.getState);

  const loadRetired = useCallback(async () => {
    const res = await canonicalApi.list<CanonicalFeature>(token, 'features', ['retired']);
    if (res.ok) setRetired(Array.isArray(res.data) ? res.data : []);
    else setError(res.error);
  }, [token]);

  // The archive count is one editor-only read when the panel opens; the rows stay out of the
  // active list unless the archive is opened explicitly.
  useEffect(() => {
    let live = true;
    void canonicalApi.list<CanonicalFeature>(token, 'features', ['retired']).then((res) => {
      if (live && res.ok && Array.isArray(res.data)) setRetired(res.data);
    });
    return () => { live = false; };
  }, [token]);

  // The scene enters the canonical view on open when map selection is on (the default), so
  // a click on canonical geometry inspects it rather than reaching inherited map handlers.
  const openedScene = useRef(false);
  useEffect(() => {
    if (openedScene.current) return;
    openedScene.current = true;
    if (pick.getState().inspecting) onTracingChange(true);
  }, [pick, onTracingChange]);
  // Outline, in the scene, whatever the feature inspector shows.
  useEffect(() => {
    pick.update(s => (s.highlightId === selectedId ? s : { ...s, highlightId: selectedId }));
  }, [pick, selectedId]);
  useEffect(() => () => { pick.update(s => ({ ...s, highlightId: null, hoverId: null, scopeOverlay: null, request: null })); }, [pick]);

  // The trace belongs to this panel: closing the panel ends it, and the scene leaves the tracing view.
  useEffect(() => () => { session.update(() => IDLE_TRACE); }, [session]);
  // Picking belongs to the panel too; the selection itself survives (it is only highlighted).
  useEffect(() => () => { selection.update(s => (s.picking ? { ...s, picking: false } : s)); }, [selection]);
  // A refresh may retire or revise land; keep the selection to accepted land only.
  useEffect(() => {
    const ids = new Set(selectableLand(data.features).map(f => f.id));
    selection.update(s => pruneSelection(s, ids));
  }, [data.features, selection]);

  const allFeatures = useMemo(() => {
    const byId = new Map<number, CanonicalFeature>();
    for (const f of data.features) byId.set(f.id, f);
    for (const f of retired) if (!byId.has(f.id)) byId.set(f.id, f);
    return [...byId.values()].sort((a, b) => a.id - b.id);
  }, [data.features, retired]);

  const matches = (f: CanonicalFeature) => {
    if (classFilter && f.feature_class !== classFilter) return false;
    const q = search.trim().toLowerCase().replace(/^#/, '');
    return !q || String(f.id) === q || (f.name ?? '').toLowerCase().includes(q);
  };
  // The active list: accepted canon plus draft/proposal work. Retired canon lives in the
  // archive, so hundreds of retired revisions never lengthen the everyday list.
  const visible = allFeatures.filter(f => f.lifecycle_state !== 'retired' && states[f.lifecycle_state] && matches(f));
  const archived = allFeatures.filter(f => f.lifecycle_state === 'retired');
  const archivedShown = archived.filter(matches);
  const selected = allFeatures.find(f => f.id === selectedId) ?? null;
  const openRevision = selected && selected.lifecycle_state === 'accepted'
    ? allFeatures.find(f => f.revises_id === selected.id && f.lifecycle_state === 'draft') ?? null : null;

  const counts = (list: { lifecycle_state: LifecycleState }[], state: LifecycleState) => list.filter(r => r.lifecycle_state === state).length;

  const evidenceLayer = referenceLayers.find(l => l.id === evidenceLayerId) ?? null;

  /** Run one request; a refusal is shown and nothing on screen is thrown away. */
  const run = async <T,>(request: () => Promise<CanonicalResult<T>>,
    onOk: (data: T) => void | Promise<void>, onError?: (error: CanonicalApiError) => void) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await request();
      if (!res.ok) { setError(res.error); onError?.(res.error); return false; }
      await onOk(res.data);
      refresh();
      if (showArchive) await loadRetired();
      return true;
    } finally {
      setBusy(false);
    }
  };

  const ops: PanelOps = { token, busy, run, notify: setNotice };

  /**
   * The scene is in the canonical view while any canonical scene tool wants it. Precedence
   * among them (tracing > land picking > map inspect) is decided by the tools themselves;
   * this only keeps inherited map handlers off while one of them is on.
   */
  const sceneWanted = (tracing: boolean, picking: boolean, inspecting: boolean) => tracing || picking || inspecting;

  /** Map picking of land: the scene enters the canonical view so inherited handlers are off. */
  const setPicking = (on: boolean) => {
    if (on && editing) return; // one scene tool at a time: finish or cancel the trace first
    selection.update(s => ({ ...s, picking: on, message: null }));
    onTracingChange(sceneWanted(false, on, pick.getState().inspecting));
  };

  /** SELECT ON MAP: clicking canonical geometry opens it in the inspector. */
  const setInspecting = (on: boolean) => {
    pick.update(s => ({ ...s, inspecting: on }));
    if (!on) setChooser(null);
    onTracingChange(sceneWanted(!!editing, selection.getState().picking, on));
  };

  // ── tracing ──────────────────────────────────────────────────────────────

  const startTracing = (feature: CanonicalFeature | null, form: FeatureForm, boundaryFor?: GeoScope) => {
    selection.update(s => (s.picking ? { ...s, picking: false } : s));
    setEditing({ feature, form, boundaryFor });
    setError(null);
    setNotice(null);
    setConfirm(null);
    const ev = feature?.evidence as Record<string, unknown> | null | undefined;
    if (typeof ev?.reference_layer_id === 'number' && referenceLayers.some(l => l.id === ev.reference_layer_id)) {
      setEvidenceLayerId(ev.reference_layer_id as number);
    } else if (!feature && evidenceLayerId === '') {
      setEvidenceLayerId(referenceLayers.find(l => l.is_visible)?.id ?? '');
    }
    setEvidenceNote(typeof ev?.note === 'string' ? ev.note : '');
    session.update(s => beginTrace(s, feature
      ? traceStartFromGeometry(feature.geometry_type, feature.geometry, feature.id, (feature.construction as Construction | null) ?? null)
      : { geometryType: form.geometry_type }));
    onTracingChange(true);
  };

  const endTracing = () => {
    setEditing(null);
    setConfirm(null);
    session.update(() => IDLE_TRACE);
    onTracingChange(sceneWanted(false, selection.getState().picking, pick.getState().inspecting));
  };

  const updateForm = (changes: Partial<FeatureForm>) => {
    if (!editing) return;
    let form = { ...editing.form, ...changes };
    if (changes.feature_class && !CLASS_GEOMETRY_TYPES[form.feature_class].includes(form.geometry_type)) {
      form = { ...form, geometry_type: CLASS_GEOMETRY_TYPES[form.feature_class][0] };
    }
    if (changes.feature_class && form.kind && !(CLASS_KINDS[form.feature_class] ?? []).includes(form.kind)) form = { ...form, kind: '' };
    // A different geometry type cannot reuse the vertices traced so far.
    if (form.geometry_type !== editing.form.geometry_type) {
      session.update(s => beginTrace(s, { geometryType: form.geometry_type, featureId: s.featureId }));
    }
    setEditing({ ...editing, form });
  };

  const traceIssues = trace.active ? geometryIssues(trace.geometryType, trace.vertices, { closed: trace.closed, holes: trace.holes }) : [];
  const geometry = traceGeometry(trace);

  const saveDraft = () => {
    if (!editing) return;
    const issues = [...formIssues(editing.form), ...(geometry ? [] : ['the geometry is incomplete'])];
    if (issues.length) { setError({ status: 0, error: `Not saved: ${issues.join('; ')}` }); return; }
    // Evidence is documentation of where the geometry came from, recorded at save time; an
    // edit with no evidence layer chosen leaves the saved evidence as it was.
    const evidence = evidenceLayer ? evidenceFromLayer(evidenceLayer, evidenceNote) : editing.feature ? undefined : null;
    const body = draftBody(editing.form, geometry, trace.construction, evidence);
    const existing = editing.feature;
    void run(
      () => (existing
        ? canonicalApi.patch<CanonicalFeature>(token, 'features', existing.id, { ...body, expected_draft_version: existing.draft_version })
        : canonicalApi.create<CanonicalFeature>(token, 'features', body)),
      async (saved) => {
        const scope = editing.boundaryFor;
        endTracing();
        setSelectedId(saved.id);
        const note = `Saved ${saved.lifecycle_state.toUpperCase()} #${saved.id} (draft v${saved.draft_version}). It is not canon until accepted.`;
        if (!scope || existing) {
          setNotice(note + (saved.anchor_id ? ` Accepting it places anchor #${saved.anchor_id}.` : ''));
          return;
        }
        // A new boundary is linked to the scope's draft (or draft revision): a draft edit, never an accept.
        const linked = await stageScopeChange(token, data.scopes, scope, { boundary_feature_id: saved.id });
        if (linked.ok) {
          setNotice(`${note} Linked as the boundary of ${scopeLabel(scope)} on ${linked.data.draft.lifecycle_state} #${linked.data.draft.id}. `
            + 'Accept this boundary feature, then accept the scope.');
        } else {
          setError({ ...linked.error, error: `${note} Linking it to ${scopeLabel(scope)} was refused: ${linked.error.error}` });
        }
      });
  };

  /** ADD PART: the WP5 tracing tool, with the part linkage set. */
  const addPart = (anchor: CanonicalAnchor, role: PartRole) => {
    const d = PART_ROLE_DEFAULTS[role];
    startTracing(null, { ...emptyForm(d.feature_class), geometry_type: d.geometry_type, anchor_id: anchor.id, part_role: role,
      name: `${anchor.name} ${role}` });
  };

  /**
   * Edit a feature's geometry with the WP5 tool: a draft directly; accepted canon through
   * its open draft revision, or a new one (Revise) — never in place.
   */
  const editFeatureGeometry = (f: CanonicalFeature) => {
    if (f.lifecycle_state === 'draft' || f.lifecycle_state === 'proposed') { startTracing(f, formFromFeature(f)); return; }
    const open = data.features.find(x => x.revises_id === f.id && x.lifecycle_state === 'draft');
    if (open) { startTracing(open, formFromFeature(open)); return; }
    void run(() => canonicalApi.revise<CanonicalFeature>(token, 'features', f.id), (draft) => {
      setSelectedId(draft.id);
      startTracing(draft, formFromFeature(draft));
      setNotice(`Editing draft revision #${draft.id} of #${f.id}. Save it, then accept it to replace revision ${f.revision}.`);
    });
  };

  const traceBoundary = (scope: GeoScope) =>
    startTracing(null, { ...emptyForm('scope_boundary'), name: `${scope.name ?? scope.scope_key} boundary` }, scope);

  // ── lifecycle actions ────────────────────────────────────────────────────

  const doAccept = async (c: Extract<Confirm, { kind: 'accept' }>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await canonicalApi.accept<CanonicalFeature>(token, 'features', c.feature.id, c.feature.draft_version);
      if (!res.ok) {
        // Keep the dialog open with every violation the server listed.
        setConfirm({ ...c, violations: res.error.violations ?? [], warnings: res.error.warnings ?? [] });
        setError(res.error);
        return;
      }
      const canon = res.data.record;
      const warnings = res.data.warnings ?? [];
      let lockNote = '';
      if (c.lockAfter) {
        const locked = await canonicalApi.setLock<CanonicalFeature>(token, 'features', canon.id, true);
        lockNote = locked.ok ? ' Then locked (separate request).' : ` The separate lock request failed: ${locked.error.error}`;
      }
      setConfirm(null);
      setSelectedId(canon.id);
      setHistory(null);
      setNotice(`Accepted feature #${canon.id} at revision ${canon.revision}.${lockNote}`
        + (warnings.length ? ` Warnings: ${warnings.map(describeIssue).join('; ')}` : ''));
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const revise = (f: CanonicalFeature) => run(() => canonicalApi.revise<CanonicalFeature>(token, 'features', f.id), (draft) => {
    setSelectedId(draft.id);
    setNotice(`Draft revision #${draft.id} of feature #${f.id} created. Edit it, then accept it to replace revision ${f.revision}.`);
  });

  const retire = (f: CanonicalFeature) => run(() => canonicalApi.retire<CanonicalFeature>(token, 'features', f.id), async () => {
    setConfirm(null);
    setNotice(`Feature #${f.id} retired and moved to the archive. It is hidden from the scene and generator queries, and can be restored from the archive.`);
    await loadRetired();
  });

  const restore = (f: CanonicalFeature) => run(() => canonicalApi.restore<CanonicalFeature>(token, 'features', f.id), (r) => {
    setNotice(`Feature #${f.id} restored to accepted.` + (r.warnings?.length ? ` Warnings: ${r.warnings.map(describeIssue).join('; ')}` : ''));
    setRetired(list => list.filter(x => x.id !== f.id));
  });

  const setLock = (f: CanonicalFeature, isLocked: boolean) =>
    run(() => canonicalApi.setLock<CanonicalFeature>(token, 'features', f.id, isLocked),
      () => setNotice(`Feature #${f.id} ${isLocked ? 'locked' : 'unlocked'}.`));

  const toggleReplacement = (f: CanonicalFeature) => {
    const next = f.replacement_state === 'replaceable' ? 'non_replaceable' : 'replaceable';
    return run(() => canonicalApi.setReplacement<CanonicalFeature>(token, 'features', f.id, next), () => {
      setConfirm(null);
      setNotice(`Feature #${f.id} is now ${next}.`);
    });
  };

  const deleteDraft = (f: CanonicalFeature) => run(() => canonicalApi.remove(token, 'features', f.id), () => {
    setConfirm(null);
    setSelectedId(f.revises_id);
    setNotice(`${f.lifecycle_state === 'proposed' ? 'Proposal' : 'Draft'} #${f.id} deleted.`);
  });

  const saveDescriptive = (f: CanonicalFeature) => {
    if (!descriptive) return;
    return run(() => canonicalApi.patch<CanonicalFeature>(token, 'features', f.id, {
      name: descriptive.name.trim() || null, description: descriptive.description.trim() || null, notes: descriptive.notes.trim() || null,
    }), () => { setDescriptive(null); setNotice(`Descriptive fields of #${f.id} updated (history recorded, revision unchanged).`); });
  };

  const loadHistory = async (f: CanonicalFeature) => {
    setError(null);
    const res = await canonicalApi.history(token, 'features', f.id);
    if (res.ok) setHistory({ featureId: f.id, rows: res.data });
    else setError(res.error);
  };

  const draftFromHistory = (f: CanonicalFeature, revision: number) =>
    run(() => canonicalApi.draftFromHistory<CanonicalFeature>(token, 'features', f.id, revision), (draft) => {
      setSelectedId(draft.id);
      setNotice(`Draft #${draft.id} created from revision ${revision} of feature #${f.id}. It becomes canon only if accepted.`);
    });

  const select = (id: number | null) => {
    setSelectedId(id);
    if (id !== null) setCtx(c => ({ scopeId: c?.scopeId ?? null, featureId: id, focus: 'feature' }));
    setHistory(null);
    setDescriptive(null);
    setConfirm(null);
    setError(null);
  };

  /** Show a feature (an anchor part, a boundary) in the feature inspector, where it is accepted. */
  const inspectFeature = (id: number) => {
    const f = allFeatures.find(x => x.id === id);
    if (f && f.lifecycle_state === 'retired') setShowArchive(true);
    else if (f && !states[f.lifecycle_state]) setStates(s => ({ ...s, [f.lifecycle_state]: true }));
    setClassFilter('');
    setSearch('');
    setChooser(null);
    setTab('features');
    select(id);
  };

  /** Select a scope: the scope tools on the right, its spatial context on the left. */
  const selectScope = (id: number | null) => {
    setScopeSelectedId(id);
    setCtx(c => (id === null ? (c ? { ...c, scopeId: null, focus: 'feature' } : c) : { scopeId: id, featureId: null, focus: 'scope' }));
  };

  const openScope = (id: number) => {
    selectScope(id);
    setChooser(null);
    setTab('scopes');
  };

  /** The one live scope whose boundary this feature is, if exactly one: that scope is what a click means. */
  const owningScope = (featureId: number) => {
    const owners = data.scopes.filter(sc => sc.revises_id === null && sc.lifecycle_state !== 'retired' && sc.boundary_feature_id === featureId);
    return owners.length === 1 ? owners[0] : null;
  };

  // A map click (CanonicalPickTool): one candidate opens it; several open the chooser.
  // Never while a trace is being edited — the tool is idle then anyway.
  const handlePick = (r: PickRequest) => {
    if (editing) return;
    if (!r.ids.length) {
      setChooser(null);
      setNotice(`No canonical geometry at ${r.at.x.toFixed(1)}, ${r.at.z.toFixed(1)}.`);
    } else if (r.ids.length === 1) {
      const owner = owningScope(r.ids[0]);
      if (owner) openScope(owner.id);
      else inspectFeature(r.ids[0]);
    } else {
      setChooser(r);
    }
  };
  const handlePickRef = useRef(handlePick);
  useEffect(() => { handlePickRef.current = handlePick; });
  const handledPick = useRef(0);
  useEffect(() => pick.subscribe(() => {
    const r = pick.getState().request;
    if (!r || r.nonce === handledPick.current) return;
    handledPick.current = r.nonce;
    handlePickRef.current(r);
  }), [pick]);

  // Bring the inspector into view when a feature is chosen from the map.
  useEffect(() => {
    if (selectedId !== null) inspectorRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedId]);

  const requestClose = () => {
    if (editing && trace.vertices.length) { setConfirm({ kind: 'discard' }); return; }
    if (editing) endTracing();
    selection.update(s => (s.picking ? { ...s, picking: false } : s));
    onClose();
  };

  // ── scope context: spatial contents and the scene overlay ─────────────────

  const ctxScope = ctx?.scopeId != null ? data.scopes.find(sc => sc.id === ctx.scopeId) ?? null : null;
  const ctxScopeId = ctxScope?.id ?? null;
  const ctxScopeAccepted = ctxScope?.lifecycle_state === 'accepted';
  // Accepted scope: the WP3 query bundle, refetched whenever canonical data is.
  useEffect(() => {
    if (ctxScopeId === null || !ctxScopeAccepted) return;
    let live = true;
    void canonicalApi.query(token, { scope_id: ctxScopeId }).then((res) => {
      if (!live) return;
      let spatial: ScopeSpatial | null = null;
      let error = res.ok ? null : `Spatial contents unavailable: ${res.error.error}`;
      if (res.ok) {
        try { spatial = spatialFromBundle(res.data); } catch { error = 'Spatial contents unavailable: unexpected query response'; }
      }
      setScopeBundle({ scopeId: ctxScopeId, spatial: spatial ?? NO_SPATIAL, error });
    });
    return () => { live = false; };
  }, [token, ctxScopeId, ctxScopeAccepted, data]);

  const spatial: ScopeSpatial = useMemo(() => {
    if (!ctxScope) return NO_SPATIAL;
    if (ctxScope.lifecycle_state !== 'accepted') return spatialPreview(ctxScope, data.features);
    return scopeBundle?.scopeId === ctxScope.id ? scopeBundle.spatial : NO_SPATIAL;
  }, [ctxScope, data.features, scopeBundle]);
  const spatialLoading = !!ctxScope && ctxScopeAccepted && scopeBundle?.scopeId !== ctxScope.id;

  const overlay: ScopeOverlay | null = useMemo(() => (ctxScope && spatial.extent.length ? {
    scopeId: ctxScope.id, extent: spatial.extent, boundaryFeatureId: ctxScope.boundary_feature_id,
    inside: spatial.land.inside, crossing: spatial.land.crossing,
  } : null), [ctxScope, spatial]);
  useEffect(() => { pick.update(s => (s.scopeOverlay === overlay ? s : { ...s, scopeOverlay: overlay })); }, [pick, overlay]);

  const ctxFeature = ctx?.featureId != null ? allFeatures.find(f => f.id === ctx.featureId) ?? null : null;

  // ── render ───────────────────────────────────────────────────────────────

  return (
    <>
    {ctx && (ctxScope || ctxFeature) && (
      <ContextPane data={{ ...data, features: allFeatures }} scope={ctxScope} feature={ctxFeature} focus={ctx.focus}
        spatial={spatial} loading={spatialLoading} error={ctxScope && scopeBundle?.scopeId === ctxScope.id ? scopeBundle.error : null}
        onHover={(id) => pick.update(s => (s.hoverId === id ? s : { ...s, hoverId: id }))}
        onInspect={(id) => { pick.update(s => ({ ...s, hoverId: null })); inspectFeature(id); }}
        onBackToScope={() => setCtx(c => (c ? { ...c, focus: 'scope' } : c))}
        onOpenScope={openScope}
        onClose={() => { setCtx(null); pick.update(s => ({ ...s, hoverId: null })); }} />
    )}
    <div className="panel canonical-geography-manager" role="dialog" aria-label="Canonical geography"
      style={{ position: 'absolute', top: '80px', right: '20px', width: '360px', maxHeight: 'calc(100vh - 100px)', overflowY: 'auto',
        zIndex: 1500, padding: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>CANONICAL_GEOGRAPHY</h3>
        <button className="utility-btn" onClick={requestClose} aria-label="Close canonical geography">X</button>
      </div>

      <label style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px', fontSize: '0.75rem' }}>
        <input type="checkbox" checked={overlayVisible} onChange={onToggleOverlay} aria-label="Show canonical overlay" />
        SHOW_CANONICAL_OVERLAY
      </label>
      <label style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '4px', fontSize: '0.75rem' }}>
        <input type="checkbox" checked={pickState.inspecting} onChange={() => setInspecting(!pickState.inspecting)} aria-label="Select on map" />
        SELECT_ON_MAP <span style={{ fontSize: '0.6rem', opacity: 0.7 }}>(click canonical geometry to inspect it)</span>
      </label>
      {pickState.inspecting && !editing && !tracingActive && (
        <div style={{ fontSize: '0.62rem', color: '#ffcc55' }}>
          Map selection is paused (another view took the scene).{' '}
          <button className="utility-btn" style={smallBtn} onClick={() => onTracingChange(true)}>RESUME</button>
        </div>
      )}

      <table style={{ width: '100%', marginTop: '6px', fontSize: '0.7rem' }}>
        <thead><tr><th style={{ textAlign: 'left' }}></th><th>ACCEPTED</th><th>DRAFT</th><th>PROPOSED</th></tr></thead>
        <tbody>
          {([['FEATURES', data.features], ['ANCHORS', data.anchors], ['CONNECTIONS', data.connections], ['SCOPES', data.scopes]] as const)
            .map(([label, list]) => (
              <tr key={label} data-row={label}>
                <td>{label}</td>
                <td style={{ textAlign: 'center' }}>{counts(list, 'accepted')}</td>
                <td style={{ textAlign: 'center' }}>{data.includesWorkingSet ? counts(list, 'draft') : '—'}</td>
                <td style={{ textAlign: 'center' }}>{data.includesWorkingSet ? counts(list, 'proposed') : '—'}</td>
              </tr>
            ))}
        </tbody>
      </table>

      {notice && <div role="status" style={{ fontSize: '0.65rem', color: 'var(--green)', marginTop: '6px' }}>{notice}</div>}
      {error && (
        <div role="alert" style={{ fontSize: '0.65rem', color: '#ff7766', marginTop: '6px' }}>
          {error.error}
          {[...(error.violations ?? []), ...(error.dependents ?? [])].length > 0 && (
            <ul style={{ margin: '2px 0 0 14px', padding: 0 }}>
              {[...(error.violations ?? []), ...(error.dependents ?? [])].map((v, i) => <li key={i}>{describeIssue(v)}</li>)}
            </ul>
          )}
        </div>
      )}

      {chooser && !editing && (
        <div role="dialog" aria-label="Choose feature at point" style={{ border: '1px solid #ff4fd8', padding: '6px', marginTop: '8px', fontSize: '0.65rem' }}>
          <strong>{chooser.ids.length} CANONICAL FEATURES HERE — CHOOSE ONE</strong>
          <ul style={{ listStyle: 'none', padding: 0, margin: '2px 0 0' }}>
            {chooser.ids.map(id => {
              const f = allFeatures.find(x => x.id === id);
              const scopes = data.scopes.filter(sc => sc.boundary_feature_id === id);
              return (
                <li key={id}>
                  <button className="utility-btn" data-choice-id={id} style={{ ...smallBtn, width: '100%', textAlign: 'left' }}
                    onClick={() => { const owner = owningScope(id); if (owner) openScope(owner.id); else inspectFeature(id); }}>
                    {f ? featureLabel(f) : `#${id}`}{scopes.length ? ` · boundary of ${scopes.map(sc => sc.name ?? `#${sc.id}`).join(', ')}` : ''}
                  </button>
                </li>
              );
            })}
          </ul>
          <button className="utility-btn" style={smallBtn} onClick={() => setChooser(null)}>CANCEL</button>
        </div>
      )}

      {confirm && <ConfirmPanel confirm={confirm} busy={busy} features={allFeatures} trace={trace}
        onCancel={() => { setConfirm(null); setError(null); }}
        onToggleLockAfter={() => confirm.kind === 'accept' && setConfirm({ ...confirm, lockAfter: !confirm.lockAfter })}
        onConfirm={() => {
          if (confirm.kind === 'accept') void doAccept(confirm);
          else if (confirm.kind === 'retire') void retire(confirm.feature);
          else if (confirm.kind === 'delete') void deleteDraft(confirm.feature);
          else if (confirm.kind === 'replacement') void toggleReplacement(confirm.feature);
          else { endTracing(); onClose(); }
        }} />}

      {!editing && (
        <div role="tablist" aria-label="Canonical geography sections" style={{ display: 'flex', gap: '2px', marginTop: '8px' }}>
          {TABS.map(([t, label]) => (
            <button key={t} role="tab" aria-selected={tab === t} className="utility-btn"
              style={{ ...smallBtn, flex: 1, marginRight: 0, ...(tab === t ? { background: 'var(--dark-green)' } : {}) }}
              onClick={() => setTab(t)}>{label}</button>
          ))}
        </div>
      )}

      {editing ? (
        <TracingPanel
          editing={editing} trace={trace} session={session} tracingActive={tracingActive} busy={busy}
          anchors={data.anchors}
          issues={[...formIssues(editing.form), ...traceIssues]}
          referenceLayers={referenceLayers} evidenceLayer={evidenceLayer} evidenceLayerId={evidenceLayerId}
          onEvidenceLayer={setEvidenceLayerId} evidenceNote={evidenceNote} onEvidenceNote={setEvidenceNote}
          onForm={updateForm} onResume={() => onTracingChange(true)} onSave={saveDraft}
          onCancel={() => (trace.vertices.length ? setConfirm({ kind: 'discard' }) : endTracing())}
        />
      ) : tab === 'anchors' ? (
        <AnchorsPanel data={data} ops={ops} onAddPart={addPart} onInspectFeature={inspectFeature} />
      ) : tab === 'scopes' ? (
        <ScopesPanel data={data} ops={ops} selection={selection} onPicking={setPicking} onTraceBoundary={traceBoundary}
          onEditBoundary={editFeatureGeometry} onInspectFeature={inspectFeature}
          selectedId={scopeSelectedId} onSelect={selectScope}
          spatial={ctxScope && ctxScope.id === scopeSelectedId && spatial.source !== 'none' ? spatial : null} />
      ) : tab === 'connections' ? (
        <ConnectionsPanel data={data} ops={ops} selection={selection} />
      ) : (
        <>
          <div style={section}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong style={{ fontSize: '0.75rem' }}>FEATURES</strong>
              <button className="utility-btn" style={smallBtn} disabled={busy} onClick={() => startTracing(null, emptyForm())}>+ TRACE NEW FEATURE</button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', fontSize: '0.62rem', marginTop: '4px' }}>
              {(['accepted', 'draft', 'proposed'] as LifecycleState[]).map(s => (
                <label key={s}><input type="checkbox" aria-label={`Show ${s}`} checked={states[s]}
                  onChange={() => setStates(prev => ({ ...prev, [s]: !prev[s] }))} /> {s}</label>
              ))}
              <input aria-label="Search features" placeholder="name or #id" value={search} style={{ ...fieldStyle, width: '90px' }}
                onChange={e => setSearch(e.target.value)} />
              <select aria-label="Filter by class" value={classFilter} style={{ ...fieldStyle, width: 'auto' }}
                onChange={e => setClassFilter(e.target.value as FeatureClass | '')}>
                <option value="">all classes</option>
                {FEATURE_CLASSES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <ul aria-label="Feature list" style={{ listStyle: 'none', padding: 0, margin: '4px 0 0', maxHeight: '180px', overflowY: 'auto', fontSize: '0.65rem' }}>
              {visible.length === 0 && <li style={{ opacity: 0.6 }}>No features match.</li>}
              {visible.map(f => (
                <li key={f.id}>
                  <button className="utility-btn" data-feature-id={f.id} aria-pressed={f.id === selectedId}
                    style={{ width: '100%', textAlign: 'left', fontSize: '0.62rem', padding: '2px 4px', marginTop: '2px',
                      ...(f.id === selectedId ? { background: 'var(--dark-green)' } : {}) }}
                    onClick={() => select(f.id)}>
                    #{f.id} {f.name || '(unnamed)'} · {f.feature_class}{f.kind ? `/${f.kind}` : ''} · {STATE_LABEL[f.lifecycle_state]}
                    {f.lifecycle_state === 'accepted' ? ` · r${f.revision}` : ''}{f.revises_id ? ` · revises #${f.revises_id}` : ''}
                    {f.is_locked ? ' 🔒' : ''}
                  </button>
                </li>
              ))}
            </ul>
            <div style={{ fontSize: '0.58rem', opacity: 0.7 }}>{visible.length} shown · click canonical geometry on the map to open it here.</div>
          </div>

          <div style={section} aria-label="Archive">
            <button className="utility-btn" style={smallBtn} aria-expanded={showArchive}
              onClick={() => { if (!showArchive) void loadRetired(); setShowArchive(v => !v); }}>
              {showArchive ? 'HIDE' : 'SHOW'} RETIRED / ARCHIVE ({archived.length})
            </button>
            {showArchive && (
              <>
                <ul aria-label="Archive list" style={{ listStyle: 'none', padding: 0, margin: '4px 0 0', maxHeight: '140px', overflowY: 'auto', fontSize: '0.62rem' }}>
                  {archivedShown.length === 0 && <li style={{ opacity: 0.6 }}>No retired features match.</li>}
                  {archivedShown.map(f => (
                    <li key={f.id}>
                      <button className="utility-btn" data-feature-id={f.id} aria-pressed={f.id === selectedId}
                        style={{ width: '100%', textAlign: 'left', fontSize: '0.62rem', padding: '2px 4px', marginTop: '2px', opacity: 0.8,
                          ...(f.id === selectedId ? { background: 'var(--dark-green)' } : {}) }}
                        onClick={() => select(f.id)}>
                        #{f.id} {f.name || '(unnamed)'} · {f.feature_class} · RETIRED · r{f.revision}
                      </button>
                    </li>
                  ))}
                </ul>
                <div style={{ fontSize: '0.58rem', opacity: 0.7 }}>
                  Retired canon is kept for recovery and history, never deleted. Select one to restore it or see its revisions.
                </div>
              </>
            )}
          </div>

          {selected && (
            <div ref={inspectorRef}>
            <Inspector feature={selected} busy={busy} referenceLayers={referenceLayers} openRevisionId={openRevision?.id ?? null}
              history={history?.featureId === selected.id ? history.rows : null}
              descriptive={descriptive} onDescriptive={setDescriptive}
              onEdit={() => startTracing(selected, formFromFeature(selected))}
              onEditGeometry={() => editFeatureGeometry(selected)}
              onAccept={() => setConfirm({ kind: 'accept', feature: selected, lockAfter: false, violations: [], warnings: [] })}
              onDelete={() => setConfirm({ kind: 'delete', feature: selected })}
              onRevise={() => void revise(selected)}
              onRetire={() => setConfirm({ kind: 'retire', feature: selected })}
              onRestore={() => void restore(selected)}
              onLock={(v) => void setLock(selected, v)}
              onReplacement={() => setConfirm({ kind: 'replacement', feature: selected })}
              onSaveDescriptive={() => void saveDescriptive(selected)}
              onLoadHistory={() => void loadHistory(selected)}
              onDraftFromHistory={(rev) => void draftFromHistory(selected, rev)}
              onSelect={select}
              boundaryOf={data.scopes.filter(sc => sc.boundary_feature_id === (selected.revises_id ?? selected.id))}
              onOpenScope={openScope}
            />
            </div>
          )}
        </>
      )}

      <p style={{ fontSize: '0.6rem', opacity: 0.7, marginTop: '8px' }}>
        Solid = accepted canon. Dashed + DRAFT = editor draft. Magenta dashed + PROPOSED = software proposal awaiting review.
        Drafts and proposals are never generator input. Legacy saved maps are not a rollback for canonical geography.
      </p>
    </div>
    </>
  );
}

// ── tracing panel ──────────────────────────────────────────────────────────

function TracingPanel({
  editing, trace, session, tracingActive, busy, anchors, issues, referenceLayers, evidenceLayer, evidenceLayerId, onEvidenceLayer,
  evidenceNote, onEvidenceNote, onForm, onResume, onSave, onCancel,
}: {
  editing: Editing; trace: TraceState; session: TracingSession; tracingActive: boolean; busy: boolean; anchors: CanonicalAnchor[]; issues: string[];
  referenceLayers: ReferenceLayer[]; evidenceLayer: ReferenceLayer | null; evidenceLayerId: number | '';
  onEvidenceLayer: (id: number | '') => void; evidenceNote: string; onEvidenceNote: (v: string) => void;
  onForm: (changes: Partial<FeatureForm>) => void; onResume: () => void; onSave: () => void; onCancel: () => void;
}) {
  const { form, feature } = editing;
  const kinds = CLASS_KINDS[form.feature_class] ?? [];
  const geometryTypes = CLASS_GEOMETRY_TYPES[form.feature_class];
  const [tolerance, setTolerance] = useState('0.5');
  const act = (edit: (s: TraceState) => TraceState) => session.update(edit);

  return (
    <div style={section} aria-label="Tracing">
      <strong style={{ fontSize: '0.75rem' }}>
        {feature ? `EDITING ${feature.lifecycle_state.toUpperCase()} #${feature.id} (v${feature.draft_version})` : 'TRACING NEW DRAFT'}
      </strong>
      {!tracingActive && (
        <div style={{ fontSize: '0.62rem', color: '#ffcc55' }}>
          Tracing is paused (another tool took the scene). <button className="utility-btn" style={smallBtn} onClick={onResume}>RESUME TRACING</button>
        </div>
      )}

      <label style={labelStyle}>CLASS
        <select aria-label="Feature class" style={fieldStyle} value={form.feature_class}
          onChange={e => onForm({ feature_class: e.target.value as FeatureClass })}>
          {FEATURE_CLASSES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      {geometryTypes.length > 1 && (
        <label style={labelStyle}>GEOMETRY
          <select aria-label="Geometry type" style={fieldStyle} value={form.geometry_type}
            onChange={e => onForm({ geometry_type: e.target.value as GeometryType })}>
            {geometryTypes.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
      )}
      {kinds.length > 0 && (
        <label style={labelStyle}>KIND (optional)
          <select aria-label="Kind" style={fieldStyle} value={form.kind} onChange={e => onForm({ kind: e.target.value })}>
            <option value="">unspecified</option>
            {kinds.map(k => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
      )}
      <label style={labelStyle}>CONSTRAINT STRENGTH
        <select aria-label="Constraint strength" style={fieldStyle} value={form.constraint_strength}
          onChange={e => onForm({ constraint_strength: e.target.value as 'hard' | 'soft' })}>
          <option value="hard">hard — geometry preserved closely</option>
          <option value="soft">soft — existence/role/approximate extent</option>
        </select>
      </label>
      {form.feature_class === 'water' && (
        <label style={labelStyle}>NAVIGABLE (optional)
          <select aria-label="Navigable" style={fieldStyle} value={form.navigable} onChange={e => onForm({ navigable: e.target.value })}>
            <option value="">unspecified</option><option value="yes">yes</option><option value="no">no</option><option value="unknown">unknown</option>
          </select>
        </label>
      )}
      {form.feature_class === 'route' && (
        <label style={labelStyle}>WIDTH, world units (optional)
          <input aria-label="Width" style={fieldStyle} value={form.width_wu} onChange={e => onForm({ width_wu: e.target.value })} />
        </label>
      )}
      <label style={labelStyle}>ANCHOR PART (optional: makes this feature a part of an anchor)
        <select aria-label="Part of anchor" style={fieldStyle} value={form.anchor_id}
          onChange={e => onForm(e.target.value === '' ? { anchor_id: '', part_role: '' } : { anchor_id: Number(e.target.value), part_role: form.part_role || 'footprint' })}>
          <option value="">not an anchor part</option>
          {anchors.filter(a => a.revises_id === null && a.lifecycle_state !== 'retired').map(a => (
            <option key={a.id} value={a.id}>#{a.id} {a.name} ({a.anchor_key}){a.lifecycle_state === 'accepted' ? '' : ` [${a.lifecycle_state.toUpperCase()}]`}</option>
          ))}
        </select>
      </label>
      {form.anchor_id !== '' && (
        <label style={labelStyle}>PART ROLE
          <select aria-label="Part role" style={fieldStyle} value={form.part_role} onChange={e => onForm({ part_role: e.target.value })}>
            {PART_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
      )}
      {editing.boundaryFor && (
        <div style={{ fontSize: '0.62rem', color: '#00e5ff' }}>
          Boundary for {scopeLabel(editing.boundaryFor)}: on save it is linked to that scope&apos;s draft. Accept the boundary, then the scope.
        </div>
      )}
      <label style={labelStyle}>NAME (optional)
        <input aria-label="Name" style={fieldStyle} value={form.name} onChange={e => onForm({ name: e.target.value })} />
      </label>
      <label style={labelStyle}>NOTES (optional)
        <textarea aria-label="Notes" style={{ ...fieldStyle, height: '32px' }} value={form.notes} onChange={e => onForm({ notes: e.target.value })} />
      </label>

      <label style={labelStyle}>EVIDENCE LAYER (recorded with a calibration snapshot on save)
        <select aria-label="Evidence layer" style={fieldStyle} value={evidenceLayerId}
          onChange={e => onEvidenceLayer(e.target.value === '' ? '' : Number(e.target.value))}>
          <option value="">{feature ? 'none — keep saved evidence' : 'none'}</option>
          {referenceLayers.map(l => <option key={l.id} value={l.id}>#{l.id} {l.name}{l.is_visible ? '' : ' (hidden)'}</option>)}
        </select>
      </label>
      {evidenceLayer && (
        <label style={labelStyle}>EVIDENCE NOTE (optional)
          <input aria-label="Evidence note" style={fieldStyle} value={evidenceNote} onChange={e => onEvidenceNote(e.target.value)} />
        </label>
      )}

      <div style={{ marginTop: '6px' }}>
        {(Object.keys(MODE_LABEL) as TraceMode[]).map(m => (
          <button key={m} className="utility-btn" aria-pressed={trace.mode === m}
            disabled={m !== 'vertex' && trace.geometryType !== 'polygon'}
            style={{ ...smallBtn, ...(trace.mode === m ? { background: 'var(--dark-green)' } : {}) }}
            onClick={() => act(s => setMode(s, m))}>{MODE_LABEL[m]}</button>
        ))}
      </div>
      <div style={{ fontSize: '0.6rem', opacity: 0.8 }}>
        {MODE_HINT[trace.mode]}
        {trace.mode !== 'vertex' && ` (${trace.constructionPoints.length}/${CONSTRUCTOR_CLICKS[trace.mode]})`}
      </div>
      <div>
        <button className="utility-btn" style={smallBtn} onClick={() => act(undoLast)}>UNDO</button>
        {trace.geometryType !== 'point' && <button className="utility-btn" style={smallBtn} disabled={trace.closed} onClick={() => act(closeRing)}>CLOSE</button>}
        <button className="utility-btn" style={smallBtn} disabled={trace.selectedVertex === null}
          onClick={() => act(s => (s.selectedVertex === null ? s : deleteVertex(s, s.selectedVertex)))}>DELETE VERTEX</button>
        <label style={{ fontSize: '0.62rem', marginLeft: '4px' }}>
          <input type="checkbox" aria-label="Snap" checked={trace.snapping} onChange={() => act(s => ({ ...s, snapping: !s.snapping }))} /> SNAP
        </label>
      </div>
      {trace.geometryType !== 'point' && (
        <div style={{ fontSize: '0.62rem', marginTop: '3px' }}>
          SIMPLIFY tolerance (m):{' '}
          <input aria-label="Simplify tolerance (m)" style={{ ...fieldStyle, width: '50px', display: 'inline-block' }} value={tolerance}
            onChange={e => setTolerance(e.target.value)} />
          <button className="utility-btn" style={smallBtn} disabled={!(Number(tolerance) > 0) || trace.vertices.length < 3}
            onClick={() => act(s => simplifyTrace(s, Number(tolerance)))}>SIMPLIFY</button>
        </div>
      )}
      {trace.message && <div style={{ fontSize: '0.62rem', color: '#ffcc55' }}>{trace.message}</div>}
      {trace.construction && (
        <div style={{ fontSize: '0.62rem' }}>Construction: {describeConstruction(trace.construction)} (saved as construction_json)</div>
      )}

      <TraceReadout trace={trace} evidenceLayer={evidenceLayer} />

      {issues.length > 0 && (
        <ul aria-label="Draft issues" style={{ fontSize: '0.62rem', color: '#ffcc55', margin: '4px 0 0 14px', padding: 0 }}>
          {issues.map(i => <li key={i}>{i}</li>)}
        </ul>
      )}
      <div style={{ marginTop: '6px' }}>
        <button className="utility-btn" style={smallBtn} disabled={busy || issues.length > 0} onClick={onSave}>SAVE DRAFT</button>
        <button className="utility-btn" style={smallBtn} disabled={busy} onClick={onCancel}>CANCEL</button>
      </div>
      <div style={{ fontSize: '0.58rem', opacity: 0.7 }}>Saving creates or updates a draft. Nothing becomes canon until you accept it.</div>
    </div>
  );
}

function describeConstruction(c: Construction): string {
  const m = (wu: number) => formatLength(wu);
  if (c.type === 'circle') return `circle, centre (${c.center.x}, ${c.center.z}), radius ${m(c.radius)}, ${c.segments} segments`;
  if (c.type === 'ellipse') return `ellipse, centre (${c.center.x}, ${c.center.z}), semi-axes ${m(c.radius_x)} × ${m(c.radius_z)}, ${c.segments} segments`;
  return `rectangle ${m(c.width)} × ${m(c.height)}, centre (${c.center.x}, ${c.center.z})`;
}

const fmt = (n: number, d = 2) => n.toFixed(d);

/** World X/Z, metres and evidence source pixels under the cursor; segment length, area. */
export function TraceReadout({ trace, evidenceLayer }: { trace: TraceState; evidenceLayer: ReferenceLayer | null }) {
  const { hover, vertices, closed, geometryType } = trace;
  const n = vertices.length;
  const last = n ? vertices[n - 1] : null;
  const lastSegment = n >= 2 ? [vertices[n - 2], vertices[n - 1]] as const : null;
  const uv = (p: WorldXZ) => {
    if (!evidenceLayer) return null;
    const s = sourcePixelReadout(evidenceLayer, p);
    return `${fmt(s.u, 1)}, ${fmt(s.v, 1)} px`;
  };
  const pxLength = (a: WorldXZ, b: WorldXZ) => {
    if (!evidenceLayer) return '';
    const sa = sourcePixelReadout(evidenceLayer, a);
    const sb = sourcePixelReadout(evidenceLayer, b);
    return ` · ${fmt(Math.hypot(sb.u - sa.u, sb.v - sa.v), 1)} px`;
  };
  return (
    <div aria-label="Tracing readout" style={{ ...kv, marginTop: '5px', border: '1px solid var(--dark-green)', padding: '3px' }}>
      <span>CURSOR X/Z</span>
      <span data-readout="world">{hover ? `${fmt(hover.x, 3)}, ${fmt(hover.z, 3)} wu` : '—'}{trace.hoverSnap ? ` (snap: ${trace.hoverSnap})` : ''}</span>
      <span>CURSOR (m)</span>
      <span data-readout="metres">{hover ? `${fmt(worldUnitsToMeters(hover.x))}, ${fmt(worldUnitsToMeters(hover.z))} m` : '—'}</span>
      <span>SOURCE u/v</span>
      <span data-readout="source">{evidenceLayer ? (hover ? uv(hover) : '—') : 'choose an evidence layer'}</span>
      <span>VERTICES</span><span data-readout="vertices">{n}{closed ? ' (closed)' : ''}</span>
      {lastSegment && <><span>LAST SEGMENT</span>
        <span data-readout="last-segment">{formatLength(distance(lastSegment[0], lastSegment[1]))}{pxLength(lastSegment[0], lastSegment[1])}</span></>}
      {last && hover && !closed && geometryType !== 'point' && <><span>CURSOR → LAST</span>
        <span data-readout="cursor-segment">{formatLength(distance(last, hover))}{pxLength(last, hover)}</span></>}
      {geometryType === 'polygon' && n >= 3 && <><span>AREA</span>
        <span data-readout="area">{formatArea(polygonArea(vertices, trace.holes))} ({fmt(squareWorldUnitsToHectares(polygonArea(vertices, trace.holes)), 4)} ha)</span></>}
      {geometryType === 'polygon' && n >= 2 && <><span>PERIMETER</span><span data-readout="perimeter">{formatLength(ringPerimeter(vertices))}</span></>}
      {geometryType === 'linestring' && n >= 2 && <><span>LENGTH</span>
        <span data-readout="length">{formatLength(lineLength(closed ? [...vertices, vertices[0]] : vertices))}</span></>}
    </div>
  );
}

// ── inspector ──────────────────────────────────────────────────────────────

function Row({ k, children }: { k: string; children: ReactNode }) {
  return <><span style={{ opacity: 0.75 }}>{k}</span><span>{children}</span></>;
}

function Inspector({
  feature: f, busy, referenceLayers, openRevisionId, history, descriptive, onDescriptive, onEdit, onAccept, onDelete, onRevise,
  onRetire, onRestore, onLock, onReplacement, onSaveDescriptive, onLoadHistory, onDraftFromHistory, onSelect, boundaryOf = [], onOpenScope,
  onEditGeometry,
}: {
  feature: CanonicalFeature; busy: boolean; referenceLayers: ReferenceLayer[]; openRevisionId: number | null;
  history: CanonicalRevision[] | null;
  descriptive: { name: string; description: string; notes: string } | null;
  onDescriptive: (d: { name: string; description: string; notes: string } | null) => void;
  onEdit: () => void; onAccept: () => void; onDelete: () => void; onRevise: () => void; onRetire: () => void; onRestore: () => void;
  onLock: (locked: boolean) => void; onReplacement: () => void; onSaveDescriptive: () => void; onLoadHistory: () => void;
  onDraftFromHistory: (revision: number) => void; onSelect: (id: number) => void;
  /** Scopes using this feature as their boundary (a district boundary opens its scope). */
  boundaryOf?: GeoScope[]; onOpenScope?: (id: number) => void;
  /** Accepted: edit geometry through its draft revision (Revise), never in place. */
  onEditGeometry?: () => void;
}) {
  const a = featureActions(f, openRevisionId);
  const metrics = geometryMetrics(f.geometry_type, f.geometry);
  const ev = f.evidence as Record<string, unknown> | null;
  const evStatus = evidenceStatus(ev, referenceLayers);
  const open = isOpenState(f.lifecycle_state);

  return (
    <div style={section} aria-label="Feature inspector">
      <strong style={{ fontSize: '0.75rem' }}>#{f.id} {f.name || '(unnamed)'} {f.is_locked ? '🔒' : ''}</strong>
      <div style={kv}>
        <Row k="STATE">{STATE_LABEL[f.lifecycle_state]}</Row>
        <Row k="CLASS / KIND">{f.feature_class}{f.kind ? ` / ${f.kind}` : ' / unspecified'}</Row>
        <Row k="GEOMETRY">{f.geometry_type}, {metrics.vertexCount} vertices</Row>
        {metrics.areaWu2 !== null && <Row k="AREA">{formatArea(metrics.areaWu2)}</Row>}
        {metrics.lengthWu !== null && <Row k={f.geometry_type === 'polygon' ? 'PERIMETER' : 'LENGTH'}>{formatLength(metrics.lengthWu)}</Row>}
        <Row k="STRENGTH">{f.constraint_strength}</Row>
        <Row k="PROVENANCE">{f.provenance}</Row>
        <Row k="REPLACEMENT">{f.replacement_state}</Row>
        <Row k="LOCK">{f.is_locked ? 'locked' : 'unlocked'}</Row>
        <Row k="REVISION">{f.revision}{open ? ` · draft v${f.draft_version}` : ''}</Row>
        {f.revises_id && <Row k="REVISES">#{f.revises_id} (built on r{f.base_revision ?? '?'})</Row>}
        {f.attributes && <Row k="ATTRIBUTES">{JSON.stringify(f.attributes)}</Row>}
        {f.construction && <Row k="CONSTRUCTION">{describeConstruction(f.construction as unknown as Construction)}</Row>}
        {boundaryOf.length > 0 && <Row k="BOUNDARY OF">{boundaryOf.map(sc => (
          <button key={sc.id} className="utility-btn" style={{ ...smallBtn, marginTop: 0 }} onClick={() => onOpenScope?.(sc.id)}>
            OPEN {scopeLabel(sc)}{sc.lifecycle_state === 'accepted' ? '' : ` [${sc.lifecycle_state.toUpperCase()}]`}
          </button>))}</Row>}
        {f.anchor_id && <Row k="ANCHOR PART">anchor #{f.anchor_id}{f.part_role ? ` · ${f.part_role}` : ''}</Row>}
        <Row k="EVIDENCE">
          {evStatus === 'none' ? 'none recorded' : `layer #${String(ev?.reference_layer_id)}`}
          {evStatus === 'differs' && <em> — the layer's calibration has changed since this was traced (informational)</em>}
          {evStatus === 'layer_missing' && <em> — layer no longer exists (historical note)</em>}
          {typeof ev?.note === 'string' && ` · ${ev.note}`}
        </Row>
        {f.proposal && <Row k="PROPOSAL">{JSON.stringify(f.proposal)}</Row>}
      </div>
      {openRevisionId !== null && (
        <div style={{ fontSize: '0.62rem' }}>Open draft revision: <button className="utility-btn" style={smallBtn} onClick={() => onSelect(openRevisionId)}>#{openRevisionId}</button></div>
      )}

      <div style={{ marginTop: '4px' }}>
        {open && <>
          <ActionButton label="EDIT DRAFT" availability={a.editGeometry} busy={busy} onClick={onEdit} />
          <ActionButton label="ACCEPT…" availability={a.accept} busy={busy} onClick={onAccept} />
          <ActionButton label="DELETE…" availability={a.deleteDraft} busy={busy} onClick={onDelete} danger />
        </>}
        {f.lifecycle_state === 'accepted' && <>
          <ActionButton label="REVISE" availability={a.revise} busy={busy} onClick={onRevise} />
          {onEditGeometry && <ActionButton label="EDIT GEOMETRY (REVISE)" busy={busy} onClick={onEditGeometry}
            availability={f.is_locked ? { enabled: false, reason: 'locked — unlock it first (its own request)' } : { enabled: true }} />}
          <ActionButton label="EDIT NAME/NOTES" availability={a.editDescriptive} busy={busy}
            onClick={() => onDescriptive({ name: f.name ?? '', description: f.description ?? '', notes: f.notes ?? '' })} />
          {f.is_locked
            ? <ActionButton label="UNLOCK" availability={a.unlock} busy={busy} onClick={() => onLock(false)} />
            : <ActionButton label="LOCK" availability={a.lock} busy={busy} onClick={() => onLock(true)} />}
          <ActionButton label={f.replacement_state === 'replaceable' ? 'MAKE NON-REPLACEABLE…' : 'MAKE REPLACEABLE…'}
            availability={a.replacement} busy={busy} onClick={onReplacement} />
          <ActionButton label="RETIRE…" availability={a.retire} busy={busy} onClick={onRetire} danger />
        </>}
        {f.lifecycle_state === 'retired' && <ActionButton label="RESTORE" availability={a.restore} busy={busy} onClick={onRestore} />}
        {(f.lifecycle_state === 'accepted' || f.lifecycle_state === 'retired') && (
          <button className="utility-btn" style={smallBtn} disabled={busy} onClick={onLoadHistory}>HISTORY</button>
        )}
      </div>

      {descriptive && (
        <div style={{ marginTop: '4px' }} aria-label="Descriptive edit">
          <label style={labelStyle}>NAME<input aria-label="Descriptive name" style={fieldStyle} value={descriptive.name}
            onChange={e => onDescriptive({ ...descriptive, name: e.target.value })} /></label>
          <label style={labelStyle}>DESCRIPTION<input aria-label="Descriptive description" style={fieldStyle} value={descriptive.description}
            onChange={e => onDescriptive({ ...descriptive, description: e.target.value })} /></label>
          <label style={labelStyle}>NOTES<input aria-label="Descriptive notes" style={fieldStyle} value={descriptive.notes}
            onChange={e => onDescriptive({ ...descriptive, notes: e.target.value })} /></label>
          <button className="utility-btn" style={smallBtn} disabled={busy} onClick={onSaveDescriptive}>SAVE NAME/NOTES</button>
          <button className="utility-btn" style={smallBtn} onClick={() => onDescriptive(null)}>CANCEL</button>
          <div style={{ fontSize: '0.58rem', opacity: 0.7 }}>Descriptive only: recorded in history, revision unchanged.</div>
        </div>
      )}

      {history && (
        <div style={{ marginTop: '4px' }} aria-label="Revision history">
          <strong style={{ fontSize: '0.65rem' }}>HISTORY</strong>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '0.62rem' }}>
            {history.length === 0 && <li>No history.</li>}
            {history.map(h => (
              <li key={h.id}>
                r{h.revision} · {h.change_kind} · {h.created_at}
                {h.change_kind === 'accept' && (
                  <ActionButton label={`DRAFT FROM r${h.revision}`} availability={a.draftFromHistory} busy={busy}
                    onClick={() => onDraftFromHistory(h.revision)} />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── confirmations ──────────────────────────────────────────────────────────

function ConfirmPanel({ confirm, busy, features, trace, onCancel, onConfirm, onToggleLockAfter }: {
  confirm: Confirm; busy: boolean; features: CanonicalFeature[]; trace: TraceState;
  onCancel: () => void; onConfirm: () => void; onToggleLockAfter: () => void;
}) {
  const frame: CSSProperties = { border: '1px solid #ffcc55', padding: '6px', marginTop: '8px', fontSize: '0.65rem' };
  if (confirm.kind === 'discard') {
    return (
      <div role="alertdialog" aria-label="Discard trace" style={frame}>
        Discard the unsaved trace ({trace.vertices.length} vertices)?
        <div><button className="utility-btn" style={smallBtn} onClick={onConfirm}>DISCARD</button>
          <button className="utility-btn" style={smallBtn} onClick={onCancel}>KEEP TRACING</button></div>
      </div>
    );
  }
  const f = confirm.feature;
  if (confirm.kind === 'accept') {
    const m = geometryMetrics(f.geometry_type, f.geometry);
    const target = f.revises_id ? features.find(x => x.id === f.revises_id) : null;
    const clientIssues = geometryIssues(f.geometry_type, pointsOf(f), {
      closed: f.geometry_type === 'polygon' || (f.geometry_type === 'linestring' && isClosedLine(f.geometry as WorldXZ[])),
      holes: f.geometry_type === 'polygon' ? ((f.geometry as { holes?: WorldXZ[][] }).holes ?? []) : [],
    });
    return (
      <div role="alertdialog" aria-label="Confirm accept" style={frame}>
        <strong>ACCEPT AS CANON?</strong>
        <div style={kv}>
          <Row k="RECORD">{f.lifecycle_state} #{f.id}, draft v{f.draft_version}</Row>
          <Row k="EFFECT">{target ? `replaces feature #${target.id} r${target.revision} → r${target.revision + 1} (same id)` : 'new canonical feature, revision 1'}</Row>
          <Row k="CLASS / KIND">{f.feature_class}{f.kind ? ` / ${f.kind}` : ''}</Row>
          <Row k="STRENGTH">{f.constraint_strength}</Row>
          <Row k="REPLACEMENT">{(target ?? f).replacement_state}</Row>
          <Row k="PROVENANCE">{f.provenance}</Row>
          <Row k="VERTICES">{m.vertexCount}</Row>
          {m.areaWu2 !== null && <Row k="AREA">{formatArea(m.areaWu2)}</Row>}
          {m.lengthWu !== null && <Row k={f.geometry_type === 'polygon' ? 'PERIMETER' : 'LENGTH'}>{formatLength(m.lengthWu)}</Row>}
          <Row k="SINGLE-RECORD CHECK">{clientIssues.length ? clientIssues.join('; ') : 'passes'}</Row>
          <Row k="CROSS-FEATURE CHECK">{confirm.violations.length ? `${confirm.violations.length} violation(s) — see below` : 'run by the server on accept; any violation is listed here'}</Row>
        </div>
        {confirm.violations.length > 0 && (
          <ul aria-label="Accept violations" style={{ color: '#ff7766', margin: '2px 0 0 14px', padding: 0 }}>
            {confirm.violations.map((v, i) => <li key={i}>{describeIssue(v)}</li>)}
          </ul>
        )}
        {confirm.warnings.length > 0 && (
          <ul aria-label="Accept warnings" style={{ color: '#ffcc55', margin: '2px 0 0 14px', padding: 0 }}>
            {confirm.warnings.map((v, i) => <li key={i}>{describeIssue(v)}</li>)}
          </ul>
        )}
        <label style={{ display: 'block', marginTop: '4px' }}>
          <input type="checkbox" aria-label="Lock after accepting" checked={confirm.lockAfter} onChange={onToggleLockAfter} />
          {' '}then lock it (a second, separate request)
        </label>
        <div>
          <button className="utility-btn" style={smallBtn} disabled={busy} onClick={onConfirm}>ACCEPT DRAFT v{f.draft_version}</button>
          <button className="utility-btn" style={smallBtn} disabled={busy} onClick={onCancel}>CANCEL</button>
        </div>
      </div>
    );
  }
  const text = confirm.kind === 'retire'
    ? `Retire feature #${f.id}? It leaves accepted canon (restorable) and is refused while accepted records depend on it.`
    : confirm.kind === 'delete'
      ? `Delete ${f.lifecycle_state} #${f.id}? Drafts and proposals are not canon and are removed permanently.`
      : `Change feature #${f.id} from ${f.replacement_state} to ${f.replacement_state === 'replaceable' ? 'non_replaceable' : 'replaceable'}?`
        + (f.replacement_state === 'replaceable' ? '' : ' This only records permission for a future explicit replace flow; nothing replaces it automatically now.');
  return (
    <div role="alertdialog" aria-label={`Confirm ${confirm.kind}`} style={frame}>
      {text}
      <div><button className="utility-btn" style={smallBtn} disabled={busy} onClick={onConfirm}>CONFIRM</button>
        <button className="utility-btn" style={smallBtn} disabled={busy} onClick={onCancel}>CANCEL</button></div>
    </div>
  );
}

const isClosedLine = (line: WorldXZ[]) =>
  Array.isArray(line) && line.length > 2 && line[0].x === line[line.length - 1].x && line[0].z === line[line.length - 1].z;

function pointsOf(f: CanonicalFeature): WorldXZ[] {
  if (f.geometry_type === 'point') return [f.geometry as WorldXZ];
  if (f.geometry_type === 'linestring') {
    const line = f.geometry as WorldXZ[];
    return isClosedLine(line) ? line.slice(0, -1) : line;
  }
  return (f.geometry as { outer: WorldXZ[] }).outer;
}
