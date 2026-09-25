/**
 * Scopes and explicit land membership (WP6): creating district / island-group / subregion
 * drafts, the hierarchy view, assigning a multi-selection of islands in one operation,
 * "select land inside boundary" as a confirmed one-off proposal, boundary assignment, and
 * the complete-coverage confirmation. Every change is a draft edit; only an explicit accept
 * makes it canon, and a server refusal keeps both the selection and the staged draft.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { addPoint, beginTrace, closeRing } from '../tracing';
import {
  CITY, boundaryFeature, button, dataOf, land, mutations, openTab, path, renderManager, scopeRec, stubFetch, type Call, type Harness,
} from './wp6Fixtures';
import type { GeoScope } from '../types';

let h: Harness;
beforeEach(() => { h = stubFetch(); });
afterEach(() => vi.unstubAllGlobals());

const islands = [land(10, 0), land(11, 20), land(12, 40), land(13, 200)];
const district = scopeRec(2, 'district', 1, { name: 'Temp District', members: [10] });
const group = scopeRec(3, 'island_group', 2, { name: 'North Chain', members: [10] });

/** Server double: revise → draft revision #20; patch echoes the body onto the record; accept echoes. */
function scopeServer(base: GeoScope[], overrides: (c: Call) => { status: number; body: unknown } | null = () => null) {
  let rev: GeoScope | null = null;
  h.respond = (c) => {
    const o = overrides(c);
    if (o) return o;
    const p = path(c);
    let m = p.match(/^\/scopes\/(\d+)\/revise$/);
    if (m && c.method === 'POST') {
      const canon = base.find(s => s.id === Number(m![1]))!;
      rev = { ...canon, id: 20, lifecycle_state: 'draft', revises_id: canon.id, base_revision: canon.revision, draft_version: 1 };
      return { status: 201, body: rev };
    }
    m = p.match(/^\/scopes\/(\d+)$/);
    if (m && c.method === 'PATCH') {
      const target = rev && rev.id === Number(m[1]) ? rev : base.find(s => s.id === Number(m![1]))!;
      const fields = { ...(c.body as Record<string, unknown>) };
      delete fields.expected_draft_version;
      const next = { ...target, ...fields, draft_version: target.draft_version + 1 } as GeoScope;
      if (rev && rev.id === next.id) rev = next;
      return { status: 200, body: next };
    }
    m = p.match(/^\/scopes\/(\d+)\/accept$/);
    if (m) return { status: 200, body: { record: { ...(rev ?? base[0]), id: rev?.revises_id ?? Number(m[1]), lifecycle_state: 'accepted' }, warnings: [] } };
    if (p === '/scopes' && c.method === 'POST') return { status: 201, body: { ...scopeRec(30, (c.body as { scope_kind: GeoScope['scope_kind'] }).scope_kind, 1), ...c.body, lifecycle_state: 'draft' } };
    return { status: 200, body: {} };
  };
}

const selectScope = (id: number) => userEvent.click(document.querySelector(`[data-scope-id="${id}"]`)!);
const scopeInspector = () => screen.getByLabelText('Scope inspector');

