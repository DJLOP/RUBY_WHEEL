/**
 * Who is offered the canonical-geography launcher (WP4): the primary administrator only,
 * on the CITY tab. This is which button is drawn — the backend enforces world-editor
 * authorization on every canonical mutation regardless.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../utils/locationHelpers', () => ({
  isUserDefinedName: (name: string) => !!name && name.trim() !== '',
  getStructLabel: (loc: any) => `STRUCT_${loc.id}`,
}));

import { AdminPanel } from '../AdminPanel';

const props = (over: any = {}): any => ({
  socketRef: { current: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } },
  token: 'admintoken', onLogout: vi.fn(), refreshLocations: vi.fn(), refreshRoads: vi.fn(),
  locations: [], roads: [], editData: {}, setEditData: vi.fn(), editId: null, setEditId: vi.fn(),
  transformMode: 'translate', setTransformMode: vi.fn(), targetObject: null, selectedLocation: null,
  setSelectedLocation: vi.fn(), setTargetObject: vi.fn(), controlsRef: { current: null }, view: 'list', setView: vi.fn(),
  pendingRequests: [], setPendingRequests: vi.fn(), isBatchSelecting: false, setIsBatchSelecting: vi.fn(),
  selectedIds: [], setSelectedIds: vi.fn(), batchDelete: vi.fn(), districtSelection: null, setDistrictSelection: vi.fn(),
  districts: [], fetchDistricts: vi.fn(), editingDistrict: null, setEditingDistrict: vi.fn(), joinSelection: null,
  setJoinSelection: vi.fn(), roadSelectionBounds: null, setRoadSelectionBounds: vi.fn(), roadTrail: [], setRoadTrail: vi.fn(),
  waterTrail: [], setWaterTrail: vi.fn(), fetchWaterBodies: vi.fn(), setRhombusState: vi.fn(), setActiveSidebarMenu: vi.fn(),
  isAdmin: true, isPrimaryAdmin: false, setShowBattleMapManager: vi.fn(), isPlantingTrees: false, setIsPlantingTrees: vi.fn(),
  treeBatchSize: 5, setTreeBatchSize: vi.fn(), userName: 'ADMIN', globalSettings: {}, fetchGlobalSettings: vi.fn(),
  activeBattleMapData: null, setIsAdminPayOpen: vi.fn(), onOpenReferenceLayers: vi.fn(), onOpenCanonicalGeography: vi.fn(),
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('the CANONICAL_GEOGRAPHY launcher', () => {
  it('is not offered to an elevated temporary admin', () => {
    render(<AdminPanel {...props({ isPrimaryAdmin: false })} />);
    expect(screen.queryByText('+ CANONICAL_GEOGRAPHY')).toBeNull();
  });

  it('is offered to the primary administrator on the city tab, beside reference layers', () => {
    render(<AdminPanel {...props({ isPrimaryAdmin: true })} />);
    expect(screen.getByText('+ CANONICAL_GEOGRAPHY')).toBeInTheDocument();
    expect(screen.getByText('+ REFERENCE_LAYERS')).toBeInTheDocument();
  });

  it('opens the dedicated manager rather than editing inline', async () => {
    const onOpenCanonicalGeography = vi.fn();
    render(<AdminPanel {...props({ isPrimaryAdmin: true, onOpenCanonicalGeography })} />);
    await userEvent.click(screen.getByText('+ CANONICAL_GEOGRAPHY'));
    expect(onOpenCanonicalGeography).toHaveBeenCalledTimes(1);
  });
});
