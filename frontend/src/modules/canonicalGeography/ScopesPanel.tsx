import { useMemo, useState, useSyncExternalStore } from 'react';
import type { CanonicalGeographyData } from './api';
import { canonicalApi } from './api';
import type { CanonicalFeature, CanonicalPolygon, GeoScope, LandCoverage, ScopeKind } from './types';
import {
  COMPLETE_COVERAGE_CONSEQUENCE, EDITABLE_SCOPE_KINDS, SCOPE_KIND_LABEL, ancestryOf, boundaryCandidates, childrenOf,
  emptyScopeForm, findScope, isRegionKind, isScopeIdentity, landMembership, membersAfter, membershipChange, openScopeRevision, parentOptions,
  sameKindHolders, scopeBody, scopeFormFrom, scopeFormIssues, scopeLabel, scopeRoots, slugify, type ScopeForm,
} from './scopes';
import {
  clearSelection, landInsideBoundary, selectableLand, setSelection, type LandSelectionStore,
} from './landSelection';
import { featureActions } from './featureEditing';
import { stageScopeChange, type ScopeChange } from './scopeRequests';
import type { ScopeSpatial } from './scopeContents';
import { formatArea } from './physicalScale';
import { polygonArea } from './geometry';
import { AcceptDialog, ArchiveSection, IssueList, LifecycleControls, Row, type PanelOps } from './panelUi';
import { STATE_LABEL, confirmFrame, fieldStyle, kv, labelStyle, listStyle, section, smallBtn } from './panelStyles';

/**
 * Scopes (plan §3.5, WP6): the city → district → island group → subregion hierarchy, each
 * scope's boundary, its explicit land membership, and its land-coverage flag.
 *
 * Districts (and subregions) are drawn spatial regions. Many islands are split between
 * districts, often by district walls, so the primary district workflow is the boundary:
 * create the district draft → TRACE DISTRICT BOUNDARY (the WP5 tool; the saved draft is
 * linked to the district draft or draft revision) → accept the boundary → accept the
 * district. The boundary may cross land; no island has to be a member, and nothing turns
 * containment into membership. Island groups are sets of whole islands, so for them
 * explicit membership stays the main tool; for districts it is optional.
 *
 * Membership is explicit and persisted. The workflow makes that quick rather than implicit:
 * select islands on the map (click, or shift-drag a box), then assign or remove them in one
 * operation. On an accepted scope that operation stages the change on a draft revision and
 * opens the accept confirmation — nothing becomes canon without it. "Select land inside
 * boundary" is a one-off proposal of a selection; it never ties membership to geometry.
 *
 * The server decides coherence (one district / island group per island, one ancestry chain,
 * parent rank). A refusal is shown as the server words it, and the selection and staged
 * draft are kept so nothing has to be redone.
 */

interface Props {
  data: CanonicalGeographyData;
  ops: PanelOps;
  selection: LandSelectionStore;
  /** Turn map picking on/off (the manager puts the scene in the canonical view). */
  onPicking: (on: boolean) => void;
  /** Trace a new scope_boundary with the WP5 tool; the manager links it to the scope on save. */
  onTraceBoundary: (scope: GeoScope) => void;
  /** Edit an existing boundary's geometry with the WP5 tool (via a draft revision when accepted). */
  onEditBoundary: (feature: CanonicalFeature) => void;
  /** Show a feature in the feature inspector (e.g. a boundary to accept). */
  onInspectFeature: (id: number) => void;
  /** The selected scope, held by the manager so a map-clicked boundary can open its scope. */
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  /** The selected scope's derived spatial contents (query bundle or draft preview), if known. */
  spatial?: ScopeSpatial | null;
}

type Staged = { draft: GeoScope; canonical: GeoScope | null; note: string };

