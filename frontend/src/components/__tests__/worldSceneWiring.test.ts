/**
 * That the canonical world scene actually mounts the scale-aware pieces.
 *
 * Both of these defects were failures of wiring rather than of arithmetic: the depth range
 * was whatever Three's constructor happened to default to, and the grid was drawn
 * unconditionally. A unit test of the new components passes whether or not `App.tsx` uses
 * them, so the wiring is checked here against the source — the same way the reference-layer
 * world-only boundary is checked.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const app = readFileSync(resolve(__dirname, '../../App.tsx'), 'utf8');

describe('the canonical world camera', () => {
  it('still declares the inherited camera and controls unchanged', () => {
    expect(app).toMatch(/<PerspectiveCamera makeDefault position=\{\[0, 200, 250\]\}/);
    expect(app).toMatch(/<CameraControls ref=\{controlsRef\} makeDefault/);
  });

  // Without this the camera keeps Three's default far of 2000, and any view wide enough to
  // hold a city-scale reference layer is entirely clipped.
  it('mounts adaptive clipping', () => {
    expect(app.match(/<AdaptiveClipping\b/g)).toHaveLength(1);
  });

  it('mounts it in the world branch, after the battle-map branch has closed', () => {
    const worldBranch = app.indexOf('<PerspectiveCamera makeDefault');
    expect(app.indexOf('<AdaptiveClipping')).toBeGreaterThan(worldBranch);
  });

  // The battle-map scene has its own orthographic camera and its own fixed range; none of
  // this applies there and none of it should reach it.
  it('leaves the battle-map camera alone', () => {
    const scene = readFileSync(resolve(__dirname, '../../BattleMapScene.tsx'), 'utf8');
    expect(scene).toMatch(/OrthographicCamera makeDefault[^/]*near=\{0\.1\} far=\{1000\}/);
    expect(scene).not.toMatch(/AdaptiveClipping|WorldGrid|CloseRangeOnly/);
  });
});

describe('the ground grid and its helpers', () => {
  it('draws city-grid through the scale-aware wrapper, not drei Grid directly', () => {
    expect(app).toMatch(/<WorldGrid name="city-grid"/);
    expect(app).not.toMatch(/<Grid name="city-grid"/);
  });

  it('keeps every inherited grid prop', () => {
    const line = app.split('\n').find(l => l.includes('<WorldGrid name="city-grid"'))!;
    for (const prop of [
      'infiniteGrid', 'fadeDistance={750}', 'fadeStrength={1.5}',
      'cellSize={1}', 'cellThickness={0.7}', 'sectionSize={10}', 'sectionThickness={1.2}',
      'sectionColor=', 'cellColor=', 'raycast=',
    ]) {
      expect(line, prop).toContain(prop);
    }
  });

  // The four 2000-unit bars through the origin: an admin alignment aid at working
  // distances, and dark streaks across the drawing at a city-wide one.
  it('gates city-ref-lines on the same view scale', () => {
    const helpers = app.indexOf('<CloseRangeOnly>');
    const refLines = app.indexOf('name="city-ref-lines"');
    expect(helpers).toBeGreaterThan(-1);
    expect(refLines).toBeGreaterThan(helpers);
    expect(app.indexOf('</CloseRangeOnly>')).toBeGreaterThan(refLines);
  });

  it('still only offers those helpers to an admin', () => {
    const gate = app.indexOf("{token !== '' && (");
    expect(gate).toBeGreaterThan(-1);
    expect(app.indexOf('<CloseRangeOnly>')).toBeGreaterThan(gate);
  });
});
