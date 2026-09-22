/**
 * The import → calibrate → display → lock workflow, driven the way a person drives it.
 *
 * The behaviour worth pinning is where state lives. Canonical values come from the map-data
 * hook and go back to the server; unsaved values live here and reach nothing but this
 * client's own scene. Getting that wrong in either direction is invisible until it matters:
 * writing on every keystroke floods the other clients, and dropping the draft on a failed
 * request costs somebody the alignment they were part-way through.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReferenceLayerManager } from '../ReferenceLayerManager';
import type { ReferenceLayer } from '../types';

const layer = (over: Partial<ReferenceLayer> = {}): ReferenceLayer => ({
  id: 1,
  name: 'Imperial City',
  asset_id: 9,
  asset_url: '/uploads/reference_layers/abc.png',
  original_name: 'city.png',
  format: 'png',
  source_width_px: 6032,
  source_height_px: 4584,
  world_center_x: 0,
  world_center_z: 0,
  world_units_per_pixel: 0.5,
  rotation_rad: 0,
  opacity: 1,
  is_visible: true,
  is_locked: false,
  provenance: 'imported',
  replacement_state: 'non_replaceable',
  ...over,
});

const ASSET = {
  id: 9,
  asset_url: '/uploads/reference_layers/abc.png',
  original_name: 'city.png',
  format: 'png' as const,
  source_width_px: 6032,
  source_height_px: 4584,
  content_hash: 'abc',
};

let fetchMock: ReturnType<typeof vi.fn>;
let onPreviewChange: ReturnType<typeof vi.fn>;
let refreshLayers: ReturnType<typeof vi.fn>;
let onClose: ReturnType<typeof vi.fn>;

const ok = (body: unknown = {}) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
const failure = (status: number, error: string) =>
  Promise.resolve({ ok: false, status, json: () => Promise.resolve({ error }) } as Response);

beforeEach(() => {
  onPreviewChange = vi.fn();
  refreshLayers = vi.fn();
  onClose = vi.fn();
  fetchMock = vi.fn((url: string) => (String(url).endsWith('/assets') ? ok([ASSET]) : ok({})));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

const show = (layers: ReferenceLayer[]) => render(
  <ReferenceLayerManager
    token="admintoken"
    layers={layers}
    refreshLayers={refreshLayers}
    onPreviewChange={onPreviewChange}
    onClose={onClose}
  />
);

/** The last preview handed to the scene. */
const lastPreview = () => onPreviewChange.mock.calls[onPreviewChange.mock.calls.length - 1][0];

/** The calls that were not the asset-inventory load. */
const writes = () => fetchMock.mock.calls.filter(c => !String(c[0]).endsWith('/assets'));

const openLayer = async (user: ReturnType<typeof userEvent.setup>, name = 'Imperial City') => {
  await user.click(screen.getByRole('button', { name: new RegExp(name) }));
};

describe('listing and selection', () => {
  it('says so when there is nothing yet', () => {
    show([]);
    expect(screen.getByText(/No reference layers yet/i)).toBeInTheDocument();
  });

  it('lists the persisted layers and marks their state', () => {
    show([layer(), layer({ id: 2, name: 'Draft Sheet', is_locked: true, is_visible: false })]);
    expect(screen.getByRole('button', { name: /Imperial City/ })).toBeInTheDocument();
    const second = screen.getByRole('button', { name: /Draft Sheet/ });
    expect(second.textContent).toContain('[LOCKED]');
    expect(second.textContent).toContain('[HIDDEN]');
  });

  it('shows the source and states that it cannot be changed', async () => {
    const user = userEvent.setup();
    show([layer()]);
    await openLayer(user);
    expect(screen.getByText(/city\.png — 6032 x 4584 PNG/)).toBeInTheDocument();
    expect(screen.getByText(/source of a layer cannot be changed/i)).toBeInTheDocument();
  });

  it('offers no way to repoint an existing layer at another source', async () => {
    const user = userEvent.setup();
    show([layer()]);
    await openLayer(user);
    // The only file input and asset picker belong to the "add a layer" form.
    expect(screen.queryByLabelText(/SOURCE_IMAGE/)).toBeNull();
    expect(screen.queryByLabelText(/OR_USE_EXISTING/)).toBeNull();
  });

  it('derives the world size from the draft scale', async () => {
    const user = userEvent.setup();
    show([layer()]);
    await openLayer(user);
    expect(screen.getByText(/WORLD_SIZE: 3016.0 x 2292.0/)).toBeInTheDocument();

    const scale = screen.getByLabelText(/WORLD_UNITS_PER_PIXEL/);
    await user.clear(scale);
    await user.type(scale, '1');
    expect(screen.getByText(/WORLD_SIZE: 6032.0 x 4584.0/)).toBeInTheDocument();
  });
});