export function ScopesPanel({
  data, ops, selection, onPicking, onTraceBoundary, onEditBoundary, onInspectFeature, selectedId, onSelect: setSelectedId, spatial = null,
}: Props) {
  const [clearConfirm, setClearConfirm] = useState<GeoScope | null>(null);
  const sel = useSyncExternalStore(selection.subscribe, selection.getState);
  const [form, setForm] = useState<{ editing: GeoScope | null; form: ScopeForm } | null>(null);
  const [coverageConfirm, setCoverageConfirm] = useState<{ scope: GeoScope; to: LandCoverage; inForm: boolean } | null>(null);
  const [staged, setStaged] = useState<Staged | null>(null);
  const [targetId, setTargetId] = useState<number | ''>('');

  const scopes = data.scopes;
  const land = useMemo(() => selectableLand(data.features), [data.features]);
  const landById = useMemo(() => new Map(data.features.map(f => [f.id, f])), [data.features]);
  const selected = findScope(scopes, selectedId);
  const assignable = scopes.filter(s => isScopeIdentity(s) && s.scope_kind !== 'city' && (s.lifecycle_state === 'accepted' || s.lifecycle_state === 'draft'));
  const target = findScope(scopes, targetId === '' ? null : targetId);

  const landName = (id: number) => {
    const f = landById.get(id);
    return f ? `#${id} ${f.name || '(unnamed island)'}` : `#${id} (not accepted land)`;
  };

  // ── staging membership / boundary / coverage ─────────────────────────────

  const stage = (scope: GeoScope, changes: ScopeChange, what: string) => void ops.run(
    () => stageScopeChange(ops.token, scopes, scope, changes),
    ({ draft, revisionCreated }) => {
      if (scope.lifecycle_state === 'accepted') {
        setStaged({ draft, canonical: scope, note: what });
        ops.notify(`${what} staged on draft revision #${draft.id}${revisionCreated ? ' (created)' : ''} of ${scopeLabel(scope)}. Review and accept to make it canon.`);
      } else {
        ops.notify(`${what} saved to ${draft.lifecycle_state} ${scopeLabel(draft)} (v${draft.draft_version}). It is not canon until the scope is accepted.`);
      }
    });

  /** The membership list a change should start from: an open revision's, else the scope's own. */
  const currentMembers = (scope: GeoScope) =>
    (scope.lifecycle_state === 'accepted' ? openScopeRevision(scopes, scope.id)?.members ?? scope.members : scope.members);

  const assign = (scope: GeoScope, ids: number[]) =>
    stage(scope, { members: membersAfter(currentMembers(scope), ids) }, `Assigning ${ids.length} island(s)`);
  const unassign = (scope: GeoScope, ids: number[]) =>
    stage(scope, { members: membersAfter(currentMembers(scope), [], ids) }, `Removing ${ids.length} island(s)`);

  const proposeInside = (scope: GeoScope) => {
    const boundary = scope.boundary_feature_id ? landById.get(scope.boundary_feature_id) : null;
    if (!boundary || boundary.geometry_type !== 'polygon') {
      selection.update(s => ({ ...s, message: 'This scope has no loaded boundary polygon to test against.' }));
      return;
    }
    const { inside, straddling } = landInsideBoundary(land, boundary.geometry as CanonicalPolygon, boundary.bbox);
    selection.update(s => ({ ...s, proposal: { scopeId: scope.id, boundaryFeatureId: boundary.id, inside, straddling }, message: null }));
  };

  // ── form ─────────────────────────────────────────────────────────────────

  const saveForm = () => {
    if (!form) return;
    const issues = scopeFormIssues(form.form);
    if (issues.length) return;
    const existing = form.editing;
    void ops.run(
      () => (existing
        ? canonicalApi.patch<GeoScope>(ops.token, 'scopes', existing.id, { ...scopeBody(form.form), expected_draft_version: existing.draft_version })
        : canonicalApi.create<GeoScope>(ops.token, 'scopes', scopeBody(form.form, []))),
      (saved) => {
        setForm(null);
        setSelectedId(saved.id);
        ops.notify(`Saved ${saved.lifecycle_state.toUpperCase()} ${scopeLabel(saved)} (v${saved.draft_version}). It is not canon until accepted.`
          + (!existing && isRegionKind(saved.scope_kind) ? ` Next: TRACE ${saved.scope_kind.toUpperCase()} BOUNDARY in its inspector.` : ''));
      });
  };

  const onCoverageChoice = (to: LandCoverage) => {
    if (!form) return;
    if (to === 'complete' && form.form.land_coverage !== 'complete') {
      setCoverageConfirm({ scope: form.editing ?? ({ id: 0, name: form.form.name, scope_kind: form.form.scope_kind } as GeoScope), to, inForm: true });
      return;
    }
    setForm({ ...form, form: { ...form.form, land_coverage: to } });
  };

  // ── render ───────────────────────────────────────────────────────────────

  const proposal = sel.proposal;
  const proposalScope = proposal ? findScope(scopes, proposal.scopeId) : null;

  return (
    <div aria-label="Scopes">
      {/* ── land selection: the one multi-select of islands ─────────────────── */}
      <div style={section} aria-label="Land selection">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong style={{ fontSize: '0.75rem' }}>LAND SELECTION · {sel.ids.length}</strong>
          <span>
            <button className="utility-btn" style={{ ...smallBtn, ...(sel.picking ? { background: 'var(--dark-green)' } : {}) }}
              aria-pressed={sel.picking} onClick={() => onPicking(!sel.picking)}>{sel.picking ? 'PICKING ON MAP' : 'PICK ON MAP'}</button>
            <button className="utility-btn" style={smallBtn} disabled={!sel.ids.length && !proposal} onClick={() => selection.update(clearSelection)}>CLEAR</button>
          </span>
        </div>
        <div style={{ fontSize: '0.6rem', opacity: 0.8 }}>
          Every accepted land polygon is an island — no separate declaration. {sel.picking
            ? 'Click an island to toggle it; Shift-drag a box to add every island wholly inside it. Plain left-drag still pans.'
            : 'Turn on PICK ON MAP to select islands in the scene.'}
        </div>
        {sel.message && <div style={{ fontSize: '0.62rem', color: '#ffcc55' }}>{sel.message}</div>}
        {sel.ids.length > 0 && (
          <ul aria-label="Selected land" style={listStyle}>
            {sel.ids.map(id => {
              const m = landMembership(scopes, id);
              return (
                <li key={id} data-land-id={id}>
                  {landName(id)} — district: {m.byKind.district ? scopeLabel(m.byKind.district) : 'none'}
                  {' · '}island group: {m.byKind.island_group ? scopeLabel(m.byKind.island_group) : 'none'}
                  {m.chain.length > 0 && <span style={{ opacity: 0.7 }}> · {m.chain.map(s => s.name ?? `#${s.id}`).join(' → ')}</span>}
                  {m.pending.length > 0 && <span style={{ color: '#ffcc55' }}> · pending in {m.pending.map(s => `#${s.id}`).join(', ')}</span>}
                </li>
              );
            })}
          </ul>
        )}
        <label style={labelStyle}>TARGET SCOPE
          <select aria-label="Target scope" style={fieldStyle} value={targetId}
            onChange={e => setTargetId(e.target.value === '' ? '' : Number(e.target.value))}>
            <option value="">choose a district / island group / subregion</option>
            {assignable.map(s => <option key={s.id} value={s.id}>{scopeLabel(s)}{s.lifecycle_state === 'accepted' ? '' : ` [${s.lifecycle_state.toUpperCase()}]`}</option>)}
          </select>
        </label>
        {target && sel.ids.length > 0 && (
          <IssueList label="Membership notes" items={sameKindHolders(scopes, target, sel.ids.filter(id => !currentMembers(target).includes(id)))
            .map(h => `${landName(h.featureId)} already belongs to ${scopeLabel(h.holder)}; the server will refuse a second ${SCOPE_KIND_LABEL[target.scope_kind]} — remove it there first`)} />
        )}
        <div>
          <button className="utility-btn" style={smallBtn} disabled={ops.busy || !target || !sel.ids.length}
            onClick={() => target && assign(target, sel.ids)}>ASSIGN SELECTED → TARGET</button>
          <button className="utility-btn" style={smallBtn} disabled={ops.busy || !target || !sel.ids.some(id => target && currentMembers(target).includes(id))}
            onClick={() => target && unassign(target, sel.ids.filter(id => currentMembers(target).includes(id)))}>REMOVE SELECTED FROM TARGET</button>
        </div>
      </div>

      {proposal && (
        <div role="region" aria-label="Inside-boundary proposal" style={confirmFrame}>
          <strong>LAND INSIDE BOUNDARY #{proposal.boundaryFeatureId} of {scopeLabel(proposalScope)}</strong>
          <div>{proposal.inside.length} island(s) lie wholly inside (highlighted). {proposal.straddling.length} cross the boundary and are NOT included.</div>
          <div style={{ fontSize: '0.6rem', opacity: 0.8 }}>
            This is a one-off selection proposal. Assigning creates ordinary explicit memberships; moving the boundary later reassigns nothing.
          </div>
          {proposal.inside.length > 0 && <div style={{ fontSize: '0.62rem' }}>Inside: {proposal.inside.map(landName).join(', ')}</div>}
          {proposal.straddling.length > 0 && <div style={{ fontSize: '0.62rem', color: '#ffaa55' }}>Crossing: {proposal.straddling.map(landName).join(', ')}</div>}
          <button className="utility-btn" style={smallBtn} disabled={!proposal.inside.length}
            onClick={() => selection.update(s => ({ ...setSelection(s, proposal.inside), proposal: null }))}>USE AS SELECTION</button>
          <button className="utility-btn" style={smallBtn} disabled={ops.busy || !proposal.inside.length || !proposalScope}
            onClick={() => {
              if (!proposalScope) return;
              selection.update(s => ({ ...setSelection(s, proposal.inside), proposal: null }));
              assign(proposalScope, proposal.inside);
            }}>ASSIGN THESE {proposal.inside.length} TO {proposalScope?.name ?? 'SCOPE'}…</button>
          <button className="utility-btn" style={smallBtn} onClick={() => selection.update(s => ({ ...s, proposal: null }))}>DISCARD</button>
        </div>
      )}

      {staged && (
        <AcceptDialog entity="scopes" record={staged.draft} label="scope" ops={ops}
          summary={<ScopeAcceptSummary draft={staged.draft} canonical={staged.canonical} landName={landName} features={data.features} />}
          onCancel={() => { setStaged(null); ops.notify(`Staged change kept on draft revision #${staged.draft.id}; it is not canon until accepted.`); }}
          onAccepted={(canon) => { setStaged(null); setSelectedId(canon.id); ops.notify(`Accepted ${scopeLabel(canon)} at revision ${canon.revision}.`); }} />
      )}

      {clearConfirm && (
        <div role="alertdialog" aria-label="Confirm clear members" style={confirmFrame}>
          <strong>CLEAR ALL {currentMembers(clearConfirm).length} EXPLICIT WHOLE-ISLAND MEMBERS OF {scopeLabel(clearConfirm)}?</strong>
          <p style={{ margin: '4px 0' }}>
            This removes only the optional explicit memberships. The boundary, the spatial land it contains, and land coverage are unchanged.
            {clearConfirm.lifecycle_state === 'accepted' ? ' The change is staged on a draft revision and becomes canon only when you accept it.' : ''}
          </p>
          <button className="utility-btn" style={smallBtn} disabled={ops.busy} onClick={() => {
            const target = clearConfirm;
            setClearConfirm(null);
            stage(target, { members: [] }, `Clearing ${currentMembers(target).length} explicit member(s)`);
          }}>CLEAR MEMBERS</button>
          <button className="utility-btn" style={smallBtn} onClick={() => setClearConfirm(null)}>CANCEL</button>
        </div>
      )}

      {coverageConfirm && (
        <div role="alertdialog" aria-label="Confirm land coverage" style={confirmFrame}>
          <strong>MARK {coverageConfirm.scope.id ? scopeLabel(coverageConfirm.scope) : 'THIS SCOPE'} LAND COVERAGE {coverageConfirm.to.toUpperCase()}?</strong>
          <p style={{ margin: '4px 0' }}>{coverageConfirm.to === 'complete' ? COMPLETE_COVERAGE_CONSEQUENCE
            : 'Returning to PARTIAL makes untraced ground inside the extent UNKNOWN again (neither buildable nor water) for generator queries.'}</p>
          <button className="utility-btn" style={smallBtn} disabled={ops.busy} onClick={() => {
            const c = coverageConfirm;
            setCoverageConfirm(null);
            if (c.inForm) { if (form) setForm({ ...form, form: { ...form.form, land_coverage: c.to } }); return; }
            stage(c.scope, { land_coverage: c.to }, `Land coverage → ${c.to}`);
          }}>{coverageConfirm.to === 'complete' ? 'I UNDERSTAND — MARK COMPLETE' : 'MARK PARTIAL'}</button>
          <button className="utility-btn" style={smallBtn} onClick={() => setCoverageConfirm(null)}>CANCEL</button>
        </div>
      )}

      {/* ── hierarchy ─────────────────────────────────────────────────────── */}
      {form ? (
        <ScopeFormPanel form={form.form} editing={form.editing} scopes={scopes} features={data.features} busy={ops.busy}
          onChange={(f) => setForm({ ...form, form: f })} onCoverage={onCoverageChoice} onSave={saveForm} onCancel={() => setForm(null)} />
      ) : (
        <div style={section}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong style={{ fontSize: '0.75rem' }}>SCOPE HIERARCHY</strong>
            <button className="utility-btn" style={smallBtn} disabled={ops.busy}
              onClick={() => setForm({ editing: null, form: emptyScopeForm('district', scopes.find(s => s.scope_kind === 'city' && s.lifecycle_state === 'accepted')?.id ?? '') })}>+ NEW SCOPE</button>
          </div>
          <ul aria-label="Scope hierarchy" style={{ ...listStyle, maxHeight: '220px' }}>
            {scopeRoots(scopes).map(s => <ScopeNode key={s.id} scope={s} scopes={scopes} depth={0} selectedId={selectedId} onSelect={setSelectedId} />)}
          </ul>
        </div>
      )}

      {!form && (
        <ArchiveSection<GeoScope> entity="scopes" label="scope" ops={ops} refreshKey={data}
          describe={(sc) => `#${sc.id} ${sc.name ?? '(unnamed)'} (${SCOPE_KIND_LABEL[sc.scope_kind]}, ${sc.scope_key})`}
          details={(sc) => <>
            <Row k="KIND">{SCOPE_KIND_LABEL[sc.scope_kind]}</Row>
            <Row k="PARENT">{sc.parent_scope_id ? scopeLabel(findScope(scopes, sc.parent_scope_id)) : 'none'}</Row>
            <Row k="BOUNDARY">{sc.boundary_feature_id ? `#${sc.boundary_feature_id}` : 'none'}</Row>
            <Row k="EXPLICIT MEMBERS">{sc.members.length}</Row>
            <Row k="LAND COVERAGE">{sc.land_coverage}</Row>
          </>} />
      )}

      {selected && !form && (
        <ScopeInspector scope={selected} scopes={scopes} features={data.features} landName={landName} ops={ops} selectionIds={sel.ids}
          onSelect={setSelectedId}
          onEdit={() => setForm({ editing: selected, form: scopeFormFrom(selected) })}
          onSelectMembers={() => selection.update(s => setSelection(s, selected.members.filter(id => landById.get(id)?.lifecycle_state === 'accepted')))}
          onAssignSelection={() => assign(selected, sel.ids)}
          onRemoveSelection={() => unassign(selected, sel.ids.filter(id => currentMembers(selected).includes(id)))}
          onRemoveMember={(id) => unassign(selected, [id])}
          onProposeInside={() => proposeInside(selected)}
          onSetBoundary={(id) => stage(selected, { boundary_feature_id: id }, id === null ? 'Clearing the boundary' : `Boundary → feature #${id}`)}
          onTraceBoundary={() => onTraceBoundary(selected)}
          onEditBoundary={onEditBoundary}
          onInspectFeature={onInspectFeature}
          onCoverage={(to) => setCoverageConfirm({ scope: selected, to, inForm: false })}
          spatial={spatial}
          onClearMembers={() => setClearConfirm(selected)}
        />
      )}
    </div>
  );
}

