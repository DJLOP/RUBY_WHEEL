/**
 * Shared fixtures for the WP6 panel tests: records as the server serialises them, a fetch
 * stub that records every call, and a manager render helper.
 */

import { vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CanonicalGeographyManager } from '../CanonicalGeographyManager';
import type { CanonicalGeographyData } from '../api';
import type { CanonicalAnchor, CanonicalConnection, CanonicalFeature, GeoScope } from '../types';
import { createTracingSession, type TracingSession } from '../tracing';
import { createLandSelection, type LandSelectionStore } from '../landSelection';
import { createMapPickStore, type MapPickStore } from '../mapPick';

const governed = {
  description: null, notes: null, provenance: 'authored' as const, replacement_state: 'non_replaceable' as const, is_locked: false,
  revision: 1, draft_version: 1, revises_id: null, base_revision: null, evidence: null, proposal: null, lifecycle_state: 'accepted' as const,
};

export const square = (x = 0, z = 0, s = 10) => ({ outer: [{ x, z }, { x: x + s, z }, { x: x + s, z: z + s }, { x, z: z + s }], holes: [] });

export const land = (id: number, x: number, z = 0, s = 10, over: Partial<CanonicalFeature> = {}): CanonicalFeature => ({
  ...governed, id, entity_type: 'feature', name: `Isle ${id}`, feature_class: 'land', kind: null, geometry_type: 'polygon',
  geometry: square(x, z, s), construction: null, attributes: null, bbox: { min_x: x, min_z: z, max_x: x + s, max_z: z + s },
  anchor_id: null, part_role: null, constraint_strength: 'hard', ...over,
});

export const boundaryFeature = (id: number, x: number, z: number, s: number, over: Partial<CanonicalFeature> = {}): CanonicalFeature =>
  land(id, x, z, s, { feature_class: 'scope_boundary', name: `Boundary ${id}`, ...over });

export const routeFeature = (id: number, over: Partial<CanonicalFeature> = {}): CanonicalFeature => ({
  ...land(id, 0), feature_class: 'route', geometry_type: 'linestring', geometry: [{ x: 0, z: 0 }, { x: 50, z: 0 }],
  bbox: { min_x: 0, min_z: 0, max_x: 50, max_z: 0 }, name: `Route ${id}`, ...over,
});

export const scopeRec = (id: number, kind: GeoScope['scope_kind'], parent: number | null, over: Partial<GeoScope> = {}): GeoScope => ({
  ...governed, id, entity_type: 'scope', name: `${kind} ${id}`, scope_key: `${kind}-${id}`, scope_kind: kind,
  parent_scope_id: parent, boundary_feature_id: null, land_coverage: 'partial', members: [], ...over,
});

export const CITY = scopeRec(1, 'city', null, { name: 'Imperial City', scope_key: 'city' });

export const anchorRec = (id: number, over: Partial<CanonicalAnchor> = {}): CanonicalAnchor => ({
  ...governed, id, entity_type: 'anchor', name: 'Arena', anchor_key: 'arena-test', category: 'landmark',
  constraint_strength: 'hard', must_exist: true, required_scope_id: null, linked_location_id: null, ...over,
});

export const connectionRec = (id: number, over: Partial<CanonicalConnection> = {}): CanonicalConnection => ({
  ...governed, id, entity_type: 'connection', name: null, connection_kind: null, from_ref_type: 'feature', from_ref_id: 1,
  to_ref_type: 'feature', to_ref_id: 2, from_hint: null, to_hint: null, via_feature_id: null, constraint_strength: 'soft', ...over,
});

export const dataOf = (over: Partial<CanonicalGeographyData> = {}): CanonicalGeographyData => ({
  features: [], anchors: [], connections: [], scopes: [CITY], includesWorkingSet: true, ...over,
});

export type Call = { method: string; url: string; body: Record<string, unknown> | undefined };

export interface Harness {
  calls: Call[];
  respond: (c: Call) => { status: number; body: unknown };
  session: TracingSession;
  selection: LandSelectionStore;
  pick: MapPickStore;
  refresh: ReturnType<typeof vi.fn>;
  onTracingChange: ReturnType<typeof vi.fn>;
}

export function stubFetch(): Harness {
  const h: Harness = {
    calls: [],
    respond: () => ({ status: 200, body: {} }),
    session: createTracingSession(),
    selection: createLandSelection(),
    pick: createMapPickStore(),
    refresh: vi.fn(),
    onTracingChange: vi.fn(),
  };
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit = {}) => {
    const call = { method: init.method ?? 'GET', url: String(url), body: init.body ? JSON.parse(String(init.body)) : undefined };
    h.calls.push(call);
    const { status, body } = h.respond(call);
    return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response);
  }));
  return h;
}

/** Calls that change state. POST /query is a read (the generator-facing query), not a mutation. */
export const mutations = (h: Harness) => h.calls.filter(c => c.method !== 'GET' && !c.url.startsWith('/api/canonical-geography/query'));
export const queries = (h: Harness) => h.calls.filter(c => c.url.startsWith('/api/canonical-geography/query'));
export const path = (c: Call) => c.url.replace('/api/canonical-geography', '').replace(/\?.*$/, '');

export function renderManager(h: Harness, data: CanonicalGeographyData) {
  const props = {
    token: 'tok', referenceLayers: [], refresh: h.refresh, session: h.session, tracingActive: false,
    onTracingChange: h.onTracingChange, overlayVisible: true, onToggleOverlay: vi.fn(), onClose: vi.fn(), selection: h.selection, pick: h.pick,
  };
  const utils = render(<CanonicalGeographyManager {...props} data={data} />);
  return { ...utils, rerenderWith: (d: CanonicalGeographyData) => utils.rerender(<CanonicalGeographyManager {...props} data={d} />) };
}

export const openTab = (name: RegExp) => userEvent.click(screen.getByRole('tab', { name }));
export const button = (scope: HTMLElement, name: RegExp) => within(scope).getByRole('button', { name });
