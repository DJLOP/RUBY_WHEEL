/**
 * The canonical physical scale: 1 world unit = 5 feet = 1.524 metres (R-005 / A-014).
 *
 * Every metre, kilometre and hectare figure canonical geography reports is derived here
 * from this one constant. Nothing in this module reads, writes or is parameterized by the
 * inherited `GLOBAL MAP SCALE (FT/UNIT)` setting (`global_settings.map_scale_multiplier`):
 * that control changes how inherited UI presents distance, and must not change how large
 * canonical geometry physically is.
 */

const METERS_PER_WORLD_UNIT = 1.524;
const SQUARE_METERS_PER_HECTARE = 10000;
const METERS_PER_KILOMETER = 1000;

const finite = (value, what) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${what} must be a finite number`);
  }
  return value;
};

/** A length in world units, in metres. */
const worldUnitsToMeters = (wu) => finite(wu, 'length') * METERS_PER_WORLD_UNIT;

/** A length in metres, in world units. */
const metersToWorldUnits = (m) => finite(m, 'length') / METERS_PER_WORLD_UNIT;

/** A length in world units, in kilometres. */
const worldUnitsToKilometers = (wu) => worldUnitsToMeters(wu) / METERS_PER_KILOMETER;

/** An area in square world units, in square metres. */
const squareWorldUnitsToSquareMeters = (wu2) =>
  finite(wu2, 'area') * METERS_PER_WORLD_UNIT * METERS_PER_WORLD_UNIT;

/** An area in square world units, in hectares. */
const squareWorldUnitsToHectares = (wu2) =>
  squareWorldUnitsToSquareMeters(wu2) / SQUARE_METERS_PER_HECTARE;

module.exports = {
  METERS_PER_WORLD_UNIT,
  worldUnitsToMeters,
  metersToWorldUnits,
  worldUnitsToKilometers,
  squareWorldUnitsToSquareMeters,
  squareWorldUnitsToHectares,
};