function ScopeNode({ scope, scopes, depth, selectedId, onSelect }:
  { scope: GeoScope; scopes: GeoScope[]; depth: number; selectedId: number | null; onSelect: (id: number) => void }) {
  const kids = depth > 8 ? [] : childrenOf(scopes, scope.id);
  const rev = openScopeRevision(scopes, scope.id);
  return (
    <li>
      <button className="utility-btn" data-scope-id={scope.id} aria-pressed={scope.id === selectedId}
        style={{ width: '100%', textAlign: 'left', fontSize: '0.62rem', padding: '2px 4px', marginTop: '2px', paddingLeft: `${4 + depth * 12}px`,
          ...(scope.id === selectedId ? { background: 'var(--dark-green)' } : {}) }}
        onClick={() => onSelect(scope.id)}>
        {depth > 0 ? '└ ' : ''}{SCOPE_KIND_LABEL[scope.scope_kind].toUpperCase()} · {scope.name ?? '(unnamed)'} · {STATE_LABEL[scope.lifecycle_state]}
        {isRegionKind(scope.scope_kind)
          ? ` · ${scope.boundary_feature_id ? `boundary #${scope.boundary_feature_id}` : 'no boundary'}${scope.members.length ? ` · ${scope.members.length} explicit (optional)` : ''}`
          : ` · ${scope.members.length} island(s)`}
        {' · '}{scope.land_coverage}{scope.is_locked ? ' 🔒' : ''}{rev ? ` · draft rev #${rev.id}` : ''}
      </button>
      {kids.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {kids.map(k => <ScopeNode key={k.id} scope={k} scopes={scopes} depth={depth + 1} selectedId={selectedId} onSelect={onSelect} />)}
        </ul>
      )}
    </li>
  );
}