describe('local draft preview', () => {
  it('previews an edit without sending anything', async () => {
    const user = userEvent.setup();
    show([layer()]);
    await openLayer(user);

    const x = screen.getByLabelText('WORLD_CENTER_X');
    await user.clear(x);
    await user.type(x, '250');

    expect(lastPreview()).toMatchObject({ id: 1, world_center_x: 250 });
    expect(writes()).toHaveLength(0);
  });

  it('previews rotation in degrees and commits it in radians', async () => {
    const user = userEvent.setup();
    show([layer()]);
    await openLayer(user);

    const rotation = screen.getByLabelText(/ROTATION_DEG/);
    await user.clear(rotation);
    await user.type(rotation, '90');
    expect(lastPreview().rotation_rad).toBeCloseTo(Math.PI / 2, 12);

    await user.click(screen.getByRole('button', { name: 'APPLY' }));
    await waitFor(() => expect(writes()).toHaveLength(1));

    const [url, init] = writes()[0];
    expect(url).toBe('/api/reference-layers/1');
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(init.body);
    expect(Object.keys(body)).toEqual(['rotation_rad']);
    expect(body.rotation_rad).toBeCloseTo(Math.PI / 2, 12);
  });

  it('clears the preview and refreshes canonical state on Apply', async () => {
    const user = userEvent.setup();
    show([layer()]);
    await openLayer(user);

    const x = screen.getByLabelText('WORLD_CENTER_X');
    await user.clear(x);
    await user.type(x, '9');
    await user.click(screen.getByRole('button', { name: 'APPLY' }));

    await waitFor(() => expect(refreshLayers).toHaveBeenCalled());
    expect(lastPreview()).toBeNull();
  });

  it('restores the persisted values on Cancel, with no request', async () => {
    const user = userEvent.setup();
    show([layer({ world_center_x: 12 })]);
    await openLayer(user);

    const x = screen.getByLabelText('WORLD_CENTER_X');
    await user.clear(x);
    await user.type(x, '9999');
    await user.click(screen.getByRole('button', { name: 'CANCEL' }));

    expect(lastPreview()).toBeNull();
    expect((screen.getByLabelText('WORLD_CENTER_X') as HTMLInputElement).value).toBe('12');
    expect(writes()).toHaveLength(0);
    expect(refreshLayers).not.toHaveBeenCalled();
  });

  it('keeps the draft and the preview when the server refuses the write', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((url: string) =>
      String(url).endsWith('/assets') ? ok([ASSET]) : failure(409, 'This layer is locked. Unlock it before changing world_center_x.'));

    show([layer()]);
    await openLayer(user);
    const x = screen.getByLabelText('WORLD_CENTER_X');
    await user.clear(x);
    await user.type(x, '77');
    await user.click(screen.getByRole('button', { name: 'APPLY' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Unlock it before changing/);
    expect((screen.getByLabelText('WORLD_CENTER_X') as HTMLInputElement).value).toBe('77');
    expect(lastPreview()).toMatchObject({ world_center_x: 77 });
    expect(refreshLayers).not.toHaveBeenCalled();
  });

  it('sends nothing at all when Apply is pressed with no changes', async () => {
    const user = userEvent.setup();
    show([layer()]);
    await openLayer(user);
    await user.click(screen.getByRole('button', { name: 'APPLY' }));
    expect(writes()).toHaveLength(0);
  });

  it('drops the preview when the manager closes', async () => {
    const user = userEvent.setup();
    const { unmount } = show([layer()]);
    await openLayer(user);
    const x = screen.getByLabelText('WORLD_CENTER_X');
    await user.clear(x);
    await user.type(x, '5');
    unmount();
    expect(lastPreview()).toBeNull();
  });
});

describe('display controls', () => {
  it('previews opacity and commits only that field', async () => {
    const user = userEvent.setup();
    show([layer()]);
    await openLayer(user);

    // A range input is dragged, not typed into.
    fireEvent.change(screen.getByLabelText(/OPACITY/), { target: { value: '0.3' } });
    expect(lastPreview().opacity).toBe(0.3);

    await user.click(screen.getByRole('button', { name: 'APPLY' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0][1].body)).toEqual({ opacity: 0.3 });
  });

  it('previews visibility and commits only that field', async () => {
    const user = userEvent.setup();
    show([layer()]);
    await openLayer(user);

    await user.click(screen.getByLabelText(/VISIBLE/));
    expect(lastPreview().is_visible).toBe(false);

    await user.click(screen.getByRole('button', { name: 'APPLY' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0][1].body)).toEqual({ is_visible: false });
  });
});

describe('locking', () => {
  it('disables name, calibration and delete while locked', async () => {
    const user = userEvent.setup();
    show([layer({ is_locked: true })]);
    await openLayer(user);

    for (const label of ['NAME', 'WORLD_CENTER_X', 'WORLD_CENTER_Z', /WORLD_UNITS_PER_PIXEL/, /ROTATION_DEG/]) {
      expect(screen.getByLabelText(label as any)).toBeDisabled();
    }
    expect(screen.getByRole('button', { name: 'DELETE' })).toBeDisabled();
  });

  it('leaves opacity and visibility usable while locked', async () => {
    const user = userEvent.setup();
    show([layer({ is_locked: true })]);
    await openLayer(user);
    expect(screen.getByLabelText(/OPACITY/)).not.toBeDisabled();
    expect(screen.getByLabelText(/VISIBLE/)).not.toBeDisabled();
  });

  // Unlocking is its own request: bundling it with an edit would make the lock a formality.
  it('unlocks in a request of its own that carries nothing else', async () => {
    const user = userEvent.setup();
    show([layer({ is_locked: true })]);
    await openLayer(user);

    await user.click(screen.getByRole('button', { name: 'UNLOCK' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0][1].body)).toEqual({ is_locked: false });
    expect(refreshLayers).toHaveBeenCalled();
  });

  it('locks an unlocked layer the same way', async () => {
    const user = userEvent.setup();
    show([layer()]);
    await openLayer(user);
    await user.click(screen.getByRole('button', { name: 'LOCK' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0][1].body)).toEqual({ is_locked: true });
  });
});

describe('deleting', () => {
  it('asks before deleting, and does nothing if the answer is no', async () => {
    const user = userEvent.setup();
    show([layer()]);
    await openLayer(user);

    await user.click(screen.getByRole('button', { name: 'DELETE' }));
    expect(screen.getByText(/Delete "Imperial City"\? This cannot be undone\./)).toBeInTheDocument();
    expect(writes()).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'KEEP' }));
    expect(writes()).toHaveLength(0);
  });

  it('deletes on confirmation and refreshes the list', async () => {
    const user = userEvent.setup();
    show([layer()]);
    await openLayer(user);
    await user.click(screen.getByRole('button', { name: 'DELETE' }));
    await user.click(screen.getByRole('button', { name: 'CONFIRM_DELETE' }));

    await waitFor(() => expect(refreshLayers).toHaveBeenCalled());
    expect(writes()[0][0]).toBe('/api/reference-layers/1');
    expect(writes()[0][1].method).toBe('DELETE');
  });

  it('surfaces a refusal instead of pretending it worked', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((url: string) =>
      String(url).endsWith('/assets') ? ok([ASSET]) : failure(409, 'This layer is locked. Unlock it before deleting.'));

    show([layer()]);
    await openLayer(user);
    await user.click(screen.getByRole('button', { name: 'DELETE' }));
    await user.click(screen.getByRole('button', { name: 'CONFIRM_DELETE' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Unlock it before deleting/);
    expect(refreshLayers).not.toHaveBeenCalled();
  });
});

