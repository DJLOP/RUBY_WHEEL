/**
 * Who is offered the reference-layer editor.
 *
 * Reference layers are canonical world data, so the launcher belongs to the primary
 * administrator. This is which button is drawn and nothing more — the backend enforces the
 * same boundary on every write, and a missing button has never stopped a request.
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
  token: 'admintoken',
  onLogout: vi.fn(),
  refreshLocations: vi.fn(),
  refreshRoads: vi.fn(),
  locations: [],
  roads: [],
  editData: {},
  setEditData: vi.fn(),
  editId: null,
  setEditId: vi.fn(),
  transformMode: 'translate',
  setTransformMode: vi.fn(),
  targetObject: null,
  selectedLocation: null,
  setSelectedLocation: vi.fn(),
  setTargetObject: vi.fn(),
  controlsRef: { current: null },
  view: 'list',
  setView: vi.fn(),
  pendingRequests: [],
  setPendingRequests: vi.fn(),
  isBatchSelecting: false,
  setIsBatchSelecting: vi.fn(),
  selectedIds: [],
  setSelectedIds: vi.fn(),
  batchDelete: vi.fn(),
  districtSelection: null,
  setDistrictSelection: vi.fn(),
  districts: [],
  fetchDistricts: vi.fn(),
  editingDistrict: null,
  setEditingDistrict: vi.fn(),
  joinSelection: null,
  setJoinSelection: vi.fn(),
  roadSelectionBounds: null,
  setRoadSelectionBounds: vi.fn(),
  roadTrail: [],
  setRoadTrail: vi.fn(),
  waterTrail: [],
  setWaterTrail: vi.fn(),
  fetchWaterBodies: vi.fn(),
  setRhombusState: vi.fn(),
  setActiveSidebarMenu: vi.fn(),
  isAdmin: true,
  isPrimaryAdmin: false,
  setShowBattleMapManager: vi.fn(),
  isPlantingTrees: false,
  setIsPlantingTrees: vi.fn(),
  treeBatchSize: 5,
  setTreeBatchSize: vi.fn(),
  userName: 'ADMIN',
  globalSettings: {},
  fetchGlobalSettings: vi.fn(),
  activeBattleMapData: null,
  setIsAdminPayOpen: vi.fn(),
  onOpenReferenceLayers: vi.fn(),
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('the REFERENCE_LAYERS launcher', () => {
  it('is not offered to an elevated temporary admin', () => {
    render(<AdminPanel {...props({ isPrimaryAdmin: false })} />);
    expect(screen.queryByText('+ REFERENCE_LAYERS')).toBeNull();
  });

  it('is offered to the primary administrator on the city tab', () => {
    render(<AdminPanel {...props({ isPrimaryAdmin: true })} />);
    expect(screen.getByText('+ REFERENCE_LAYERS')).toBeInTheDocument();
  });

  it('opens the dedicated manager rather than editing inline', async () => {
    const onOpenReferenceLayers = vi.fn();
    render(<AdminPanel {...props({ isPrimaryAdmin: true, onOpenReferenceLayers })} />);

    await userEvent.click(screen.getByText('+ REFERENCE_LAYERS'));
    expect(onOpenReferenceLayers).toHaveBeenCalledTimes(1);
    // No calibration form is grafted onto AdminPanel itself.
    expect(screen.queryByLabelText('WORLD_UNITS_PER_PIXEL')).toBeNull();
  });
});
