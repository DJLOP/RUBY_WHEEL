/**
 * Anchors and their parts, as the anchor register and editor show and edit them
 * (plan §3.3, §4.3, §7.2, WP6).
 *
 * Pure: no React, Three.js, network or reference-layer imports.
 *
 * An anchor is a semantic register entry; its geometry is its parts — ordinary canonical
 * features carrying `anchor_id` + `part_role`, traced with the same WP5 tool as any other
 * feature. Placement is derived, never stored: an accepted anchor is placed exactly when
 * one of its parts is accepted. A must-exist anchor can never be made replaceable; the
 * server enforces that, and the UI never offers it.
 */

import type {
  AnchorCategory, CanonicalAnchor, CanonicalFeature, ConstraintStrength, FeatureClass, GeometryType, PartRole, ReplacementState, ScopeKind,
} from './types';
import { featureActions, type Availability, type FeatureActions } from './featureEditing';

export const ANCHOR_CATEGORIES: AnchorCategory[] = ['landmark', 'precinct', 'compound', 'facility', 'network', 'other'];
export const PART_ROLES: PartRole[] = ['core', 'footprint', 'precinct', 'node', 'link', 'access', 'extent'];

/**
 * A sensible starting class/geometry for a new part of each role. Any class may be a part
 * (a docks basin stays `water`), so the tracing panel lets the GM change it.
 */
export const PART_ROLE_DEFAULTS: Record<PartRole, { feature_class: FeatureClass; geometry_type: GeometryType }> = {
  core: { feature_class: 'site', geometry_type: 'point' },
  footprint: { feature_class: 'site', geometry_type: 'polygon' },
  precinct: { feature_class: 'site', geometry_type: 'polygon' },
  node: { feature_class: 'site', geometry_type: 'point' },
  link: { feature_class: 'route', geometry_type: 'linestring' },
  access: { feature_class: 'site', geometry_type: 'point' },
  extent: { feature_class: 'site', geometry_type: 'polygon' },
};

/** GET /anchors/register — accepted anchors with derived placement (plan §5.1). */
export interface AnchorRegisterEntry {
  id: number;
  anchor_key: string;
  name: string;
  category: AnchorCategory;
  constraint_strength: ConstraintStrength;
  must_exist: boolean;
  replacement_state: ReplacementState;
  is_locked: boolean;
  revision: number;
  required_scope_id: number | null;
  required_scope: { id: number; accepted: true; scope_key: string; scope_kind: ScopeKind; name: string } | { id: number; accepted: false } | null;
  status: 'placed' | 'unplaced';
  placed: boolean;
  part_summary: {
    count: number;
    by_role: Record<string, number>;
    parts: { feature_id: number; revision: number; feature_class: FeatureClass; geometry_type: GeometryType; part_role: PartRole | null; constraint_strength: ConstraintStrength }[];
  };
}

export interface AnchorRegister {
  anchors: AnchorRegisterEntry[];
  summary: { total: number; placed: number; unplaced: number; unplaced_must_exist: number[] };
}

/** Every part feature of an anchor in the working set (accepted and open drafts/proposals). */
export const partsOf = (features: CanonicalFeature[], anchorId: number) =>
  features.filter(f => f.anchor_id === anchorId && f.lifecycle_state !== 'retired').sort((a, b) => a.id - b.id);

/** Client mirror of the derived rule, for anchors the register does not list yet. */
export const isPlaced = (features: CanonicalFeature[], anchorId: number) =>
  features.some(f => f.anchor_id === anchorId && f.lifecycle_state === 'accepted');

export const partRoleSummary = (byRole: Record<string, number>) =>
  Object.entries(byRole).map(([role, n]) => `${n} ${role}`).join(', ') || 'no accepted parts';

/**
 * Lifecycle actions for an anchor: the feature rules, plus "never replaceable" for a
 * must-exist anchor — the control is unavailable, not merely refused later.
 */
export function anchorActions(a: CanonicalAnchor, openRevisionId: number | null = null): FeatureActions {
  const base = featureActions(a, openRevisionId);
  const replacement: Availability = a.must_exist && a.replacement_state !== 'replaceable'
    ? { enabled: false, reason: 'a must-exist anchor can never be replaceable' }
    : base.replacement;
  return { ...base, replacement };
}

// ── the anchor form ─────────────────────────────────────────────────────────

export interface AnchorForm {
  anchor_key: string;
  name: string;
  category: AnchorCategory;
  constraint_strength: ConstraintStrength;
  must_exist: boolean;
  required_scope_id: number | '';
  description: string;
  notes: string;
}

export const emptyAnchorForm = (): AnchorForm => ({
  anchor_key: '', name: '', category: 'landmark', constraint_strength: 'hard', must_exist: true, required_scope_id: '',
  description: '', notes: '',
});

export const anchorFormFrom = (a: CanonicalAnchor): AnchorForm => ({
  anchor_key: a.anchor_key, name: a.name ?? '', category: a.category, constraint_strength: a.constraint_strength,
  must_exist: a.must_exist, required_scope_id: a.required_scope_id ?? '', description: a.description ?? '', notes: a.notes ?? '',
});

export function anchorFormIssues(form: AnchorForm): string[] {
  const issues: string[] = [];
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(form.anchor_key) || form.anchor_key.length > 80) issues.push('key must be a lowercase slug (a-z, 0-9, _ or -)');
  if (!form.name.trim()) issues.push('name is required');
  return issues;
}

/** Body for POST /anchors or PATCH /anchors/:id; never lifecycle, lock or replacement fields. */
export const anchorBody = (form: AnchorForm): Record<string, unknown> => ({
  anchor_key: form.anchor_key,
  name: form.name.trim(),
  category: form.category,
  constraint_strength: form.constraint_strength,
  must_exist: form.must_exist,
  required_scope_id: form.required_scope_id === '' ? null : form.required_scope_id,
  description: form.description.trim() || null,
  notes: form.notes.trim() || null,
});
