import { useState, useSyncExternalStore } from 'react';
import type { CanonicalGeographyData } from './api';
import { canonicalApi } from './api';
import type { CanonicalConnection, ConnectionKind, RefType } from './types';
import {
  CONNECTION_KINDS, REF_TYPES, connectionAcceptHints, connectionBody, connectionFormFrom, connectionFormIssues, emptyConnectionForm,
  endpointLabel, endpointOptions, viaOptions, type ConnectionForm,
} from './connections';
import { featureActions } from './featureEditing';
import type { LandSelectionStore } from './landSelection';
import { ArchiveSection, IssueList, LifecycleControls, Row, type PanelOps } from './panelUi';
import { STATE_LABEL, fieldStyle, kv, labelStyle, listStyle, section, smallBtn } from './panelStyles';

/**
 * Required connections (plan §3.4, §4.4, WP6): an obligation between two endpoints —
 * islands, anchor parts or sites, anchors, or scopes — with an optional mode, strength and
 * fixing route.
 *
 * Endpoints are chosen from lists (or from the land selection on the map), never typed as
 * raw ids. A connection starts as a draft; only Accept makes it canon, and the server
 * refuses a hard connection without an accepted via route — this panel says so up front
 * but offers no way around it.
 */

interface Props {
  data: CanonicalGeographyData;
  ops: PanelOps;
  selection: LandSelectionStore;
}

