import { useEffect, useState } from 'react';
import type { CanonicalGeographyData } from './api';
import { canonicalApi } from './api';
import type { CanonicalAnchor, CanonicalFeature, GeoScope, PartRole } from './types';
import {
  ANCHOR_CATEGORIES, PART_ROLES, anchorActions, anchorBody, anchorFormFrom, anchorFormIssues, emptyAnchorForm, isPlaced, partRoleSummary,
  partsOf, type AnchorForm, type AnchorRegister,
} from './anchors';
import { findScope, isScopeIdentity, scopeLabel, slugify } from './scopes';
import { ArchiveSection, IssueList, LifecycleControls, Row, type PanelOps } from './panelUi';
import { STATE_LABEL, fieldStyle, kv, labelStyle, listStyle, section, smallBtn } from './panelStyles';

/**
 * The anchor register and anchor editor (plan §3.3, §7.2 "Hard anchors", WP6).
 *
 * 1. Create an anchor record (a draft) and accept it. It then appears in the register as
 *    UNPLACED — a hard must-exist anchor may be accepted before any geometry exists.
 * 2. ADD PART: pick a role; the WP5 tracing tool opens with the part linkage set. Saving
 *    creates a draft part — an ordinary canonical feature with anchor_id + part_role.
 * 3. Accept the part (feature inspector). The register then shows the anchor PLACED.
 *
 * Placement comes from GET /anchors/register (derived on the server from accepted parts).
 * A must-exist anchor's replacement control is unavailable; the server refuses it anyway.
 * The real Bible §9 register arrives through the WP7 import, not by typing it here.
 */

interface Props {
  data: CanonicalGeographyData;
  ops: PanelOps;
  /** Open the WP5 tracing tool for a new part of this anchor. */
  onAddPart: (anchor: CanonicalAnchor, role: PartRole) => void;
  /** Show a part in the feature inspector (where it is accepted). */
  onInspectFeature: (id: number) => void;
}

