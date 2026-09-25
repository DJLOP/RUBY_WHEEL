/**
 * Required connections, as the connection editor builds them (plan §3.4, §4.4, WP6).
 *
 * Pure: no React, Three.js, network or reference-layer imports.
 *
 * A connection is an obligation between two endpoints — a feature (an island, an anchor
 * part, a site), an anchor, or a scope. `soft` means "must connect, alignment free" and
 * needs no route; `hard` means the alignment is canon, so it needs an accepted `route`
 * feature as `via`. A draft may be saved while it breaks that rule; accept refuses it on
 * the server, and nothing here offers a way around that.
 */

import type { CanonicalAnchor, CanonicalConnection, CanonicalFeature, ConnectionKind, ConstraintStrength, GeoScope, RefType } from './types';
import { SCOPE_KIND_LABEL } from './scopes';

export const CONNECTION_KINDS: ConnectionKind[] = ['road', 'bridge', 'ferry', 'water_route', 'utility', 'pedestrian', 'other'];
export const REF_TYPES: RefType[] = ['feature', 'anchor', 'scope'];

export interface EndpointOption { id: number; label: string; accepted: boolean }

interface Sources { features: CanonicalFeature[]; anchors: CanonicalAnchor[]; scopes: GeoScope[] }

const stateTag = (s: string) => (s === 'accepted' ? '' : ` [${s.toUpperCase()}]`);

export function featureLabel(f: CanonicalFeature): string {
  const what = f.feature_class === 'land' ? 'island' : `${f.feature_class}${f.kind ? `/${f.kind}` : ''}`;
  const part = f.anchor_id ? ` · part of anchor #${f.anchor_id}${f.part_role ? ` (${f.part_role})` : ''}` : '';
  return `#${f.id} ${f.name || '(unnamed)'} · ${what}${part}${stateTag(f.lifecycle_state)}`;
}

/**
 * Endpoint choices per type. Only accepted canon may be an endpoint at accept time, so
 * accepted entries come first; drafts are listed (marked) because a draft connection may
 * be prepared before its endpoints are accepted. Revisions are never endpoints — the
 * canonical id is.
 */
export function endpointOptions({ features, anchors, scopes }: Sources): Record<RefType, EndpointOption[]> {
  const order = (a: EndpointOption, b: EndpointOption) => Number(b.accepted) - Number(a.accepted) || a.id - b.id;
  return {
    feature: features
      .filter(f => f.revises_id === null && f.lifecycle_state !== 'retired' && f.feature_class !== 'scope_boundary')
      .map(f => ({ id: f.id, label: featureLabel(f), accepted: f.lifecycle_state === 'accepted' })).sort(order),
    anchor: anchors
      .filter(a => a.revises_id === null && a.lifecycle_state !== 'retired')
      .map(a => ({ id: a.id, label: `#${a.id} ${a.name} (${a.anchor_key})${stateTag(a.lifecycle_state)}`, accepted: a.lifecycle_state === 'accepted' })).sort(order),
    scope: scopes
      .filter(s => s.revises_id === null && s.lifecycle_state !== 'retired')
      .map(s => ({ id: s.id, label: `#${s.id} ${s.name ?? ''} (${SCOPE_KIND_LABEL[s.scope_kind]})${stateTag(s.lifecycle_state)}`, accepted: s.lifecycle_state === 'accepted' })).sort(order),
  };
}

/** Accepted and draft route features, for `via`. Only an accepted route makes a hard connection acceptable. */
export const viaOptions = (features: CanonicalFeature[]): EndpointOption[] =>
  features.filter(f => f.feature_class === 'route' && f.revises_id === null && f.lifecycle_state !== 'retired')
    .map(f => ({ id: f.id, label: featureLabel(f), accepted: f.lifecycle_state === 'accepted' }))
    .sort((a, b) => Number(b.accepted) - Number(a.accepted) || a.id - b.id);

export function endpointLabel(src: Sources, type: RefType, id: number): string {
  if (type === 'feature') { const f = src.features.find(x => x.id === id); return f ? featureLabel(f) : `feature #${id} (not loaded)`; }
  if (type === 'anchor') { const a = src.anchors.find(x => x.id === id); return a ? `anchor #${a.id} ${a.name}${stateTag(a.lifecycle_state)}` : `anchor #${id} (not loaded)`; }
  const s = src.scopes.find(x => x.id === id);
  return s ? `${SCOPE_KIND_LABEL[s.scope_kind]} #${s.id} ${s.name ?? ''}${stateTag(s.lifecycle_state)}` : `scope #${id} (not loaded)`;
}

// ── the connection form ─────────────────────────────────────────────────────

export interface ConnectionForm {
  connection_kind: ConnectionKind | '';
  from_ref_type: RefType;
  from_ref_id: number | '';
  to_ref_type: RefType;
  to_ref_id: number | '';
  via_feature_id: number | '';
  constraint_strength: ConstraintStrength;
  name: string;
  notes: string;
}

export const emptyConnectionForm = (): ConnectionForm => ({
  connection_kind: '', from_ref_type: 'feature', from_ref_id: '', to_ref_type: 'feature', to_ref_id: '',
  via_feature_id: '', constraint_strength: 'soft', name: '', notes: '',
});

export const connectionFormFrom = (c: CanonicalConnection): ConnectionForm => ({
  connection_kind: c.connection_kind ?? '', from_ref_type: c.from_ref_type, from_ref_id: c.from_ref_id,
  to_ref_type: c.to_ref_type, to_ref_id: c.to_ref_id, via_feature_id: c.via_feature_id ?? '',
  constraint_strength: c.constraint_strength, name: c.name ?? '', notes: c.notes ?? '',
});

/** Problems that stop a draft from being saved at all. */
export function connectionFormIssues(form: ConnectionForm): string[] {
  const issues: string[] = [];
  if (form.from_ref_id === '') issues.push('choose a FROM endpoint');
  if (form.to_ref_id === '') issues.push('choose a TO endpoint');
  if (form.from_ref_id !== '' && form.from_ref_type === form.to_ref_type && form.from_ref_id === form.to_ref_id) {
    issues.push('a connection must join two different entities');
  }
  return issues;
}

/**
 * Things that will make accept fail, said up front. The draft can still be saved: the
 * server decides at accept, and these do not replace its checks.
 */
export function connectionAcceptHints(form: ConnectionForm, features: CanonicalFeature[]): string[] {
  const hints: string[] = [];
  const via = form.via_feature_id === '' ? null : features.find(f => f.id === form.via_feature_id) ?? null;
  if (form.constraint_strength === 'hard' && form.via_feature_id === '') {
    hints.push('hard means the alignment is canon: accept requires an accepted route as VIA (otherwise make it soft)');
  }
  if (via && via.feature_class !== 'route') hints.push(`via #${via.id} is not a route feature`);
  if (via && via.lifecycle_state !== 'accepted') hints.push(`via route #${via.id} is ${via.lifecycle_state}; accept it before accepting this connection`);
  return hints;
}

/** Body for POST /connections or PATCH /connections/:id. */
export const connectionBody = (form: ConnectionForm): Record<string, unknown> => ({
  connection_kind: form.connection_kind || null,
  from_ref_type: form.from_ref_type,
  from_ref_id: form.from_ref_id === '' ? null : form.from_ref_id,
  to_ref_type: form.to_ref_type,
  to_ref_id: form.to_ref_id === '' ? null : form.to_ref_id,
  via_feature_id: form.via_feature_id === '' ? null : form.via_feature_id,
  constraint_strength: form.constraint_strength,
  name: form.name.trim() || null,
  notes: form.notes.trim() || null,
});
