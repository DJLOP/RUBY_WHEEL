import type { CanonicalResult } from './api';
import { canonicalApi } from './api';
import type { GeoScope, LandCoverage } from './types';
import { openScopeRevision } from './scopes';

export type ScopeChange = Partial<{ members: number[]; boundary_feature_id: number | null; land_coverage: LandCoverage; parent_scope_id: number | null }>;

/**
 * Stage constraint changes on a scope: a draft or proposal is patched directly; an
 * accepted scope gets (or reuses) its open draft revision, which is patched. Accepted canon
 * is never edited in place, and nothing here accepts.
 */
export async function stageScopeChange(token: string, scopes: GeoScope[], scope: GeoScope, changes: ScopeChange):
  Promise<CanonicalResult<{ draft: GeoScope; revisionCreated: boolean }>> {
  let target = scope;
  let revisionCreated = false;
  if (scope.lifecycle_state === 'retired') {
    return { ok: false, error: { status: 0, error: `scope #${scope.id} is retired; restore it before changing it` } };
  }
  if (scope.lifecycle_state === 'accepted') {
    const open = openScopeRevision(scopes, scope.id);
    if (open) target = open;
    else {
      const revised = await canonicalApi.revise<GeoScope>(token, 'scopes', scope.id);
      if (!revised.ok) return revised;
      target = revised.data;
      revisionCreated = true;
    }
  }
  const patched = await canonicalApi.patch<GeoScope>(token, 'scopes', target.id, { ...changes, expected_draft_version: target.draft_version });
  if (!patched.ok) return patched;
  return { ok: true, data: { draft: patched.data, revisionCreated } };
}