export function AnchorsPanel({ data, ops, onAddPart, onInspectFeature }: Props) {
  const [register, setRegister] = useState<AnchorRegister | null>(null);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [form, setForm] = useState<{ editing: CanonicalAnchor | null; form: AnchorForm } | null>(null);

  // Refetch the register whenever canonical data is refetched, so an accepted part shows at once.
  useEffect(() => {
    let live = true;
    void canonicalApi.anchorRegister(ops.token).then((res) => {
      if (!live) return;
      if (res.ok) { setRegister(res.data); setRegisterError(null); } else setRegisterError(res.error.error);
    });
    return () => { live = false; };
  }, [ops.token, data]);

  const working = data.anchors.filter(a => a.lifecycle_state === 'draft' || a.lifecycle_state === 'proposed');
  const selected = data.anchors.find(a => a.id === selectedId) ?? null;

  const save = () => {
    if (!form || anchorFormIssues(form.form).length) return;
    const existing = form.editing;
    void ops.run(
      () => (existing
        ? canonicalApi.patch<CanonicalAnchor>(ops.token, 'anchors', existing.id, { ...anchorBody(form.form), expected_draft_version: existing.draft_version })
        : canonicalApi.create<CanonicalAnchor>(ops.token, 'anchors', anchorBody(form.form))),
      (saved) => {
        setForm(null);
        setSelectedId(saved.id);
        ops.notify(`Saved ${saved.lifecycle_state.toUpperCase()} anchor #${saved.id} "${saved.anchor_key}" (v${saved.draft_version}). It is not in the register until accepted.`);
      });
  };

  return (
    <div aria-label="Anchors">
      <div style={section}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong style={{ fontSize: '0.75rem' }}>ANCHOR REGISTER</strong>
          <button className="utility-btn" style={smallBtn} disabled={ops.busy} onClick={() => setForm({ editing: null, form: emptyAnchorForm() })}>+ NEW ANCHOR</button>
        </div>
        {registerError && <div role="alert" style={{ fontSize: '0.62rem', color: '#ff7766' }}>Register unavailable: {registerError}</div>}
        {register && (
          <div aria-label="Register summary" style={{ fontSize: '0.62rem' }}>
            {register.summary.total} accepted · {register.summary.placed} placed · {register.summary.unplaced} unplaced
            {register.summary.unplaced_must_exist.length > 0 && <span style={{ color: '#ffcc55' }}> · {register.summary.unplaced_must_exist.length} must-exist unplaced</span>}
          </div>
        )}
        <ul aria-label="Anchor register" style={listStyle}>
          {register && register.anchors.length === 0 && <li style={{ opacity: 0.6 }}>No accepted anchors.</li>}
          {register?.anchors.map(e => (
            <li key={e.id}>
              <button className="utility-btn" data-anchor-id={e.id} aria-pressed={e.id === selectedId}
                style={{ width: '100%', textAlign: 'left', fontSize: '0.62rem', padding: '2px 4px', marginTop: '2px', ...(e.id === selectedId ? { background: 'var(--dark-green)' } : {}) }}
                onClick={() => setSelectedId(e.id)}>
                <span data-status={e.status} style={{ color: e.placed ? 'var(--green)' : '#ffcc55', fontWeight: 'bold' }}>{e.placed ? 'PLACED' : 'UNPLACED'}</span>
                {' '}#{e.id} {e.name} ({e.anchor_key}) · {e.constraint_strength}{e.must_exist ? ' · MUST-EXIST' : ''}
                {e.required_scope ? ` · in ${e.required_scope.accepted ? e.required_scope.name : `scope #${e.required_scope.id}`}` : ''}
                {' · '}{partRoleSummary(e.part_summary.by_role)}{e.is_locked ? ' 🔒' : ''}
              </button>
            </li>
          ))}
        </ul>
        {working.length > 0 && <>
          <strong style={{ fontSize: '0.65rem' }}>DRAFTS / PROPOSALS (not in the register until accepted)</strong>
          <ul aria-label="Anchor drafts" style={listStyle}>
            {working.map(a => (
              <li key={a.id}>
                <button className="utility-btn" data-anchor-id={a.id} aria-pressed={a.id === selectedId}
                  style={{ width: '100%', textAlign: 'left', fontSize: '0.62rem', padding: '2px 4px', marginTop: '2px', ...(a.id === selectedId ? { background: 'var(--dark-green)' } : {}) }}
                  onClick={() => setSelectedId(a.id)}>
                  #{a.id} {a.name} ({a.anchor_key}) · {STATE_LABEL[a.lifecycle_state]}{a.revises_id ? ` · revises #${a.revises_id}` : ''}
                </button>
              </li>
            ))}
          </ul>
        </>}
      </div>

      <ArchiveSection<CanonicalAnchor> entity="anchors" label="anchor" ops={ops} refreshKey={data}
        describe={(a) => `#${a.id} ${a.name} (${a.anchor_key})`}
        details={(a) => <>
          <Row k="ANCHOR">{a.name} ({a.anchor_key}) · {a.category}</Row>
          <Row k="STRENGTH">{a.constraint_strength}{a.must_exist ? ' · must exist' : ''}</Row>
          <Row k="REQUIRED SCOPE">{a.required_scope_id ? `#${a.required_scope_id}` : 'none'}</Row>
          {a.description && <Row k="DESCRIPTION">{a.description}</Row>}
        </>} />

      {form ? (
        <AnchorFormPanel form={form.form} editing={form.editing} scopes={data.scopes} busy={ops.busy}
          onChange={(f) => setForm({ ...form, form: f })} onSave={save} onCancel={() => setForm(null)} />
      ) : selected && (
        <AnchorInspector anchor={selected} data={data} ops={ops} registerPlaced={register?.anchors.find(e => e.id === selected.id)?.placed ?? null}
          onEdit={() => setForm({ editing: selected, form: anchorFormFrom(selected) })}
          onSelect={setSelectedId} onAddPart={onAddPart} onInspectFeature={onInspectFeature} />
      )}
    </div>
  );
}

function AnchorFormPanel({ form, editing, scopes, busy, onChange, onSave, onCancel }: {
  form: AnchorForm; editing: CanonicalAnchor | null; scopes: GeoScope[]; busy: boolean;
  onChange: (f: AnchorForm) => void; onSave: () => void; onCancel: () => void;
}) {
  const issues = anchorFormIssues(form);
  const isRevision = !!editing?.revises_id;
  const scopeOptions = scopes.filter(s => isScopeIdentity(s) && s.lifecycle_state !== 'retired');
  return (
    <div style={section} aria-label="Anchor form">
      <strong style={{ fontSize: '0.75rem' }}>{editing ? `EDITING ${editing.lifecycle_state.toUpperCase()} ANCHOR #${editing.id} (v${editing.draft_version})` : 'NEW ANCHOR (DRAFT)'}</strong>
      <label style={labelStyle}>NAME
        <input aria-label="Anchor name" style={fieldStyle} value={form.name}
          onChange={e => onChange({ ...form, name: e.target.value, anchor_key: !editing && (form.anchor_key === '' || form.anchor_key === slugify(form.name)) ? slugify(e.target.value) : form.anchor_key })} />
      </label>
      <label style={labelStyle}>KEY (stable slug{isRevision ? '; fixed for a revision' : ''})
        <input aria-label="Anchor key" style={fieldStyle} value={form.anchor_key} disabled={isRevision} onChange={e => onChange({ ...form, anchor_key: e.target.value })} />
      </label>
      <label style={labelStyle}>CATEGORY (organizational only)
        <select aria-label="Anchor category" style={fieldStyle} value={form.category} onChange={e => onChange({ ...form, category: e.target.value as AnchorForm['category'] })}>
          {ANCHOR_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      <label style={labelStyle}>ANCHOR STRENGTH
        <select aria-label="Anchor strength" style={fieldStyle} value={form.constraint_strength}
          onChange={e => onChange({ ...form, constraint_strength: e.target.value as 'hard' | 'soft' })}>
          <option value="hard">hard — identity, presence, scope and relationships are protected</option>
          <option value="soft">soft — must exist in an appropriate place and role</option>
        </select>
      </label>
      <label style={{ ...labelStyle, opacity: 1 }}>
        <input type="checkbox" aria-label="Must exist" checked={form.must_exist} onChange={() => onChange({ ...form, must_exist: !form.must_exist })} />
        {' '}MUST EXIST (never replaceable)
      </label>
      <label style={labelStyle}>REQUIRED SCOPE (optional; parts must lie inside its accepted extent)
        <select aria-label="Required scope" style={fieldStyle} value={form.required_scope_id}
          onChange={e => onChange({ ...form, required_scope_id: e.target.value === '' ? '' : Number(e.target.value) })}>
          <option value="">none</option>
          {scopeOptions.map(s => <option key={s.id} value={s.id}>{scopeLabel(s)}{s.lifecycle_state === 'accepted' ? '' : ` [${s.lifecycle_state.toUpperCase()}]`}</option>)}
        </select>
      </label>
      <label style={labelStyle}>DESCRIPTION (optional)
        <input aria-label="Anchor description" style={fieldStyle} value={form.description} onChange={e => onChange({ ...form, description: e.target.value })} />
      </label>
      <label style={labelStyle}>NOTES (optional)
        <textarea aria-label="Anchor notes" style={{ ...fieldStyle, height: '32px' }} value={form.notes} onChange={e => onChange({ ...form, notes: e.target.value })} />
      </label>
      <IssueList label="Anchor form issues" items={issues} />
      <button className="utility-btn" style={smallBtn} disabled={busy || issues.length > 0} onClick={onSave}>SAVE DRAFT</button>
      <button className="utility-btn" style={smallBtn} disabled={busy} onClick={onCancel}>CANCEL</button>
    </div>
  );
}

function AnchorInspector({ anchor: a, data, ops, registerPlaced, onEdit, onSelect, onAddPart, onInspectFeature }: {
  anchor: CanonicalAnchor; data: CanonicalGeographyData; ops: PanelOps; registerPlaced: boolean | null;
  onEdit: () => void; onSelect: (id: number) => void; onAddPart: (anchor: CanonicalAnchor, role: PartRole) => void; onInspectFeature: (id: number) => void;
}) {
  const [role, setRole] = useState<PartRole>('footprint');
  const canonicalId = a.revises_id ?? a.id;
  const parts: CanonicalFeature[] = partsOf(data.features, canonicalId);
  const scope = findScope(data.scopes, a.required_scope_id);
  const openRev = a.lifecycle_state === 'accepted'
    ? data.anchors.find(x => x.revises_id === a.id && x.lifecycle_state === 'draft') ?? null : null;
  const placed = a.lifecycle_state === 'accepted' ? (registerPlaced ?? isPlaced(data.features, a.id)) : null;
  const canAddPart = a.lifecycle_state !== 'retired' && !a.revises_id;

  return (
    <div style={section} aria-label="Anchor inspector">
      <strong style={{ fontSize: '0.75rem' }}>#{a.id} {a.name} ({a.anchor_key}) {a.is_locked ? '🔒' : ''}</strong>
      <div style={kv}>
        <Row k="STATE">{STATE_LABEL[a.lifecycle_state]}{a.lifecycle_state === 'accepted' ? ` · r${a.revision}` : ` · draft v${a.draft_version}`}</Row>
        <Row k="REGISTER">{placed === null ? 'not in the register until accepted' : <span data-placement={placed ? 'placed' : 'unplaced'}>{placed ? 'PLACED' : 'UNPLACED'}</span>}</Row>
        <Row k="CATEGORY">{a.category}</Row>
        <Row k="STRENGTH">{a.constraint_strength}</Row>
        <Row k="MUST EXIST">{a.must_exist ? 'yes — never replaceable' : 'no'}</Row>
        <Row k="REPLACEMENT">{a.replacement_state}</Row>
        <Row k="REQUIRED SCOPE">{a.required_scope_id ? `${scopeLabel(scope)}${scope && scope.lifecycle_state !== 'accepted' ? ` [${scope.lifecycle_state.toUpperCase()}]` : ''}` : 'none'}</Row>
        <Row k="PROVENANCE">{a.provenance}</Row>
        {a.revises_id && <Row k="REVISES">#{a.revises_id} (built on r{a.base_revision ?? '?'})</Row>}
      </div>
      {openRev && <div style={{ fontSize: '0.62rem' }}>Open draft revision: <button className="utility-btn" style={smallBtn} onClick={() => onSelect(openRev.id)}>#{openRev.id}</button></div>}

      <strong style={{ fontSize: '0.65rem', display: 'block', marginTop: '4px' }}>PARTS</strong>
      <ul aria-label="Anchor parts" style={listStyle}>
        {parts.length === 0 && <li style={{ opacity: 0.6 }}>No parts yet.</li>}
        {parts.map(p => (
          <li key={p.id}>
            #{p.id} {p.part_role ?? 'part'} · {p.feature_class}/{p.geometry_type} · {p.constraint_strength} · {STATE_LABEL[p.lifecycle_state]}
            <button className="utility-btn" style={{ ...smallBtn, marginTop: 0 }} onClick={() => onInspectFeature(p.id)}>
              {p.lifecycle_state === 'accepted' ? 'INSPECT' : 'INSPECT / ACCEPT'}
            </button>
          </li>
        ))}
      </ul>
      {canAddPart && (
        <div aria-label="Add part">
          <select aria-label="Part role" style={{ ...fieldStyle, width: '45%', display: 'inline-block' }} value={role} onChange={e => setRole(e.target.value as PartRole)}>
            {PART_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <button className="utility-btn" style={smallBtn} disabled={ops.busy} onClick={() => onAddPart(a, role)}>ADD PART (TRACE)</button>
          <div style={{ fontSize: '0.58rem', opacity: 0.7 }}>
            {a.lifecycle_state === 'accepted'
              ? 'The part is saved as a draft feature; accepting it places the anchor.'
              : 'Parts can be traced now, but a part is accepted only after its anchor is.'}
            {a.required_scope_id ? ' Accepting a part checks it lies inside the required scope\'s accepted extent.' : ''}
          </div>
        </div>
      )}

      <LifecycleControls entity="anchors" label="anchor" record={a} actions={anchorActions(a, openRev?.id ?? null)} ops={ops}
        onEdit={onEdit} onRevised={(d) => onSelect(d.id)} onAccepted={(c) => onSelect(c.id)} onDeleted={() => onSelect(a.revises_id ?? 0)}
        acceptSummary={<>
          <Row k="ANCHOR">{a.name} ({a.anchor_key}) · {a.category}</Row>
          <Row k="STRENGTH">{a.constraint_strength}{a.must_exist ? ' · must exist' : ''}</Row>
          <Row k="REPLACEMENT">{a.revises_id ? data.anchors.find(x => x.id === a.revises_id)?.replacement_state ?? a.replacement_state : a.replacement_state}</Row>
          <Row k="REQUIRED SCOPE">{a.required_scope_id ? scopeLabel(scope) : 'none'}</Row>
          <Row k="PLACEMENT">{a.revises_id ? 'unchanged by this revision' : 'accepted UNPLACED until a part is accepted'}</Row>
        </>} />
    </div>
  );
}