describe('scope hierarchy', () => {
  it('shows kind, parent, children, members, boundary and coverage; land shows its district and group', async () => {
    renderManager(h, dataOf({ features: islands, scopes: [CITY, district, group] }));
    await openTab(/SCOPES/);
    const tree = screen.getByLabelText('Scope hierarchy');
    expect(tree.textContent).toContain('CITY · Imperial City');
    expect(tree.textContent).toContain('DISTRICT · Temp District · ACCEPTED · no boundary · 1 explicit (optional) · partial');
    expect(tree.textContent).toContain('ISLAND GROUP · North Chain');

    await selectScope(2);
    const insp = scopeInspector();
    expect(insp.textContent).toMatch(/KINDdistrict/);
    expect(insp.textContent).toMatch(/PARENT#1 Imperial City \(city\)/);
    expect(insp.textContent).toMatch(/CHILDREN#3 North Chain \(island group\)/);
    expect(insp.textContent).toMatch(/BOUNDARYnone/);
    expect(insp.textContent).toMatch(/LAND COVERAGEpartial/);
    expect(within(screen.getByLabelText('Scope members')).getByText(/#10 Isle 10/)).toBeInTheDocument();

    act(() => h.selection.update(s => ({ ...s, ids: [10, 11] })));
    const sel = screen.getByLabelText('Selected land');
    expect(sel.querySelector('[data-land-id="10"]')!.textContent).toMatch(/district: #2 Temp District.*island group: #3 North Chain.*Imperial City → Temp District → North Chain/);
    // An island in no group is fine: nothing requires every island to belong to an island group.
    expect(sel.querySelector('[data-land-id="11"]')!.textContent).toMatch(/district: none · island group: none/);
    expect(screen.queryByText(/declare/i)).toBeNull();
  });
});

describe('creating scopes', () => {
  it('creates district, island group and subregion drafts with their parents — never accepted', async () => {
    scopeServer([CITY, district, group]);
    renderManager(h, dataOf({ features: islands, scopes: [CITY, district, group] }));
    await openTab(/SCOPES/);
    const create = async (kind: string, name: string, parent: string) => {
      await userEvent.click(screen.getByRole('button', { name: '+ NEW SCOPE' }));
      const form = screen.getByLabelText('Scope form');
      await userEvent.selectOptions(within(form).getByLabelText('Scope kind'), kind);
      await userEvent.type(within(form).getByLabelText('Scope name'), name);
      await userEvent.selectOptions(within(form).getByLabelText('Parent scope'), parent);
      await userEvent.click(button(form, /SAVE DRAFT/));
      await waitFor(() => expect(screen.queryByLabelText('Scope form')).toBeNull());
    };
    await create('district', 'Temp Two', '1');
    await create('island_group', 'West Chain', '2');
    await create('subregion', 'Quay Ward', '3');
    const posts = mutations(h);
    expect(posts.map(c => [c.method, path(c)])).toEqual([['POST', '/scopes'], ['POST', '/scopes'], ['POST', '/scopes']]);
    expect(posts.map(c => [c.body!.scope_kind, c.body!.parent_scope_id, c.body!.scope_key])).toEqual([
      ['district', 1, 'temp-two'], ['island_group', 2, 'west-chain'], ['subregion', 3, 'quay-ward']]);
    expect(posts[0].body).toMatchObject({ land_coverage: 'partial', members: [], boundary_feature_id: null });
    for (const c of posts) for (const k of ['culture', 'wealth', 'lifecycle_state']) expect(c.body).not.toHaveProperty(k);
  });

  it('offers only lower-ranked parents', async () => {
    renderManager(h, dataOf({ scopes: [CITY, district, group] }));
    await openTab(/SCOPES/);
    await userEvent.click(screen.getByRole('button', { name: '+ NEW SCOPE' }));
    const form = screen.getByLabelText('Scope form');
    const values = () => [...(within(form).getByLabelText('Parent scope') as HTMLSelectElement).options].map(o => o.value).filter(Boolean);
    expect(values()).toEqual(['1']);
    await userEvent.selectOptions(within(form).getByLabelText('Scope kind'), 'subregion');
    expect(values()).toEqual(['1', '2', '3']);
  });
});

describe('assigning selected land', () => {
  it('assigns several islands to an accepted district in one operation: staged on a revision, then an explicit accept', async () => {
    scopeServer([CITY, district]);
    renderManager(h, dataOf({ features: islands, scopes: [CITY, district] }));
    await openTab(/SCOPES/);
    act(() => h.selection.update(s => ({ ...s, ids: [10, 11, 12] })));
    await userEvent.selectOptions(screen.getByLabelText('Target scope'), '2');
    await userEvent.click(screen.getByRole('button', { name: /ASSIGN SELECTED → TARGET/ }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Confirm accept scope' });
    expect(mutations(h).map(c => [c.method, path(c)])).toEqual([['POST', '/scopes/2/revise'], ['PATCH', '/scopes/20']]);
    expect(mutations(h)[1].body).toEqual({ members: [10, 11, 12], expected_draft_version: 1 });
    expect(dialog.textContent).toMatch(/MEMBERS3 island\(s\) \(was 1\)/);
    expect(dialog.textContent).toMatch(/ADDED#11 Isle 11, #12 Isle 12/);

    await userEvent.click(button(dialog, /ACCEPT DRAFT v2/));
    await waitFor(() => expect(mutations(h)).toHaveLength(3));
    expect(mutations(h)[2]).toMatchObject({ method: 'POST', body: { expected_draft_version: 2 } });
    expect(path(mutations(h)[2])).toBe('/scopes/20/accept');
    expect(h.selection.getState().ids).toEqual([10, 11, 12]);
  });

  it('on a draft scope, assignment is a plain draft edit (no revise, no accept)', async () => {
    const draft = scopeRec(5, 'island_group', 2, { lifecycle_state: 'draft', name: 'Draft Chain' });
    scopeServer([CITY, district, draft]);
    renderManager(h, dataOf({ features: islands, scopes: [CITY, district, draft] }));
    await openTab(/SCOPES/);
    act(() => h.selection.update(s => ({ ...s, ids: [10, 11] })));
    await userEvent.selectOptions(screen.getByLabelText('Target scope'), '5');
    await userEvent.click(screen.getByRole('button', { name: /ASSIGN SELECTED → TARGET/ }));
    await waitFor(() => expect(mutations(h)).toHaveLength(1));
    expect(mutations(h)[0]).toMatchObject({ method: 'PATCH', body: { members: [10, 11], expected_draft_version: 1 } });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('removes selected memberships explicitly', async () => {
    const d = { ...district, members: [10, 11, 12] };
    scopeServer([CITY, d]);
    renderManager(h, dataOf({ features: islands, scopes: [CITY, d] }));
    await openTab(/SCOPES/);
    act(() => h.selection.update(s => ({ ...s, ids: [11, 12, 13] })));
    await userEvent.selectOptions(screen.getByLabelText('Target scope'), '2');
    await userEvent.click(screen.getByRole('button', { name: /REMOVE SELECTED FROM TARGET/ }));
    await screen.findByRole('alertdialog', { name: 'Confirm accept scope' });
    expect(mutations(h)[1].body).toEqual({ members: [10], expected_draft_version: 1 });
    expect(screen.getByRole('alertdialog').textContent).toMatch(/REMOVED#11 Isle 11, #12 Isle 12/);
  });

  it('a contradictory membership is refused by the server: the violation shows, and the selection and staged draft stay', async () => {
    const other = scopeRec(6, 'island_group', 2, { name: 'Other Group' });
    scopeServer([CITY, district, other], (c) => (path(c).endsWith('/accept')
      ? { status: 409, body: { error: 'cannot accept scope #20: 1 cross-feature violation(s)',
        violations: [{ code: 'scope_membership_incoherent', message: 'land #13 would belong to district #7, which is not on the lineage' }] } }
      : null));
    renderManager(h, dataOf({ features: islands, scopes: [CITY, district, other] }));
    await openTab(/SCOPES/);
    act(() => h.selection.update(s => ({ ...s, ids: [13] })));
    await userEvent.selectOptions(screen.getByLabelText('Target scope'), '6');
    await userEvent.click(screen.getByRole('button', { name: /ASSIGN SELECTED → TARGET/ }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Confirm accept scope' });
    await userEvent.click(button(dialog, /ACCEPT DRAFT/));
    expect((await screen.findByLabelText('Accept violations')).textContent).toMatch(/not on the lineage/);
    expect(screen.getByRole('alert').textContent).toMatch(/cannot accept scope #20/);
    expect(screen.getByRole('alertdialog', { name: 'Confirm accept scope' })).toBeInTheDocument();
    expect(h.selection.getState().ids).toEqual([13]);
    expect(mutations(h).some(c => c.method === 'DELETE')).toBe(false);
  });

  it('warns before assigning an island another scope of the same kind already holds — without moving it', async () => {
    const d2 = scopeRec(7, 'district', 1, { name: 'Second District' });
    renderManager(h, dataOf({ features: islands, scopes: [CITY, district, d2] }));
    await openTab(/SCOPES/);
    act(() => h.selection.update(s => ({ ...s, ids: [10] })));
    await userEvent.selectOptions(screen.getByLabelText('Target scope'), '7');
    expect(screen.getByLabelText('Membership notes').textContent).toMatch(/#10 Isle 10 already belongs to #2 Temp District/);
    expect(mutations(h)).toEqual([]);
  });
});

describe('select land inside boundary', () => {
  const b = boundaryFeature(50, -5, -5, 40);
  const withBoundary = { ...district, boundary_feature_id: 50, members: [] };
  const features = [...islands, land(14, 30, 0, 20), b];

  it('previews a proposed selection (no request, no membership), then assigns ordinary explicit members on confirmation', async () => {
    scopeServer([CITY, withBoundary]);
    renderManager(h, dataOf({ features, scopes: [CITY, withBoundary] }));
    await openTab(/SCOPES/);
    await selectScope(2);
    await userEvent.click(button(scopeInspector(), /SELECT LAND INSIDE BOUNDARY/));

    const region = screen.getByRole('region', { name: 'Inside-boundary proposal' });
    expect(region.textContent).toMatch(/2 island\(s\) lie wholly inside/);
    expect(region.textContent).toMatch(/1 cross the boundary and are NOT included/);
    expect(region.textContent).toMatch(/moving the boundary later reassigns nothing/);
    expect(h.selection.getState().proposal).toMatchObject({ inside: [10, 11], straddling: [14] });
    expect(h.selection.getState().ids).toEqual([]);
    expect(mutations(h)).toEqual([]);

    await userEvent.click(button(region, /ASSIGN THESE 2/));
    await screen.findByRole('alertdialog', { name: 'Confirm accept scope' });
    const patch = mutations(h).find(c => c.method === 'PATCH')!;
    expect(patch.body).toEqual({ members: [10, 11], expected_draft_version: 1 });
    expect(h.selection.getState()).toMatchObject({ ids: [10, 11], proposal: null });
  });

  it('can be used only as a selection, or discarded', async () => {
    renderManager(h, dataOf({ features, scopes: [CITY, withBoundary] }));
    await openTab(/SCOPES/);
    await selectScope(2);
    await userEvent.click(button(scopeInspector(), /SELECT LAND INSIDE BOUNDARY/));
    await userEvent.click(screen.getByRole('button', { name: 'USE AS SELECTION' }));
    expect(h.selection.getState()).toMatchObject({ ids: [10, 11], proposal: null });
    expect(mutations(h)).toEqual([]);
  });
});

describe('boundary and coverage', () => {
  it('assigns an existing boundary through a staged revision', async () => {
    scopeServer([CITY, district]);
    renderManager(h, dataOf({ features: [...islands, boundaryFeature(50, -5, -5, 40)], scopes: [CITY, district] }));
    await openTab(/SCOPES/);
    await selectScope(2);
    await userEvent.selectOptions(within(scopeInspector()).getByLabelText('Choose boundary'), '50');
    await userEvent.click(button(scopeInspector(), /^SET$/));
    await screen.findByRole('alertdialog', { name: 'Confirm accept scope' });
    expect(mutations(h)[1].body).toEqual({ boundary_feature_id: 50, expected_draft_version: 1 });
  });

  it('traces a new boundary with the WP5 tool and links the saved draft to the scope — accepting nothing', async () => {
    const draft = scopeRec(5, 'district', 1, { lifecycle_state: 'draft', name: 'Draft District' });
    scopeServer([CITY, draft], (c) => (path(c) === '/features' && c.method === 'POST'
      ? { status: 201, body: { ...boundaryFeature(60, 0, 0, 10), lifecycle_state: 'draft' } } : null));
    renderManager(h, dataOf({ features: islands, scopes: [CITY, draft] }));
    await openTab(/SCOPES/);
    await selectScope(5);
    await userEvent.click(button(scopeInspector(), /TRACE DISTRICT BOUNDARY/));
    expect(screen.getByLabelText('Tracing').textContent).toMatch(/Boundary for #5 Draft District/);
    expect((screen.getByLabelText('Feature class') as HTMLSelectElement).value).toBe('scope_boundary');
    act(() => h.session.update(s => closeRing(addPoint(addPoint(addPoint(beginTrace(s, { geometryType: 'polygon' }), { x: 0, z: 0 }), { x: 10, z: 0 }), { x: 10, z: 10 }))));
    await userEvent.click(screen.getByRole('button', { name: 'SAVE DRAFT' }));
    await waitFor(() => expect(mutations(h)).toHaveLength(2));
    expect(mutations(h)[0]).toMatchObject({ method: 'POST', body: { feature_class: 'scope_boundary' } });
    expect(mutations(h)[1]).toMatchObject({ method: 'PATCH', body: { boundary_feature_id: 60, expected_draft_version: 1 } });
    expect(mutations(h).some(c => path(c).endsWith('/accept'))).toBe(false);
    expect(screen.getByRole('status').textContent).toMatch(/Accept this boundary feature, then accept the scope/);
  });

  it('marking coverage complete states the water-by-complement consequence before anything is sent', async () => {
    scopeServer([CITY, district]);
    renderManager(h, dataOf({ features: islands, scopes: [CITY, district] }));
    await openTab(/SCOPES/);
    await selectScope(2);
    await userEvent.click(button(scopeInspector(), /MARK COVERAGE COMPLETE/));
    const confirm = screen.getByRole('alertdialog', { name: 'Confirm land coverage' });
    expect(confirm.textContent).toMatch(/not accepted land as WATER \(by complement\)/);
    expect(mutations(h)).toEqual([]);
    await userEvent.click(button(confirm, /I UNDERSTAND — MARK COMPLETE/));
    const accept = await screen.findByRole('alertdialog', { name: 'Confirm accept scope' });
    expect(mutations(h)[1].body).toEqual({ land_coverage: 'complete', expected_draft_version: 1 });
    expect(accept.textContent).toMatch(/LAND COVERAGEcomplete \(was partial\) — non-land inside the extent becomes water by complement/);
  });

  it('choosing complete in the scope form also asks first, and cancel leaves it partial', async () => {
    renderManager(h, dataOf({ scopes: [CITY] }));
    await openTab(/SCOPES/);
    await userEvent.click(screen.getByRole('button', { name: '+ NEW SCOPE' }));
    await userEvent.selectOptions(screen.getByLabelText('Land coverage'), 'complete');
    const confirm = screen.getByRole('alertdialog', { name: 'Confirm land coverage' });
    expect(confirm.textContent).toMatch(/WATER \(by complement\)/);
    expect((screen.getByLabelText('Land coverage') as HTMLSelectElement).value).toBe('partial');
    await userEvent.click(button(confirm, /^CANCEL$/));
    expect(screen.queryByRole('alertdialog', { name: 'Confirm land coverage' })).toBeNull();
    expect((screen.getByLabelText('Land coverage') as HTMLSelectElement).value).toBe('partial');
  });

  it('a locked scope offers no membership, boundary or coverage change', async () => {
    const locked = { ...district, is_locked: true };
    renderManager(h, dataOf({ features: islands, scopes: [CITY, locked] }));
    await openTab(/SCOPES/);
    act(() => h.selection.update(s => ({ ...s, ids: [11] })));
    await selectScope(2);
    expect(button(scopeInspector(), /ASSIGN SELECTION \(1\) HERE/)).toBeDisabled();
    expect(button(scopeInspector(), /TRACE DISTRICT BOUNDARY/)).toBeDisabled();
    expect(button(scopeInspector(), /MARK COVERAGE COMPLETE/)).toBeDisabled();
  });
});

describe('map picking', () => {
  it('turns picking on through the scene view and off again', async () => {
    renderManager(h, dataOf({ features: islands }));
    await userEvent.click(screen.getByLabelText('Select on map')); // map inspect off: only picking holds the scene
    await openTab(/SCOPES/);
    await userEvent.click(screen.getByRole('button', { name: 'PICK ON MAP' }));
    expect(h.selection.getState().picking).toBe(true);
    expect(h.onTracingChange).toHaveBeenLastCalledWith(true);
    await userEvent.click(screen.getByRole('button', { name: 'PICKING ON MAP' }));
    expect(h.selection.getState().picking).toBe(false);
    expect(h.onTracingChange).toHaveBeenLastCalledWith(false);
  });

  it('with map inspect on (the default), the scene stays in the canonical view after picking ends', async () => {
    renderManager(h, dataOf({ features: islands }));
    expect(h.onTracingChange).toHaveBeenLastCalledWith(true);
    await openTab(/SCOPES/);
    await userEvent.click(screen.getByRole('button', { name: 'PICK ON MAP' }));
    await userEvent.click(screen.getByRole('button', { name: 'PICKING ON MAP' }));
    expect(h.onTracingChange).toHaveBeenLastCalledWith(true);
  });
});
