/**
 * The canonical physical scale: 1 world unit = 5 feet = 1.524 metres (R-005 / A-014).
 *
 * Every metre, kilometre and hectare figure the canonical-geography UI shows is derived
 * here from this one constant — the twin of backend/canonicalGeography/physicalScale.js.
 * Nothing here reads, writes or is parameterised by the inherited GLOBAL MAP SCALE
 * (FT/UNIT) setting: that control changes how inherited UI presents distance, never how
 * large canonical geometry physically is.
 */

export const METERS_PER_WORLD_UNIT = 1.524;
const SQUARE_METERS_PER_HECTARE = 10_000;
const METERS_PER_KILOMETER = 1_000;

function finite(value: number, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${what} must be a finite number`);
  return value;
}

/** A length in world units, in metres. */
export const worldUnitsToMeters = (wu: number): number => finite(wu, 'length') * METERS_PER_WORLD_UNIT;

/** A length in metres, in world units. */
export const metersToWorldUnits = (m: number): number => finite(m, 'length') / METERS_PER_WORLD_UNIT;

/** A length in world units, in kilometres. */
export const worldUnitsToKilometers = (wu: number): number => worldUnitsToMeters(wu) / METERS_PER_KILOMETER;

/** An area in square world units, in square metres. */
export const squareWorldUnitsToSquareMeters = (wu2: number): number =>
  finite(wu2, 'area') * METERS_PER_WORLD_UNIT * METERS_PER_WORLD_UNIT;

/** An area in square world units, in hectares. */
export const squareWorldUnitsToHectares = (wu2: number): number =>
  squareWorldUnitsToSquareMeters(wu2) / SQUARE_METERS_PER_HECTARE;

/** "12.3 m" below a kilometre, "1.23 km" from one kilometre up. */
export function formatLength(wu: number): string {
  const m = worldUnitsToMeters(wu);
  return Math.abs(m) < METERS_PER_KILOMETER ? `${m.toFixed(1)} m` : `${(m / METERS_PER_KILOMETER).toFixed(2)} km`;
}

/** "450 m²" below a hectare, "1.25 ha" from one hectare up. */
export function formatArea(wu2: number): string {
  const m2 = squareWorldUnitsToSquareMeters(wu2);
  return Math.abs(m2) < SQUARE_METERS_PER_HECTARE
    ? `${Math.round(m2).toLocaleString('en-US')} m²`
    : `${(m2 / SQUARE_METERS_PER_HECTARE).toFixed(2)} ha`;
}
