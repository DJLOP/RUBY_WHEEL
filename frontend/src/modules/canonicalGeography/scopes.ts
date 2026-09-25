/**
 * Scope hierarchy and explicit land membership, as the scope manager shows and edits them
 * (plan §3.5, §6.3, WP6).
 *
 * Pure: no React, Three.js, network or reference-layer imports.
 *
 * Membership is explicit and persisted on the scope (`members`); nothing here infers it
 * from geometry. The helpers only describe the current state (who holds which island, the
 * ancestry of a scope) and build request bodies. Coherence — one district and one island
 * group per island, memberships on one ancestry chain, parent rank — is the server's to
 * decide at accept, and a refusal is shown as the server words it.
 *
 * Scopes carry no planning fields (culture, wealth, crops, profiles, budgets, density):
 * those attach to scopes by id in later slices (plan §3.5).
 */

import type { CanonicalFeature, GeoScope, LandCoverage, ScopeKind } from './types';

/** city < district < island_group < subregion; a parent must rank strictly lower (plan §3.5). */
export const SCOPE_RANK: Record<ScopeKind, number> = { city: 0, district: 1, island_group: 2, subregion: 3 };

/** The kinds the editor creates. The single city scope is structural (migration 002). */
export const EDITABLE_SCOPE_KINDS: ScopeKind[] = ['district', 'island_group', 'subregion'];

export const SCOPE_KIND_LABEL: Record<ScopeKind, string> = {
  city: 'city', district: 'district', island_group: 'island group', subregion: 'subregion',
};

/**
 * Region scopes (district, subregion) are drawn spatial regions: their boundary is the
 * normal representation, it may cut across islands, and whole-island membership is
 * optional. An island group is a set of whole islands: explicit membership is its
 * representation. The city is structural.
 */
export const isRegionKind = (kind: ScopeKind) => kind === 'district' || kind === 'subregion';

/** A canonical scope row (or a new draft), not a draft/proposal revision of another. */
export const isScopeIdentity = (s: GeoScope) => s.revises_id === null;

export const scopeLabel = (s: Pick<GeoScope, 'id' | 'name' | 'scope_kind'> | null | undefined) =>
  (s ? `#${s.id} ${s.name ?? '(unnamed)'} (${SCOPE_KIND_LABEL[s.scope_kind]})` : '—');

export const findScope = (scopes: GeoScope[], id: number | null | undefined) =>
  (id == null ? null : scopes.find(s => s.id === id) ?? null);

/** The open draft/proposed revision of an accepted scope, if the working set holds one. */
export const openScopeRevision = (scopes: GeoScope[], scopeId: number, state: 'draft' | 'proposed' = 'draft') =>
  scopes.find(s => s.revises_id === scopeId && s.lifecycle_state === state) ?? null;

/** Child scopes (accepted and new drafts, never revisions), sorted by kind rank then name. */
export function childrenOf(scopes: GeoScope[], id: number): GeoScope[] {
  return scopes
    .filter(s => isScopeIdentity(s) && s.parent_scope_id === id && s.id !== id)
    .sort((a, b) => SCOPE_RANK[a.scope_kind] - SCOPE_RANK[b.scope_kind] || (a.name ?? '').localeCompare(b.name ?? '') || a.id - b.id);
}

/** Root-first ancestry of a scope (excluding itself), following parent ids; cycle-safe. */
export function ancestryOf(scopes: GeoScope[], scope: GeoScope): GeoScope[] {
  const out: GeoScope[] = [];
  const seen = new Set<number>([scope.id]);
  for (let cur = findScope(scopes, scope.parent_scope_id); cur && !seen.has(cur.id); cur = findScope(scopes, cur.parent_scope_id)) {
    seen.add(cur.id);
    out.unshift(cur);
  }
  return out;
}

/** Scopes that may parent a scope of `kind`: lower rank, not itself, not a revision. Accepted first. */
export function parentOptions(scopes: GeoScope[], kind: ScopeKind, selfId: number | null): GeoScope[] {
  return scopes
    .filter(s => isScopeIdentity(s) && s.id !== selfId && s.lifecycle_state !== 'retired' && SCOPE_RANK[s.scope_kind] < SCOPE_RANK[kind])
    .sort((a, b) => Number(b.lifecycle_state === 'accepted') - Number(a.lifecycle_state === 'accepted')
      || SCOPE_RANK[a.scope_kind] - SCOPE_RANK[b.scope_kind] || a.id - b.id);
}

/** Roots for the hierarchy view: scopes with no parent, or whose parent is not in the list. */
export function scopeRoots(scopes: GeoScope[]): GeoScope[] {
  const ids = new Set(scopes.filter(isScopeIdentity).map(s => s.id));
  return scopes.filter(s => isScopeIdentity(s) && (s.parent_scope_id === null || !ids.has(s.parent_scope_id)))
    .sort((a, b) => SCOPE_RANK[a.scope_kind] - SCOPE_RANK[b.scope_kind] || a.id - b.id);
}

export interface LandMembership {
  /** Accepted scopes that list this land, by kind. */
  byKind: Partial<Record<ScopeKind, GeoScope>>;
  /** Every accepted scope listing it (normally at most one per kind). */
  accepted: GeoScope[];
  /** Root-first ancestry of its deepest accepted membership, including that scope. */
  chain: GeoScope[];
  /** Open drafts/proposals (new scopes or revisions) that list it — pending, not canon. */
  pending: GeoScope[];
}

