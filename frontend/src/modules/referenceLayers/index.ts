// Persistent calibrated reference layers: raster drawings of the Imperial City, placed in
// world coordinates so the procedural build has something authored to follow.
//
// The calibration is deliberately renderer-independent — see calibration.ts. The scene
// derives everything it draws from it; it never becomes the source of truth itself.

export { ReferenceLayers } from './ReferenceLayers';
export {
  sourceToWorld,
  worldToSource,
  planeDimensions,
  worldBounds,
  threeRotationY,
  referencePlaneProps,
  referenceMaterialProps,
  REFERENCE_LAYER_Y,
  REFERENCE_LAYER_Y_STEP,
  NO_RAYCAST,
} from './calibration';
export type { Calibration, SourcePoint, WorldPoint } from './calibration';
export type {
  ReferenceLayer,
  ReferenceAsset,
  ReferenceLayerCreatePayload,
  ReferenceLayerCreateFromAssetPayload,
  ReferenceLayerUpdatePayload,
} from './types';
