/**
 * A reference layer as the backend serialises it.
 *
 * Source dimensions and format belong to the asset, which is the stored raster, and are
 * read from its bytes by the server. They travel with the layer because the renderer needs
 * them to size a plane, but nothing in the client may write them: the source of a layer is
 * chosen once, at creation.
 */
export interface ReferenceLayer {
  id: number;
  name: string;

  /** The stored raster. Immutable for the life of the layer. */
  asset_id: number;
  asset_url: string;
  original_name: string | null;
  format: 'png' | 'jpeg';
  source_width_px: number;
  source_height_px: number;

  /** Where the centre of the source image sits in world X/Z. */
  world_center_x: number;
  world_center_z: number;
  /** Uniform scale. One source pixel is this many world units, so aspect is preserved. */
  world_units_per_pixel: number;
  /** Top-down clockwise rotation, in radians. Degrees are a UI convenience only. */
  rotation_rad: number;

  opacity: number;
  is_visible: boolean;
  is_locked: boolean;

  provenance: 'imported';
  replacement_state: 'non_replaceable';

  created_at?: string;
  updated_at?: string;
}

/** The calibration and display fields a client may send when creating a layer. */
export interface ReferenceLayerCreatePayload {
  name: string;
  world_center_x?: number;
  world_center_z?: number;
  world_units_per_pixel?: number;
  rotation_rad?: number;
  opacity?: number;
  is_visible?: boolean;
}

/** Creating a second layer from a source already uploaded. */
export interface ReferenceLayerCreateFromAssetPayload extends ReferenceLayerCreatePayload {
  asset_id: number;
}

/**
 * A partial update.
 *
 * There is no `asset_id` here and that is the point: using another source means creating
 * another layer, whether or not the layer is locked.
 */
export interface ReferenceLayerUpdatePayload {
  name?: string;
  world_center_x?: number;
  world_center_z?: number;
  world_units_per_pixel?: number;
  rotation_rad?: number;
  opacity?: number;
  is_visible?: boolean;
  is_locked?: boolean;
}

/** One previously uploaded source, as offered by the asset picker. */
export interface ReferenceAsset {
  id: number;
  asset_url: string;
  original_name: string | null;
  format: 'png' | 'jpeg';
  source_width_px: number;
  source_height_px: number;
  content_hash: string;
  created_at?: string;
}
