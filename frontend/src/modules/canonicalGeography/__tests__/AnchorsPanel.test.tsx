/**
 * The anchor register and part workflow (WP6): manual anchor drafts stay drafts until an
 * explicit accept; the register (GET /anchors/register) shows placed/unplaced; must-exist
 * anchors never offer "replaceable"; parts are traced with the WP5 tool and carry
 * anchor_id + part_role; accepting a part places the anchor; required-scope refusals and
 * warnings are shown without losing the draft.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { addPoint, beginTrace, closeRing } from '../tracing';
import type { AnchorRegister, AnchorRegisterEntry } from '../anchors';
import { CITY, anchorRec, button, dataOf, land, mutations, openTab, path, renderManager, scopeRec, stubFetch, type Harness } from './wp6Fixtures';

let h: Harness;
beforeEach(() => { h = stubFetch(); });
afterEach(() => vi.unstubAllGlobals());

const entry = (over: Partial<AnchorRegisterEntry> = {}): AnchorRegisterEntry => ({
  id: 4, anchor_key: 'arena-test', name: 'Arena', category: 'landmark', constraint_strength: 'hard', must_exist: true,
  replacement_state: 'non_replaceable', is_locked: false, revision: 1, required_scope_id: null, required_scope: null,
  status: 'unplaced', placed: false, part_summary: { count: 0, by_role: {}, parts: [] }, ...over,
});
const registerOf = (entries: AnchorRegisterEntry[]): AnchorRegister => ({
  anchors: entries,
  summary: { total: entries.length, placed: entries.filter(e => e.placed).length, unplaced: entries.filter(e => !e.placed).length,
    unplaced_must_exist: entries.filter(e => !e.placed && e.must_exist).map(e => e.id) },
});

let register = registerOf([]);
function server(extra: (c: { method: string; url: string; body?: Record<string, unknown> }) => { status: number; body: unknown } | null = () => null) {
  h.respond = (c) => extra(c) ?? (path(c) === '/anchors/register' ? { status: 200, body: register } : { status: 200, body: {} });
}

const arena = anchorRec(4);
const selectAnchor = (id: number) => userEvent.click(document.querySelector(`[data-anchor-id="${id}"]`)!);
const anchorInspector = () => screen.getByLabelText('Anchor inspector');

describe('anchor register', () => {
  it('shows an accepted hard must-exist anchor with no parts as UNPLACED, from the register endpoint', async () => {
    register = registerOf([entry()]);
    server();
    renderManager(h, dataOf({ anchors: [arena] }));
    await openTab(/ANCHORS/);
    const list = await screen.findByLabelText('Anchor register');
    await waitFor(() => expect(list.textContent).toMatch(/UNPLACED #4 Arena \(arena-test\) · hard · MUST-EXIST · no accepted parts/));
    expect(screen.getByLabelText('Register summary').textContent).toMatch(/1 accepted · 0 placed · 1 unplaced · 1 must-exist unplaced/);
    expect(h.calls.some(c => path(c) === '/anchors/register' && c.method === 'GET')).toBe(true);
  });

  it('manual creation makes a draft only; accepting it is a separate confirmed request', async () => {
    register = registerOf([]);
    server((c) => (c.method === 'POST' && path(c) === '/anchors'
      ? { status: 201, body: anchorRec(9, { ...(c.body as object), lifecycle_state: 'draft', revision: 0 }) }
      : path(c) === '/anchors/9/accept' ? { status: 200, body: { record: anchorRec(9, { name: 'Arena Test' }), warnings: [] } } : null));
    const { rerenderWith } = renderManager(h, dataOf());
    await openTab(/ANCHORS/);
    await userEvent.click(screen.getByRole('button', { name: '+ NEW ANCHOR' }));
    const form = screen.getByLabelText('Anchor form');
    await userEvent.type(within(form).getByLabelText('Anchor name'), 'Arena Test');
    expect((within(form).getByLabelText('Must exist') as HTMLInputElement).checked).toBe(true);
    await userEvent.click(button(form, /SAVE DRAFT/));
    await waitFor(() => expect(mutations(h)).toHaveLength(1));
    expect(mutations(h)[0]).toMatchObject({ method: 'POST', body: { anchor_key: 'arena-test', name: 'Arena Test', constraint_strength: 'hard', must_exist: true } });
    expect(mutations(h)[0].body).not.toHaveProperty('lifecycle_state');

    const draft = anchorRec(9, { name: 'Arena Test', lifecycle_state: 'draft', revision: 0 });
    rerenderWith(dataOf({ anchors: [draft] }));
    expect(screen.getByLabelText('Anchor drafts').textContent).toMatch(/#9 Arena Test.*DRAFT/);
    expect(anchorInspector().textContent).toMatch(/REGISTERnot in the register until accepted/);

    await userEvent.click(button(anchorInspector(), /ACCEPT…/));
    const dialog = screen.getByRole('alertdialog', { name: 'Confirm accept anchor' });
    expect(dialog.textContent).toMatch(/accepted UNPLACED until a part is accepted/);
    expect(mutations(h)).toHaveLength(1);
    await userEvent.click(button(dialog, /ACCEPT DRAFT v1/));
    await waitFor(() => expect(mutations(h)).toHaveLength(2));
    expect(mutations(h)[1]).toMatchObject({ method: 'POST', body: { expected_draft_version: 1 } });
    expect(path(mutations(h)[1])).toBe('/anchors/9/accept');
    expect(await screen.findByRole('status')).toHaveTextContent('Accepted anchor #9.');
  });

  it('never offers "replaceable" for a must-exist anchor', async () => {
    register = registerOf([entry(), entry({ id: 5, anchor_key: 'soft-one', name: 'Soft', must_exist: false })]);
    server();
    renderManager(h, dataOf({ anchors: [arena, anchorRec(5, { must_exist: false, anchor_key: 'soft-one', name: 'Soft' })] }));
    await openTab(/ANCHORS/);
    await waitFor(() => expect(document.querySelector('[data-anchor-id="5"]')).not.toBeNull());
    await selectAnchor(4);
    const replace = button(anchorInspector(), /MAKE REPLACEABLE/);
    expect(replace).toBeDisabled();
    expect(replace.getAttribute('title')).toBe('a must-exist anchor can never be replaceable');
    await selectAnchor(5);
    expect(button(anchorInspector(), /MAKE REPLACEABLE/)).toBeEnabled();
  });
});

describe('anchor parts through the WP5 tracing tool', () => {
  it('ADD PART opens the tracing tool with the linkage set; saving sends anchor_id + part_role as a draft', async () => {
    register = registerOf([entry()]);
    server((c) => (c.method === 'POST' && path(c) === '/features'
      ? { status: 201, body: land(70, 0, 0, 10, { feature_class: 'site', anchor_id: 4, part_role: 'footprint', lifecycle_state: 'draft' }) } : null));
    renderManager(h, dataOf({ anchors: [arena] }));
    await openTab(/ANCHORS/);
    await selectAnchor(4);
    await userEvent.selectOptions(within(anchorInspector()).getByLabelText('Part role'), 'footprint');
    await userEvent.click(button(anchorInspector(), /ADD PART \(TRACE\)/));

    const tracing = screen.getByLabelText('Tracing');
    expect((within(tracing).getByLabelText('Part of anchor') as HTMLSelectElement).value).toBe('4');
    expect((within(tracing).getByLabelText('Part role') as HTMLSelectElement).value).toBe('footprint');
    expect((within(tracing).getByLabelText('Feature class') as HTMLSelectElement).value).toBe('site');
    expect(h.onTracingChange).toHaveBeenLastCalledWith(true);

    act(() => h.session.update(s => closeRing(addPoint(addPoint(addPoint(beginTrace(s, { geometryType: 'polygon' }), { x: 0, z: 0 }), { x: 10, z: 0 }), { x: 10, z: 10 }))));
    await userEvent.click(within(tracing).getByRole('button', { name: 'SAVE DRAFT' }));
    await waitFor(() => expect(mutations(h)).toHaveLength(1));
    expect(mutations(h)[0]).toMatchObject({ method: 'POST', body: { feature_class: 'site', geometry_type: 'polygon', anchor_id: 4, part_role: 'footprint' } });
    expect(screen.getByRole('status').textContent).toMatch(/Accepting it places anchor #4/);
  });

  it('accepting the part turns the register entry PLACED', async () => {
    register = registerOf([entry()]);
    const part = land(70, 0, 0, 10, { feature_class: 'site', anchor_id: 4, part_role: 'footprint', lifecycle_state: 'draft', revision: 0 });
    server((c) => (path(c) === '/features/70/accept'
      ? { status: 200, body: { record: { ...part, lifecycle_state: 'accepted', revision: 1 }, warnings: [] } } : null));
    const { rerenderWith } = renderManager(h, dataOf({ anchors: [arena], features: [part] }));
    await openTab(/ANCHORS/);
    await selectAnchor(4);
    expect(within(screen.getByLabelText('Anchor parts')).getByText(/#70 footprint · site\/polygon · hard · DRAFT/)).toBeInTheDocument();
    expect(anchorInspector().textContent).toMatch(/REGISTERUNPLACED/);

    await userEvent.click(button(screen.getByLabelText('Anchor parts'), /INSPECT \/ ACCEPT/));
    await userEvent.click(button(screen.getByLabelText('Feature inspector'), /ACCEPT…/));
    await userEvent.click(screen.getByRole('button', { name: /ACCEPT DRAFT v1/ }));
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());

    register = registerOf([entry({ status: 'placed', placed: true, part_summary: { count: 1, by_role: { footprint: 1 }, parts: [] } })]);
    rerenderWith(dataOf({ anchors: [arena], features: [{ ...part, lifecycle_state: 'accepted', revision: 1 }] }));
    await openTab(/ANCHORS/);
    await waitFor(() => expect(screen.getByLabelText('Anchor register').textContent).toMatch(/PLACED #4 Arena.*1 footprint/));
  });
});

describe('required scope', () => {
  const district = scopeRec(2, 'district', 1, { name: 'Temp District' });
  const scoped = anchorRec(4, { required_scope_id: 2 });
  const part = land(70, 500, 500, 10, { feature_class: 'site', anchor_id: 4, part_role: 'footprint', lifecycle_state: 'draft', revision: 0 });

  it('a part outside the required scope is refused with the server reason, and the draft is kept', async () => {
    register = registerOf([entry({ required_scope_id: 2, required_scope: { id: 2, accepted: true, scope_key: 'temp', scope_kind: 'district', name: 'Temp District' } })]);
    server((c) => (path(c) === '/features/70/accept'
      ? { status: 409, body: { error: 'cannot accept feature #70: 1 cross-feature violation(s)',
        violations: [{ code: 'required_scope_violation', message: 'part #70 of anchor "arena-test" lies outside the extent of its anchor\'s required scope #2' }], warnings: [] } }
      : null));
    renderManager(h, dataOf({ anchors: [scoped], features: [part], scopes: [CITY, district] }));
    await openTab(/ANCHORS/);
    await waitFor(() => expect(screen.getByLabelText('Anchor register').textContent).toMatch(/in Temp District/));
    await selectAnchor(4);
    expect(anchorInspector().textContent).toMatch(/REQUIRED SCOPE#2 Temp District \(district\)/);
    await userEvent.click(button(screen.getByLabelText('Anchor parts'), /INSPECT \/ ACCEPT/));
    await userEvent.click(button(screen.getByLabelText('Feature inspector'), /ACCEPT…/));
    await userEvent.click(screen.getByRole('button', { name: /ACCEPT DRAFT v1/ }));
    expect((await screen.findByLabelText('Accept violations')).textContent).toMatch(/lies outside the extent of its anchor's required scope #2/);
    expect(screen.getByRole('alertdialog', { name: 'Confirm accept' })).toBeInTheDocument();
    expect(mutations(h).some(c => c.method === 'DELETE')).toBe(false);
  });

  it('a part accepted while the required scope has no extent surfaces the server warning', async () => {
    register = registerOf([entry()]);
    server((c) => (path(c) === '/features/70/accept'
      ? { status: 200, body: { record: { ...part, lifecycle_state: 'accepted', revision: 1 },
        warnings: [{ code: 'required_scope_unverified', message: 'required scope #2 has no accepted extent yet, so placement inside it is unverified' }] } }
      : null));
    renderManager(h, dataOf({ anchors: [scoped], features: [part], scopes: [CITY, district] }));
    await openTab(/ANCHORS/);
    await selectAnchor(4);
    await userEvent.click(button(screen.getByLabelText('Anchor parts'), /INSPECT \/ ACCEPT/));
    await userEvent.click(button(screen.getByLabelText('Feature inspector'), /ACCEPT…/));
    await userEvent.click(screen.getByRole('button', { name: /ACCEPT DRAFT v1/ }));
    expect(await screen.findByRole('status')).toHaveTextContent(/Warnings: required scope #2 has no accepted extent yet/);
  });
});