export function ConnectionsPanel({ data, ops, selection }: Props) {
  const sel = useSyncExternalStore(selection.subscribe, selection.getState);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [form, setForm] = useState<{ editing: CanonicalConnection | null; form: ConnectionForm } | null>(null);
  const src = { features: data.features, anchors: data.anchors, scopes: data.scopes };
  const selected = data.connections.find(c => c.id === selectedId) ?? null;
  const list = [...data.connections].sort((a, b) => a.id - b.id);

  const save = () => {
    if (!form || connectionFormIssues(form.form).length) return;
    const existing = form.editing;
    void ops.run(
      () => (existing
        ? canonicalApi.patch<CanonicalConnection>(ops.token, 'connections', existing.id, { ...connectionBody(form.form), expected_draft_version: existing.draft_version })
        : canonicalApi.create<CanonicalConnection>(ops.token, 'connections', connectionBody(form.form))),
      (saved) => {
        setForm(null);
        setSelectedId(saved.id);
        ops.notify(`Saved ${saved.lifecycle_state.toUpperCase()} connection #${saved.id} (v${saved.draft_version}). It is not canon until accepted.`);
      });
  };

  return (
    <div aria-label="Connections">
      <div style={section}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong style={{ fontSize: '0.75rem' }}>REQUIRED CONNECTIONS</strong>
          <button className="utility-btn" style={smallBtn} disabled={ops.busy} onClick={() => setForm({ editing: null, form: emptyConnectionForm() })}>+ NEW CONNECTION</button>
        </div>
        <ul aria-label="Connection list" style={listStyle}>
          {list.length === 0 && <li style={{ opacity: 0.6 }}>No connections.</li>}
          {list.map(c => (
            <li key={c.id}>
              <button className="utility-btn" data-connection-id={c.id} aria-pressed={c.id === selectedId}
                style={{ width: '100%', textAlign: 'left', fontSize: '0.62rem', padding: '2px 4px', marginTop: '2px', ...(c.id === selectedId ? { background: 'var(--dark-green)' } : {}) }}
                onClick={() => setSelectedId(c.id)}>
                #{c.id} {c.name || ''} {c.connection_kind ?? 'mode unspecified'} · {c.constraint_strength} · {STATE_LABEL[c.lifecycle_state]}
                {c.revises_id ? ` · revises #${c.revises_id}` : ''}{c.is_locked ? ' 🔒' : ''}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <ArchiveSection<CanonicalConnection> entity="connections" label="connection" ops={ops} refreshKey={data}
        describe={(c) => `#${c.id} ${c.name ?? ''} ${c.connection_kind ?? 'mode unspecified'} · ${c.constraint_strength}`}
        details={(c) => <>
          <Row k="FROM">{endpointLabel(src, c.from_ref_type, c.from_ref_id)}</Row>
          <Row k="TO">{endpointLabel(src, c.to_ref_type, c.to_ref_id)}</Row>
          <Row k="VIA">{c.via_feature_id ? `#${c.via_feature_id}` : 'none'}</Row>
        </>} />

      {form ? (
        <ConnectionFormPanel form={form.form} editing={form.editing} data={data} busy={ops.busy} selectionIds={sel.ids}
          onChange={(f) => setForm({ ...form, form: f })} onSave={save} onCancel={() => setForm(null)} />
      ) : selected && (
        <div style={section} aria-label="Connection inspector">
          <strong style={{ fontSize: '0.75rem' }}>CONNECTION #{selected.id} {selected.name ?? ''} {selected.is_locked ? '🔒' : ''}</strong>
          <div style={kv}>
            <Row k="STATE">{STATE_LABEL[selected.lifecycle_state]}{selected.lifecycle_state === 'accepted' ? ` · r${selected.revision}` : ` · draft v${selected.draft_version}`}</Row>
            <Row k="FROM">{endpointLabel(src, selected.from_ref_type, selected.from_ref_id)}</Row>
            <Row k="TO">{endpointLabel(src, selected.to_ref_type, selected.to_ref_id)}</Row>
            <Row k="MODE">{selected.connection_kind ?? 'unspecified — later synthesis chooses'}</Row>
            <Row k="STRENGTH">{selected.constraint_strength === 'hard' ? 'hard — alignment fixed by the via route' : 'soft — must connect, alignment free'}</Row>
            <Row k="VIA">{selected.via_feature_id ? endpointLabel(src, 'feature', selected.via_feature_id) : 'none'}</Row>
            {selected.revises_id && <Row k="REVISES">#{selected.revises_id}</Row>}
          </div>
          <IssueList label="Connection accept hints" items={selected.lifecycle_state === 'accepted' ? [] : connectionAcceptHints(connectionFormFrom(selected), data.features)} />
          <LifecycleControls entity="connections" label="connection" record={selected} ops={ops}
            actions={featureActions(selected, data.connections.find(x => x.revises_id === selected.id && x.lifecycle_state === 'draft')?.id ?? null)}
            onEdit={() => setForm({ editing: selected, form: connectionFormFrom(selected) })}
            onRevised={(d) => setSelectedId(d.id)} onAccepted={(c) => setSelectedId(c.id)} onDeleted={() => setSelectedId(selected.revises_id)}
            acceptSummary={<>
              <Row k="FROM">{endpointLabel(src, selected.from_ref_type, selected.from_ref_id)}</Row>
              <Row k="TO">{endpointLabel(src, selected.to_ref_type, selected.to_ref_id)}</Row>
              <Row k="MODE">{selected.connection_kind ?? 'unspecified'}</Row>
              <Row k="STRENGTH">{selected.constraint_strength}</Row>
              <Row k="VIA">{selected.via_feature_id ? `#${selected.via_feature_id}` : 'none'}</Row>
            </>} />
        </div>
      )}
    </div>
  );
}

function EndpointPicker({ which, form, options, onChange }: {
  which: 'from' | 'to'; form: ConnectionForm; options: ReturnType<typeof endpointOptions>; onChange: (f: ConnectionForm) => void;
}) {
  const typeKey = `${which}_ref_type` as const;
  const idKey = `${which}_ref_id` as const;
  const label = which.toUpperCase();
  return (
    <label style={labelStyle}>{label} ENDPOINT
      <span style={{ display: 'flex', gap: '4px' }}>
        <select aria-label={`${label} type`} style={{ ...fieldStyle, width: '30%' }} value={form[typeKey]}
          onChange={e => onChange({ ...form, [typeKey]: e.target.value as RefType, [idKey]: '' })}>
          {REF_TYPES.map(t => <option key={t} value={t}>{t === 'feature' ? 'feature / island / part' : t}</option>)}
        </select>
        <select aria-label={`${label} endpoint`} style={fieldStyle} value={form[idKey]}
          onChange={e => onChange({ ...form, [idKey]: e.target.value === '' ? '' : Number(e.target.value) })}>
          <option value="">choose…</option>
          {options[form[typeKey]].map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </span>
    </label>
  );
}

function ConnectionFormPanel({ form, editing, data, busy, selectionIds, onChange, onSave, onCancel }: {
  form: ConnectionForm; editing: CanonicalConnection | null; data: CanonicalGeographyData; busy: boolean; selectionIds: number[];
  onChange: (f: ConnectionForm) => void; onSave: () => void; onCancel: () => void;
}) {
  const options = endpointOptions({ features: data.features, anchors: data.anchors, scopes: data.scopes });
  const issues = connectionFormIssues(form);
  const hints = connectionAcceptHints(form, data.features);
  return (
    <div style={section} aria-label="Connection form">
      <strong style={{ fontSize: '0.75rem' }}>{editing ? `EDITING ${editing.lifecycle_state.toUpperCase()} CONNECTION #${editing.id} (v${editing.draft_version})` : 'NEW CONNECTION (DRAFT)'}</strong>
      <EndpointPicker which="from" form={form} options={options} onChange={onChange} />
      <EndpointPicker which="to" form={form} options={options} onChange={onChange} />
      <button className="utility-btn" style={smallBtn} disabled={selectionIds.length !== 2}
        title={selectionIds.length === 2 ? '' : 'select exactly two islands on the map'}
        onClick={() => onChange({ ...form, from_ref_type: 'feature', from_ref_id: selectionIds[0], to_ref_type: 'feature', to_ref_id: selectionIds[1] })}>
        USE MAP SELECTION ({selectionIds.length}/2 islands)
      </button>
      <label style={labelStyle}>MODE (optional)
        <select aria-label="Connection kind" style={fieldStyle} value={form.connection_kind}
          onChange={e => onChange({ ...form, connection_kind: e.target.value as ConnectionKind | '' })}>
          <option value="">unspecified — later synthesis chooses (ferry-only gaps are normal)</option>
          {CONNECTION_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
        </select>
      </label>
      <label style={labelStyle}>STRENGTH
        <select aria-label="Connection strength" style={fieldStyle} value={form.constraint_strength}
          onChange={e => onChange({ ...form, constraint_strength: e.target.value as 'hard' | 'soft' })}>
          <option value="soft">soft — must connect, alignment free</option>
          <option value="hard">hard — alignment fixed by an accepted via route</option>
        </select>
      </label>
      <label style={labelStyle}>VIA ROUTE (optional; required for hard)
        <select aria-label="Via route" style={fieldStyle} value={form.via_feature_id}
          onChange={e => onChange({ ...form, via_feature_id: e.target.value === '' ? '' : Number(e.target.value) })}>
          <option value="">none</option>
          {viaOptions(data.features).map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </label>
      <label style={labelStyle}>NAME (optional)
        <input aria-label="Connection name" style={fieldStyle} value={form.name} onChange={e => onChange({ ...form, name: e.target.value })} />
      </label>
      <label style={labelStyle}>NOTES (optional)
        <textarea aria-label="Connection notes" style={{ ...fieldStyle, height: '32px' }} value={form.notes} onChange={e => onChange({ ...form, notes: e.target.value })} />
      </label>
      <IssueList label="Connection form issues" items={issues} color="#ff7766" />
      <IssueList label="Connection accept hints" items={hints} />
      <button className="utility-btn" style={smallBtn} disabled={busy || issues.length > 0} onClick={onSave}>SAVE DRAFT</button>
      <button className="utility-btn" style={smallBtn} disabled={busy} onClick={onCancel}>CANCEL</button>
      <div style={{ fontSize: '0.58rem', opacity: 0.7 }}>Saving creates or updates a draft. Nothing becomes canon until you accept it.</div>
    </div>
  );
}
