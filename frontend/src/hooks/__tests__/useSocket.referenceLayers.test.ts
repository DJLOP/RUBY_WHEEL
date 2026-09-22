/**
 * One client's committed change reaching another client.
 *
 * Reference layers ride the inherited server-wide `dataUpdated` broadcast and the refetch
 * it triggers, rather than getting an event and a patch protocol of their own. An Apply is
 * an occasional, deliberate action, so a refetch is cheap and there is nothing here that a
 * targeted event would buy.
 *
 * The two halves that matter: a real broadcast must refresh the list, and a rhombus-only
 * broadcast must not. The second is not an optimisation detail — token and sheet movement
 * emits that flag constantly, and a request per step for a collection that changes when an
 * admin presses a button would be a request per step forever.
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

/** The server broadcasting to this client. */
const serverEmit = (event: string, data?: any) => act(() => {
  (listeners[event] ?? []).forEach(h => h(data));
});

let callbacks: Record<string, ReturnType<typeof vi.fn>>;

const mount = () => {
  callbacks = {
    onFetchAll: vi.fn(),
    onFetchLocations: vi.fn(),
    onFetchRoads: vi.fn(),
    onFetchDistricts: vi.fn(),
    onFetchWaterBodies: vi.fn(),
    onFetchOverpasses: vi.fn(),
    onFetchSigns: vi.fn(),
    onFetchReferenceLayers: vi.fn(),
    onFetchBattleMaps: vi.fn(),
    onBankUpdate: vi.fn(),
    onNotification: vi.fn(),
    onHasUnreadChat: vi.fn(),
    onTokenUpdate: vi.fn(),
    onIsAdminUpdate: vi.fn(),
  };
  return renderHook(() => useSocket({
    userName: 'ADMIN',
    token: 'admintoken',
    isLoggedIn: true,
    notificationsEnabled: false,
    isChatOpen: false,
    ...callbacks,
  } as any));
};

beforeEach(() => {
  for (const key of Object.keys(listeners)) delete listeners[key];
  vi.clearAllMocks();
});

describe('reference layers on the inherited dataUpdated path', () => {
  it('refetches the layers when another client commits a change', () => {
    mount();
    serverEmit('dataUpdated', {});
    expect(callbacks.onFetchReferenceLayers).toHaveBeenCalledTimes(1);
  });

  it('refreshes them alongside the other canonical collections, not instead of them', () => {
    mount();
    serverEmit('dataUpdated', {});
    for (const name of ['onFetchLocations', 'onFetchRoads', 'onFetchDistricts', 'onFetchWaterBodies', 'onFetchSigns']) {
      expect(callbacks[name], name).toHaveBeenCalledTimes(1);
    }
  });

  it('does not refetch them for a rhombus-only update', () => {
    mount();
    serverEmit('dataUpdated', { isRhombusOnly: true });
    expect(callbacks.onFetchReferenceLayers).not.toHaveBeenCalled();
    // The token itself still moves, which is what that broadcast is for.
    expect(callbacks.onFetchLocations).toHaveBeenCalledTimes(1);
  });

  it('refreshes once per broadcast, and again on the next one', () => {
    mount();
    serverEmit('dataUpdated', {});
    serverEmit('dataUpdated', {});
    expect(callbacks.onFetchReferenceLayers).toHaveBeenCalledTimes(2);
  });

  // The callback is optional on the hook, and a client that does not pass one — the
  // standalone sheet page, for instance — must not fall over on a broadcast.
  it('survives a client that never asked for reference layers', () => {
    const { result } = renderHook(() => useSocket({
      userName: 'PLAYER',
      token: '',
      isLoggedIn: true,
      notificationsEnabled: false,
      isChatOpen: false,
      onFetchAll: vi.fn(),
      onFetchLocations: vi.fn(),
      onFetchRoads: vi.fn(),
      onFetchDistricts: vi.fn(),
      onFetchWaterBodies: vi.fn(),
      onBankUpdate: vi.fn(),
      onNotification: vi.fn(),
      onHasUnreadChat: vi.fn(),
      onTokenUpdate: vi.fn(),
      onIsAdminUpdate: vi.fn(),
    } as any));

    expect(() => serverEmit('dataUpdated', {})).not.toThrow();
    expect(result.current.socketRef.current).toBe(fakeSocket);
  });
});

describe('what reference layers do not put on the socket', () => {
  // Rasters go over HTTP from /uploads; the socket carries "something changed" and
  // nothing else. A client that only listens must never be handed image bytes.
  it('registers no reference-layer event of its own', () => {
    mount();
    const registered = Object.keys(listeners);
    expect(registered.filter(e => /reference/i.test(e))).toEqual([]);
    expect(registered).toContain('dataUpdated');
  });

  it('emits nothing back to the server on a refresh', () => {
    mount();
    fakeSocket.emit.mockClear();
    serverEmit('dataUpdated', {});
    expect(fakeSocket.emit).not.toHaveBeenCalled();
  });
});
