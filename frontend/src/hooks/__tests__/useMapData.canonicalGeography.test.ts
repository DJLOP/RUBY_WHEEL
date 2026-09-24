/**
 * Canonical geography joins the map collections (WP4): accepted canon for everyone in the
 * bulk refresh; drafts and proposals only with the world editor's token, falling back to
 * accepted canon when the server refuses it; and a late response never overwrites a newer
 * one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useMapData } from '../useMapData';

const ACCEPTED = { id: 1, entity_type: 'feature', lifecycle_state: 'accepted' };
const DRAFT = { id: 2, entity_type: 'feature', lifecycle_state: 'draft' };

let fetchMock: ReturnType<typeof vi.fn>;
let refuseWorkingSet: boolean;

beforeEach(() => {
  refuseWorkingSet = false;
  fetchMock = vi.fn((url: string, init?: { headers?: Record<string, string> }) => {
    const u = String(url);
    if (!u.startsWith('/api/canonical-geography/')) return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    const working = u.includes('states=');
    if (working && (refuseWorkingSet || !init?.headers?.Authorization)) {
      return Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({ error: 'forbidden' }) });
    }
    const body = u.startsWith('/api/canonical-geography/features') ? (working ? [ACCEPTED, DRAFT] : [ACCEPTED]) : [];
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

const canonicalCalls = () => fetchMock.mock.calls
  .filter(c => String(c[0]).startsWith('/api/canonical-geography/'))
  .map(c => ({ url: String(c[0]).replace(/[?&]_t=\d+/, ''), auth: c[1]?.headers?.Authorization ?? null }));

describe('useMapData canonical geography', () => {
  it('starts empty', () => {
    const { result } = renderHook(() => useMapData());
    expect(result.current.canonicalGeography).toEqual({ features: [], anchors: [], connections: [], scopes: [], includesWorkingSet: false });
  });

  it('is part of the bulk refresh, as a public read of accepted canon', async () => {
    const { result } = renderHook(() => useMapData());
    await act(async () => { result.current.fetchAll(); });
    await waitFor(() => expect(result.current.canonicalGeography.features).toEqual([ACCEPTED]));
    expect(canonicalCalls()).toEqual(['features', 'anchors', 'connections', 'scopes']
      .map(e => ({ url: `/api/canonical-geography/${e}`, auth: null })));
    expect(result.current.canonicalGeography.includesWorkingSet).toBe(false);
  });

  it('adds drafts and proposals with the world editor\'s token', async () => {
    const { result } = renderHook(() => useMapData());
    act(() => result.current.setCanonicalWorldEditorToken('editor-token'));
    await act(async () => { result.current.fetchCanonicalGeography(); });
    await waitFor(() => expect(result.current.canonicalGeography.features).toEqual([ACCEPTED, DRAFT]));
    expect(result.current.canonicalGeography.includesWorkingSet).toBe(true);
    expect(canonicalCalls()[0]).toEqual({ url: '/api/canonical-geography/features?states=accepted,draft,proposed', auth: 'Bearer editor-token' });
  });

  it('falls back to accepted canon when the working set is refused', async () => {
    refuseWorkingSet = true;
    const { result } = renderHook(() => useMapData());
    act(() => result.current.setCanonicalWorldEditorToken('temp-admin-token'));
    await act(async () => { result.current.fetchCanonicalGeography(); });
    await waitFor(() => expect(result.current.canonicalGeography.features).toEqual([ACCEPTED]));
    expect(result.current.canonicalGeography.includesWorkingSet).toBe(false);
  });

  it('drops a response that arrives after a newer one', async () => {
    const resolvers: ((v: unknown) => void)[] = [];
    fetchMock.mockImplementation((url: string) => {
      const u = String(url);
      const body = u.startsWith('/api/canonical-geography/features') ? [{ ...ACCEPTED, id: resolvers.length + 1 }] : [];
      return new Promise(res => resolvers.push(() => res({ ok: true, json: () => Promise.resolve(body) })));
    });
    const { result } = renderHook(() => useMapData());
    act(() => { result.current.fetchCanonicalGeography(); }); // requests 1–4 (features is id 1)
    act(() => { result.current.fetchCanonicalGeography(); }); // requests 5–8 (features is id 5)
    await act(async () => { for (const r of resolvers.slice(4)) r(undefined); });
    await waitFor(() => expect(result.current.canonicalGeography.features.map(f => f.id)).toEqual([5]));
    await act(async () => { for (const r of resolvers.slice(0, 4)) r(undefined); });
    expect(result.current.canonicalGeography.features.map(f => f.id)).toEqual([5]);
  });
});
