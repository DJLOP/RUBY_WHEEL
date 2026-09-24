/**
 * Canonical geography on the inherited `dataUpdated` path (WP4).
 *
 * The canonical routes flag their broadcasts `canonicalGeography: true`; only those refetch
 * canonical geography. Every other broadcast — inherited edits, token movement — leaves it
 * alone, because at city scale the canonical set is megabytes and nothing else changes it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

type Handler = (data?: any) => void;

const listeners: Record<string, Handler[]> = {};
const fakeSocket = {
  on: (event: string, fn: Handler) => { (listeners[event] ??= []).push(fn); },
  off: (event: string) => { listeners[event] = []; },
  emit: vi.fn(),
  disconnect: vi.fn(),
  connected: false,
};

vi.mock('socket.io-client', () => ({ io: () => fakeSocket }));

import { useSocket } from '../useSocket';

const serverEmit = (event: string, data?: any) => act(() => {
  (listeners[event] ?? []).forEach(h => h(data));
});

let callbacks: Record<string, ReturnType<typeof vi.fn>>;

const mount = (extra: Record<string, unknown> = {}) => {
  callbacks = {
    onFetchAll: vi.fn(), onFetchLocations: vi.fn(), onFetchRoads: vi.fn(), onFetchDistricts: vi.fn(),
    onFetchWaterBodies: vi.fn(), onFetchReferenceLayers: vi.fn(), onFetchCanonicalGeography: vi.fn(),
    onBankUpdate: vi.fn(), onNotification: vi.fn(), onHasUnreadChat: vi.fn(), onTokenUpdate: vi.fn(), onIsAdminUpdate: vi.fn(),
  };
  return renderHook(() => useSocket({
    userName: 'ADMIN', token: 'admintoken', isLoggedIn: true, notificationsEnabled: false, isChatOpen: false,
    ...callbacks, ...extra,
  } as any));
};

beforeEach(() => {
  for (const key of Object.keys(listeners)) delete listeners[key];
  vi.clearAllMocks();
});

describe('canonical geography on the dataUpdated path', () => {
  it('refetches when a canonical mutation is broadcast', () => {
    mount();
    serverEmit('dataUpdated', { canonicalGeography: true });
    expect(callbacks.onFetchCanonicalGeography).toHaveBeenCalledTimes(1);
  });

  it('does not refetch for inherited or rhombus-only broadcasts', () => {
    mount();
    serverEmit('dataUpdated', {});
    serverEmit('dataUpdated', { isRhombusOnly: true });
    serverEmit('dataUpdated', undefined);
    expect(callbacks.onFetchCanonicalGeography).not.toHaveBeenCalled();
    expect(callbacks.onFetchLocations).toHaveBeenCalledTimes(3);
  });

  it('refreshes once per canonical broadcast', () => {
    mount();
    serverEmit('dataUpdated', { canonicalGeography: true });
    serverEmit('dataUpdated', { canonicalGeography: true });
    expect(callbacks.onFetchCanonicalGeography).toHaveBeenCalledTimes(2);
  });

  it('survives a client that never asked for canonical geography', () => {
    mount({ onFetchCanonicalGeography: undefined });
    expect(() => serverEmit('dataUpdated', { canonicalGeography: true })).not.toThrow();
  });
});
