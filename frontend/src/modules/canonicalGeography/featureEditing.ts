/**
 * What the feature manager may offer for a record, and how a traced draft becomes a
 * request body (plan §3.7, §5.2, §7.2, WP5).
 *
 * Pure: no React, Three.js, network or reference-layer imports. The rules here only decide
 * which buttons are enabled; the server enforces every one of them independently, so a
 * disabled button is a convenience and never the protection.
 */

import type { CanonicalFeature, FeatureClass, GeometryType, WorldXZ } from './types';
import { lineLength, polygonArea, ringPerimeter } from './geometry';
import type { Construction } from './geometry';

/** Which geometry types each class may carry — mirrors the backend (plan §4.1). */
export const CLASS_GEOMETRY_TYPES: Record<FeatureClass, GeometryType[]> = {
  land: ['polygon'],
  water: ['polygon'],
  route: ['linestring'],
  protected_region: ['polygon'],
  site: ['point', 'linestring', 'polygon'],
  scope_boundary: ['polygon'],
};

/** Optional subtype vocabularies — mirrors the backend. Unspecified is always allowed. */
export const CLASS_KINDS: Partial<Record<FeatureClass, string[]>> = {
  water: ['open_water', 'channel', 'basin', 'wetland', 'other'],
  route: ['wall', 'bridge', 'causeway', 'road', 'quay_edge', 'conduit', 'other'],
  protected_region: ['no_build', 'preserve_existing', 'reserved'],
};

export const FEATURE_CLASSES = Object.keys(CLASS_GEOMETRY_TYPES) as FeatureClass[];

// ── action availability ─────────────────────────────────────────────────────

export interface Availability {
  enabled: boolean;
  /** Why not, when disabled. */
  reason?: string;
}

export interface FeatureActions {
  editGeometry: Availability;
  editProperties: Availability;
  accept: Availability;
  deleteDraft: Availability;
  revise: Availability;
  editDescriptive: Availability;
  retire: Availability;
  restore: Availability;
  lock: Availability;
  unlock: Availability;
  replacement: Availability;
  draftFromHistory: Availability;
}

const yes: Availability = { enabled: true };
const no = (reason: string): Availability => ({ enabled: false, reason });

/**
 * Which lifecycle actions a feature offers in its current state.
 *
 * - Drafts and proposals: edit, accept (through confirmation), delete.
 * - Accepted, unlocked: revise, descriptive edit, retire, lock, replacement, draft from history.
 * - Accepted, locked: unlock only; every destructive or constraint path waits for it.
 * - Retired: restore.
 *
 * `openRevisionId` is the id of an open draft revision of this accepted row, if one is
 * loaded; revise and draft-from-history point at it rather than creating a second.
 */
export function featureActions(f: CanonicalFeature, openRevisionId: number | null = null): FeatureActions {
  const open = f.lifecycle_state === 'draft' || f.lifecycle_state === 'proposed';
  const accepted = f.lifecycle_state === 'accepted';
  const locked = accepted && f.is_locked;
  const lockedWhy = 'locked — unlock it first (its own request)';
  const onlyAccepted = `only accepted canon; this is ${f.lifecycle_state}`;
  const openRev = openRevisionId !== null ? no(`open draft revision #${openRevisionId} exists — edit or delete it`) : null;
  return {
    editGeometry: open ? yes : no(accepted ? 'accepted geometry changes only through Revise → Accept' : `${f.lifecycle_state} records are not editable`),
    editProperties: open ? yes : no(accepted ? 'accepted constraint fields change only through Revise → Accept' : `${f.lifecycle_state} records are not editable`),
    accept: open ? yes : no(`only drafts and proposals can be accepted; this is ${f.lifecycle_state}`),
    deleteDraft: open ? yes : no('canonical records are retired, never deleted'),
    revise: !accepted ? no(onlyAccepted) : locked ? no(lockedWhy) : openRev ?? yes,
    editDescriptive: !accepted ? no(onlyAccepted) : locked ? no(lockedWhy) : yes,
    retire: !accepted ? no(onlyAccepted) : locked ? no(lockedWhy) : yes,
    restore: f.lifecycle_state === 'retired' ? yes : no(`only retired canon can be restored; this is ${f.lifecycle_state}`),
    lock: !accepted ? no(onlyAccepted) : locked ? no('already locked') : yes,
    unlock: !accepted ? no(onlyAccepted) : !locked ? no('not locked') : yes,
    replacement: !accepted ? no(onlyAccepted) : locked ? no(lockedWhy) : yes,
    draftFromHistory: !accepted ? no(onlyAccepted + (f.lifecycle_state === 'retired' ? ' (restore it first)' : '')) : locked ? no(lockedWhy) : openRev ?? yes,
  };
}

// ── metrics ────────────────────────────────────────────────────────────────

export interface GeometryMetrics {
  vertexCount: number;
  /** Square world units; polygons only. */
  areaWu2: number | null;
  /** World units: perimeter for polygons, length for lines. */
  lengthWu: number | null;
}

const isClosedLine = (line: WorldXZ[]) =>
  line.length > 2 && line[0].x === line[line.length - 1].x && line[0].z === line[line.length - 1].z;

