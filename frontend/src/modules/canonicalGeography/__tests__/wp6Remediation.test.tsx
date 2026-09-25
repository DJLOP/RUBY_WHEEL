/**
 * WP6 remediation, through the manager:
 * - districts are drawn regions: boundary first, via the WP5 tracing tool; whole-island
 *   membership optional (island groups keep it as their main tool);
 * - retired canon lives in an archive, hidden from the active list, still restorable;
 * - clicking canonical geometry opens it in the inspector, with a chooser for overlaps.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { addPoint, beginTrace, closeRing } from '../tracing';
import { requestPick } from '../mapPick';
import {
  CITY, boundaryFeature, button, dataOf, land, mutations, openTab, path, renderManager, scopeRec, stubFetch, type Harness,
} from './wp6Fixtures';

let h: Harness;
beforeEach(() => { h = stubFetch(); });
afterEach(() => vi.unstubAllGlobals());

const selectScope = (id: number) => userEvent.click(document.querySelector(`[data-scope-id="${id}"]`)!);
const scopeInspector = () => screen.getByLabelText('Scope inspector');
const featureInspector = () => screen.getByLabelText('Feature inspector');
const clickMap = (ids: number[]) => act(() => h.pick.update(s => requestPick(s, { x: 1, z: 2 }, ids)));
const traceSquare = () => act(() => h.session.update(s =>
  closeRing(addPoint(addPoint(addPoint(beginTrace(s, { geometryType: 'polygon' }), { x: 0, z: 0 }), { x: 60, z: 0 }), { x: 60, z: 60 }))));

// ── districts ───────────────────────────────────────────────────────────────

describe('district boundary workflow', () => {
  it('creates a district draft with no members, then TRACE DISTRICT BOUNDARY links the traced draft — no membership, no accept', async () => {
    const draft = scopeRec(5, 'district', 1, { lifecycle_state: 'draft', name: 'Arena District' });
    h.respond = (c) => {
      if (c.method === 'POST' && path(c) === '/scopes') return { status: 201, body: { ...draft, ...c.body } };
      if (c.method === 'POST' && path(c) === '/features') return { status: 201, body: boundaryFeature(60, 0, 0, 60, { lifecycle_state: 'draft' }) };
      if (c.method === 'PATCH' && path(c) === '/scopes/5') return { status: 200, body: { ...draft, boundary_feature_id: 60, draft_version: 2 } };
      return { status: 200, body: [] };
    };
    const { rerenderWith } = renderManager(h, dataOf({ features: [land(10, 30, 30, 50)], scopes: [CITY] }));
    await openTab(/SCOPES/);
    await userEvent.click(screen.getByRole('button', { name: '+ NEW SCOPE' }));
    expect(screen.getByLabelText('Scope form').textContent).toMatch(/drawn region: after saving, trace its boundary/);
    await userEvent.type(screen.getByLabelText('Scope name'), 'Arena District');
    await userEvent.selectOptions(screen.getByLabelText('Parent scope'), '1');
    await userEvent.click(button(screen.getByLabelText('Scope form'), /SAVE DRAFT/));
    await waitFor(() => expect(mutations(h)).toHaveLength(1));
    expect(mutations(h)[0].body).toMatchObject({ scope_kind: 'district', members: [], boundary_feature_id: null });
    expect(screen.getByRole('status').textContent).toMatch(/Next: TRACE DISTRICT BOUNDARY/);

    rerenderWith(dataOf({ features: [land(10, 30, 30, 50)], scopes: [CITY, draft] }));
    await openTab(/SCOPES/);
    await selectScope(5);
    const steps = within(scopeInspector()).getByLabelText('Boundary steps');
    expect([...steps.querySelectorAll('li')].map(li => li.getAttribute('data-done'))).toEqual(['true', 'false', 'false', 'false']);
    await userEvent.click(button(scopeInspector(), /TRACE DISTRICT BOUNDARY/));

    // The WP5 tracing panel, set up for a scope_boundary polygon.
    expect((screen.getByLabelText('Feature class') as HTMLSelectElement).value).toBe('scope_boundary');
    traceSquare(); // crosses land #10 — allowed
    await userEvent.click(screen.getByRole('button', { name: 'SAVE DRAFT' }));
    await waitFor(() => expect(mutations(h)).toHaveLength(3));
    expect(mutations(h)[1]).toMatchObject({ method: 'POST', body: { feature_class: 'scope_boundary', geometry_type: 'polygon' } });
    expect(mutations(h)[2]).toMatchObject({ method: 'PATCH', body: { boundary_feature_id: 60, expected_draft_version: 1 } });
    expect(mutations(h)[2].body).not.toHaveProperty('members');
    expect(mutations(h).some(c => path(c).endsWith('/accept'))).toBe(false);
  });

  it('with a draft boundary it offers ACCEPT BOUNDARY… (feature inspector) and EDIT BOUNDARY through the WP5 tool', async () => {
    const b = boundaryFeature(60, 0, 0, 60, { lifecycle_state: 'draft', revision: 0 });
    const d = scopeRec(5, 'district', 1, { lifecycle_state: 'draft', boundary_feature_id: 60 });
    renderManager(h, dataOf({ features: [b], scopes: [CITY, d] }));
    await openTab(/SCOPES/);
    await selectScope(5);
    const steps = within(scopeInspector()).getByLabelText('Boundary steps');
    expect([...steps.querySelectorAll('li')].map(li => li.getAttribute('data-done'))).toEqual(['true', 'true', 'false', 'false']);
    await userEvent.click(button(scopeInspector(), /EDIT BOUNDARY \(TRACE\)/));
    expect(h.session.getState()).toMatchObject({ active: true, featureId: 60, closed: true });
    expect(screen.getByLabelText('Tracing').textContent).toMatch(/EDITING DRAFT #60/);
    expect(mutations(h)).toEqual([]);
  });

  it('editing an accepted boundary goes through Revise, then the WP5 tool on the draft revision', async () => {
    const b = boundaryFeature(60, 0, 0, 60);
    const d = scopeRec(5, 'district', 1, { boundary_feature_id: 60 });
    h.respond = (c) => (path(c) === '/features/60/revise'
      ? { status: 201, body: { ...b, id: 61, lifecycle_state: 'draft', revises_id: 60, base_revision: 1 } } : { status: 200, body: [] });
    renderManager(h, dataOf({ features: [b], scopes: [CITY, d] }));
    await openTab(/SCOPES/);
    await selectScope(5);
    expect([...within(scopeInspector()).getByLabelText('Boundary steps').querySelectorAll('li')].map(li => li.getAttribute('data-done')))
      .toEqual(['true', 'true', 'true', 'true']);
    await userEvent.click(button(scopeInspector(), /EDIT BOUNDARY \(TRACE\)/));
    await waitFor(() => expect(h.session.getState()).toMatchObject({ active: true, featureId: 61 }));
    expect(mutations(h).map(c => path(c))).toEqual(['/features/60/revise']);
  });

  it('keeps whole-island membership optional for a district, and primary for an island group', async () => {
    const d = scopeRec(2, 'district', 1, { name: 'Temp District' });
    const g = scopeRec(3, 'island_group', 2, { name: 'North Chain' });
    renderManager(h, dataOf({ features: [land(10, 0)], scopes: [CITY, d, g] }));
    await openTab(/SCOPES/);
    await selectScope(2);
    const optional = within(scopeInspector()).getByLabelText('Optional whole-island membership');
    expect(optional.tagName).toBe('DETAILS');
    expect(optional.hasAttribute('open')).toBe(false);
    expect(optional.textContent).toMatch(/not required for a district/);
    expect(within(scopeInspector()).getByLabelText('Scope members').textContent).toMatch(/none required/);
    await selectScope(3);
    expect(within(scopeInspector()).queryByLabelText('Optional whole-island membership')).toBeNull();
    expect(within(scopeInspector()).queryByLabelText('Region boundary')).toBeNull();
    expect(button(scopeInspector(), /ASSIGN SELECTION/)).toBeInTheDocument();
  });

  it('an island split between two districts shows no whole-island membership, and nothing asks for one', async () => {
    const isle = land(10, 0, 0, 100);
    const west = scopeRec(2, 'district', 1, { name: 'West', boundary_feature_id: 60 });
    const east = scopeRec(3, 'district', 1, { name: 'East', boundary_feature_id: 61 });
    renderManager(h, dataOf({ features: [isle, boundaryFeature(60, -50, -50, 100), boundaryFeature(61, 50, -50, 100)], scopes: [CITY, west, east] }));
    await openTab(/SCOPES/);
    act(() => h.selection.update(s => ({ ...s, ids: [10] })));
    expect(screen.getByLabelText('Selected land').textContent).toMatch(/district: none/);
    expect(screen.getByLabelText('Scope hierarchy').textContent).toMatch(/West · ACCEPTED · boundary #60 · partial/);
    expect(screen.getByLabelText('Scope hierarchy').textContent).toMatch(/East · ACCEPTED · boundary #61 · partial/);
    expect(mutations(h)).toEqual([]);
  });
});

// ── archive ─────────────────────────────────────────────────────────────────

describe('retired archive', () => {
  const active = land(1, 0);
  const retiredRows = Array.from({ length: 50 }, (_, i) => land(100 + i, i * 20, 0, 10, { lifecycle_state: 'retired', name: `Old ${i}` }));

  it('hides retired canon from the active list however much history exists, behind a counted archive', async () => {
    h.respond = (c) => (c.method === 'GET' && c.url.includes('states=retired') ? { status: 200, body: retiredRows } : { status: 200, body: {} });
    renderManager(h, dataOf({ features: [active] }));
    const list = screen.getByLabelText('Feature list');
    await screen.findByRole('button', { name: /SHOW RETIRED \/ ARCHIVE \(50\)/ });
    expect(list.querySelectorAll('li')).toHaveLength(1);
    expect(list.textContent).not.toMatch(/Old/);
    expect(screen.queryByLabelText('Archive list')).toBeNull();
    expect(screen.queryByLabelText('Show retired')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /SHOW RETIRED \/ ARCHIVE/ }));
    expect(screen.getByLabelText('Archive list').querySelectorAll('li')).toHaveLength(50);
    await userEvent.type(screen.getByLabelText('Search features'), 'Old 7');
    expect(screen.getByLabelText('Archive list').querySelectorAll('li')).toHaveLength(1);
    expect(list.textContent).toMatch(/No features match/);
  });

  it('restores from the archive, and history stays on the selected feature', async () => {
    h.respond = (c) => (c.method === 'GET' && c.url.includes('states=retired') ? { status: 200, body: retiredRows.slice(0, 1) }
      : path(c).endsWith('/restore') ? { status: 200, body: { record: { ...retiredRows[0], lifecycle_state: 'accepted' }, warnings: [] } }
        : c.url.includes('/revisions') ? { status: 200, body: [{ id: 1, entity_type: 'feature', entity_id: 100, revision: 1, change_kind: 'retire', snapshot: {}, created_at: 't' }] }
          : { status: 200, body: {} });
    renderManager(h, dataOf({ features: [active] }));
    await userEvent.click(await screen.findByRole('button', { name: /SHOW RETIRED \/ ARCHIVE \(1\)/ }));
    await userEvent.click(within(screen.getByLabelText('Archive list')).getByRole('button'));
    await userEvent.click(button(featureInspector(), /HISTORY/));
    expect((await screen.findByLabelText('Revision history')).textContent).toMatch(/r1 · retire/);
    await userEvent.click(button(featureInspector(), /RESTORE/));
    await waitFor(() => expect(mutations(h)).toEqual([expect.objectContaining({ method: 'POST', url: '/api/canonical-geography/features/100/restore' })]));
    expect(mutations(h).some(c => c.method === 'DELETE')).toBe(false);
  });

  it('offers no delete for retired canon', async () => {
    h.respond = (c) => (c.method === 'GET' && c.url.includes('states=retired') ? { status: 200, body: retiredRows.slice(0, 1) } : { status: 200, body: {} });
    renderManager(h, dataOf({ features: [active] }));
    await userEvent.click(await screen.findByRole('button', { name: /SHOW RETIRED \/ ARCHIVE \(1\)/ }));
    await userEvent.click(within(screen.getByLabelText('Archive list')).getByRole('button'));
    expect(within(featureInspector()).queryByRole('button', { name: /DELETE/ })).toBeNull();
  });
});

// ── map click to inspect ────────────────────────────────────────────────────

describe('map click to inspect', () => {
  const isle = land(10, 0, 0, 100, { name: 'North Isle' });
  const road = land(11, 0, 0, 1, { feature_class: 'route', geometry_type: 'linestring', geometry: [{ x: 0, z: 50 }, { x: 100, z: 50 }], name: 'Causeway' });
  const b = boundaryFeature(60, -50, -50, 100);
  const district = scopeRec(2, 'district', 1, { name: 'West', boundary_feature_id: 60 });
  const data = () => dataOf({ features: [isle, road, b], scopes: [CITY, district] });

  it('one feature under the click opens its inspector (from any tab) and outlines it in the scene', async () => {
    renderManager(h, data());
    await openTab(/SCOPES/);
    clickMap([10]);
    expect(await screen.findByLabelText('Feature inspector')).toHaveTextContent('#10 North Isle');
    expect(screen.getByRole('tab', { name: 'FEATURES' })).toHaveAttribute('aria-selected', 'true');
    expect(h.pick.getState().highlightId).toBe(10);
  });

  it('overlapping features open a chooser instead of guessing', async () => {
    renderManager(h, data());
    clickMap([11, 60, 10]);
    const chooser = screen.getByRole('dialog', { name: 'Choose feature at point' });
    const choices = [...chooser.querySelectorAll('[data-choice-id]')].map(el => el.textContent);
    expect(choices[0]).toMatch(/#11 Causeway · route/);
    expect(choices[1]).toMatch(/#60 Boundary 60 · scope_boundary · boundary of West/);
    expect(choices[2]).toMatch(/#10 North Isle · island/);
    expect(screen.queryByLabelText('Feature inspector')).toBeNull();
    await userEvent.click(chooser.querySelector('[data-choice-id="10"]')!);
    expect(featureInspector()).toHaveTextContent('#10 North Isle');
    expect(screen.queryByRole('dialog', { name: 'Choose feature at point' })).toBeNull();
  });

  it('a click on a boundary owned by one district opens the district itself; the raw boundary still links back to it', async () => {
    renderManager(h, data());
    clickMap([60]);
    expect(await screen.findByLabelText('Scope inspector')).toHaveTextContent('#2 West (district)');
    expect(screen.getByRole('tab', { name: 'SCOPES' })).toHaveAttribute('aria-selected', 'true');
    // The raw boundary feature, inspected directly, still offers its scope.
    await userEvent.click(screen.getByRole('tab', { name: 'FEATURES' }));
    await userEvent.click(document.querySelector('[data-feature-id="60"]')!);
    await userEvent.click(within(featureInspector()).getByRole('button', { name: /OPEN #2 West \(district\)/ }));
    expect(scopeInspector()).toHaveTextContent('#2 West (district)');
  });

  it('a click on nothing says so, and a click during tracing is ignored', async () => {
    renderManager(h, data());
    clickMap([]);
    expect(screen.getByRole('status')).toHaveTextContent('No canonical geometry at 1.0, 2.0.');
    await userEvent.click(screen.getByRole('button', { name: '+ TRACE NEW FEATURE' }));
    clickMap([10]);
    expect(screen.queryByLabelText('Feature inspector')).toBeNull();
    expect(screen.getByLabelText('Tracing')).toBeInTheDocument();
  });

  it('list selection still works, and turning SELECT ON MAP off releases the scene', async () => {
    renderManager(h, data());
    expect(h.onTracingChange).toHaveBeenLastCalledWith(true);
    await userEvent.click(document.querySelector('[data-feature-id="11"]')!);
    expect(featureInspector()).toHaveTextContent('#11 Causeway');
    expect(h.pick.getState().highlightId).toBe(11);
    await userEvent.click(screen.getByLabelText('Select on map'));
    expect(h.pick.getState().inspecting).toBe(false);
    expect(h.onTracingChange).toHaveBeenLastCalledWith(false);
  });
});