describe('adding a layer', () => {
  const openForm = async (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('button', { name: '+ ADD_REFERENCE_LAYER' }));

  const pngFile = () => new File([new Uint8Array([137, 80, 78, 71])], 'imperial.png', { type: 'image/png' });

  it('uploads a chosen PNG with its name and scale', async () => {
    const user = userEvent.setup();
    show([]);
    await openForm(user);

    await user.upload(screen.getByLabelText(/SOURCE_IMAGE/), pngFile());
    const scale = screen.getByLabelText('WORLD_UNITS_PER_PIXEL');
    await user.clear(scale);
    await user.type(scale, '0.25');
    await user.click(screen.getByRole('button', { name: 'ADD' }));

    await waitFor(() => expect(refreshLayers).toHaveBeenCalled());
    const [url, init] = writes()[0];
    expect(url).toBe('/api/reference-layers/upload');
    expect(init.method).toBe('POST');
    const form = init.body as FormData;
    expect((form.get('image') as File).name).toBe('imperial.png');
    expect(form.get('name')).toBe('imperial');
    expect(form.get('world_units_per_pixel')).toBe('0.25');
  });

  it('limits the picker to the formats it can render', async () => {
    const user = userEvent.setup();
    show([]);
    await openForm(user);
    expect(screen.getByLabelText(/SOURCE_IMAGE/)).toHaveAttribute('accept', 'image/png,image/jpeg');
  });

  // The picker's `accept` is a filter, not a gate — a drag-and-drop, or "All files" in the
  // dialog, goes straight past it. So the check runs on the file itself as well.
  it('refuses a format it cannot render before uploading anything', async () => {
    const user = userEvent.setup();
    show([]);
    await openForm(user);

    const tiff = new File([new Uint8Array([1, 2, 3])], 'plan.tif', { type: 'image/tiff' });
    fireEvent.change(screen.getByLabelText(/SOURCE_IMAGE/), { target: { files: [tiff] } });

    expect(await screen.findByRole('alert')).toHaveTextContent(/not a PNG or JPEG/);
    await user.click(screen.getByRole('button', { name: 'ADD' }));
    expect(writes()).toHaveLength(0);
  });

  it('creates from an existing source by its id, with no upload', async () => {
    const user = userEvent.setup();
    show([]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/reference-layers/assets', expect.anything()));
    await openForm(user);

    await user.type(screen.getByLabelText('NAME'), 'Second Sheet');
    await user.selectOptions(await screen.findByLabelText(/OR_USE_EXISTING/), '9');
    await user.click(screen.getByRole('button', { name: 'ADD' }));

    await waitFor(() => expect(refreshLayers).toHaveBeenCalled());
    const [url, init] = writes()[0];
    expect(url).toBe('/api/reference-layers');
    expect(JSON.parse(init.body)).toMatchObject({ name: 'Second Sheet', asset_id: 9 });
  });

  it('will not submit without a name', async () => {
    const user = userEvent.setup();
    show([]);
    await openForm(user);
    await user.click(screen.getByRole('button', { name: 'ADD' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Give the layer a name/);
    expect(writes()).toHaveLength(0);
  });

  it('will not submit without a source', async () => {
    const user = userEvent.setup();
    show([]);
    await openForm(user);
    await user.type(screen.getByLabelText('NAME'), 'Nothing');
    await user.click(screen.getByRole('button', { name: 'ADD' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Choose a source image/);
    expect(writes()).toHaveLength(0);
  });

  it('reports what the server said when a create is refused', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((url: string) =>
      String(url).endsWith('/assets') ? ok([ASSET]) : failure(400, '"plan.png" is not supported. Use .png, .jpg, .jpeg.'));

    show([]);
    await openForm(user);
    await user.upload(screen.getByLabelText(/SOURCE_IMAGE/), pngFile());
    await user.click(screen.getByRole('button', { name: 'ADD' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/is not supported/);
    expect(refreshLayers).not.toHaveBeenCalled();
  });
});

describe('operational wording', () => {
  // The database and the uploads directory are two persistent things in two places, and a
  // legacy saved map covers neither. Saying so is cheaper than somebody finding out.
  it('does not describe saved maps as a backup of reference imagery', () => {
    show([layer()]);
    expect(screen.getByText(/Saved maps are not\s+a backup of them/i)).toBeInTheDocument();
  });
});
