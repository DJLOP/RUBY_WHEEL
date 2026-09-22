/**
 * Reference layers join the canonical map collections rather than being fetched wherever
 * they happen to be needed. That is what makes one refresh path — and later one socket
 * event — cover them along with roads, water and signs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useMapData } from '../useMapData';

const LAYER = {
  id: 1,
  name: 'Imperial City',
  asset_id: 1,
  asset_url: '/uploads/reference_layers/abc.png',
  original_name: 'city.png',
  format: 'png',
  source_width_px: 6032,
  source_height_px: 4584,
  world_center_x: 0,
  world_center_z: 0,
  world_units_per_pixel: 0.5,
  rotation_rad: 0,
  opacity: 1,
  is_visible: true,
  is_locked: false,
  provenance: 'imported',
  replacement_state: 'non_replaceable',
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn((url: string) =>
    Promise.resolve({ json: () => Promise.resolve(url.startsWith('/api/reference-layers') ? [LAYER] : []) })
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

const urlsFetched = () => fetchMock.mock.calls.map(c => String(c[0]).split('?')[0]);

describe('useMapData reference layers', () => {
  it('starts empty', () => {
    const { result } = renderHook(() => useMapData());
    expect(result.current.referenceLayers).toEqual([]);
  });

  it('fetches the persisted list and stores it', async () => {
    const { result } = renderHook(() => useMapData());
    await act(async () => { result.current.fetchReferenceLayers(); });
    await waitFor(() => expect(result.current.referenceLayers).toEqual([LAYER]));
    expect(urlsFetched()).toContain('/api/reference-layers');
  });

  it('is part of the initial bulk refresh', async () => {
    const { result } = renderHook(() => useMapData());
    await act(async () => { result.current.fetchAll(); });
    await waitFor(() => expect(result.current.referenceLayers).toEqual([LAYER]));
    expect(urlsFetched()).toEqual(expect.arrayContaining([
      '/api/locations', '/api/roads', '/api/water', '/api/signs', '/api/reference-layers',
    ]));
  });

  it('leaves the collection alone when the request fails', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('offline')));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderHook(() => useMapData());
    await act(async () => { result.current.fetchReferenceLayers(); });
    expect(result.current.referenceLayers).toEqual([]);
    errors.mockRestore();
  });
});