/** Where an island currently sits in the hierarchy — explicit memberships only. */
export function landMembership(scopes: GeoScope[], featureId: number): LandMembership {
  const accepted = scopes.filter(s => s.lifecycle_state === 'accepted' && (s.members ?? []).includes(featureId))
    .sort((a, b) => SCOPE_RANK[a.scope_kind] - SCOPE_RANK[b.scope_kind] || a.id - b.id);
  const byKind: Partial<Record<ScopeKind, GeoScope>> = {};
  for (const s of accepted) if (!byKind[s.scope_kind]) byKind[s.scope_kind] = s;
  const deepest = accepted[accepted.length - 1];
  const chain = deepest ? [...ancestryOf(scopes, deepest), deepest] : [];
  const pending = scopes.filter(s => (s.lifecycle_state === 'draft' || s.lifecycle_state === 'proposed') && (s.members ?? []).includes(featureId));
  return { byKind, accepted, chain, pending };
}

/** Members after adding and removing; sorted, de-duplicated. */
export function membersAfter(current: number[], add: number[] = [], remove: number[] = []): number[] {
  const drop = new Set(remove);
  return [...new Set([...current, ...add])].filter(id => !drop.has(id)).sort((a, b) => a - b);
}

export interface MembershipChange { added: number[]; removed: number[] }

export function membershipChange(before: number[], after: number[]): MembershipChange {
  const b = new Set(before);
  const a = new Set(after);
  return { added: after.filter(id => !b.has(id)), removed: before.filter(id => !a.has(id)) };
}

/**
 * Islands being added that another accepted scope of the same kind already holds. This is
 * shown as information before the request; the server's refusal remains the authority, and
 * nothing here moves an island out of its current scope.
 */
export function sameKindHolders(scopes: GeoScope[], target: Pick<GeoScope, 'id' | 'scope_kind' | 'revises_id'>, adding: number[]):
  { featureId: number; holder: GeoScope }[] {
  const canonicalId = target.revises_id ?? target.id;
  const out: { featureId: number; holder: GeoScope }[] = [];
  for (const fid of adding) {
    const holder = scopes.find(s => s.lifecycle_state === 'accepted' && s.id !== canonicalId && s.scope_kind === target.scope_kind && s.members.includes(fid));
    if (holder) out.push({ featureId: fid, holder });
  }
  return out;
}

/** Accepted scope_boundary polygons and drafts, for a scope's optional boundary. */
export const boundaryCandidates = (features: CanonicalFeature[]) =>
  features.filter(f => f.feature_class === 'scope_boundary' && f.revises_id === null
    && (f.lifecycle_state === 'accepted' || f.lifecycle_state === 'draft' || f.lifecycle_state === 'proposed'));

// ── the scope form ──────────────────────────────────────────────────────────

export interface ScopeForm {
  scope_key: string;
  name: string;
  scope_kind: ScopeKind;
  parent_scope_id: number | '';
  boundary_feature_id: number | '';
  land_coverage: LandCoverage;
  description: string;
  notes: string;
}

export const emptyScopeForm = (kind: ScopeKind = 'district', parentId: number | '' = ''): ScopeForm => ({
  scope_key: '', name: '', scope_kind: kind, parent_scope_id: parentId, boundary_feature_id: '', land_coverage: 'partial',
  description: '', notes: '',
});

export const scopeFormFrom = (s: GeoScope): ScopeForm => ({
  scope_key: s.scope_key, name: s.name ?? '', scope_kind: s.scope_kind, parent_scope_id: s.parent_scope_id ?? '',
  boundary_feature_id: s.boundary_feature_id ?? '', land_coverage: s.land_coverage,
  description: s.description ?? '', notes: s.notes ?? '',
});

const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** Key text as a slug suggestion from a name ("Arena District" → "arena-district"). */
export const slugify = (name: string) => name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

export function scopeFormIssues(form: ScopeForm): string[] {
  const issues: string[] = [];
  if (!KEY_PATTERN.test(form.scope_key) || form.scope_key.length > 80) issues.push('key must be a lowercase slug (a-z, 0-9, _ or -)');
  if (!form.name.trim()) issues.push('name is required');
  if (form.scope_kind !== 'city' && form.parent_scope_id === '') issues.push(`a ${SCOPE_KIND_LABEL[form.scope_kind]} needs a parent scope`);
  return issues;
}

/**
 * Body for POST /scopes or PATCH /scopes/:id. Members are sent only when given, so a form
 * save never silently rewrites membership edited elsewhere.
 */
export function scopeBody(form: ScopeForm, members?: number[]): Record<string, unknown> {
  const body: Record<string, unknown> = {
    scope_key: form.scope_key,
    name: form.name.trim(),
    scope_kind: form.scope_kind,
    parent_scope_id: form.parent_scope_id === '' ? null : form.parent_scope_id,
    boundary_feature_id: form.boundary_feature_id === '' ? null : form.boundary_feature_id,
    land_coverage: form.land_coverage,
    description: form.description.trim() || null,
    notes: form.notes.trim() || null,
  };
  if (members) body.members = members;
  return body;
}

/** What marking coverage complete means, in words the confirmation shows before it is applied. */
export const COMPLETE_COVERAGE_CONSEQUENCE =
  'Marking land coverage COMPLETE declares that every island inside this scope\'s extent has been traced and accepted. '
  + 'Generator queries will then treat every point in the extent that is not accepted land as WATER (by complement), '
  + 'not as unknown. Any island not yet traced inside the extent would be read as water. '
  + 'Partial coverage (the default) leaves untraced ground unknown — neither buildable nor water.';
