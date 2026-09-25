/**
 * Context-pane hover (WP6 live-acceptance fix): three independent visual states — scope
 * context, the explicitly selected feature, and the temporary hover — layered so the hover
 * is always on top and never replaces or clears the other two, and hover changes nothing
 * canonical.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as THREE from 'three';

const three = {} as { camera: THREE.PerspectiveCamera; gl: { domElement: HTMLElement } };
vi.mock('@react-three/fiber', () => ({ useThree: () => three, useFrame: () => {} }));

import { CanonicalPickTool } from '../CanonicalPickTool';
import { createMapPickStore, type MapPickStore } from '../mapPick';
import { createLandSelection } from '../landSelection';
import { createTracingSession } from '../tracing';
import type { CanonicalQueryBundle } from '../types';
import {
  CITY, boundaryFeature, dataOf, land, mutations, openTab, path, queries, renderManager, routeFeature, scopeRec, stubFetch, type Harness,
} from './wp6Fixtures';

const isle = land(10, 0, 0, 20, { name: 'Inner Isle' });
const other = land(11, 40, 0, 20, { name: 'Split Isle' });
const road = routeFeature(12, { name: 'Wall Road', geometry: [{ x: 0, z: 30 }, { x: 20, z: 30 }, { x: 40, z: 35 }] });
const node = land(13, 5, 5, 0, { feature_class: 'site', geometry_type: 'point', geometry: { x: 5, z: 5 }, bbox: { min_x: 5, min_z: 5, max_x: 5, max_z: 5 },
  name: 'Gate Node', anchor_id: 7, part_role: 'node' });
const b = boundaryFeature(60, -50, -50, 100);
const features = [isle, other, road, node, b];
const extent = b.geometry as never;

// ── the scene layers ─────────────────────────────────────────────────────────

describe('hover layer in the scene', () => {
  let el: HTMLDivElement;
  let pick: MapPickStore;
  beforeEach(() => {
    el = document.createElement('div');
    el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200, x: 0, y: 0, toJSON() {} });
    document.body.appendChild(el);
    three.camera = new THREE.PerspectiveCamera(90, 1, 0.1, 10000);
    three.gl = { domElement: el };
    pick = createMapPickStore();
  });
  afterEach(() => { cleanup(); el.remove(); });

  const mount = () => render(<CanonicalPickTool pick={pick} session={createTracingSession()} selection={createLandSelection()} features={features} active={false} />);
  const withDistrict = () => act(() => pick.update(s => ({ ...s, scopeOverlay: { scopeId: 2, extent: [extent], boundaryFeatureId: 60, inside: [10], crossing: [11] } })));
  const named = (c: HTMLElement, name: string) => c.querySelector(`[name="${name}"]`);
  const order = (e: Element | null) => Number(e?.getAttribute('renderorder'));
  const lineColor = (c: HTMLElement, name: string) => named(c, name)?.querySelector('linebasicmaterial')?.getAttribute('color');

  it('district selected + hovered land row: the land gets a fill, outline and marker above every district layer', () => {
    const { container } = mount();
    withDistrict();
    act(() => pick.update(s => ({ ...s, hoverId: 10 })));
    const fill = named(container, 'canonical-hover-fill');
    const outline = named(container, 'canonical-hovered-feature');
    expect(fill).not.toBeNull();
    expect(outline).not.toBeNull();
    expect(container.querySelector('[name="canonical-hover-marker-ring"]')).not.toBeNull();
    expect(lineColor(container, 'canonical-hovered-feature')).toBe('#ffffff');
    // The district context is still drawn, underneath.
    const district = ['scope-extent-fill', 'scope-extent-outline', 'scope-land-inside', 'scope-land-crossing'].map(n => named(container, n));
    for (const d of district) expect(d).not.toBeNull();
    const top = Math.max(...district.map(order));
    expect(order(fill)).toBeGreaterThan(top);
    expect(order(outline)).toBeGreaterThan(order(fill));
  });

  it('mouse leave removes only the hover layer; the district layers stay', () => {
    const { container } = mount();
    withDistrict();
    act(() => pick.update(s => ({ ...s, hoverId: 10 })));
    act(() => pick.update(s => ({ ...s, hoverId: null })));
    expect(named(container, 'canonical-hover-layer')).toBeNull();
    expect(named(container, 'scope-extent-fill')).not.toBeNull();
    expect(named(container, 'scope-land-inside')).not.toBeNull();
  });

  it('a selected feature and a hovered other feature are drawn distinctly, hover on top', () => {
    const { container } = mount();
    withDistrict();
    act(() => pick.update(s => ({ ...s, highlightId: 11, hoverId: 10 })));
    expect(lineColor(container, 'canonical-selected-feature')).toBe('#ff4fd8');
    expect(lineColor(container, 'canonical-hovered-feature')).toBe('#ffffff');
    expect(order(named(container, 'canonical-hovered-feature'))).toBeGreaterThan(order(named(container, 'canonical-selected-feature')));
  });

  it('hovering the selected feature stays coherent: selection kept, hover outline in the selected colour, fill added', () => {
    const { container } = mount();
    act(() => pick.update(s => ({ ...s, highlightId: 10, hoverId: 10 })));
    expect(named(container, 'canonical-selected-feature')).not.toBeNull();
    expect(lineColor(container, 'canonical-hovered-feature')).toBe('#ff4fd8');
    expect(named(container, 'canonical-hover-fill')).not.toBeNull();
  });

  it('lines and points get on-screen markers (a line at its vertices, a point at itself), not a fill', () => {
    const { container } = mount();
    withDistrict();
    act(() => pick.update(s => ({ ...s, hoverId: 12 })));
    expect(named(container, 'canonical-hover-fill')).toBeNull();
    expect(named(container, 'canonical-hovered-feature')).not.toBeNull();
    expect(container.querySelectorAll('[name="canonical-hover-marker-ring"]')).toHaveLength(3);
    act(() => pick.update(s => ({ ...s, hoverId: 13 })));
    const rings = container.querySelectorAll('[name="canonical-hover-marker-ring"]');
    expect(rings).toHaveLength(1);
    const [x, , z] = rings[0].getAttribute('position')!.split(',').map(Number);
    expect([x, z]).toEqual([5, 5]);
  });

  it('a hovered district boundary row is outlined with a light fill (it is as large as the district)', () => {
    const { container } = mount();
    withDistrict();
    act(() => pick.update(s => ({ ...s, hoverId: 60 })));
    expect(named(container, 'canonical-hover-fill')?.querySelector('meshbasicmaterial')?.getAttribute('opacity')).toBe('0.12');
    expect(named(container, 'canonical-hovered-feature')).not.toBeNull();
  });
});

// ── through the manager and context pane ─────────────────────────────────────

describe('hover through the context pane', () => {
  let h: Harness;
  beforeEach(() => { h = stubFetch(); });
  afterEach(() => vi.unstubAllGlobals());

  const district = scopeRec(2, 'district', 1, { name: 'White Gold', boundary_feature_id: 60 });
  const bundle = {
    bundle_version: 1, digest: 'abc',
    scope: { ref: { type: 'scope', id: 2 }, kind: 'district', chain: [], extent: [extent], extent_feature_ids: [60], land_coverage: 'partial', halo_wu: 0, descendant_scope_ids: [] },
    water_complement: { rule: 'partial', coverage_scope_id: null, extent: [] }, readiness: { unplaced_must_exist: [], required_scope_unverified: [], enforced: false },
    immutable: [], metrics: {},
    land: [{ id: 10, name: 'Inner Isle', feature_class: 'land', kind: null, relation: 'inside' }, { id: 11, name: 'Split Isle', feature_class: 'land', kind: null, relation: 'boundary' }],
    routes: [{ id: 12, name: 'Wall Road', feature_class: 'route', kind: null, relation: 'inside' }],
    sites: [{ id: 13, name: 'Gate Node', feature_class: 'site', kind: null, relation: 'inside' }],
    anchors: [], water: [], protected: [], connections: [],
  } as unknown as CanonicalQueryBundle;

  const setup = async () => {
    h.respond = (c) => (path(c) === '/query' ? { status: 200, body: bundle } : { status: 200, body: [] });
    const d = dataOf({ features, scopes: [CITY, district] });
    const frozen = JSON.stringify(d);
    renderManager(h, d);
    await openTab(/SCOPES/);
    await userEvent.click(document.querySelector('[data-scope-id="2"]')!);
    const pane = screen.getByLabelText('Canonical context');
    await waitFor(() => expect(pane.querySelector('[data-context-feature="10"]')).not.toBeNull());
    return { pane, frozen, d, row: (id: number) => pane.querySelector(`[data-context-feature="${id}"]`) as HTMLElement };
  };

  it('hovering a land row sets only the hover; the district stays selected and drawn; leaving clears only the hover', async () => {
    const { row } = await setup();
    const overlay = h.pick.getState().scopeOverlay;
    expect(overlay).toMatchObject({ scopeId: 2, inside: [10], crossing: [11] });
    const highlight = h.pick.getState().highlightId;

    fireEvent.mouseEnter(row(10));
    expect(h.pick.getState()).toMatchObject({ hoverId: 10, highlightId: highlight });
    expect(h.pick.getState().scopeOverlay).toBe(overlay);
    expect(screen.getByLabelText('Scope inspector')).toHaveTextContent('#2 White Gold (district)');

    fireEvent.mouseLeave(row(10));
    expect(h.pick.getState().hoverId).toBeNull();
    expect(h.pick.getState().scopeOverlay).toBe(overlay);
  });

  it('route, site/anchor-part and boundary rows hover their own feature', async () => {
    const { pane, row } = await setup();
    for (const title of ['Routes', 'Sites']) fireEvent.click(pane.querySelector(`[data-group="${title}"] summary`)!);
    fireEvent.mouseEnter(row(12));
    expect(h.pick.getState().hoverId).toBe(12);
    fireEvent.mouseEnter(row(13));
    expect(h.pick.getState().hoverId).toBe(13);
    fireEvent.mouseEnter(within(pane).getByRole('button', { name: /INSPECT RAW BOUNDARY #60/ }));
    expect(h.pick.getState().hoverId).toBe(60);
  });

  it('clicking a row is the explicit selection; hovering another row afterwards leaves that selection alone', async () => {
    const { row } = await setup();
    fireEvent.mouseEnter(row(10));
    await userEvent.click(row(10));
    expect(screen.getByLabelText('Feature inspector')).toHaveTextContent('#10 Inner Isle');
    expect(h.pick.getState().highlightId).toBe(10);
    expect(h.pick.getState().scopeOverlay).not.toBeNull();

    await userEvent.click(within(screen.getByLabelText('Canonical context')).getByRole('button', { name: /BACK TO #2 White Gold/ }));
    fireEvent.mouseEnter(row(11));
    expect(h.pick.getState()).toMatchObject({ highlightId: 10, hoverId: 11 });
  });

  it('hover changes nothing canonical: no requests, no data mutation', async () => {
    const { row, frozen, d } = await setup();
    const before = { mutations: mutations(h).length, queries: queries(h).length, calls: h.calls.length };
    for (const id of [10, 11, 10]) { fireEvent.mouseEnter(row(id)); fireEvent.mouseLeave(row(id)); }
    fireEvent.focus(row(11));
    fireEvent.blur(row(11));
    expect(h.calls.length).toBe(before.calls);
    expect(mutations(h).length).toBe(before.mutations);
    expect(queries(h).length).toBe(before.queries);
    expect(JSON.stringify(d)).toBe(frozen);
    expect(h.refresh).not.toHaveBeenCalled();
  });
});
