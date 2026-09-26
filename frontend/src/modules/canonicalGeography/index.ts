// Normalized canonical macro geography: the governed spatial constraints generators must
// respect (docs/CANONICAL_GEOGRAPHY_PLAN.md). The generator seam (constraints.ts) and its
// types are pure; the layer and manager are the only React/Three.js pieces.

export { CanonicalGeographyLayer } from './CanonicalGeographyLayer';
export { CanonicalGeographyManager } from './CanonicalGeographyManager';
export { TracingTool } from './TracingTool';
export { LandSelectionTool } from './LandSelectionTool';
export { CanonicalPickTool } from './CanonicalPickTool';
export { RadialConstructionPreview } from './RadialConstructionPreview';
export { createRadialSession } from './radialSession';
export type { RadialSession } from './radialSession';
export { createMapPickStore } from './mapPick';
export type { MapPickStore } from './mapPick';
export { createLandSelection } from './landSelection';
export type { LandSelectionStore } from './landSelection';
export { createTracingSession } from './tracing';
export type { TracingSession } from './tracing';
export { fetchCanonicalGeography, EMPTY_CANONICAL_GEOGRAPHY, CANONICAL_API, canonicalApi } from './api';
export type { CanonicalGeographyData } from './api';
export { createCanonicalConstraints, pointInCanonicalPolygon } from './constraints';
export type { CanonicalConstraints, GroundClass, FootprintRect, FootprintConflict } from './constraints';
export * from './physicalScale';
export type * from './types';
