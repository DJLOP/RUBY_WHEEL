// Normalized canonical macro geography: the governed spatial constraints generators must
// respect (docs/CANONICAL_GEOGRAPHY_PLAN.md). The generator seam (constraints.ts) and its
// types are pure; the layer and manager are the only React/Three.js pieces.

export { CanonicalGeographyLayer } from './CanonicalGeographyLayer';
export { CanonicalGeographyManager } from './CanonicalGeographyManager';
export { fetchCanonicalGeography, EMPTY_CANONICAL_GEOGRAPHY, CANONICAL_API } from './api';
export type { CanonicalGeographyData } from './api';
export { createCanonicalConstraints, pointInCanonicalPolygon } from './constraints';
export type { CanonicalConstraints, GroundClass, FootprintRect, FootprintConflict } from './constraints';
export * from './physicalScale';
export type * from './types';
