/**
 * Required connections (WP6): endpoints chosen from lists or the map selection, soft
 * connections need no route, hard ones are refused on accept without an accepted via
 * route (and accepted with one), and nothing becomes canon except through Accept.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  anchorRec, button, connectionRec, dataOf, land, mutations, openTab, path, renderManager, routeFeature, stubFetch, type Harness,
} from './wp6Fixtures';

let h: Harness;
beforeEach(() => { h = stubFetch(); });
afterEach(() => vi.unstubAllGlobals());

const node = (id: number, x: number) => land(id, x, 0, 1, { feature_class: 'site', geometry_type: 'point', geometry: { x, z: 0 },
  anchor_id: 8, part_role: 'node', name: `Node ${id}` });
const features = [land(1, 0), land(2, 20), node(3, 5), node(4, 25), routeFeature(5, { kind: 'bridge' }), routeFeature(6, { lifecycle_state: 'draft' })];
const data = () => dataOf({ features, anchors: [anchorRec(8, { name: 'Arboretum', anchor_key: 'arboretum-test', category: 'network' })] });

const form = () => screen.getByLabelText('Connection form');
const newConnection = async () => {
  await openTab(/CONNECTIONS/);
  await userEvent.click(screen.getByRole('button', { name: '+ NEW CONNECTION' }));
};

describe('connection creation', () => {
  it('picks endpoints from lists (islands, anchor nodes) and saves a soft draft with no route — never accepting', async () => {
    h.respond = (c) => (c.method === 'POST' ? { status: 201, body: connectionRec(40, { ...(c.body as object), lifecycle_state: 'draft', revision: 0 }) } : { status: 200, body: {} });
    renderManager(h, data());
    await newConnection();
    const from = within(form()).getByLabelText('FROM endpoint') as HTMLSelectElement;
    expect([...from.options].map(o => o.textContent)).toEqual(expect.arrayContaining([
      expect.stringMatching(/#1 Isle 1 · island/), expect.stringMatching(/#3 Node 3 · site · part of anchor #8 \(node\)/)]));
    await userEvent.selectOptions(from, '3');
    await userEvent.selectOptions(within(form()).getByLabelText('TO endpoint'), '4');
    await userEvent.selectOptions(within(form()).getByLabelText('Connection kind'), 'utility');
    expect(screen.queryByLabelText('Connection accept hints')).toBeNull();
    await userEvent.click(button(form(), /SAVE DRAFT/));
    await waitFor(() => expect(mutations(h)).toHaveLength(1));
    expect(mutations(h)[0]).toMatchObject({ method: 'POST', body: {
      from_ref_type: 'feature', from_ref_id: 3, to_ref_type: 'feature', to_ref_id: 4, connection_kind: 'utility', constraint_strength: 'soft', via_feature_id: null } });
    expect(path(mutations(h)[0])).toBe('/connections');
    expect(screen.getByRole('status').textContent).toMatch(/not canon until accepted/);
  });

  it('fills both endpoints from two islands selected on the map', async () => {
    renderManager(h, data());
    await newConnection();
    expect(button(form(), /USE MAP SELECTION \(0\/2/)).toBeDisabled();
    act(() => h.selection.update(s => ({ ...s, ids: [1, 2] })));
    await userEvent.click(button(form(), /USE MAP SELECTION \(2\/2/));
    expect((within(form()).getByLabelText('FROM endpoint') as HTMLSelectElement).value).toBe('1');
    expect((within(form()).getByLabelText('TO endpoint') as HTMLSelectElement).value).toBe('2');
  });

  it('can join an anchor or a scope, not only features', async () => {
    renderManager(h, data());
    await newConnection();
    await userEvent.selectOptions(within(form()).getByLabelText('FROM type'), 'anchor');
    const from = within(form()).getByLabelText('FROM endpoint') as HTMLSelectElement;
    expect([...from.options].map(o => o.value)).toEqual(['', '8']);
    await userEvent.selectOptions(within(form()).getByLabelText('TO type'), 'scope');
    expect([...(within(form()).getByLabelText('TO endpoint') as HTMLSelectElement).options].map(o => o.value)).toEqual(['', '1']);
  });

  it('refuses to save a connection from an entity to itself', async () => {
    renderManager(h, data());
    await newConnection();
    await userEvent.selectOptions(within(form()).getByLabelText('FROM endpoint'), '1');
    await userEvent.selectOptions(within(form()).getByLabelText('TO endpoint'), '1');
    expect(screen.getByLabelText('Connection form issues').textContent).toMatch(/two different entities/);
    expect(button(form(), /SAVE DRAFT/)).toBeDisabled();
  });
});

describe('hard connections', () => {
  it('warns that hard needs an accepted via route, and a draft via is not enough', async () => {
    renderManager(h, data());
    await newConnection();
    await userEvent.selectOptions(within(form()).getByLabelText('FROM endpoint'), '1');
    await userEvent.selectOptions(within(form()).getByLabelText('TO endpoint'), '2');
    await userEvent.selectOptions(within(form()).getByLabelText('Connection strength'), 'hard');
    expect(screen.getByLabelText('Connection accept hints').textContent).toMatch(/accept requires an accepted route as VIA/);
    await userEvent.selectOptions(within(form()).getByLabelText('Via route'), '6');
    expect(screen.getByLabelText('Connection accept hints').textContent).toMatch(/via route #6 is draft/);
    await userEvent.selectOptions(within(form()).getByLabelText('Via route'), '5');
    expect(screen.queryByLabelText('Connection accept hints')).toBeNull();
  });

  it('a hard draft without via is refused on accept: the server reason shows and the draft stays', async () => {
    const hard = connectionRec(41, { lifecycle_state: 'draft', revision: 0, constraint_strength: 'hard' });
    h.respond = (c) => (path(c) === '/connections/41/accept'
      ? { status: 409, body: { error: 'cannot accept connection #41: 1 cross-feature violation(s)',
        violations: [{ code: 'hard_connection_requires_via', message: 'a hard connection must have an accepted via_feature_id fixing its alignment; without one it must be soft' }] } }
      : { status: 200, body: {} });
    renderManager(h, dataOf({ features, connections: [hard] }));
    await openTab(/CONNECTIONS/);
    await userEvent.click(document.querySelector('[data-connection-id="41"]')!);
    const insp = screen.getByLabelText('Connection inspector');
    expect(within(insp).getByLabelText('Connection accept hints').textContent).toMatch(/requires an accepted route as VIA/);
    await userEvent.click(button(insp, /ACCEPT…/));
    await userEvent.click(button(screen.getByRole('alertdialog', { name: 'Confirm accept connection' }), /ACCEPT DRAFT v1/));
    expect((await screen.findByLabelText('Accept violations')).textContent).toMatch(/must have an accepted via_feature_id/);
    expect(mutations(h).map(c => path(c))).toEqual(['/connections/41/accept']);
  });

  it('a hard connection with an accepted via route is accepted through the confirmation', async () => {
    const hard = connectionRec(42, { lifecycle_state: 'draft', revision: 0, constraint_strength: 'hard', via_feature_id: 5, connection_kind: 'bridge' });
    h.respond = (c) => (path(c) === '/connections/42/accept'
      ? { status: 200, body: { record: { ...hard, lifecycle_state: 'accepted', revision: 1 }, warnings: [] } } : { status: 200, body: {} });
    renderManager(h, dataOf({ features, connections: [hard] }));
    await openTab(/CONNECTIONS/);
    await userEvent.click(document.querySelector('[data-connection-id="42"]')!);
    const insp = screen.getByLabelText('Connection inspector');
    expect(insp.textContent).toMatch(/VIA#5 Route 5 · route\/bridge/);
    expect(mutations(h)).toEqual([]);
    await userEvent.click(button(insp, /ACCEPT…/));
    const dialog = screen.getByRole('alertdialog', { name: 'Confirm accept connection' });
    expect(mutations(h)).toEqual([]);
    await userEvent.click(button(dialog, /ACCEPT DRAFT v1/));
    await waitFor(() => expect(mutations(h)).toHaveLength(1));
    expect(mutations(h)[0].body).toEqual({ expected_draft_version: 1 });
    expect(await screen.findByRole('status')).toHaveTextContent('Accepted connection #42.');
  });
});
