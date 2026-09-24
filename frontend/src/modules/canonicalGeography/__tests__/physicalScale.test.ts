/**
 * The canonical physical scale on the client (R-005 / A-014): 1 wu = 1.524 m, from one
 * constant, independent of the inherited GLOBAL MAP SCALE setting.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  METERS_PER_WORLD_UNIT, worldUnitsToMeters, metersToWorldUnits, worldUnitsToKilometers,
  squareWorldUnitsToSquareMeters, squareWorldUnitsToHectares, formatLength, formatArea,
} from '../physicalScale';

describe('physical scale', () => {
  it('is 1.524 metres per world unit', () => {
    expect(METERS_PER_WORLD_UNIT).toBe(1.524);
    expect(worldUnitsToMeters(1000)).toBeCloseTo(1524, 9);
    expect(metersToWorldUnits(1524)).toBeCloseTo(1000, 9);
    expect(worldUnitsToKilometers(4425.2)).toBeCloseTo(6.744, 3); // the canonical wall span
  });

  it('converts areas: a 1,000 wu square is 1,524 m on a side', () => {
    expect(squareWorldUnitsToSquareMeters(1_000_000)).toBeCloseTo(1524 * 1524, 3);
    expect(squareWorldUnitsToHectares(1_000_000)).toBeCloseTo(232.2576, 6);
  });

  it('formats metres/kilometres and square metres/hectares', () => {
    expect(formatLength(10)).toBe('15.2 m');
    expect(formatLength(1000)).toBe('1.52 km');
    expect(formatArea(100)).toBe('232 m²');
    expect(formatArea(1_000_000)).toBe('232.26 ha');
  });

  it('refuses non-finite input rather than reporting NaN', () => {
    expect(() => worldUnitsToMeters(Number.NaN)).toThrow(TypeError);
    expect(() => squareWorldUnitsToHectares(Infinity)).toThrow(TypeError);
  });

  it('never reads the inherited map-scale setting', () => {
    const src = readFileSync(resolve(__dirname, '../physicalScale.ts'), 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
    expect(src).not.toMatch(/map_scale|mapScale|global_settings|import /);
  });
});
