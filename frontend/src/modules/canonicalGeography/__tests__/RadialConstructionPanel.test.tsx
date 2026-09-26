/**
 * RADIAL CONSTRUCT through the manager (plan §15.6, §15.9, §15.13, §15.14):
 * eligibility, blocking errors and explicit omission, the Create request, failure keeping
 * state, the review list (nothing pre-ticked; explicit Accept selected; Discard drafts
 * only), Reconstruct pre-fill and revision-mode availability, and the inspector's record
 * display with its stale-inputs notice.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CanonicalGeographyManager } from '../CanonicalGeographyManager';
import type { CanonicalGeographyData } from '../api';
import type { CanonicalFeature, WorldXZ } from '../types';
import { circleFromDefinition, type RadialSpokeConstruction } from '../geometry';
import { CONSTRUCTOR_HINTS } from '../tracing';
import { CLASS_KINDS } from '../featureEditing';
import { createRadialSession, requestRadialPick, type RadialSession } from '../radialSession';
import { revisionAvailability } from '../radialWorkflow';
import { dataOf, land, mutations, path, stubFetch, type Harness } from './wp6Fixtures';

let h: Harness;
let radial: RadialSession;
beforeEach(() => { h = stubFetch(); radial = createRadialSession(); });
afterEach(() => vi.unstubAllGlobals());

const sq = (half: number): WorldXZ[] => [{ x: -half, z: -half }, { x: half, z: -half }, { x: half, z: half }, { x: -half, z: half }];
const polygonFeature = (id: number, ring: WorldXZ[], over: Partial<CanonicalFeature> = {}): CanonicalFeature => ({
  ...land(id, 0), feature_class: 'site', name: `Ring ${id}`, geometry: { outer: ring, holes: [] },
  bbox: { min_x: Math.min(...ring.map(p => p.x)), min_z: Math.min(...ring.map(p => p.z)), max_x: Math.max(...ring.map(p => p.x)), max_z: Math.max(...ring.map(p => p.z)) },
  ...over,
});
const wall = (id: number, half: number, over: Partial<CanonicalFeature> = {}): CanonicalFeature => ({
  ...polygonFeature(id, sq(half)), feature_class: 'route', kind: 'wall', geometry_type: 'linestring', name: `Wall ${id}`,
  geometry: [...sq(half), sq(half)[0]], ...over,
});

const INNER = polygonFeature(10, sq(50), { name: 'Inner ring' });
const OUTER = wall(11, 200, { name: 'Outer ring' });
const DRAFT_RING = polygonFeature(12, sq(60), { lifecycle_state: 'draft', revision: 0, name: 'Draft ring' });
const OPEN_LINE = { ...wall(13, 300), geometry: sq(300), name: 'Open line' } as CanonicalFeature;
const POINT = { ...land(14, 0), feature_class: 'site', geometry_type: 'point', geometry: { x: 1, z: 2 }, name: 'Center point' } as CanonicalFeature;
const BASE = [INNER, OUTER, DRAFT_RING, OPEN_LINE, POINT];

function renderWith(data: CanonicalGeographyData) {
  const props = {
    token: 'tok', referenceLayers: [], refresh: h.refresh, session: h.session, tracingActive: true,
    onTracingChange: h.onTracingChange, overlayVisible: true, onToggleOverlay: vi.fn(), onClose: vi.fn(), selection: h.selection, pick: h.pick, radial,
  };
  const utils = render(<CanonicalGeographyManager {...props} data={data} />);
  return { ...utils, rerenderWith: (d: CanonicalGeographyData) => utils.rerender(<CanonicalGeographyManager {...props} data={d} />) };
}

const panel = () => screen.getByLabelText('Radial construction');
const open = () => userEvent.click(screen.getByRole('button', { name: 'RADIAL CONSTRUCT' }));
const createButton = () => within(panel()).getByRole('button', { name: /^CREATE/ });
const blockers = () => screen.queryByLabelText('Create blockers')?.textContent ?? '';

async function fill({ inner = 10, outer = 11, x = '0', z = '0', n = '4', offset = '0' } = {}) {
  await userEvent.selectOptions(screen.getByLabelText('Inner boundary'), String(inner));
  await userEvent.selectOptions(screen.getByLabelText('Outer boundary'), String(outer));
  await userEvent.clear(screen.getByLabelText('Center X'));
  await userEvent.type(screen.getByLabelText('Center X'), x);
  await userEvent.clear(screen.getByLabelText('Center Z'));
  await userEvent.type(screen.getByLabelText('Center Z'), z);
  await userEvent.clear(screen.getByLabelText('Spoke count'));
  await userEvent.type(screen.getByLabelText('Spoke count'), n);
  await userEvent.clear(screen.getByLabelText('Angular offset'));
  await userEvent.type(screen.getByLabelText('Angular offset'), offset);
}

const spokeRecord = (index: number, over: Partial<RadialSpokeConstruction> = {}): RadialSpokeConstruction => ({
  type: 'radial_spoke', version: 1, construction_id: 'c0ffee00-0000-4000-8000-000000000001', center: { x: 0, z: 0 },
  center_source: { kind: 'coordinate' }, inner: { feature_id: 10, revision: 1 }, outer: { feature_id: 11, revision: 1 },
  count: 4, offset_deg: 0, omit_indices: [], index, angle_deg: index * 90, angle_convention: 'deg_from_+x_toward_+z', ...over,
});
const AXIS: [WorldXZ, WorldXZ][] = [[{ x: 50, z: 0 }, { x: 200, z: 0 }], [{ x: 0, z: 50 }, { x: 0, z: 200 }], [{ x: -50, z: 0 }, { x: -200, z: 0 }], [{ x: 0, z: -50 }, { x: 0, z: -200 }]];
const spoke = (id: number, index: number, over: Partial<CanonicalFeature> = {}, rec: Partial<RadialSpokeConstruction> = {}): CanonicalFeature => ({
  ...wall(id, 1), name: `Spoke #${index}`, geometry: AXIS[index], construction: spokeRecord(index, rec) as unknown as Record<string, unknown>,
  bbox: { min_x: -200, min_z: -200, max_x: 200, max_z: 200 }, ...over,
});
const acceptedSpokes = (over: (i: number) => Partial<CanonicalFeature> = () => ({})) => [0, 1, 2, 3].map(i => spoke(100 + i, i, over(i)));

describe('eligibility and blocking (§15.3, §15.13)', () => {
  it('offers only accepted closed boundaries; ineligible features are listed with their reason', async () => {
    renderWith(dataOf({ features: BASE }));
    await open();
    const options = [...(screen.getByLabelText('Inner boundary') as HTMLSelectElement).options].map(o => o.value).filter(Boolean);
    expect(options).toEqual(['10', '11']);
    const ineligible = screen.getByLabelText('Ineligible boundaries').textContent!;
    expect(ineligible).toMatch(/#12 Draft ring .* draft — accept it first/);
    expect(ineligible).toMatch(/#13 Open line .* open linestring/);
    expect(ineligible).not.toMatch(/#14/); // points are not boundary candidates at all
  });

  it('a construction error disables Create and says why', async () => {
    renderWith(dataOf({ features: BASE }));
    await open();
    await fill({ x: '60' });
    expect(createButton()).toBeDisabled();
    expect(blockers()).toMatch(/lies outside the inner boundary \(feature #10\)/);
    expect(screen.getByLabelText('Center readout').textContent).toMatch(/VS INNEROUTSIDE/);
  });

  it('per-spoke errors disable Create until every invalid index is explicitly omitted', async () => {
    const wide = polygonFeature(20, [{ x: -150, z: -30 }, { x: 150, z: -30 }, { x: 150, z: 30 }, { x: -150, z: 30 }]);
    const tall = polygonFeature(21, [{ x: -100, z: -200 }, { x: 100, z: -200 }, { x: 100, z: 200 }, { x: -100, z: 200 }]);
    renderWith(dataOf({ features: [wide, tall] }));
    await open();
    await fill({ inner: 20, outer: 21 });
    const table = screen.getByLabelText('Spoke preview');
    expect(table.querySelector('[data-spoke="0"]')!.getAttribute('data-status')).toBe('invalid');
    expect(table.textContent).toMatch(/Spoke 0 \(0\.000°\): outer boundary reached .* rings cross here/);
    expect(createButton()).toBeDisabled();
    await userEvent.click(screen.getByLabelText('Omit spoke 0'));
    expect(createButton()).toBeDisabled();
    await userEvent.click(screen.getByLabelText('Omit spoke 2'));
    expect(createButton()).toBeEnabled();
    expect(createButton().textContent).toBe('CREATE 2 DRAFTS');
    expect(mutations(h)).toEqual([]); // preview never writes
  });
});

describe('Create (§15.6 step 10)', () => {
  it('sends the pinned revisions, center, parameters and output settings in one request', async () => {
    h.respond = () => ({ status: 201, body: { ok: true, mode: 'new_drafts', construction_id: 'abcd1234-0000', features: [], spokes: [], errors: [], normalized: {} } });
    renderWith(dataOf({ features: [INNER, { ...OUTER, revision: 3 }] }));
    await open();
    await fill({ offset: '-30' });
    await userEvent.selectOptions(screen.getByLabelText('Output kind'), 'wall');
    await userEvent.type(screen.getByLabelText('Output width'), '4');
    await userEvent.clear(screen.getByLabelText('Name prefix'));
    await userEvent.type(screen.getByLabelText('Name prefix'), 'Radial');
    await userEvent.click(createButton());
    await waitFor(() => expect(mutations(h)).toHaveLength(1));
    const [call] = mutations(h);
    expect(path(call)).toBe('/constructions/radial');
    expect(call.body).toEqual({
      inner: { feature_id: 10, expected_revision: 1 }, outer: { feature_id: 11, expected_revision: 3 },
      center: { x: 0, z: 0 }, center_source: { kind: 'coordinate' }, count: 4, offset_deg: 330, omit_indices: [],
      output: { feature_class: 'route', kind: 'wall', constraint_strength: 'hard', width_wu: 4, name_prefix: 'Radial' }, dry_run: false,
    });
  });

  it('a feature-derived center sends the feature pin and no coordinate', async () => {
    h.respond = () => ({ status: 201, body: { ok: true, mode: 'new_drafts', construction_id: 'x', features: [], spokes: [], errors: [], normalized: {} } });
    renderWith(dataOf({ features: BASE }));
    await open();
    await fill();
    await userEvent.selectOptions(screen.getByLabelText('Center source'), 'feature_point');
    await userEvent.selectOptions(screen.getByLabelText('Center feature'), '14');
    await userEvent.click(createButton());
    await waitFor(() => expect(mutations(h)).toHaveLength(1));
    expect(mutations(h)[0].body).toMatchObject({ center_source: { kind: 'feature_point', feature_id: 14, expected_revision: 1 } });
    expect(mutations(h)[0].body).not.toHaveProperty('center');
  });

  it('a refused Create keeps every input and shows the server\'s reasons', async () => {
    h.respond = (c) => (path(c) === '/constructions/radial'
      ? { status: 409, body: { error: 'radial construction refused', ok: false, errors: [{ code: 'stale_input', message: 'Outer boundary (feature #11) changed from revision 1 to 2 since preview.' }], spokes: [] } }
      : { status: 200, body: [] });
    renderWith(dataOf({ features: BASE }));
    await open();
    await fill({ n: '6', offset: '12.5' });
    await userEvent.click(createButton());
    await waitFor(() => expect(screen.getByLabelText('Server refusal').textContent).toMatch(/changed from revision 1 to 2/));
    expect(screen.getByLabelText('Radial construction')).toBeInTheDocument();
    expect((screen.getByLabelText('Spoke count') as HTMLInputElement).value).toBe('6');
    expect((screen.getByLabelText('Angular offset') as HTMLInputElement).value).toBe('12.5');
    expect(screen.queryByLabelText('Radial construction review')).toBeNull();
    expect(h.refresh).toHaveBeenCalled(); // stale: reload and re-preview
    expect(screen.getByText(/Preview refreshed from current canon/)).toBeInTheDocument();
  });
});

describe('review list (§15.6 steps 11–12)', () => {
  const cid = 'c0ffee00-0000-4000-8000-000000000001';
  const drafts = [0, 1, 2, 3].map(i => spoke(200 + i, i, { lifecycle_state: 'draft', revision: 0, draft_version: i + 1 }));

  async function reviewAfterCreate() {
    h.respond = (c) => (path(c) === '/constructions/radial'
      ? { status: 201, body: { ok: true, mode: 'new_drafts', construction_id: cid, features: drafts, spokes: [], errors: [], normalized: {} } }
      : { status: 200, body: { record: {}, warnings: [] } });
    const utils = renderWith(dataOf({ features: BASE }));
    await open();
    await fill();
    await userEvent.click(createButton());
    await screen.findByLabelText('Radial construction review');
    utils.rerenderWith(dataOf({ features: [...BASE, ...drafts] }));
    return utils;
  }

  it('pre-ticks nothing and offers no accept-all', async () => {
    await reviewAfterCreate();
    const review = screen.getByLabelText('Radial construction review');
    const boxes = within(review).getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes).toHaveLength(4);
    expect(boxes.every(b => !b.checked)).toBe(true);
    expect(within(review).getByRole('button', { name: /ACCEPT SELECTED \(0\)/ })).toBeDisabled();
    expect(within(review).queryByRole('button', { name: /accept all|lock/i })).toBeNull();
  });

  it('Accept selected confirms the count, then accepts each at its own draft version, one by one', async () => {
    await reviewAfterCreate();
    const before = mutations(h).length;
    await userEvent.click(screen.getByLabelText('Select spoke #201'));
    await userEvent.click(screen.getByLabelText('Select spoke #203'));
    await userEvent.click(screen.getByRole('button', { name: /ACCEPT SELECTED \(2\)/ }));
    const dialog = screen.getByRole('alertdialog', { name: 'Confirm accept selected' });
    expect(dialog.querySelector('[data-confirm="count"]')!.textContent).toBe('2');
    expect(dialog.textContent).toMatch(/CLASSroute.*KINDwall.*STRENGTHhard.*TOTAL LENGTH/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'ACCEPT 2' }));
    await waitFor(() => expect(mutations(h).length - before).toBe(2));
    expect(mutations(h).slice(before).map(c => [path(c), c.body])).toEqual([
      ['/features/201/accept', { expected_draft_version: 2 }],
      ['/features/203/accept', { expected_draft_version: 4 }],
    ]);
  });

  it('stops at the first refused accept and says which were accepted', async () => {
    await reviewAfterCreate();
    h.respond = (c) => (path(c) === '/features/202/accept' ? { status: 409, body: { error: 'draft_version is 9' } } : { status: 200, body: { record: {}, warnings: [] } });
    const before = mutations(h).length;
    for (const id of [201, 202, 203]) await userEvent.click(screen.getByLabelText(`Select spoke #${id}`));
    await userEvent.click(screen.getByRole('button', { name: /ACCEPT SELECTED \(3\)/ }));
    await userEvent.click(within(screen.getByRole('alertdialog', { name: 'Confirm accept selected' })).getByRole('button', { name: 'ACCEPT 3' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Accepted #201\. Stopped at #202: draft_version is 9/));
    expect(mutations(h).slice(before).map(path)).toEqual(['/features/201/accept', '/features/202/accept']);
  });

  it('shows the server\'s rows until the refetch lands, then only loaded data (a deleted draft never reappears)', async () => {
    h.respond = (c) => (path(c) === '/constructions/radial'
      ? { status: 201, body: { ok: true, mode: 'new_drafts', construction_id: cid, features: drafts, spokes: [], errors: [], normalized: {} } }
      : { status: 200, body: [] });
    const utils = renderWith(dataOf({ features: BASE }));
    await open();
    await fill();
    await userEvent.click(createButton());
    const review = await screen.findByLabelText('Radial construction review');
    expect(within(review).getAllByRole('checkbox')).toHaveLength(4); // from the Create response
    utils.rerenderWith(dataOf({ features: [...BASE, ...drafts.slice(2)] })); // two drafts since deleted elsewhere
    expect(within(screen.getByLabelText('Radial construction review')).getAllByRole('checkbox')).toHaveLength(2);
  });

  it('Discard drafts deletes only draft rows of the construction, after a count confirmation', async () => {
    const mixed = [spoke(300, 0), ...drafts.slice(1)];
    renderWith(dataOf({ features: [...BASE, ...mixed] }));
    await userEvent.click(document.querySelector('[data-feature-id="300"]')!);
    await userEvent.click(screen.getByRole('button', { name: 'REVIEW CONSTRUCTION' }));
    const review = screen.getByLabelText('Radial construction review');
    expect((screen.getByLabelText('Select spoke #300') as HTMLInputElement).disabled).toBe(true); // accepted rows are never tickable
    await userEvent.click(within(review).getByRole('button', { name: /DISCARD DRAFTS OF THIS CONSTRUCTION \(3\)/ }));
    const dialog = screen.getByRole('alertdialog', { name: 'Confirm discard drafts' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'DISCARD 3' }));
    await waitFor(() => expect(mutations(h)).toHaveLength(3));
    expect(mutations(h).map(c => `${c.method} ${path(c)}`)).toEqual(['DELETE /features/201', 'DELETE /features/202', 'DELETE /features/203']);
  });
});

describe('reconstruct (§15.9)', () => {
  const inspectAndReconstruct = async (id: number) => {
    await userEvent.click(document.querySelector(`[data-feature-id="${id}"]`)!);
    await userEvent.click(screen.getByRole('button', { name: /RECONSTRUCT FROM THIS CONSTRUCTION/ }));
  };

  it('pre-fills from the record and offers revision mode when every condition holds', async () => {
    renderWith(dataOf({ features: [...BASE, ...acceptedSpokes()] }));
    await inspectAndReconstruct(101);
    expect(screen.getByText(/RADIAL CONSTRUCT · RECONSTRUCT c0ffee00/)).toBeInTheDocument();
    expect((screen.getByLabelText('Inner boundary') as HTMLSelectElement).value).toBe('10');
    expect((screen.getByLabelText('Outer boundary') as HTMLSelectElement).value).toBe('11');
    expect((screen.getByLabelText('Spoke count') as HTMLInputElement).value).toBe('4');
    expect(screen.getByLabelText('Revision mode')).toBeChecked();
    expect(screen.queryByLabelText('Output settings')).toBeNull(); // revision mode keeps canon's own class/kind/strength/name
    expect(createButton()).toBeEnabled();
    expect(createButton().textContent).toBe('CREATE DRAFT REVISIONS');
  });

  it('sends every accepted sibling in revises and no output', async () => {
    h.respond = () => ({ status: 201, body: { ok: true, mode: 'revision', construction_id: 'c0ffee00', features: [], spokes: [], errors: [], normalized: {} } });
    renderWith(dataOf({ features: [...BASE, ...acceptedSpokes()] }));
    await inspectAndReconstruct(102);
    await userEvent.clear(screen.getByLabelText('Angular offset'));
    await userEvent.type(screen.getByLabelText('Angular offset'), '5');
    await userEvent.click(createButton());
    await waitFor(() => expect(mutations(h)).toHaveLength(1));
    const body = mutations(h)[0].body!;
    expect(body.revises).toEqual([0, 1, 2, 3].map(i => ({ index: i, feature_id: 100 + i, expected_revision: 1 })));
    expect(body).not.toHaveProperty('output');
    expect(body).toMatchObject({ count: 4, omit_indices: [], offset_deg: 5 });
  });

  it('editing N or an omission disables revision mode with a reason pointing to new-drafts mode; restoring re-enables it', async () => {
    renderWith(dataOf({ features: [...BASE, ...acceptedSpokes()] }));
    await inspectAndReconstruct(100);
    await userEvent.clear(screen.getByLabelText('Spoke count'));
    await userEvent.type(screen.getByLabelText('Spoke count'), '5');
    expect(document.querySelector('[data-revision-reason]')!.textContent).toMatch(/N differs from the recorded 4.*NEW DRAFTS mode/);
    expect(createButton()).toBeDisabled();
    await userEvent.clear(screen.getByLabelText('Spoke count'));
    await userEvent.type(screen.getByLabelText('Spoke count'), '4');
    expect(document.querySelector('[data-revision-reason]')).toBeNull();
    expect(createButton()).toBeEnabled();

    await userEvent.click(screen.getByLabelText('Omit spoke 1'));
    expect(document.querySelector('[data-revision-reason]')!.textContent).toMatch(/omissions differ .*NEW DRAFTS mode/);
    expect(createButton()).toBeDisabled();
    await userEvent.click(screen.getByLabelText('New drafts mode'));
    expect(createButton()).toBeEnabled(); // the changed set is a new construction
    await userEvent.click(screen.getByLabelText('Revision mode'));
    await userEvent.click(screen.getByLabelText('Omit spoke 1'));
    expect(createButton()).toBeEnabled();
  });

  it('is not offered while a sibling is locked, or has an open draft revision', async () => {
    renderWith(dataOf({ features: [...BASE, ...acceptedSpokes(i => (i === 2 ? { is_locked: true } : {}))] }));
    await inspectAndReconstruct(100);
    expect(screen.getByLabelText('New drafts mode')).toBeChecked();
    expect(document.querySelector('[data-revision-reason]')!.textContent).toMatch(/locked: spoke 2 \(#102\)/);
    const spokes = acceptedSpokes();
    const open = { ...spokes[3], id: 150, lifecycle_state: 'draft' as const, revises_id: 103 };
    expect(revisionAvailability([...spokes, open], spokes[0].construction!.construction_id as string, 4, []))
      .toEqual({ enabled: false, reason: expect.stringMatching(/open draft revision on spoke 3 \(#103\)/) });
  });

  it('a 409 revision refusal shows the listed reasons, keeps the preview, and shows no draft revisions', async () => {
    h.respond = (c) => (path(c) === '/constructions/radial'
      ? { status: 409, body: { error: 'radial construction refused', ok: false, mode: 'revision', spokes: [], errors: [
        { code: 'revision_target_locked', message: 'Spoke 2 (feature #102) is locked. Unlock it (its own request) before reconstructing in revision mode.' },
        { code: 'revision_missing_sibling', message: 'Accepted spoke(s) #199 (spoke 0) of this construction are missing from the revision.' },
      ] } }
      : { status: 200, body: [] });
    renderWith(dataOf({ features: [...BASE, ...acceptedSpokes()] }));
    await inspectAndReconstruct(100);
    await userEvent.click(createButton());
    const refusal = await screen.findByLabelText('Server refusal');
    expect(refusal.textContent).toMatch(/Spoke 2 \(feature #102\) is locked/);
    expect(refusal.textContent).toMatch(/#199 \(spoke 0\) .* missing/);
    expect(screen.queryByLabelText('Radial construction review')).toBeNull();
    expect(screen.getByLabelText('Spoke preview')).toBeInTheDocument();
    expect(radial.getState().preview?.spokes).toHaveLength(4);
  });
});

describe('inspector record and stale-inputs notice (§15.8)', () => {
  it('shows the record read-only, and notices an input revised since construction without doing anything', async () => {
    renderWith(dataOf({ features: [INNER, { ...OUTER, revision: 2 }, ...acceptedSpokes()] }));
    await userEvent.click(document.querySelector('[data-feature-id="102"]')!);
    const rec = screen.getByLabelText('Radial construction record');
    expect(rec.textContent).toMatch(/SPOKE2 of N = 4/);
    expect(rec.textContent).toMatch(/INNER#10 r1/);
    expect(rec.textContent).toMatch(/OUTER#11 r1/);
    expect(screen.getByLabelText('Stale inputs').textContent).toMatch(/outer #11 now at r2 \(built from r1\)/);
    expect(mutations(h)).toEqual([]);
  });

  it('reports a retired or missing input', async () => {
    renderWith(dataOf({ features: [OUTER, ...acceptedSpokes()] }));
    await userEvent.click(document.querySelector('[data-feature-id="100"]')!);
    expect(screen.getByLabelText('Stale inputs').textContent).toMatch(/inner #10 not found/);
  });
});

describe('map picking and aiming', () => {
  it('a boundary click takes the one eligible candidate, and lists ineligible ones with reasons', async () => {
    renderWith(dataOf({ features: BASE }));
    await open();
    await userEvent.click(within(panel()).getAllByRole('button', { name: 'PICK ON MAP' })[0]);
    expect(radial.getState().pickMode).toBe('inner');
    act(() => radial.update(s => requestRadialPick(s, { x: 0, z: 0 }, [12, 10])));
    expect((screen.getByLabelText('Inner boundary') as HTMLSelectElement).value).toBe('10');
    await userEvent.click(within(panel()).getAllByRole('button', { name: 'PICK ON MAP' })[1]);
    act(() => radial.update(s => requestRadialPick(s, { x: 0, z: 0 }, [12, 13])));
    const chooser = screen.getByRole('dialog', { name: 'Choose picked feature' });
    expect(chooser.textContent).toMatch(/#12 .* ineligible: draft — accept it first/);
    expect(within(chooser).getAllByRole('button').filter(b => b.hasAttribute('data-choice-id')).every(b => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it('a center click sets the coordinate; aiming spoke 0 sets θ₀ from center to the click', async () => {
    renderWith(dataOf({ features: BASE }));
    await open();
    await userEvent.click(within(panel()).getByRole('button', { name: 'CLICK MAP' }));
    act(() => radial.update(s => requestRadialPick(s, { x: 1.23456, z: -2 }, [])));
    expect((screen.getByLabelText('Center X') as HTMLInputElement).value).toBe('1.235');
    await userEvent.click(within(panel()).getByRole('button', { name: 'AIM SPOKE 0' }));
    act(() => radial.update(s => requestRadialPick(s, { x: 1.235, z: 8 }, [])));
    expect((screen.getByLabelText('Angular offset') as HTMLInputElement).value).toBe('90');
    expect(within(panel()).getByText(/Angles run from \+X toward \+Z/)).toBeInTheDocument();
  });

  it('opening pauses map inspection and closing restores it; the preview is discarded on close', async () => {
    renderWith(dataOf({ features: BASE }));
    expect(h.pick.getState().inspecting).toBe(true);
    await open();
    expect(h.pick.getState().inspecting).toBe(false);
    expect(radial.getState().active).toBe(true);
    await fill();
    expect(radial.getState().preview?.spokes).toHaveLength(4);
    await userEvent.click(screen.getByRole('button', { name: 'Close radial construct' }));
    expect(h.pick.getState().inspecting).toBe(true);
    expect(radial.getState()).toMatchObject({ active: false, preview: null });
    expect(mutations(h)).toEqual([]);
  });
});

describe('inline circle boundaries (§15.3.1)', () => {
  const pickCircle = (role: 'Inner' | 'Outer') =>
    userEvent.click(within(screen.getByLabelText(`${role} circle`)).getByRole('button', { name: /PICK \d POINTS ON MAP/ }));
  const click = (x: number, z: number) => act(() => radial.update(s => requestRadialPick(s, { x, z }, [])));
  const center = async (x: string, z: string) => {
    await userEvent.clear(screen.getByLabelText('Center X'));
    await userEvent.type(screen.getByLabelText('Center X'), x);
    await userEvent.clear(screen.getByLabelText('Center Z'));
    await userEvent.type(screen.getByLabelText('Center Z'), z);
  };

  it('each boundary independently offers an existing canonical boundary or a constructed circle', async () => {
    renderWith(dataOf({ features: BASE }));
    await open();
    expect((screen.getByLabelText('Inner boundary source') as HTMLSelectElement).value).toBe('feature');
    await userEvent.selectOptions(screen.getByLabelText('Outer boundary source'), 'circle');
    expect(screen.getByLabelText('Outer circle')).toBeInTheDocument();
    expect(screen.queryByLabelText('Inner circle')).toBeNull();
    expect(screen.getByLabelText('Inner boundary')).toBeInTheDocument(); // the canonical picker is still there for INNER
    expect(screen.queryByLabelText('Outer boundary')).toBeNull();
    // The shape creator's own circle modes and instructions.
    const outerCircle = screen.getByLabelText('Outer circle');
    expect(within(outerCircle).getByRole('button', { name: 'CIRCLE 3PT' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(outerCircle).getByRole('button', { name: 'CIRCLE C+R' })).toBeInTheDocument();
    expect(outerCircle.textContent).toContain(CONSTRUCTOR_HINTS.circle_3pt);
    await userEvent.click(within(outerCircle).getByRole('button', { name: 'CIRCLE C+R' }));
    expect(screen.getByLabelText('Outer circle').textContent).toContain(CONSTRUCTOR_HINTS.circle_center);
  });

  it('a three-point circle is picked on the map inside the radial workflow and previews immediately, nothing sent', async () => {
    renderWith(dataOf({ features: BASE }));
    await open();
    await userEvent.selectOptions(screen.getByLabelText('Inner boundary'), '10');
    await userEvent.selectOptions(screen.getByLabelText('Outer boundary source'), 'circle');
    await center('0', '0');
    await pickCircle('Outer');
    expect(radial.getState().pickMode).toBe('outer_circle');
    click(300, 0);
    click(0, 300);
    expect(radial.getState().pickMode).toBe('outer_circle'); // still collecting: 2/3
    expect(screen.getByLabelText('Outer circle').textContent).toMatch(/\(2\/3\)/);
    click(-300, 0);
    expect(radial.getState().pickMode).toBeNull();
    expect(screen.getByLabelText('Outer circle').textContent).toMatch(/centre \(0, 0\).*radius .*construction input only, not a canonical feature/);
    // The preview is there at once: spokes and the constructed circle ring, from the same helper the shape creator uses.
    const preview = radial.getState().preview!;
    expect(preview.spokes).toHaveLength(8);
    expect(preview.spokes.every(s => s.status === 'valid')).toBe(true);
    expect(preview.spokes[0].geometry).toEqual([{ x: 50, z: 0 }, { x: 300, z: 0 }]);
    expect(preview.circles).toEqual([{ ring: circleFromDefinition('three_point', [{ x: 300, z: 0 }, { x: 0, z: 300 }, { x: -300, z: 0 }])!.ring, materialize: false }]);
    expect(createButton()).toBeEnabled();
    expect(mutations(h)).toEqual([]);
  });

  it('Create sends the circle definition (never geometry) and makes only the spoke drafts — no canonical circle', async () => {
    h.respond = () => ({ status: 201, body: { ok: true, mode: 'new_drafts', construction_id: 'x', features: [], spokes: [], errors: [], normalized: {} } });
    renderWith(dataOf({ features: BASE }));
    await open();
    await userEvent.selectOptions(screen.getByLabelText('Inner boundary source'), 'circle');
    await userEvent.click(within(screen.getByLabelText('Inner circle')).getByRole('button', { name: 'CIRCLE C+R' }));
    await pickCircle('Inner');
    click(0, 0);
    click(100.0004, 0);
    await userEvent.selectOptions(screen.getByLabelText('Outer boundary'), '11');
    await userEvent.click(screen.getByRole('button', { name: 'USE CENTER OF INNER CIRCLE' }));
    await userEvent.click(createButton());
    await waitFor(() => expect(mutations(h)).toHaveLength(1));
    const [call] = mutations(h);
    expect(`${call.method} ${path(call)}`).toBe('POST /constructions/radial');
    expect(call.body!.inner).toEqual({ circle: { method: 'center_radius', points: [{ x: 0, z: 0 }, { x: 100, z: 0 }] } });
    expect(call.body!.outer).toEqual({ feature_id: 11, expected_revision: 1 });
    expect(call.body!.center).toEqual({ x: 0, z: 0 });
  });

  it('collinear clicks are refused with the shape creator\'s message and block Create', async () => {
    renderWith(dataOf({ features: BASE }));
    await open();
    await userEvent.selectOptions(screen.getByLabelText('Inner boundary'), '10');
    await userEvent.selectOptions(screen.getByLabelText('Outer boundary source'), 'circle');
    await center('0', '0');
    await pickCircle('Outer');
    click(0, 0); click(10, 10); click(20, 20);
    expect(screen.getByText(/do not define a shape \(collinear or coincident\)/)).toBeInTheDocument();
    expect(blockers()).toMatch(/outer circle's points do not define a circle/);
    expect(createButton()).toBeDisabled();
  });

  it('reconstruct restores an inline circle source from the persisted record, and may revise it', async () => {
    const circleRec = { method: 'three_point' as const, points: [{ x: 300, z: 0 }, { x: 0, z: 300 }, { x: -300, z: 0 }],
      center: { x: 0, z: 0 }, radius: 300, segments: 95, max_chord_error_m: 0.25 };
    const spokes = [0, 1, 2, 3].map(i => spoke(400 + i, i, { geometry: [AXIS[i][0], { x: AXIS[i][1].x * 1.5, z: AXIS[i][1].z * 1.5 }] }, { outer: { circle: circleRec } }));
    h.respond = () => ({ status: 201, body: { ok: true, mode: 'revision', construction_id: 'c', features: [], spokes: [], errors: [], normalized: {} } });
    renderWith(dataOf({ features: [...BASE, ...spokes] }));
    await userEvent.click(document.querySelector('[data-feature-id="401"]')!);
    const rec = screen.getByLabelText('Radial construction record');
    expect(rec.textContent).toMatch(/OUTERconstructed circle \(3 rim points\), centre \(0, 0\)/);
    expect(screen.queryByLabelText('Stale inputs')).toBeNull(); // a circle has no revision to go stale
    await userEvent.click(screen.getByRole('button', { name: /RECONSTRUCT FROM THIS CONSTRUCTION/ }));
    expect((screen.getByLabelText('Outer boundary source') as HTMLSelectElement).value).toBe('circle');
    expect(within(screen.getByLabelText('Outer circle')).getByRole('button', { name: 'CIRCLE 3PT' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Outer circle').textContent).toMatch(/centre \(0, 0\)/);
    expect((screen.getByLabelText('Inner boundary') as HTMLSelectElement).value).toBe('10');
    expect(radial.getState().preview!.spokes.every(s => s.status === 'valid')).toBe(true);
    expect(screen.getByLabelText('Revision mode')).toBeChecked();
    // Re-pick the circle larger: revision mode stays available (a boundary input change), and the new definition is sent.
    await pickCircle('Outer');
    click(320, 0); click(0, 320); click(-320, 0);
    await userEvent.click(createButton());
    await waitFor(() => expect(mutations(h)).toHaveLength(1));
    expect(mutations(h)[0].body).toMatchObject({
      outer: { circle: { method: 'three_point', points: [{ x: 320, z: 0 }, { x: 0, z: 320 }, { x: -320, z: 0 }] } },
      revises: spokes.map(s => ({ index: (s.construction as { index: number }).index, feature_id: s.id, expected_revision: 1 })),
    });
  });
});

describe('materializing a constructed boundary as a canonical draft (§15.3.1)', () => {
  const click = (x: number, z: number) => act(() => radial.update(s => requestRadialPick(s, { x, z }, [])));
  const circleRing = circleFromDefinition('three_point', [{ x: 300, z: 0 }, { x: 0, z: 300 }, { x: -300, z: 0 }])!.ring;
  const setup = async () => {
    const utils = renderWith(dataOf({ features: BASE }));
    await open();
    await userEvent.selectOptions(screen.getByLabelText('Inner boundary'), '10');
    await userEvent.selectOptions(screen.getByLabelText('Outer boundary source'), 'circle');
    await userEvent.clear(screen.getByLabelText('Center X'));
    await userEvent.type(screen.getByLabelText('Center X'), '0');
    await userEvent.clear(screen.getByLabelText('Center Z'));
    await userEvent.type(screen.getByLabelText('Center Z'), '0');
    await userEvent.click(within(screen.getByLabelText('Outer circle')).getByRole('button', { name: /PICK 3 POINTS ON MAP/ }));
    click(300, 0); click(0, 300); click(-300, 0);
    return utils;
  };

  it('is offered only for a constructed circle, never for an existing canonical boundary', async () => {
    await setup();
    expect(screen.getByLabelText('Create outer boundary as canonical draft')).not.toBeChecked(); // off by default
    expect(screen.queryByLabelText('Create inner boundary as canonical draft')).toBeNull(); // INNER is a canonical feature
    await userEvent.selectOptions(screen.getByLabelText('Inner boundary source'), 'circle');
    expect(screen.getByLabelText('Create inner boundary as canonical draft')).toBeInTheDocument();
  });

  it('takes ordinary feature semantics, distinguishes the scheduled boundary in the preview, and states the draft count', async () => {
    await setup();
    expect(createButton().textContent).toBe('CREATE 8 DRAFTS');
    await userEvent.click(screen.getByLabelText('Create outer boundary as canonical draft'));
    const classes = [...(screen.getByLabelText('Outer boundary class') as HTMLSelectElement).options].map(o => o.value);
    expect(classes).toEqual(['land', 'water', 'route', 'protected_region', 'site', 'scope_boundary']);
    expect(screen.getByLabelText('Outer boundary class').textContent).toMatch(/route \(closed linestring\).*site \(polygon\)/);
    await userEvent.selectOptions(screen.getByLabelText('Outer boundary kind'), 'wall');
    expect([...(screen.getByLabelText('Outer boundary kind') as HTMLSelectElement).options].map(o => o.value)).toEqual(['', ...CLASS_KINDS.route!]);
    await userEvent.selectOptions(screen.getByLabelText('Outer boundary class'), 'site');
    expect(screen.getByLabelText('Outer boundary kind')).toBeDisabled(); // site takes no kind
    await userEvent.selectOptions(screen.getByLabelText('Outer boundary class'), 'route');
    expect(radial.getState().preview!.circles).toEqual([{ ring: circleRing, materialize: true }]);
    expect(createButton().textContent).toBe('CREATE 9 DRAFTS: 1 BOUNDARY + 8 SPOKES');
    expect(screen.getByLabelText('Outer circle').textContent).toMatch(/Create also makes it a canonical feature draft/);
  });

  it('sends the materialization with the circle definition in the one request, and reviews boundary drafts apart from spokes', async () => {
    const ringDraft = { ...land(90, 0), feature_class: 'route' as const, kind: 'wall', geometry_type: 'linestring' as const, name: 'Outer wall ring',
      lifecycle_state: 'draft' as const, revision: 0, geometry: [...circleRing, circleRing[0]], construction: null };
    const drafts = [0, 1, 2, 3, 4, 5, 6, 7].map(i => spoke(500 + i, i % 4, { lifecycle_state: 'draft', revision: 0 },
      { index: i, count: 8, angle_deg: i * 45, outer: { circle: { method: 'three_point', points: [{ x: 300, z: 0 }, { x: 0, z: 300 }, { x: -300, z: 0 }], center: { x: 0, z: 0 }, radius: 300, segments: 95, max_chord_error_m: 0.25 }, materialized_feature_id: 90 } }));
    h.respond = (c) => (path(c) === '/constructions/radial'
      ? { status: 201, body: { ok: true, mode: 'new_drafts', construction_id: 'c0ffee00-0000-4000-8000-000000000001', features: drafts, boundary_features: [{ role: 'outer', feature: ringDraft }], spokes: [], errors: [], normalized: {} } }
      : { status: 200, body: [] });
    const utils = await setup();
    await userEvent.click(screen.getByLabelText('Create outer boundary as canonical draft'));
    await userEvent.selectOptions(screen.getByLabelText('Outer boundary kind'), 'wall');
    await userEvent.clear(screen.getByLabelText('Outer boundary name'));
    await userEvent.type(screen.getByLabelText('Outer boundary name'), 'Outer wall ring');
    await userEvent.click(createButton());
    await waitFor(() => expect(mutations(h)).toHaveLength(1));
    expect(mutations(h)[0].body!.outer).toEqual({
      circle: { method: 'three_point', points: [{ x: 300, z: 0 }, { x: 0, z: 300 }, { x: -300, z: 0 }] },
      materialize: { feature_class: 'route', kind: 'wall', constraint_strength: 'hard', name: 'Outer wall ring' },
    });
    const review = await screen.findByLabelText('Radial construction review');
    const boundaries = within(review).getByLabelText('Boundary drafts');
    expect(boundaries.textContent).toMatch(/outer: #90 Outer wall ring · route\/wall · linestring · DRAFT/);
    expect(within(review).getAllByRole('checkbox')).toHaveLength(8); // Accept selected covers spokes only
    expect(screen.getByRole('status').textContent).toMatch(/Also created 1 boundary draft\(s\): #90 \(outer\).*not accepted/);
    // After the refetch the boundary is an ordinary draft in the FEATURES data, openable in the inspector.
    utils.rerenderWith(dataOf({ features: [...BASE, ringDraft, ...drafts] }));
    await userEvent.click(within(screen.getByLabelText('Boundary drafts')).getByRole('button', { name: 'OPEN' }));
    const inspector = screen.getByLabelText('Feature inspector');
    expect(inspector.textContent).toMatch(/#90 Outer wall ring/);
    expect(inspector.textContent).toMatch(/DRAFT/);
    expect(mutations(h)).toHaveLength(1); // nothing was accepted
  });

  it('reconstruction restores the circle but never re-selects materialization', async () => {
    const circleRec = { method: 'three_point' as const, points: [{ x: 300, z: 0 }, { x: 0, z: 300 }, { x: -300, z: 0 }], center: { x: 0, z: 0 }, radius: 300, segments: 95, max_chord_error_m: 0.25 };
    const spokes = [0, 1, 2, 3].map(i => spoke(600 + i, i, {}, { outer: { circle: circleRec, materialized_feature_id: 77 } }));
    h.respond = () => ({ status: 201, body: { ok: true, mode: 'revision', construction_id: 'c', features: [], boundary_features: [], spokes: [], errors: [], normalized: {} } });
    renderWith(dataOf({ features: [...BASE, ...spokes] }));
    await userEvent.click(document.querySelector('[data-feature-id="601"]')!);
    expect(screen.getByLabelText('Radial construction record').textContent).toMatch(/created as draft #77 \(independent\)/);
    await userEvent.click(screen.getByRole('button', { name: /RECONSTRUCT FROM THIS CONSTRUCTION/ }));
    expect((screen.getByLabelText('Outer boundary source') as HTMLSelectElement).value).toBe('circle');
    expect(screen.getByLabelText('Create outer boundary as canonical draft')).not.toBeChecked();
    expect(createButton().textContent).toBe('CREATE DRAFT REVISIONS');
    await userEvent.click(createButton());
    await waitFor(() => expect(mutations(h)).toHaveLength(1));
    expect(mutations(h)[0].body!.outer).not.toHaveProperty('materialize');
  });
});

describe('materialized boundary width and the SPOKE OUTPUT block', () => {
  const click = (x: number, z: number) => act(() => radial.update(s => requestRadialPick(s, { x, z }, [])));
  async function twoCircles() {
    renderWith(dataOf({ features: BASE }));
    await open();
    for (const [Role, r] of [['Inner', 100], ['Outer', 300]] as const) {
      await userEvent.selectOptions(screen.getByLabelText(`${Role} boundary source`), 'circle');
      await userEvent.click(within(screen.getByLabelText(`${Role} circle`)).getByRole('button', { name: /PICK 3 POINTS ON MAP/ }));
      click(r, 0); click(0, r); click(-r, 0);
      await userEvent.click(screen.getByLabelText(`Create ${Role.toLowerCase()} boundary as canonical draft`));
    }
    await userEvent.clear(screen.getByLabelText('Center X'));
    await userEvent.type(screen.getByLabelText('Center X'), '0');
    await userEvent.clear(screen.getByLabelText('Center Z'));
    await userEvent.type(screen.getByLabelText('Center Z'), '0');
  }

  it('labels the lower block SPOKE OUTPUT, applying to spokes only', async () => {
    renderWith(dataOf({ features: BASE }));
    await open();
    const block = screen.getByLabelText('Output settings');
    expect(block.textContent).toMatch(/^SPOKE OUTPUT — applies to the spoke drafts only/);
    expect(block.textContent).not.toMatch(/OUTPUT CLASS/);
  });

  it('a route boundary shows WIDTH wu; a non-route boundary does not', async () => {
    await twoCircles();
    expect(screen.getByLabelText('Outer boundary width')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Outer boundary width'), '7');
    await userEvent.selectOptions(screen.getByLabelText('Outer boundary class'), 'land');
    expect(screen.queryByLabelText('Outer boundary width')).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('Outer boundary class'), 'route');
    expect((screen.getByLabelText('Outer boundary width') as HTMLInputElement).value).toBe(''); // not carried over from a non-route class
  });

  it('INNER, OUTER and spoke widths are independent, and the request carries each on its own output', async () => {
    h.respond = () => ({ status: 201, body: { ok: true, mode: 'new_drafts', construction_id: 'x', features: [], boundary_features: [], spokes: [], errors: [], normalized: {} } });
    await twoCircles();
    await userEvent.selectOptions(screen.getByLabelText('Outer boundary kind'), 'wall');
    await userEvent.type(screen.getByLabelText('Outer boundary width'), '7.87');
    await userEvent.type(screen.getByLabelText('Inner boundary width'), '3.5');
    await userEvent.selectOptions(screen.getByLabelText('Output kind'), 'wall');
    await userEvent.type(screen.getByLabelText('Output width'), '5.25');
    expect((screen.getByLabelText('Inner boundary width') as HTMLInputElement).value).toBe('3.5');
    expect((screen.getByLabelText('Outer boundary width') as HTMLInputElement).value).toBe('7.87');
    expect((screen.getByLabelText('Output width') as HTMLInputElement).value).toBe('5.25');
    await userEvent.clear(screen.getByLabelText('Inner boundary width'));
    expect((screen.getByLabelText('Outer boundary width') as HTMLInputElement).value).toBe('7.87');
    await userEvent.type(screen.getByLabelText('Inner boundary width'), '3.5');
    await userEvent.click(createButton());
    await waitFor(() => expect(mutations(h)).toHaveLength(1));
    const b = mutations(h)[0].body!;
    expect((b.outer as { materialize: unknown }).materialize).toEqual({ feature_class: 'route', kind: 'wall', constraint_strength: 'hard', name: 'Outer ring', width_wu: 7.87 });
    expect((b.inner as { materialize: unknown }).materialize).toEqual({ feature_class: 'route', kind: null, constraint_strength: 'hard', name: 'Inner ring', width_wu: 3.5 });
    expect(b.output).toMatchObject({ kind: 'wall', width_wu: 5.25 });
  });

  it('an omitted boundary width is simply not sent; an invalid one blocks Create with the ordinary route-width message', async () => {
    await twoCircles();
    expect(createButton()).toBeEnabled();
    await userEvent.type(screen.getByLabelText('Outer boundary width'), '-2');
    expect(blockers()).toMatch(/outer boundary draft: width must be a positive number of world units/);
    expect(createButton()).toBeDisabled();
  });

  it('reconstruction restores spoke output (with its width) but not boundary materialization or width', async () => {
    const circleRec = { method: 'three_point' as const, points: [{ x: 300, z: 0 }, { x: 0, z: 300 }, { x: -300, z: 0 }], center: { x: 0, z: 0 }, radius: 300, segments: 95, max_chord_error_m: 0.25 };
    const spokes = [0, 1, 2, 3].map(i => spoke(700 + i, i, { attributes: { width_wu: 5.25 } }, { outer: { circle: circleRec, materialized_feature_id: 77 } }));
    renderWith(dataOf({ features: [...BASE, ...spokes] }));
    await userEvent.click(document.querySelector('[data-feature-id="701"]')!);
    await userEvent.click(screen.getByRole('button', { name: /RECONSTRUCT FROM THIS CONSTRUCTION/ }));
    await userEvent.click(screen.getByLabelText('New drafts mode'));
    expect((screen.getByLabelText('Output width') as HTMLInputElement).value).toBe('5.25');
    expect(screen.getByLabelText('Create outer boundary as canonical draft')).not.toBeChecked();
    expect(screen.queryByLabelText('Outer boundary width')).toBeNull();
  });
});
