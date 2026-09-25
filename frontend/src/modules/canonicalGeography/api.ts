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
  CanonicalQueryBundle,
  CanonicalAnchor, CanonicalConnection, CanonicalFeature, GeoScope, LifecycleState, ReplacementState,
} from './types';
import type { AnchorRegister } from './anchors';

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

// ── lifecycle requests (world editor) ─────────────────────────────────────────

export type CanonicalEntity = 'features' | 'anchors' | 'connections' | 'scopes';

/**
 * A refusal as the server words it. `violations`, `warnings`, `dependents` and
 * `draft_version` are carried through so the UI can show all of them at once.
 */
export interface CanonicalApiError {
  status: number;
  error: string;
  violations?: unknown[];
  warnings?: unknown[];
  dependents?: unknown[];
  draft_version?: number;
  code?: string;
  [key: string]: unknown;
}

export type CanonicalResult<T> = { ok: true; data: T } | { ok: false; error: CanonicalApiError };

/** One history row (GET /:entity/:id/revisions). */
export interface CanonicalRevision {
  id: number;
  entity_type: string;
  entity_id: number;
  revision: number;
  change_kind: 'accept' | 'descriptive_edit' | 'retire' | 'restore' | 'lock' | 'unlock' | 'replacement_change';
  snapshot: Record<string, unknown>;
  created_at: string;
}

/**
 * One request to the canonical API. Never throws: a network failure or a refusal comes
 * back as `{ok: false}` with the server's own message where there is one, because the
 * caller must keep the editor's unsaved work on screen either way.
 */
export async function canonicalRequest<T>(token: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string,
  body?: unknown): Promise<CanonicalResult<T>> {
  let res: Response;
  try {
    res = await fetch(`${CANONICAL_API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: { status: 0, error: `Network error: ${err instanceof Error ? err.message : String(err)}` } };
  }
  let data: unknown = null;
  try { data = await res.json(); } catch { /* empty or non-JSON body */ }
  if (res.ok) return { ok: true, data: data as T };
  const refusal = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const error: CanonicalApiError = {
    ...refusal,
    status: res.status,
    error: typeof refusal.error === 'string' ? refusal.error : `Request failed (${res.status})`,
  };
  return { ok: false, error };
}

/**
 * The lifecycle operations of plan §5.2, one request each. There is deliberately no
 * combined operation: accept-and-lock is two calls, and unlocking never rides along with
 * another change.
 */
export const canonicalApi = {
  list: <T>(token: string, entity: CanonicalEntity, states: LifecycleState[]) =>
    canonicalRequest<T[]>(token, 'GET', `/${entity}?states=${states.join(',')}&_t=${Date.now()}`),
  create: <T>(token: string, entity: CanonicalEntity, body: Record<string, unknown>) =>
    canonicalRequest<T>(token, 'POST', `/${entity}`, body),
  patch: <T>(token: string, entity: CanonicalEntity, id: number, body: Record<string, unknown>) =>
    canonicalRequest<T>(token, 'PATCH', `/${entity}/${id}`, body),
  remove: (token: string, entity: CanonicalEntity, id: number) =>
    canonicalRequest<{ id: number; deleted: true }>(token, 'DELETE', `/${entity}/${id}`),
  revise: <T>(token: string, entity: CanonicalEntity, id: number) =>
    canonicalRequest<T>(token, 'POST', `/${entity}/${id}/revise`),
  accept: <T>(token: string, entity: CanonicalEntity, id: number, expectedDraftVersion: number) =>
    canonicalRequest<{ record: T; warnings: unknown[] }>(token, 'POST', `/${entity}/${id}/accept`,
      { expected_draft_version: expectedDraftVersion }),
  retire: <T>(token: string, entity: CanonicalEntity, id: number) =>
    canonicalRequest<T>(token, 'POST', `/${entity}/${id}/retire`),
  restore: <T>(token: string, entity: CanonicalEntity, id: number) =>
    canonicalRequest<{ record: T; warnings: unknown[] }>(token, 'POST', `/${entity}/${id}/restore`),
  setLock: <T>(token: string, entity: CanonicalEntity, id: number, isLocked: boolean) =>
    canonicalRequest<T>(token, 'PATCH', `/${entity}/${id}/lock`, { is_locked: isLocked }),
  setReplacement: <T>(token: string, entity: CanonicalEntity, id: number, replacementState: ReplacementState) =>
    canonicalRequest<T>(token, 'PATCH', `/${entity}/${id}/replacement`, { replacement_state: replacementState }),
  history: (token: string, entity: CanonicalEntity, id: number) =>
    canonicalRequest<CanonicalRevision[]>(token, 'GET', `/${entity}/${id}/revisions`),
  draftFromHistory: <T>(token: string, entity: CanonicalEntity, id: number, revision: number) =>
    canonicalRequest<T>(token, 'POST', `/${entity}/${id}/revisions/${revision}/draft`),
  /** The generator-facing query (WP3): accepted canon only, used for a scope's spatial contents. */
  query: (token: string, body: Record<string, unknown>) =>
    canonicalRequest<CanonicalQueryBundle>(token, 'POST', '/query', body),
  /** Accepted anchors with derived placed/unplaced status and part summary (WP6). */
  anchorRegister: (token: string) =>
    canonicalRequest<AnchorRegister>(token, 'GET', `/anchors/register?_t=${Date.now()}`),
};