function ScopeAcceptSummary({ draft, canonical, landName, features }:
  { draft: GeoScope; canonical: GeoScope | null; landName: (id: number) => string; features: CanonicalFeature[] }) {
  const change = membershipChange(canonical?.members ?? [], draft.members);
  const boundary = draft.boundary_feature_id ? features.find(f => f.id === draft.boundary_feature_id) : null;
  return (
    <>
      <Row k="SCOPE">{SCOPE_KIND_LABEL[draft.scope_kind]} · {draft.name} ({draft.scope_key})</Row>
      <Row k="PARENT">{draft.parent_scope_id ? `#${draft.parent_scope_id}` : 'none'}</Row>
      <Row k="MEMBERS">{draft.members.length} island(s){canonical ? ` (was ${canonical.members.length})` : ''}</Row>
      {change.added.length > 0 && <Row k="ADDED">{change.added.map(landName).join(', ')}</Row>}
      {change.removed.length > 0 && <Row k="REMOVED">{change.removed.map(landName).join(', ')}</Row>}
      <Row k="BOUNDARY">{draft.boundary_feature_id
        ? `#${draft.boundary_feature_id}${boundary ? ` (${boundary.lifecycle_state})` : ''}${boundary && boundary.lifecycle_state !== 'accepted' ? ' — accept the boundary feature first' : ''}`
        : 'none'}</Row>
      <Row k="LAND COVERAGE">{draft.land_coverage}{canonical && canonical.land_coverage !== draft.land_coverage ? ` (was ${canonical.land_coverage})` : ''}
        {draft.land_coverage === 'complete' ? ' — non-land inside the extent becomes water by complement' : ''}</Row>
    </>
  );
}

