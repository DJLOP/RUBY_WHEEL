/**
 * Fetch helpers for canonical geography (plan §5.1).
 *
 * Accepted canon is a public read, like the rest of the shared world scene. The world
 * editor additionally sees their working set — drafts and proposals — which needs their
 * token; if the server refuses it (a temporary admin, an expired session) the client falls
 * back to accepted canon rather than showing nothing. Retired rows are never fetched here:
 * they are hidden unless a later manager view filters them in.
 */

import type {
  CanonicalAnchor, CanonicalConnection, CanonicalFeature, GeoScope, LifecycleState,
} from './types';

export const CANONICAL_API = '/api/canonical-geography';

export interface CanonicalGeographyData {
  features: CanonicalFeature[];
  anchors: CanonicalAnchor[];
  connections: CanonicalConnection[];
  scopes: GeoScope[];
  /** Whether drafts and proposals were requested and granted. */
  includesWorkingSet: boolean;
}

export const EMPTY_CANONICAL_GEOGRAPHY: CanonicalGeographyData = {
  features: [], anchors: [], connections: [], scopes: [], includesWorkingSet: false,
};

const ENTITIES = ['features', 'anchors', 'connections', 'scopes'] as const;
const WORKING_STATES: LifecycleState[] = ['accepted', 'draft', 'proposed'];

async function fetchLists(states: LifecycleState[] | null, token: string | null) {
  const query = states ? `states=${states.join(',')}&` : '';
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const responses = await Promise.all(ENTITIES.map(e =>
    fetch(`${CANONICAL_API}/${e}?${query}_t=${Date.now()}`, { headers })));
  if (responses.some(r => !r.ok)) return null;
  const [features, anchors, connections, scopes] = await Promise.all(responses.map(r => r.json()));
  return { features, anchors, connections, scopes };
}

/**
 * Accepted canon, plus the working set when a world-editor token is given. Throws only if
 * even the public accepted read fails.
 */
export async function fetchCanonicalGeography(worldEditorToken: string | null): Promise<CanonicalGeographyData> {
  if (worldEditorToken) {
    const working = await fetchLists(WORKING_STATES, worldEditorToken);
    if (working) return { ...working, includesWorkingSet: true };
  }
  const accepted = await fetchLists(null, null);
  if (!accepted) throw new Error('canonical geography could not be loaded');
  return { ...accepted, includesWorkingSet: false };
}
