import type { ReferenceLayer } from './types';

/**
 * Unsaved edits, and how the local scene shows them.
 *
 * Calibrating a drawing means nudging a number and looking at the result, over and over.
 * Sending each nudge to the server would put a hundred writes and a hundred broadcasts
 * behind one adjustment, and would show every other client a layer sliding around while
 * somebody is still deciding where it goes.
 *
 * So a draft is local. It overrides the persisted layer in this client's renderer only;
 * canonical state, the other clients and the database all continue to see the saved
 * values until Apply. Cancel discards it with no request and no event.
 */

/** The fields a draft may override. Source identity is not among them, ever. */
export interface ReferenceLayerPreview {
  id: number;
  name?: string;
  world_center_x?: number;
  world_center_z?: number;
  world_units_per_pixel?: number;
  rotation_rad?: number;
  opacity?: number;
  is_visible?: boolean;
}

/**
 * The persisted layers with one draft laid over the layer it belongs to.
 *
 * Every other layer is returned untouched, and a draft for a layer that is no longer
 * there — deleted by this client or another — simply has nothing to apply to.
 */
export function withPreview(
  layers: ReferenceLayer[],
  preview: ReferenceLayerPreview | null,
): ReferenceLayer[] {
  if (!preview) return layers;
  return layers.map(layer => (layer.id === preview.id ? { ...layer, ...stripUndefined(preview) } : layer));
}

const stripUndefined = (preview: ReferenceLayerPreview) => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(preview)) {
    if (key !== 'id' && value !== undefined) out[key] = value;
  }
  return out;
};

// ─── form values ─────────────────────────────────────────────────────────────

/**
 * The editable fields, held as the strings a text input actually contains.
 *
 * Numbers are not parsed on every keystroke because a half-typed "-" or "0." is not a
 * number and would either snap the field back or move the layer to the origin while
 * somebody is still typing.
 */
export interface ReferenceLayerDraft {
  name: string;
  world_center_x: string;
  world_center_z: string;
  world_units_per_pixel: string;
  /** Degrees here and radians at the API boundary; only one of the two is persisted. */
  rotation_deg: string;
  opacity: number;
  is_visible: boolean;
}

export const RAD_PER_DEG = Math.PI / 180;

export const toDegrees = (rad: number) => (rad / RAD_PER_DEG);
export const toRadians = (deg: number) => deg * RAD_PER_DEG;

/** A draft seeded from the persisted values of a layer. */
export function draftFromLayer(layer: ReferenceLayer): ReferenceLayerDraft {
  return {
    name: layer.name,
    world_center_x: String(layer.world_center_x),
    world_center_z: String(layer.world_center_z),
    world_units_per_pixel: String(layer.world_units_per_pixel),
    rotation_deg: String(round(toDegrees(layer.rotation_rad), 6)),
    opacity: layer.opacity,
    is_visible: layer.is_visible,
  };
}

const round = (n: number, places: number) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

const numberOr = (text: string, fallback: number) => {
  const n = Number(String(text).trim());
  return Number.isFinite(n) ? n : fallback;
};

/**
 * What the local scene should draw for this draft.
 *
 * A field that is mid-edit and not yet a number falls back to the persisted value, so the
 * layer stays where it was rather than jumping to zero between keystrokes. Scale falls
 * back the same way, because a zero there would collapse the plane to nothing.
 */
export function previewFromDraft(layer: ReferenceLayer, draft: ReferenceLayerDraft): ReferenceLayerPreview {
  const scale = numberOr(draft.world_units_per_pixel, layer.world_units_per_pixel);
  return {
    id: layer.id,
    name: draft.name,
    world_center_x: numberOr(draft.world_center_x, layer.world_center_x),
    world_center_z: numberOr(draft.world_center_z, layer.world_center_z),
    world_units_per_pixel: scale > 0 ? scale : layer.world_units_per_pixel,
    rotation_rad: toRadians(numberOr(draft.rotation_deg, toDegrees(layer.rotation_rad))),
    opacity: draft.opacity,
    is_visible: draft.is_visible,
  };
}

/**
 * The patch a draft would send: only what actually differs from the persisted layer.
 *
 * Sending everything would make an opacity change look like a calibration change, which
 * a locked layer would then refuse — correctly, and confusingly.
 */
export function changedFields(layer: ReferenceLayer, draft: ReferenceLayerDraft) {
  const preview = previewFromDraft(layer, draft);
  const patch: Record<string, unknown> = {};

  if (preview.name !== undefined && preview.name.trim() !== layer.name) patch.name = preview.name.trim();
  for (const key of ['world_center_x', 'world_center_z', 'world_units_per_pixel', 'rotation_rad', 'opacity'] as const) {
    if (preview[key] !== layer[key]) patch[key] = preview[key];
  }
  if (preview.is_visible !== layer.is_visible) patch.is_visible = preview.is_visible;
  return patch;
}

// ─── source files ────────────────────────────────────────────────────────────

/** What the file picker offers. The server decides again from the bytes regardless. */
export const ACCEPTED_SOURCE_TYPES = 'image/png,image/jpeg';

/**
 * A quick local check so an obviously wrong file is refused before a large upload.
 *
 * Advisory only. Both the extension and the MIME type come from the client and neither is
 * evidence of anything; the server reads the bytes and can still reject what this accepts.
 */
export function validateSourceFile(file: { name?: string; type?: string } | null): { ok: boolean; error?: string } {
  if (!file) return { ok: false, error: 'Choose a PNG or JPEG image.' };

  const type = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();
  const typeOk = type === 'image/png' || type === 'image/jpeg' || type === 'image/jpg';
  const extOk = /\.(png|jpe?g)$/.test(name);

  if (!typeOk && !extOk) {
    return { ok: false, error: `${file.name || 'That file'} is not a PNG or JPEG.` };
  }
  return { ok: true };
}
