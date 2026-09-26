/**
 * Decisions of the radial constructor workflow (plan §15.9, §15.3.4): which features
 * belong to a construction, whether revision mode may be offered, and the output settings.
 *
 * Pure: no React, Three.js, network or reference-layer imports. The panel only presents
 * these; the server re-checks every one of them inside the construct transaction.
 */

import type { CanonicalFeature } from './types';
import type { RadialSpokeConstruction } from './geometry';

/** Output feature settings of a new-drafts construction (plan §15.3.4), as the construct request carries them. */
export interface RadialOutputSettings {
  feature_class: 'route' | 'site';
  kind?: string | null;
  constraint_strength: 'hard' | 'soft';
  width_wu?: number | null;
  name_prefix?: string;
}

export type RadialSpokeFeature = CanonicalFeature & { construction: RadialSpokeConstruction };

export const isRadialSpoke = (f: CanonicalFeature | null | undefined): f is RadialSpokeFeature =>
  !!f && !!f.construction && (f.construction as { type?: string }).type === 'radial_spoke';

const byIndex = (a: RadialSpokeFeature, b: RadialSpokeFeature) => a.construction.index - b.construction.index || a.id - b.id;

/** Every live feature carrying spokes of this construction (drafts, proposals and accepted). */
export const constructionMembers = (features: CanonicalFeature[], constructionId: string): RadialSpokeFeature[] =>
  features.filter((f): f is RadialSpokeFeature => f.lifecycle_state !== 'retired' && isRadialSpoke(f) && f.construction.construction_id === constructionId)
    .sort(byIndex);

export type RevisionAvailability =
  | { enabled: true; revises: { index: number; feature_id: number; expected_revision: number }[] }
  | { enabled: false; reason: string };

const sameList = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Whether revision mode may be offered for a reconstruction (plan §15.9): every
 * non-omitted index has exactly one accepted spoke of the construction, all of them are
 * named, unlocked and without an open draft revision, their records agree, and the
 * requested N and omissions equal the recorded ones. The server re-checks every condition.
 */
export function revisionAvailability(features: CanonicalFeature[], constructionId: string, count: number | null, omit: number[]): RevisionAvailability {
  const accepted = features.filter((f): f is RadialSpokeFeature => f.lifecycle_state === 'accepted' && isRadialSpoke(f)
    && f.construction.construction_id === constructionId).sort(byIndex);
  if (!accepted.length) return { enabled: false, reason: 'no accepted spoke of this construction exists; use new-drafts mode' };
  const rec = accepted[0].construction;
  if (!accepted.every(f => f.construction.count === rec.count && sameList(f.construction.omit_indices, rec.omit_indices))) {
    return { enabled: false, reason: 'the accepted spokes\' records disagree on N or omissions; use new-drafts mode' };
  }
  if (count !== rec.count) {
    return { enabled: false, reason: `N differs from the recorded ${rec.count}: changing the spoke count is a new set of spokes — use NEW DRAFTS mode (or restore N = ${rec.count})` };
  }
  if (!sameList(omit, rec.omit_indices)) {
    return { enabled: false, reason: `omissions differ from the recorded [${rec.omit_indices.join(', ')}]: changing omissions is a new set of spokes — use NEW DRAFTS mode (or restore them)` };
  }
  const omitted = new Set(rec.omit_indices);
  for (let n = 0; n < rec.count; n++) {
    const at = accepted.filter(f => f.construction.index === n);
    if (omitted.has(n)) continue;
    if (at.length !== 1) {
      return { enabled: false, reason: at.length ? `spoke ${n} has ${at.length} accepted features` : `spoke ${n} has no accepted feature (accept or recreate it first, or use new-drafts mode)` };
    }
  }
  const locked = accepted.filter(f => f.is_locked);
  if (locked.length) {
    return { enabled: false, reason: `locked: ${locked.map(f => `spoke ${f.construction.index} (#${f.id})`).join(', ')} — unlock (its own request) first` };
  }
  const open = accepted.filter(f => features.some(x => x.revises_id === f.id && x.lifecycle_state === 'draft'));
  if (open.length) {
    return { enabled: false, reason: `open draft revision on ${open.map(f => `spoke ${f.construction.index} (#${f.id})`).join(', ')} — accept or delete it first` };
  }
  return { enabled: true, revises: accepted.map(f => ({ index: f.construction.index, feature_id: f.id, expected_revision: f.revision })) };
}

export interface OutputForm { feature_class: 'route' | 'site'; kind: string; constraint_strength: 'hard' | 'soft'; width_wu: string; name_prefix: string }
export const DEFAULT_OUTPUT: OutputForm = { feature_class: 'route', kind: '', constraint_strength: 'hard', width_wu: '', name_prefix: 'Spoke' };

export function outputSettings(form: OutputForm): { ok: true; output: RadialOutputSettings } | { ok: false; reason: string } {
  const out: RadialOutputSettings = { feature_class: form.feature_class, constraint_strength: form.constraint_strength };
  if (form.kind) out.kind = form.kind;
  if (form.feature_class === 'route' && form.width_wu.trim()) {
    const w = Number(form.width_wu);
    if (!Number.isFinite(w) || w <= 0) return { ok: false, reason: 'width must be a positive number of world units' };
    out.width_wu = w;
  }
  if (form.name_prefix.trim()) out.name_prefix = form.name_prefix.trim();
  return { ok: true, output: out };
}
