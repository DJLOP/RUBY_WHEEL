/**
 * Drafts, and what separates an unsaved number from a committed one.
 *
 * Calibrating a drawing is a hundred small nudges. Each one has to be visible immediately
 * and none of them may reach the server or the other clients until somebody says so, so
 * the override is computed here and the request is built from the difference.
 */

import { describe, it, expect } from 'vitest';
import {
  withPreview,
  draftFromLayer,
  previewFromDraft,
  changedFields,
  validateSourceFile,
  toDegrees,
  toRadians,
} from '../preview';
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

describe('withPreview', () => {
  it('returns the persisted layers untouched when nothing is being edited', () => {
    const layers = [layer(), layer({ id: 2 })];
    expect(withPreview(layers, null)).toBe(layers);
  });

  it('overrides only the layer being edited', () => {
    const layers = [layer(), layer({ id: 2, world_center_x: 7 })];
    const out = withPreview(layers, { id: 2, world_center_x: 99 });
    expect(out[0]).toBe(layers[0]);
    expect(out[1].world_center_x).toBe(99);
    // The persisted object is not mutated: canonical state stays canonical.
    expect(layers[1].world_center_x).toBe(7);
  });

  it('leaves fields the draft says nothing about alone', () => {
    const out = withPreview([layer({ opacity: 0.8, rotation_rad: 1 })], { id: 1, world_center_x: 5 });
    expect(out[0]).toMatchObject({ world_center_x: 5, opacity: 0.8, rotation_rad: 1 });
  });

  it('never rewrites the source of a layer', () => {
    const out = withPreview([layer()], { id: 1, world_center_x: 5 } as any);
    expect(out[0].asset_id).toBe(9);
    expect(out[0].asset_url).toBe('/uploads/reference_layers/abc.png');
    expect(out[0].source_width_px).toBe(6032);
  });

  it('applies nothing for a layer that is no longer there', () => {
    const layers = [layer()];
    expect(withPreview(layers, { id: 404, opacity: 0 })).toEqual(layers);
  });
});

describe('draftFromLayer', () => {
  it('shows rotation in degrees while the layer persists radians', () => {
    expect(draftFromLayer(layer({ rotation_rad: Math.PI / 2 })).rotation_deg).toBe('90');
    expect(draftFromLayer(layer({ rotation_rad: -Math.PI })).rotation_deg).toBe('-180');
  });

  it('seeds every field from the persisted values', () => {
    expect(draftFromLayer(layer({ world_center_x: -12.5, world_center_z: 40, opacity: 0.3, is_visible: false })))
      .toEqual({
        name: 'Imperial City',
        world_center_x: '-12.5',
        world_center_z: '40',
        world_units_per_pixel: '0.5',
        rotation_deg: '0',
        opacity: 0.3,
        is_visible: false,
      });
  });
});

describe('previewFromDraft', () => {
  it('converts degrees to radians at the boundary', () => {
    const preview = previewFromDraft(layer(), { ...draftFromLayer(layer()), rotation_deg: '90' });
    expect(preview.rotation_rad).toBeCloseTo(Math.PI / 2, 12);
  });

  // Otherwise a layer jumps to the origin between keystrokes while somebody types "-12".
  it('falls back to the persisted value while a field is mid-edit', () => {
    const base = layer({ world_center_x: 500 });
    const preview = previewFromDraft(base, { ...draftFromLayer(base), world_center_x: '-' });
    expect(preview.world_center_x).toBe(500);
  });

  it('refuses to collapse the plane when the scale is emptied or zeroed', () => {
    const base = layer({ world_units_per_pixel: 0.5 });
    for (const text of ['', '0', '-3', 'abc']) {
      expect(previewFromDraft(base, { ...draftFromLayer(base), world_units_per_pixel: text }).world_units_per_pixel).toBe(0.5);
    }
  });
});

describe('changedFields', () => {
  it('sends nothing when nothing was touched', () => {
    const base = layer();
    expect(changedFields(base, draftFromLayer(base))).toEqual({});
  });

  // A locked layer refuses calibration, so bundling an untouched centre with an opacity
  // change would turn a permitted edit into a 409.
  it('sends only the display field when only display changed', () => {
    const base = layer();
    expect(changedFields(base, { ...draftFromLayer(base), opacity: 0.25 })).toEqual({ opacity: 0.25 });
    expect(changedFields(base, { ...draftFromLayer(base), is_visible: false })).toEqual({ is_visible: false });
  });

  it('sends calibration in radians, not degrees', () => {
    const base = layer();
    const patch = changedFields(base, { ...draftFromLayer(base), rotation_deg: '45' });
    expect(Object.keys(patch)).toEqual(['rotation_rad']);
    expect(patch.rotation_rad).toBeCloseTo(Math.PI / 4, 12);
  });

  it('trims a renamed layer and ignores a name that only gained whitespace', () => {
    const base = layer({ name: 'Imperial City' });
    expect(changedFields(base, { ...draftFromLayer(base), name: '  Imperial City  ' })).toEqual({});
    expect(changedFields(base, { ...draftFromLayer(base), name: ' New Name ' })).toEqual({ name: 'New Name' });
  });

  it('never includes the source', () => {
    const base = layer();
    const patch = changedFields(base, { ...draftFromLayer(base), world_center_x: '3' });
    expect(patch).not.toHaveProperty('asset_id');
    expect(patch).not.toHaveProperty('source_width_px');
  });
});

describe('degrees and radians', () => {
  it('round-trip', () => {
    for (const deg of [0, 45, 90, -137.5, 360]) expect(toDegrees(toRadians(deg))).toBeCloseTo(deg, 12);
  });
});

describe('validateSourceFile', () => {
  it('accepts a PNG or a JPEG', () => {
    expect(validateSourceFile({ name: 'city.png', type: 'image/png' }).ok).toBe(true);
    expect(validateSourceFile({ name: 'city.jpg', type: 'image/jpeg' }).ok).toBe(true);
    expect(validateSourceFile({ name: 'city.jpeg', type: '' }).ok).toBe(true);
  });

  it('refuses a format this feature cannot render', () => {
    const result = validateSourceFile({ name: 'city.tif', type: 'image/tiff' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/PNG or JPEG/);
  });

  it('refuses nothing chosen', () => {
    expect(validateSourceFile(null).ok).toBe(false);
  });

  // Advisory only: the name and the MIME type both come from the client. The server reads
  // the bytes and can still reject what this waves through.
  it('accepts on the extension alone when the browser reports no type', () => {
    expect(validateSourceFile({ name: 'plan.PNG', type: '' }).ok).toBe(true);
  });
});