function ScopeFormPanel({ form, editing, scopes, features, busy, onChange, onCoverage, onSave, onCancel }: {
  form: ScopeForm; editing: GeoScope | null; scopes: GeoScope[]; features: CanonicalFeature[]; busy: boolean;
  onChange: (f: ScopeForm) => void; onCoverage: (to: LandCoverage) => void; onSave: () => void; onCancel: () => void;
}) {
  const issues = scopeFormIssues(form);
  const parents = parentOptions(scopes, form.scope_kind, editing?.revises_id ?? editing?.id ?? null);
  const isRevision = !!editing?.revises_id;
  return (
    <div style={section} aria-label="Scope form">
      <strong style={{ fontSize: '0.75rem' }}>{editing ? `EDITING ${editing.lifecycle_state.toUpperCase()} SCOPE #${editing.id} (v${editing.draft_version})` : 'NEW SCOPE (DRAFT)'}</strong>
      <label style={labelStyle}>KIND
        <select aria-label="Scope kind" style={fieldStyle} value={form.scope_kind} disabled={isRevision && form.scope_kind === 'city'}
          onChange={e => onChange({ ...form, scope_kind: e.target.value as ScopeKind })}>
          {(form.scope_kind === 'city' ? ['city' as ScopeKind] : EDITABLE_SCOPE_KINDS).map(k => <option key={k} value={k}>{SCOPE_KIND_LABEL[k]}</option>)}
        </select>
      </label>
      <label style={labelStyle}>NAME
        <input aria-label="Scope name" style={fieldStyle} value={form.name}
          onChange={e => onChange({ ...form, name: e.target.value, scope_key: !editing && (form.scope_key === '' || form.scope_key === slugify(form.name)) ? slugify(e.target.value) : form.scope_key })} />
      </label>
      <label style={labelStyle}>KEY (stable slug{isRevision ? '; fixed for a revision' : ''})
        <input aria-label="Scope key" style={fieldStyle} value={form.scope_key} disabled={isRevision} onChange={e => onChange({ ...form, scope_key: e.target.value })} />
      </label>
      {form.scope_kind !== 'city' && (
        <label style={labelStyle}>PARENT SCOPE (must be accepted, and rank lower)
          <select aria-label="Parent scope" style={fieldStyle} value={form.parent_scope_id}
            onChange={e => onChange({ ...form, parent_scope_id: e.target.value === '' ? '' : Number(e.target.value) })}>
            <option value="">choose a parent</option>
            {parents.map(p => <option key={p.id} value={p.id}>{scopeLabel(p)}{p.lifecycle_state === 'accepted' ? '' : ` [${p.lifecycle_state.toUpperCase()}]`}</option>)}
          </select>
        </label>
      )}
      <label style={labelStyle}>BOUNDARY (optional scope_boundary polygon)
        <select aria-label="Boundary feature" style={fieldStyle} value={form.boundary_feature_id}
          onChange={e => onChange({ ...form, boundary_feature_id: e.target.value === '' ? '' : Number(e.target.value) })}>
          <option value="">none — extent is the member islands</option>
          {boundaryCandidates(features).map(f => <option key={f.id} value={f.id}>#{f.id} {f.name || 'boundary'} [{f.lifecycle_state.toUpperCase()}]</option>)}
        </select>
      </label>
      <label style={labelStyle}>LAND COVERAGE
        <select aria-label="Land coverage" style={fieldStyle} value={form.land_coverage} onChange={e => onCoverage(e.target.value as LandCoverage)}>
          <option value="partial">partial — untraced ground is unknown</option>
          <option value="complete">complete — non-land is water by complement (confirm)</option>
        </select>
      </label>
      <label style={labelStyle}>DESCRIPTION (optional)
        <input aria-label="Scope description" style={fieldStyle} value={form.description} onChange={e => onChange({ ...form, description: e.target.value })} />
      </label>
      <label style={labelStyle}>NOTES (optional)
        <textarea aria-label="Scope notes" style={{ ...fieldStyle, height: '32px' }} value={form.notes} onChange={e => onChange({ ...form, notes: e.target.value })} />
      </label>
      <IssueList label="Scope form issues" items={issues} />
      <div style={{ fontSize: '0.58rem', opacity: 0.7 }}>
        {isRegionKind(form.scope_kind)
          ? `A ${SCOPE_KIND_LABEL[form.scope_kind]} is a drawn region: after saving, trace its boundary from the inspector. The boundary may cut across islands; whole-island membership is optional. `
          : 'An island group is a set of whole islands: after saving, assign its islands from the land selection. '}
        Scopes hold hierarchy, boundary, explicit membership and coverage only — no culture, wealth, crop, profile, budget or density fields.
      </div>
      <button className="utility-btn" style={smallBtn} disabled={busy || issues.length > 0} onClick={onSave}>SAVE DRAFT</button>
      <button className="utility-btn" style={smallBtn} disabled={busy} onClick={onCancel}>CANCEL</button>
    </div>
  );
}

function ScopeInspector({
  scope: s, scopes, features, landName, ops, selectionIds, onSelect, onEdit, onSelectMembers, onAssignSelection, onRemoveSelection,
  onRemoveMember, onProposeInside, onSetBoundary, onTraceBoundary, onEditBoundary, onInspectFeature, onCoverage, spatial, onClearMembers,
}: {
  scope: GeoScope; scopes: GeoScope[]; features: CanonicalFeature[]; landName: (id: number) => string; ops: PanelOps; selectionIds: number[];
  onSelect: (id: number) => void; onEdit: () => void; onSelectMembers: () => void; onAssignSelection: () => void; onRemoveSelection: () => void;
  onRemoveMember: (id: number) => void; onProposeInside: () => void; onSetBoundary: (id: number | null) => void; onTraceBoundary: () => void;
  onEditBoundary: (feature: CanonicalFeature) => void; onInspectFeature: (id: number) => void; onCoverage: (to: LandCoverage) => void;
  spatial: ScopeSpatial | null; onClearMembers: () => void;
}) {
  const [boundaryChoice, setBoundaryChoice] = useState<number | ''>('');
  const parent = findScope(scopes, s.parent_scope_id);
  const children = childrenOf(scopes, s.revises_id ?? s.id);
  const chain = ancestryOf(scopes, s);
  const openRev = s.lifecycle_state === 'accepted' ? openScopeRevision(scopes, s.id) : null;
  const boundary = s.boundary_feature_id ? features.find(f => f.id === s.boundary_feature_id) ?? null : null;
  const actions = featureActions(s, openRev?.id ?? null);
  const editable = s.lifecycle_state !== 'retired' && !(s.lifecycle_state === 'accepted' && s.is_locked);
  const why = s.lifecycle_state === 'accepted' && s.is_locked ? 'locked — unlock it first (its own request)' : '';
  const isCity = s.scope_kind === 'city';
  const inSelection = selectionIds.filter(id => s.members.includes(id));
  const region = isRegionKind(s.scope_kind);
  const kindUpper = SCOPE_KIND_LABEL[s.scope_kind].toUpperCase();
  const boundaryAccepted = boundary?.lifecycle_state === 'accepted';
  const boundaryEditable = !!boundary && !(boundaryAccepted && boundary.is_locked);
  const steps: [string, boolean][] = [
    [`${SCOPE_KIND_LABEL[s.scope_kind]} draft saved`, true],
    [`boundary traced${boundary ? ` (#${boundary.id}, ${boundary.lifecycle_state})` : ''}`, !!s.boundary_feature_id],
    ['boundary accepted', boundaryAccepted],
    [`${SCOPE_KIND_LABEL[s.scope_kind]} accepted with this boundary`, s.lifecycle_state === 'accepted' && !openRev && boundaryAccepted],
  ];

  const membership = (
    <>
      <ul aria-label="Scope members" style={listStyle}>
        {s.members.length === 0 && <li style={{ opacity: 0.6 }}>No explicit member islands{region ? ' (none required).' : '.'}</li>}
        {s.members.map(id => {
          const f = features.find(x => x.id === id);
          return (
            <li key={id}>
              {landName(id)}{f && f.geometry_type === 'polygon' ? ` · ${formatArea(polygonArea((f.geometry as CanonicalPolygon).outer, (f.geometry as CanonicalPolygon).holes))}` : ''}
              {!isCity && <button className="utility-btn" style={{ ...smallBtn, marginTop: 0 }} disabled={ops.busy || !editable} title={why}
                aria-label={`Remove member ${id}`} onClick={() => onRemoveMember(id)}>REMOVE</button>}
            </li>
          );
        })}
      </ul>
      {!isCity && (
        <div aria-label="Membership actions">
          <button className="utility-btn" style={smallBtn} disabled={!s.members.length} onClick={onSelectMembers}>SELECT MEMBERS ON MAP</button>
          <button className="utility-btn" style={smallBtn} disabled={ops.busy || !editable || !selectionIds.length} title={why}
            onClick={onAssignSelection}>ASSIGN SELECTION ({selectionIds.length}) HERE</button>
          <button className="utility-btn" style={smallBtn} disabled={ops.busy || !editable || !inSelection.length} title={why}
            onClick={onRemoveSelection}>REMOVE SELECTION ({inSelection.length}) FROM HERE</button>
          <button className="utility-btn" style={smallBtn} disabled={!boundary || boundary.geometry_type !== 'polygon'}
            title={boundary ? '' : 'needs a boundary polygon'} onClick={onProposeInside}>SELECT LAND INSIDE BOUNDARY…</button>
        </div>
      )}
    </>
  );

  return (
    <div style={section} aria-label="Scope inspector">
      <strong style={{ fontSize: '0.75rem' }}>{scopeLabel(s)} {s.is_locked ? '🔒' : ''}</strong>
      <div style={kv}>
        <Row k="STATE">{STATE_LABEL[s.lifecycle_state]}{s.lifecycle_state === 'accepted' ? ` · r${s.revision}` : ` · draft v${s.draft_version}`}</Row>
        <Row k="KIND">{SCOPE_KIND_LABEL[s.scope_kind]}</Row>
        <Row k="KEY">{s.scope_key}</Row>
        {s.revises_id && <Row k="REVISES">#{s.revises_id} (built on r{s.base_revision ?? '?'})</Row>}
        <Row k="PARENT">{parent ? <button className="utility-btn" style={{ ...smallBtn, marginTop: 0 }} onClick={() => onSelect(parent.id)}>{scopeLabel(parent)}</button> : 'none'}</Row>
        <Row k="ANCESTRY">{chain.length ? chain.map(c => c.name ?? `#${c.id}`).join(' → ') + ` → ${s.name}` : s.name}</Row>
        <Row k="CHILDREN">{children.length ? children.map(c => (
          <button key={c.id} className="utility-btn" style={{ ...smallBtn, marginTop: 0 }} onClick={() => onSelect(c.id)}>{scopeLabel(c)}</button>)) : 'none'}</Row>
        <Row k="BOUNDARY">{s.boundary_feature_id
          ? <>#{s.boundary_feature_id} {boundary ? `(${boundary.lifecycle_state})` : '(not loaded)'}
            <button className="utility-btn" style={{ ...smallBtn, marginTop: 0 }} onClick={() => onInspectFeature(s.boundary_feature_id!)}>INSPECT</button></>
          : 'none — extent is the member islands'}</Row>
        <Row k="LAND COVERAGE">{s.land_coverage}{s.land_coverage === 'complete' ? ' (non-land in extent = water)' : ' (untraced = unknown)'}</Row>
        {region ? <>
          <Row k="SPATIAL LAND">{spatial
            ? <span data-spatial-land>{spatial.land.inside.length} inside · {spatial.land.crossing.length} on/crossing boundary
              {spatial.source === 'preview' ? ' (draft preview)' : ''}</span>
            : s.boundary_feature_id ? 'loading…' : 'no boundary yet'}</Row>
          <Row k="EXPLICIT MEMBERS">{s.members.length} whole island(s) (optional)</Row>
        </> : <Row k="MEMBERS">{s.members.length} island(s)</Row>}
      </div>
      {region && <div style={{ fontSize: '0.58rem', opacity: 0.7 }}>Spatial land is derived from the boundary (see the left context pane); it is not membership.</div>}
      {openRev && (
        <div style={{ fontSize: '0.62rem' }}>Open draft revision: <button className="utility-btn" style={smallBtn} onClick={() => onSelect(openRev.id)}>#{openRev.id}</button>
          {' '}— membership/boundary/coverage changes are staged there.</div>
      )}

      {region && (
        <div aria-label="Region boundary" style={{ border: '1px solid #00e5ff', padding: '4px', marginTop: '6px' }}>
          <strong style={{ fontSize: '0.68rem' }}>{kindUpper} BOUNDARY — a {SCOPE_KIND_LABEL[s.scope_kind]} is a drawn region</strong>
          <ol aria-label="Boundary steps" style={{ fontSize: '0.62rem', margin: '2px 0 2px 16px', padding: 0 }}>
            {steps.map(([label, done]) => <li key={label} data-done={done} style={{ opacity: done ? 1 : 0.6 }}>{done ? '✓ ' : ''}{label}</li>)}
          </ol>
          {!s.boundary_feature_id ? (
            <button className="utility-btn" style={{ ...smallBtn, fontWeight: 'bold' }} disabled={ops.busy || !editable} title={why}
              onClick={onTraceBoundary}>TRACE {kindUpper} BOUNDARY</button>
          ) : (
            <>
              <button className="utility-btn" style={smallBtn} disabled={ops.busy || !boundaryEditable}
                title={boundary ? (boundaryEditable ? '' : 'the boundary is locked — unlock it first') : 'boundary feature not loaded'}
                onClick={() => boundary && onEditBoundary(boundary)}>EDIT BOUNDARY (TRACE)</button>
              {boundary && !boundaryAccepted && (
                <button className="utility-btn" style={smallBtn} onClick={() => onInspectFeature(boundary.id)}>ACCEPT BOUNDARY…</button>
              )}
            </>
          )}
          <div style={{ fontSize: '0.58rem', opacity: 0.75 }}>
            The boundary may cross islands. An island split between districts needs no membership here, and nothing turns
            containment into membership.
          </div>
        </div>
      )}

      {region ? (
        <details aria-label="Optional whole-island membership" style={{ marginTop: '4px', fontSize: '0.65rem' }}>
          <summary>OPTIONAL: WHOLE-ISLAND MEMBERSHIP ({s.members.length}) — not required for a {SCOPE_KIND_LABEL[s.scope_kind]}</summary>
          {membership}
          <button className="utility-btn" style={smallBtn} disabled={ops.busy || !editable || !s.members.length} title={why}
            onClick={onClearMembers}>CLEAR ALL EXPLICIT MEMBERS…</button>
        </details>
      ) : membership}

      {!isCity && (
        <div aria-label="Boundary actions" style={{ marginTop: '4px' }}>
          <select aria-label="Choose boundary" style={{ ...fieldStyle, width: '55%', display: 'inline-block' }} value={boundaryChoice}
            onChange={e => setBoundaryChoice(e.target.value === '' ? '' : Number(e.target.value))}>
            <option value="">existing boundary…</option>
            {boundaryCandidates(features).map(f => <option key={f.id} value={f.id}>#{f.id} {f.name || 'boundary'} [{f.lifecycle_state.toUpperCase()}]</option>)}
          </select>
          <button className="utility-btn" style={smallBtn} disabled={ops.busy || !editable || boundaryChoice === ''} onClick={() => boundaryChoice !== '' && onSetBoundary(boundaryChoice)}>SET</button>
          {!region && <button className="utility-btn" style={smallBtn} disabled={ops.busy || !editable} title={why} onClick={onTraceBoundary}>TRACE NEW BOUNDARY</button>}
          {s.boundary_feature_id && <button className="utility-btn" style={smallBtn} disabled={ops.busy || !editable} onClick={() => onSetBoundary(null)}>CLEAR BOUNDARY</button>}
          <div style={{ fontSize: '0.58rem', opacity: 0.7 }}>Order: link the boundary draft to this scope, accept the boundary feature, then accept the scope.</div>
        </div>
      )}

      <div>
        {s.land_coverage === 'partial'
          ? <button className="utility-btn" style={smallBtn} disabled={ops.busy || !editable} title={why} onClick={() => onCoverage('complete')}>MARK COVERAGE COMPLETE…</button>
          : <button className="utility-btn" style={smallBtn} disabled={ops.busy || !editable} title={why} onClick={() => onCoverage('partial')}>MARK COVERAGE PARTIAL…</button>}
      </div>

      <LifecycleControls entity="scopes" label="scope" record={s} actions={actions} ops={ops}
        onEdit={onEdit} onRevised={(d) => onSelect(d.id)} onAccepted={(c) => onSelect(c.id)} onDeleted={() => onSelect(s.revises_id ?? 0)}
        acceptSummary={<ScopeAcceptSummary draft={s} canonical={findScope(scopes, s.revises_id)} landName={landName} features={features} />} />
    </div>
  );
}