export function geometryMetrics(geometryType: GeometryType, geometry: unknown): GeometryMetrics {
  if (geometryType === 'point') return { vertexCount: 1, areaWu2: null, lengthWu: null };
  if (geometryType === 'linestring') {
    const line = (geometry as WorldXZ[]) ?? [];
    return { vertexCount: isClosedLine(line) ? line.length - 1 : line.length, areaWu2: null, lengthWu: lineLength(line) };
  }
  const poly = geometry as { outer: WorldXZ[]; holes?: WorldXZ[][] };
  const holes = poly?.holes ?? [];
  return {
    vertexCount: (poly?.outer?.length ?? 0) + holes.reduce((s, h) => s + h.length, 0),
    areaWu2: polygonArea(poly?.outer ?? [], holes),
    lengthWu: ringPerimeter(poly?.outer ?? []) + holes.reduce((s, h) => s + ringPerimeter(h), 0),
  };
}

// ── draft request bodies ───────────────────────────────────────────────────

/** The editor's non-geometry choices for a draft. */
export interface FeatureForm {
  feature_class: FeatureClass;
  geometry_type: GeometryType;
  kind: string;
  constraint_strength: 'hard' | 'soft';
  name: string;
  description: string;
  notes: string;
  /** Water only: 'yes' | 'no' | 'unknown' | '' (unspecified). */
  navigable: string;
  /** Route only: width in world units, '' when unspecified. */
  width_wu: string;
}

export const emptyForm = (feature_class: FeatureClass = 'land'): FeatureForm => ({
  feature_class, geometry_type: CLASS_GEOMETRY_TYPES[feature_class][0], kind: '', constraint_strength: 'hard',
  name: '', description: '', notes: '', navigable: '', width_wu: '',
});

export function formFromFeature(f: CanonicalFeature): FeatureForm {
  const a = (f.attributes ?? {}) as Record<string, unknown>;
  return {
    feature_class: f.feature_class,
    geometry_type: f.geometry_type,
    kind: f.kind ?? '',
    constraint_strength: f.constraint_strength,
    name: f.name ?? '',
    description: f.description ?? '',
    notes: f.notes ?? '',
    navigable: typeof a.navigable === 'string' ? a.navigable : '',
    width_wu: typeof a.width_wu === 'number' ? String(a.width_wu) : '',
  };
}

/** Class-validated attributes; every one is optional, and unspecified is omitted (plan §7.1). */
export function formAttributes(form: FeatureForm): Record<string, unknown> | null {
  if (form.feature_class === 'water' && form.navigable) return { navigable: form.navigable };
  if (form.feature_class === 'route' && form.width_wu.trim()) {
    const w = Number(form.width_wu);
    return Number.isFinite(w) ? { width_wu: w } : { width_wu: form.width_wu };
  }
  return null;
}

/** Problems with the form itself, before the server sees it. */
export function formIssues(form: FeatureForm): string[] {
  const issues: string[] = [];
  if (!CLASS_GEOMETRY_TYPES[form.feature_class].includes(form.geometry_type)) {
    issues.push(`a ${form.feature_class} feature cannot have ${form.geometry_type} geometry`);
  }
  if (form.kind && !(CLASS_KINDS[form.feature_class] ?? []).includes(form.kind)) {
    issues.push(`${form.kind} is not a ${form.feature_class} kind`);
  }
  if (form.feature_class === 'route' && form.width_wu.trim()) {
    const w = Number(form.width_wu);
    if (!Number.isFinite(w) || w <= 0) issues.push('width must be a positive number of world units');
  }
  return issues;
}

/** Evidence as stored (plan §3.1): documentation of where geometry came from, never a dependency. */
export interface EvidenceSnapshot {
  reference_layer_id: number;
  calibration_snapshot: { world_center_x: number; world_center_z: number; world_units_per_pixel: number; rotation_rad: number };
  note?: string;
}

/**
 * The body for POST /features or PATCH /features/:id. Never carries lifecycle, lock,
 * replacement, revision or provenance-generated fields — those have their own routes, and
 * the server refuses them here anyway.
 */
export function draftBody(form: FeatureForm, geometry: unknown, construction: Construction | null,
  evidence: EvidenceSnapshot | null | undefined): Record<string, unknown> {
  const body: Record<string, unknown> = {
    feature_class: form.feature_class,
    geometry_type: form.geometry_type,
    kind: form.kind || null,
    constraint_strength: form.constraint_strength,
    name: form.name.trim() || null,
    description: form.description.trim() || null,
    notes: form.notes.trim() || null,
    geometry,
    construction,
    attributes: formAttributes(form),
  };
  // Undefined leaves saved evidence as it was; null or a snapshot replaces it.
  if (evidence !== undefined) body.evidence = evidence;
  return body;
}

/** A server violation/warning/dependent entry, in one line. */
export function describeIssue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.message === 'string') return o.message;
    if (typeof o.entity_type === 'string' && o.id !== undefined) return `${o.entity_type} #${o.id}${o.relation ? ` (${o.relation})` : ''}`;
    return JSON.stringify(v);
  }
  return String(v);
}
