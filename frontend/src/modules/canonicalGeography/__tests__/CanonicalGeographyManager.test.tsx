/**
 * The feature manager (plan §7.2, §10 "Manager", WP5): list and inspector, save draft,
 * accept through confirmation with the displayed draft_version, revise, lock, retire and
 * restore, replacement state, history, and the tracing readout. Every action is one request
 * to the lifecycle API; nothing here may shortcut it.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CanonicalGeographyManager, TraceReadout, evidenceStatus, sourcePixelReadout } from '../CanonicalGeographyManager';
import type { CanonicalGeographyData } from '../api';
import type { CanonicalFeature } from '../types';
import { IDLE_TRACE, addPoint, beginTrace, closeRing, createTracingSession, type TracingSession } from '../tracing';
import { worldToSource, type ReferenceLayer } from '../../referenceLayers';

const square = (x = 0, s = 10) => ({ outer: [{ x, z: 0 }, { x: x + s, z: 0 }, { x: x + s, z: s }, { x, z: s }], holes: [] });

const feature = (over: Partial<CanonicalFeature> = {}): CanonicalFeature => ({
  id: 1, entity_type: 'feature', name: 'North Isle', description: null, notes: null,
  feature_class: 'land', kind: null, geometry_type: 'polygon', geometry: square(),
  construction: null, attributes: null, bbox: { min_x: 0, min_z: 0, max_x: 10, max_z: 10 },
  anchor_id: null, part_role: null, constraint_strength: 'hard',
  lifecycle_state: 'accepted', provenance: 'authored', replacement_state: 'non_replaceable', is_locked: false,
  revision: 1, draft_version: 1, revises_id: null, base_revision: null, evidence: null, proposal: null,
  ...over,
});

const layer: ReferenceLayer = {
  id: 5, name: 'Imperial City', asset_id: 1, asset_url: '/x.png', original_name: null, format: 'png',
  source_width_px: 6032, source_height_px: 4584, world_center_x: 12, world_center_z: -7,
  world_units_per_pixel: 250 / 127, rotation_rad: 0.1, opacity: 0.5, is_visible: true, is_locked: true,
  provenance: 'imported', replacement_state: 'non_replaceable',
};

const data = (features: CanonicalFeature[], over: Partial<CanonicalGeographyData> = {}): CanonicalGeographyData => ({
  features, anchors: [], connections: [], scopes: [{ id: 1, lifecycle_state: 'accepted' } as CanonicalGeographyData['scopes'][number]], includesWorkingSet: true, ...over,
});

type Call = { method: string; url: string; body: Record<string, unknown> | undefined };
let calls: Call[];
let respond: (c: Call) => { status: number; body: unknown };
let session: TracingSession;
let refresh: ReturnType<typeof vi.fn>;
let onTracingChange: ReturnType<typeof vi.fn>;
let onClose: ReturnType<typeof vi.fn>;

beforeEach(() => {
  calls = [];
  respond = () => ({ status: 200, body: {} });
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit = {}) => {
    const call = { method: init.method ?? 'GET', url: String(url), body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const { status, body } = respond(call);
    return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response);
  }));
  session = createTracingSession();
  refresh = vi.fn();
  onTracingChange = vi.fn();
  onClose = vi.fn();
});

afterEach(() => vi.unstubAllGlobals());

function renderManager(d: CanonicalGeographyData, { layers = [layer], tracingActive = false } = {}) {
  return render(
    <CanonicalGeographyManager token="tok" data={d} referenceLayers={layers} refresh={refresh} session={session}
      tracingActive={tracingActive} onTracingChange={onTracingChange} overlayVisible onToggleOverlay={vi.fn()} onClose={onClose} />);
}

const mutations = () => calls.filter(c => c.method !== 'GET');
const selectFeature = (id: number) => userEvent.click(document.querySelector(`[data-feature-id="${id}"]`)!);
const inspector = () => screen.getByLabelText('Feature inspector');
const button = (scope: HTMLElement, name: RegExp) => within(scope).getByRole('button', { name });

describe('CanonicalGeographyManager', () => {
  it('counts what the scene draws by lifecycle state, and shows no working-set counts it did not load', () => {
    const { container, rerender } = renderManager(data([feature(), feature({ id: 2, lifecycle_state: 'draft' })]));
    const cells = (row: string) => [...container.querySelector(`[data-row="${row}"]`)!.querySelectorAll('td')].map(td => td.textContent);
    expect(cells('FEATURES')).toEqual(['FEATURES', '1', '1', '0']);
    rerender(<CanonicalGeographyManager token="tok" data={data([feature()], { includesWorkingSet: false })} referenceLayers={[]}
      refresh={refresh} session={session} tracingActive={false} onTracingChange={onTracingChange} overlayVisible onToggleOverlay={vi.fn()} onClose={onClose} />);
    expect(cells('FEATURES')).toEqual(['FEATURES', '1', '—', '—']);
  });

  it('lists features with state, revision and lock glyph, filtered by state and class', async () => {
    renderManager(data([feature({ is_locked: true }), feature({ id: 2, lifecycle_state: 'draft', feature_class: 'water', name: 'Bay' })]));
    const list = screen.getByLabelText('Feature list');
    expect(list.textContent).toContain('#1 North Isle · land · ACCEPTED · r1 🔒');
    expect(list.textContent).toContain('#2 Bay · water · DRAFT');
    await userEvent.click(screen.getByLabelText('Show draft'));
    expect(list.textContent).not.toContain('Bay');
    await userEvent.selectOptions(screen.getByLabelText('Filter by class'), 'water');
    expect(list.textContent).toContain('No features match');
  });

  it('offers no accept-all, and accept only through a confirmation that sends the displayed draft_version', async () => {
    const draft = feature({ id: 7, lifecycle_state: 'draft', revision: 0, draft_version: 3, name: 'Draft Isle' });
    respond = (c) => (c.url.endsWith('/features/7/accept')
      ? { status: 200, body: { record: { ...draft, lifecycle_state: 'accepted', revision: 1 }, warnings: [] } }
      : { status: 200, body: {} });
    renderManager(data([draft, feature({ id: 8, lifecycle_state: 'draft' })]));
    expect(screen.queryByRole('button', { name: /accept all/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /accept/i })).toBeNull(); // nothing selected, nothing to accept

    await selectFeature(7);
    await userEvent.click(button(inspector(), /ACCEPT…/));
    expect(mutations()).toEqual([]); // opening the dialog sends nothing

    const dialog = screen.getByRole('alertdialog', { name: 'Confirm accept' });
    expect(dialog.textContent).toMatch(/draft #7, draft v3/);
    expect(dialog.textContent).toMatch(/new canonical feature, revision 1/);
    expect(dialog.textContent).toMatch(/STRENGTHhard/);
    expect(dialog.textContent).toMatch(/REPLACEMENTnon_replaceable/);
    expect(dialog.textContent).toMatch(/VERTICES4/);
    expect(dialog.textContent).toMatch(/AREA232 m²/); // 100 wu² × 1.524²
    await userEvent.click(button(dialog, /ACCEPT DRAFT v3/));

    await waitFor(() => expect(mutations()).toHaveLength(1));
    expect(mutations()[0]).toEqual({ method: 'POST', url: '/api/canonical-geography/features/7/accept', body: { expected_draft_version: 3 } });
    expect(await screen.findByRole('status')).toHaveTextContent('Accepted feature #7 at revision 1.');
    expect(refresh).toHaveBeenCalled();
  });

  it('keeps the dialog open with every cross-feature violation when accept is refused', async () => {
    const draft = feature({ id: 7, lifecycle_state: 'draft', revision: 0 });
    respond = () => ({ status: 409, body: { error: 'cannot accept feature #7: 2 cross-feature violation(s)',
      violations: [{ code: 'land_contact', message: 'overlaps accepted land #1' }, { code: 'x', message: 'second problem' }], warnings: [] } });
    renderManager(data([draft]));
    await selectFeature(7);
    await userEvent.click(button(inspector(), /ACCEPT…/));
    await userEvent.click(screen.getByRole('button', { name: /ACCEPT DRAFT v1/ }));
    const violations = await screen.findByLabelText('Accept violations');
    expect(violations.textContent).toContain('overlaps accepted land #1');
    expect(violations.textContent).toContain('second problem');
    expect(screen.getByRole('alertdialog', { name: 'Confirm accept' })).toBeInTheDocument();
  });

  it('"then lock" is a second, separate request after the accept succeeds', async () => {
    const draft = feature({ id: 7, lifecycle_state: 'draft', revision: 0 });
    respond = (c) => (c.url.endsWith('/accept')
      ? { status: 200, body: { record: { ...draft, lifecycle_state: 'accepted', revision: 1 }, warnings: [] } }
      : { status: 200, body: { ...draft, is_locked: true } });
    renderManager(data([draft]));
    await selectFeature(7);
    await userEvent.click(button(inspector(), /ACCEPT…/));
    await userEvent.click(screen.getByLabelText('Lock after accepting'));
    await userEvent.click(screen.getByRole('button', { name: /ACCEPT DRAFT v1/ }));
    await waitFor(() => expect(mutations()).toHaveLength(2));
    expect(mutations().map(c => [c.method, c.url, c.body])).toEqual([
      ['POST', '/api/canonical-geography/features/7/accept', { expected_draft_version: 1 }],
      ['PATCH', '/api/canonical-geography/features/7/lock', { is_locked: true }],
    ]);
  });

  it('disables revise, retire, replacement and edits on a locked row; unlock is its own request', async () => {
    renderManager(data([feature({ is_locked: true })]));
    await selectFeature(1);
    for (const name of [/^REVISE$/, /RETIRE/, /REPLACEABLE/, /EDIT NAME/]) expect(button(inspector(), name)).toBeDisabled();
    await userEvent.click(button(inspector(), /UNLOCK/));
    await waitFor(() => expect(mutations()).toHaveLength(1));
    expect(mutations()[0]).toMatchObject({ method: 'PATCH', url: '/api/canonical-geography/features/1/lock', body: { is_locked: false } });
  });

  it('revises accepted canon into a draft and selects it', async () => {
    const revision = feature({ id: 11, lifecycle_state: 'draft', revises_id: 1, base_revision: 1, revision: 1 });
    respond = () => ({ status: 201, body: revision });
    const { rerender } = renderManager(data([feature()]));
    await selectFeature(1);
    await userEvent.click(button(inspector(), /^REVISE$/));
    await waitFor(() => expect(mutations()).toEqual([{ method: 'POST', url: '/api/canonical-geography/features/1/revise', body: undefined }]));
    rerender(<CanonicalGeographyManager token="tok" data={data([feature(), revision])} referenceLayers={[layer]} refresh={refresh}
      session={session} tracingActive={false} onTracingChange={onTracingChange} overlayVisible onToggleOverlay={vi.fn()} onClose={onClose} />);
    expect(inspector().textContent).toContain('#11');
    expect(inspector().textContent).toMatch(/REVISES#1 \(built on r1\)/);
  });

  it('changes replacement state only after confirmation, with a body of that one field', async () => {
    renderManager(data([feature()]));
    await selectFeature(1);
    await userEvent.click(button(inspector(), /MAKE REPLACEABLE/));
    expect(mutations()).toEqual([]);
    await userEvent.click(within(screen.getByRole('alertdialog', { name: 'Confirm replacement' })).getByRole('button', { name: 'CONFIRM' }));
    await waitFor(() => expect(mutations()).toHaveLength(1));
    expect(mutations()[0]).toEqual({ method: 'PATCH', url: '/api/canonical-geography/features/1/replacement', body: { replacement_state: 'replaceable' } });
  });

  it('retires after confirmation, and restores from the retired filter', async () => {
    const retiredRow = feature({ id: 3, lifecycle_state: 'retired', name: 'Old Isle' });
    respond = (c) => (c.method === 'GET' && c.url.includes('states=retired')
      ? { status: 200, body: [retiredRow] }
      : c.url.endsWith('/restore') ? { status: 200, body: { record: { ...retiredRow, lifecycle_state: 'accepted' }, warnings: [] } }
        : { status: 200, body: {} });
    renderManager(data([feature()]));
    await selectFeature(1);
    await userEvent.click(button(inspector(), /RETIRE/));
    await userEvent.click(within(screen.getByRole('alertdialog', { name: 'Confirm retire' })).getByRole('button', { name: 'CONFIRM' }));
    await waitFor(() => expect(mutations()[0]).toMatchObject({ method: 'POST', url: '/api/canonical-geography/features/1/retire' }));
    // Retiring turns the retired filter on, which loads retired rows (editor-only read).
    await waitFor(() => expect(screen.getByLabelText('Feature list').textContent).toContain('Old Isle'));
    await selectFeature(3);
    await userEvent.click(button(inspector(), /RESTORE/));
    await waitFor(() => expect(mutations().at(-1)).toMatchObject({ method: 'POST', url: '/api/canonical-geography/features/3/restore' }));
  });

  it('shows history and creates a draft from an accepted revision', async () => {
    respond = (c) => (c.url.includes('/revisions') && c.method === 'GET'
      ? { status: 200, body: [
        { id: 1, entity_type: 'feature', entity_id: 1, revision: 1, change_kind: 'accept', snapshot: {}, created_at: 't1' },
        { id: 2, entity_type: 'feature', entity_id: 1, revision: 1, change_kind: 'lock', snapshot: {}, created_at: 't2' },
        { id: 3, entity_type: 'feature', entity_id: 1, revision: 1, change_kind: 'unlock', snapshot: {}, created_at: 't3' },
        { id: 4, entity_type: 'feature', entity_id: 1, revision: 2, change_kind: 'accept', snapshot: {}, created_at: 't4' },
      ] }
      : { status: 201, body: feature({ id: 20, lifecycle_state: 'draft', revises_id: 1 }) });
    renderManager(data([feature({ revision: 2 })]));
    await selectFeature(1);
    await userEvent.click(button(inspector(), /HISTORY/));
    const history = await screen.findByLabelText('Revision history');
    expect(history.textContent).toMatch(/r1 · accept.*r1 · lock.*r1 · unlock.*r2 · accept/s);
    await userEvent.click(within(history).getByRole('button', { name: 'DRAFT FROM r1' }));
    await waitFor(() => expect(mutations()).toEqual([{ method: 'POST', url: '/api/canonical-geography/features/1/revisions/1/draft', body: undefined }]));
  });

  it('edits descriptive fields of accepted canon in place, sending only those fields', async () => {
    renderManager(data([feature()]));
    await selectFeature(1);
    await userEvent.click(button(inspector(), /EDIT NAME/));
    await userEvent.clear(screen.getByLabelText('Descriptive name'));
    await userEvent.type(screen.getByLabelText('Descriptive name'), 'South Isle');
    await userEvent.click(screen.getByRole('button', { name: 'SAVE NAME/NOTES' }));
    await waitFor(() => expect(mutations()).toHaveLength(1));
    expect(mutations()[0]).toEqual({ method: 'PATCH', url: '/api/canonical-geography/features/1',
      body: { name: 'South Isle', description: null, notes: null } });
  });
});

describe('tracing and saving drafts', () => {
  const traceSquare = () => act(() => session.update(s =>
    closeRing([[0, 0], [100, 0], [100, 100], [0, 100]].reduce((acc, [x, z]) => addPoint(acc, { x, z }), s))));

  it('starts tracing, then saves a DRAFT with an evidence calibration snapshot — never accepted', async () => {
    respond = () => ({ status: 201, body: feature({ id: 30, lifecycle_state: 'draft', revision: 0 }) });
    renderManager(data([]));
    await userEvent.click(screen.getByRole('button', { name: '+ TRACE NEW FEATURE' }));
    expect(onTracingChange).toHaveBeenLastCalledWith(true);
    expect(session.getState()).toMatchObject({ active: true, geometryType: 'polygon' });
    expect(screen.getByRole('button', { name: 'SAVE DRAFT' })).toBeDisabled(); // nothing traced yet

    traceSquare();
    await userEvent.type(screen.getByLabelText('Name'), 'Test Isle');
    await userEvent.click(screen.getByRole('button', { name: 'SAVE DRAFT' }));
    await waitFor(() => expect(mutations()).toHaveLength(1));
    const call = mutations()[0];
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/api/canonical-geography/features');
    expect(call.body).toMatchObject({
      feature_class: 'land', geometry_type: 'polygon', name: 'Test Isle', constraint_strength: 'hard',
      geometry: { outer: [{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 100, z: 100 }, { x: 0, z: 100 }], holes: [] },
      evidence: { reference_layer_id: 5, calibration_snapshot: { world_center_x: 12, world_center_z: -7, world_units_per_pixel: 250 / 127, rotation_rad: 0.1 } },
    });
    expect(call.body).not.toHaveProperty('lifecycle_state');
    expect(calls.some(c => c.url.includes('/accept'))).toBe(false);
    expect(await screen.findByRole('status')).toHaveTextContent('Saved DRAFT #30');
    expect(onTracingChange).toHaveBeenLastCalledWith(false);
    expect(session.getState().active).toBe(false);
  });

  it('keeps the trace and the form when the save is refused', async () => {
    respond = () => ({ status: 400, body: { error: 'geometry is invalid: something' } });
    renderManager(data([]));
    await userEvent.click(screen.getByRole('button', { name: '+ TRACE NEW FEATURE' }));
    traceSquare();
    await userEvent.type(screen.getByLabelText('Name'), 'Keep Me');
    await userEvent.click(screen.getByRole('button', { name: 'SAVE DRAFT' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('geometry is invalid: something');
    expect(session.getState().vertices).toHaveLength(4);
    expect(session.getState().active).toBe(true);
    expect(screen.getByLabelText('Name')).toHaveValue('Keep Me');
    expect(onTracingChange).not.toHaveBeenCalledWith(false);
  });

  it('edits an existing draft with PATCH and its draft_version, keeping saved evidence when no layer is chosen', async () => {
    const draft = feature({ id: 9, lifecycle_state: 'draft', revision: 0, draft_version: 4, evidence: { reference_layer_id: 99, note: 'old' } });
    respond = () => ({ status: 200, body: { ...draft, draft_version: 5 } });
    renderManager(data([draft]), { layers: [] });
    await selectFeature(9);
    await userEvent.click(button(inspector(), /EDIT DRAFT/));
    expect(session.getState()).toMatchObject({ featureId: 9, closed: true, vertices: square().outer });
    await userEvent.click(screen.getByRole('button', { name: 'SAVE DRAFT' }));
    await waitFor(() => expect(mutations()).toHaveLength(1));
    expect(mutations()[0].method).toBe('PATCH');
    expect(mutations()[0].url).toBe('/api/canonical-geography/features/9');
    expect(mutations()[0].body.expected_draft_version).toBe(4);
    expect(mutations()[0].body).not.toHaveProperty('evidence');
  });

  it('reads out world X/Z, metres and the evidence layer’s source pixel through worldToSource', async () => {
    renderManager(data([]), { tracingActive: true });
    await userEvent.click(screen.getByRole('button', { name: '+ TRACE NEW FEATURE' }));
    act(() => session.update(s => ({ ...addPoint(addPoint(s, { x: 0, z: 0 }), { x: 100, z: 0 }), hover: { x: 150, z: -40 } })));
    const readout = screen.getByLabelText('Tracing readout');
    const cell = (k: string) => readout.querySelector(`[data-readout="${k}"]`)!.textContent;
    expect(cell('world')).toBe('150.000, -40.000 wu');
    expect(cell('metres')).toBe('228.60, -60.96 m');
    const uv = worldToSource(layer, { x: 150, z: -40 });
    expect(sourcePixelReadout(layer, { x: 150, z: -40 })).toEqual(uv);
    expect(cell('source')).toBe(`${uv.u.toFixed(1)}, ${uv.v.toFixed(1)} px`);
    // 100 wu = 152.4 m; at 250/127 wu per source pixel that is 50.8 px (≈ 3 m per pixel).
    expect(cell('last-segment')).toBe('152.4 m · 50.8 px');
  });

  it('records a normalization construction with the draft', async () => {
    respond = () => ({ status: 201, body: feature({ id: 31, lifecycle_state: 'draft' }) });
    renderManager(data([]));
    await userEvent.click(screen.getByRole('button', { name: '+ TRACE NEW FEATURE' }));
    await userEvent.click(screen.getByRole('button', { name: 'CIRCLE 3PT' }));
    act(() => session.update(s => [[10, 0], [0, 10], [-10, 0]].reduce((acc, [x, z]) => addPoint(acc, { x, z }), s)));
    expect(screen.getByText(/Construction: circle/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'SAVE DRAFT' }));
    await waitFor(() => expect(mutations()).toHaveLength(1));
    expect(mutations()[0].body.construction).toMatchObject({ type: 'circle', center: { x: 0, z: 0 }, radius: 10, method: 'three_point' });
  });

  it('the explicit CLOSE button closes an open ring, with SNAP on or off', async () => {
    renderManager(data([]));
    await userEvent.click(screen.getByRole('button', { name: '+ TRACE NEW FEATURE' }));
    const threePoints = () => act(() => session.update(s => [[0, 0], [100, 0], [100, 100]].reduce((acc, [x, z]) => addPoint(acc, { x, z }), s)));
    threePoints();
    expect(session.getState().snapping).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'CLOSE' }));
    expect(session.getState().closed).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: 'UNDO' })); // reopen
    await userEvent.click(screen.getByLabelText('Snap'));
    expect(session.getState()).toMatchObject({ closed: false, snapping: false });
    await userEvent.click(screen.getByRole('button', { name: 'CLOSE' }));
    expect(session.getState().closed).toBe(true);
    expect(session.getState().vertices).toHaveLength(3);
  });

  it('asks before discarding an unsaved trace on close', async () => {
    renderManager(data([]));
    await userEvent.click(screen.getByRole('button', { name: '+ TRACE NEW FEATURE' }));
    traceSquare();
    await userEvent.click(screen.getByLabelText('Close canonical geography'));
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'DISCARD' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(session.getState().active).toBe(false);
  });
});

describe('segment readout: metres from world distance, pixels through the evidence layer calibration', () => {
  // 43.04 wu = 65.59 m. At the source scale (3 m per pixel, 250/127 wu per pixel) that is 21.86 px.
  const SEG_WU = 43.04;
  const imperial: ReferenceLayer = { ...layer, world_center_x: 0, world_center_z: 0, world_units_per_pixel: 250 / 127, rotation_rad: 0 };
  const segment = (a: { x: number; z: number }, b: { x: number; z: number }) =>
    addPoint(addPoint(beginTrace(IDLE_TRACE, { geometryType: 'polygon' }), a), b);
  const lastSegment = (trace: ReturnType<typeof segment>, evidence: ReferenceLayer | null) => {
    const { container } = render(<TraceReadout trace={trace} evidenceLayer={evidence} />);
    return container.querySelector('[data-readout="last-segment"]')!.textContent;
  };

  it('reads ~65.6 m as ~21.9 source px under the Imperial City source-scale calibration, not 43 px', () => {
    expect(lastSegment(segment({ x: 0, z: 0 }, { x: SEG_WU, z: 0 }), imperial)).toBe('65.6 m · 21.9 px');
  });

  it('measures pixels between both transformed endpoints, whatever the layer’s translation and rotation', () => {
    const moved: ReferenceLayer = { ...imperial, world_center_x: 812.5, world_center_z: -340.25, rotation_rad: 0.7 };
    const angle = 1.1;
    const a = { x: 500, z: -200 };
    const b = { x: a.x + SEG_WU * Math.cos(angle), z: a.z + SEG_WU * Math.sin(angle) };
    const ua = worldToSource(moved, a);
    const ub = worldToSource(moved, b);
    expect(Math.hypot(ub.u - ua.u, ub.v - ua.v)).toBeCloseTo(SEG_WU * 127 / 250, 6);
    expect(lastSegment(segment(a, b), moved)).toBe('65.6 m · 21.9 px');
  });

  it('keeps metres on the canonical world distance, independent of the evidence calibration', () => {
    const coarse: ReferenceLayer = { ...imperial, world_units_per_pixel: 1 };
    // A layer persisted at 1 wu per pixel really does put 43 source pixels under 43 wu.
    expect(lastSegment(segment({ x: 0, z: 0 }, { x: SEG_WU, z: 0 }), coarse)).toBe('65.6 m · 43.0 px');
    expect(lastSegment(segment({ x: 0, z: 0 }, { x: SEG_WU, z: 0 }), imperial)).toMatch(/^65\.6 m/);
  });

  it('shows no pixel distance without an evidence layer', () => {
    expect(lastSegment(segment({ x: 0, z: 0 }, { x: SEG_WU, z: 0 }), null)).toBe('65.6 m');
  });
});

describe('evidence status', () => {
  it('notes when the evidence layer was recalibrated or removed, informationally', () => {
    const snap = { world_center_x: 12, world_center_z: -7, world_units_per_pixel: 250 / 127, rotation_rad: 0.1 };
    expect(evidenceStatus(null, [layer])).toBe('none');
    expect(evidenceStatus({ reference_layer_id: 5, calibration_snapshot: snap }, [layer])).toBe('matches');
    expect(evidenceStatus({ reference_layer_id: 5, calibration_snapshot: { ...snap, rotation_rad: 0 } }, [layer])).toBe('differs');
    expect(evidenceStatus({ reference_layer_id: 6, calibration_snapshot: snap }, [layer])).toBe('layer_missing');
  });
});
