/**
 * WP6 live-acceptance remediation, second round:
 * - a selected district shows its spatial context (query bundle) in the left pane and a
 *   scene overlay, keeping spatial land (inside / crossing) apart from optional explicit
 *   members, and never writing membership;
 * - an owned district boundary click selects the district;
 * - pane rows highlight and inspect features; the raw boundary stays reachable;
 * - bulk clearing of explicit members;
 * - a translated draft saves, and accepted canon moves only through a revision.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beginTranslate, translateFrom, translateSnapshot } from '../tracing';
import { requestPick } from '../mapPick';
import type { CanonicalQueryBundle } from '../types';
import {
  CITY, boundaryFeature, button, dataOf, land, mutations, openTab, path, queries, renderManager, routeFeature, scopeRec, stubFetch, type Call, type Harness,
} from './wp6Fixtures';

let h: Harness;
beforeEach(() => { h = stubFetch(); });
afterEach(() => vi.unstubAllGlobals());

const b = boundaryFeature(60, -50, -50, 100);
const inside = land(10, 0, 0, 10, { name: 'Inner Isle' });
const crossing = land(11, 40, 0, 20, { name: 'Split Isle' });
const road = routeFeature(12, { name: 'Wall Road' });
const district = scopeRec(2, 'district', 1, { name: 'White Gold', boundary_feature_id: 60, members: [10], land_coverage: 'complete' });

function bundle(landRows: { id: number; relation: string }[], extra: Partial<CanonicalQueryBundle> = {}): CanonicalQueryBundle {
  return {
    bundle_version: 1, digest: 'abc',
    scope: { ref: { type: 'scope', id: 2 }, kind: 'district', chain: [], extent: [b.geometry as never], extent_feature_ids: [60], land_coverage: 'complete', halo_wu: 0, descendant_scope_ids: [] },
    water_complement: { rule: 'complete', coverage_scope_id: 2, extent: [] }, readiness: { unplaced_must_exist: [], required_scope_unverified: [], enforced: false },
    immutable: [], metrics: {} as never,
    land: landRows.map(r => ({ id: r.id, name: `Isle ${r.id}`, feature_class: 'land', kind: null, relation: r.relation })) as never,
    routes: [{ id: 12, name: 'Wall Road', feature_class: 'route', kind: null, relation: 'inside' }] as never,
    anchors: [], water: [], protected: [], sites: [], connections: [],
    ...extra,
  };
}

function server(landRows = [{ id: 10, relation: 'inside' }, { id: 11, relation: 'boundary' }], over: (c: Call) => { status: number; body: unknown } | null = () => null) {
  h.respond = (c) => over(c) ?? (path(c) === '/query' ? { status: 200, body: bundle(landRows) } : { status: 200, body: [] });
}

const data = () => dataOf({ features: [inside, crossing, road, b], scopes: [CITY, district] });
const pane = () => screen.getByLabelText('Canonical context');
const selectScope = (id: number) => userEvent.click(document.querySelector(`[data-scope-id="${id}"]`)!);

describe('selected district: visual and spatial context', () => {
  it('queries the scope, overlays its extent, and separates spatial land from optional explicit members — writing nothing', async () => {
    server();
    renderManager(h, data());
    await openTab(/SCOPES/);
    await selectScope(2);
    await waitFor(() => expect(within(pane()).getByLabelText('Spatial land').textContent).toMatch(/Inside \(1\).*On \/ crossing boundary \(1\)/));
    expect(queries(h).map(c => c.body)).toEqual([{ scope_id: 2 }]);
    expect(pane().querySelector('[data-source="query"]')).not.toBeNull();
    expect(within(pane()).getByLabelText('Explicit members').textContent).toMatch(/EXPLICIT WHOLE-ISLAND MEMBERS \(1, optional\)/);
    expect(pane().textContent).toMatch(/LAND COVERAGEcomplete/);

    const overlay = h.pick.getState().scopeOverlay!;
    expect(overlay).toMatchObject({ scopeId: 2, boundaryFeatureId: 60, inside: [10], crossing: [11] });
    expect(overlay.extent).toHaveLength(1);

    const insp = screen.getByLabelText('Scope inspector');
    expect(insp.querySelector('[data-spatial-land]')!.textContent).toMatch(/1 inside · 1 on\/crossing boundary/);
    expect(insp.textContent).toMatch(/EXPLICIT MEMBERS1 whole island\(s\) \(optional\)/);
    expect(mutations(h)).toEqual([]);
  });

  it('a draft district is previewed locally from its draft boundary (no query), still without membership', async () => {
    const draftB = boundaryFeature(61, -50, -50, 100, { lifecycle_state: 'draft' });
    const draft = scopeRec(5, 'district', 1, { lifecycle_state: 'draft', name: 'Draft D', boundary_feature_id: 61 });
    server();
    renderManager(h, dataOf({ features: [inside, crossing, draftB], scopes: [CITY, draft] }));
    await openTab(/SCOPES/);
    await selectScope(5);
    expect(pane().querySelector('[data-source="preview"]')).not.toBeNull();
    expect(h.pick.getState().scopeOverlay).toMatchObject({ inside: [10], crossing: [11] });
    expect(queries(h)).toEqual([]);
    expect(mutations(h)).toEqual([]);
  });

  it('closing the pane clears the scene overlay', async () => {
    server();
    renderManager(h, data());
    await openTab(/SCOPES/);
    await selectScope(2);
    await waitFor(() => expect(h.pick.getState().scopeOverlay).not.toBeNull());
    await userEvent.click(within(pane()).getByRole('button', { name: 'Close context' }));
    expect(h.pick.getState().scopeOverlay).toBeNull();
  });
});

describe('left context pane', () => {
  it('a map click on an owned district boundary selects the district and opens its context', async () => {
    server();
    renderManager(h, data());
    act(() => h.pick.update(s => requestPick(s, { x: 50, z: 0 }, [60])));
    expect(await screen.findByLabelText('Scope inspector')).toHaveTextContent('#2 White Gold (district)');
    expect(within(pane()).getByLabelText('Scope context')).toHaveTextContent('DISTRICT · White Gold');
  });

  it('rows highlight on hover/focus and inspect on click; the pane can return to the scope; the raw boundary is inspectable', async () => {
    server();
    renderManager(h, data());
    await openTab(/SCOPES/);
    await selectScope(2);
    const row = await waitFor(() => {
      const r = pane().querySelector('[data-context-feature="11"]');
      expect(r).not.toBeNull();
      return r as HTMLElement;
    });
    fireEvent.mouseEnter(row);
    expect(h.pick.getState().hoverId).toBe(11);
    fireEvent.mouseLeave(row);
    expect(h.pick.getState().hoverId).toBeNull();
    fireEvent.focus(row);
    expect(h.pick.getState().hoverId).toBe(11);

    await userEvent.click(row);
    expect(screen.getByLabelText('Feature inspector')).toHaveTextContent('#11 Split Isle');
    const card = within(pane()).getByLabelText('Feature context');
    expect(card.textContent).toMatch(/SPATIALLY IN.*White Gold · crossing/);
    expect(h.pick.getState().scopeOverlay).not.toBeNull(); // scope context kept

    await userEvent.click(within(pane()).getByRole('button', { name: /BACK TO #2 White Gold/ }));
    expect(within(pane()).getByLabelText('Scope context')).toBeInTheDocument();

    await userEvent.click(within(pane()).getByRole('button', { name: /INSPECT RAW BOUNDARY #60/ }));
    expect(screen.getByLabelText('Feature inspector')).toHaveTextContent('#60 Boundary 60');
  });

  it('groups hundreds of rows into collapsible, paged, filterable sections', async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ id: 1000 + i, relation: 'inside' }));
    server(many);
    renderManager(h, data());
    await openTab(/SCOPES/);
    await selectScope(2);
    const group = await waitFor(() => {
      const g = pane().querySelector('[data-group="Inside"]');
      expect(g?.textContent).toMatch(/Inside \(80\)/);
      return g as HTMLElement;
    });
    expect(group.tagName).toBe('DETAILS');
    expect(group.querySelectorAll('[data-context-feature]')).toHaveLength(25);
    expect(within(group).getByRole('button', { name: /SHOW 25 MORE of 55/ })).toBeInTheDocument();
    await userEvent.type(within(group).getByLabelText('Filter Inside'), '1079');
    expect(group.querySelectorAll('[data-context-feature]')).toHaveLength(1);
    // Other groups are collapsed sections, not one dump.
    expect(pane().querySelector('[data-group="Routes"]')!.hasAttribute('open')).toBe(false);
  });
});

describe('clearing explicit district members', () => {
  it('asks first, then stages members: [] on a revision — boundary and coverage untouched', async () => {
    server([{ id: 10, relation: 'inside' }], (c) => {
      if (path(c) === '/scopes/2/revise') return { status: 201, body: { ...district, id: 20, lifecycle_state: 'draft', revises_id: 2 } };
      if (c.method === 'PATCH' && path(c) === '/scopes/20') return { status: 200, body: { ...district, id: 20, lifecycle_state: 'draft', revises_id: 2, members: [], draft_version: 2 } };
      return null;
    });
    renderManager(h, data());
    await openTab(/SCOPES/);
    await selectScope(2);
    await userEvent.click(button(screen.getByLabelText('Scope inspector'), /CLEAR ALL EXPLICIT MEMBERS/));
    const confirm = screen.getByRole('alertdialog', { name: 'Confirm clear members' });
    expect(confirm.textContent).toMatch(/boundary, the spatial land it contains, and land coverage are unchanged/);
    expect(mutations(h)).toEqual([]);
    await userEvent.click(button(confirm, /CLEAR MEMBERS/));
    const accept = await screen.findByRole('alertdialog', { name: 'Confirm accept scope' });
    expect(mutations(h).map(c => [c.method, path(c), c.body])).toEqual([
      ['POST', '/scopes/2/revise', undefined], ['PATCH', '/scopes/20', { members: [], expected_draft_version: 1 }]]);
    expect(accept.textContent).toMatch(/REMOVED#10/);
  });
});

describe('translation through the manager', () => {
  it('Save persists the translated draft geometry and its moved construction record', async () => {
    const draft = land(40, 0, 0, 10, { lifecycle_state: 'draft', revision: 0, construction: { type: 'rect', center: { x: 5, z: 5 }, width: 10, height: 10, rotation_rad: 0 } });
    server([], (c) => (c.method === 'PATCH' ? { status: 200, body: { ...draft, draft_version: 2 } } : null));
    renderManager(h, dataOf({ features: [draft] }));
    await userEvent.click(document.querySelector('[data-feature-id="40"]')!);
    await userEvent.click(button(screen.getByLabelText('Feature inspector'), /EDIT DRAFT/));
    act(() => h.session.update(s => translateFrom(beginTranslate(s), translateSnapshot(s), 100, -20)));
    await userEvent.click(screen.getByRole('button', { name: 'SAVE DRAFT' }));
    await waitFor(() => expect(mutations(h)).toHaveLength(1));
    const body = mutations(h)[0].body!;
    expect((body.geometry as { outer: unknown[] }).outer[0]).toEqual({ x: 100, z: -20 });
    expect(body.construction).toEqual({ type: 'rect', center: { x: 105, z: -15 }, width: 10, height: 10, rotation_rad: 0 });
    expect(body).not.toHaveProperty('evidence'); // evidence stays as it was
  });

  it('an accepted feature is not editable in place: EDIT GEOMETRY revises first, then edits the revision', async () => {
    const canon = land(41, 0, 0, 10);
    server([], (c) => (path(c) === '/features/41/revise' ? { status: 201, body: { ...canon, id: 42, lifecycle_state: 'draft', revises_id: 41 } } : null));
    renderManager(h, dataOf({ features: [canon] }));
    await userEvent.click(document.querySelector('[data-feature-id="41"]')!);
    expect(h.session.getState().active).toBe(false);
    expect(within(screen.getByLabelText('Feature inspector')).queryByRole('button', { name: 'EDIT DRAFT' })).toBeNull();
    await userEvent.click(button(screen.getByLabelText('Feature inspector'), /EDIT GEOMETRY \(REVISE\)/));
    await waitFor(() => expect(h.session.getState()).toMatchObject({ active: true, featureId: 42 }));
    expect(mutations(h).map(c => path(c))).toEqual(['/features/41/revise']);
  });

  it('click-to-inspect still works for an ordinary feature', async () => {
    server();
    renderManager(h, data());
    act(() => h.pick.update(s => requestPick(s, { x: 5, z: 5 }, [10])));
    expect(await screen.findByLabelText('Feature inspector')).toHaveTextContent('#10 Inner Isle');
    expect(within(pane()).getByLabelText('Feature context')).toHaveTextContent('#10 Inner Isle');
  });
});
