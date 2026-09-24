/**
 * Canonical geography belongs to the canonical world scene, never to a battle map (plan
 * §10 "nothing rendered under BattleMapScene"). A battle map has its own camera, scale and
 * origin; island outlines in world X/Z mean nothing there.
 *
 * The scenes are branches of one Canvas in `App.tsx`, so this is a structural fact about
 * where the element sits, checked against the source like the reference-layer boundary.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (rel: string) => readFileSync(resolve(__dirname, '../../..', rel), 'utf8');

describe('canonical geography is confined to the world scene', () => {
  const app = read('App.tsx');

  it('renders the layer exactly once', () => {
    expect(app.match(/<CanonicalGeographyLayer\b/g)).toHaveLength(1);
  });

  it('renders it in the world branch, after the battle-map branch has closed, above the reference layers', () => {
    const battleBranch = app.indexOf("view === 'battle_map' ? (");
    const battleScene = app.indexOf('<BattleMapScene');
    const worldBranch = app.indexOf('<PerspectiveCamera makeDefault');
    const references = app.indexOf('<ReferenceLayers ');
    const layer = app.indexOf('<CanonicalGeographyLayer');
    expect(battleScene).toBeGreaterThan(battleBranch);
    expect(worldBranch).toBeGreaterThan(battleScene);
    expect(layer).toBeGreaterThan(worldBranch);
    expect(layer).toBeGreaterThan(references);
  });

  it('mounts the tracing tool once, in the world branch, only in the tracing view for the primary admin', () => {
    expect(app.match(/<TracingTool\b/g)).toHaveLength(1);
    const worldBranch = app.indexOf('<PerspectiveCamera makeDefault');
    const tool = app.indexOf('<TracingTool');
    expect(tool).toBeGreaterThan(worldBranch);
    expect(app).toMatch(/view === 'canonical_geo' && showCanonicalGeographyManager && isPrimaryAdmin && \(\s*<TracingTool/);
  });

  it('keeps buildings unselectable while tracing', () => {
    expect(app).toMatch(/if \(view === 'canonical_geo'\) return;/);
  });

  it('is not reachable from the battle-map scene or manager', () => {
    for (const file of ['BattleMapScene.tsx', 'BattleMapManager.tsx']) {
      expect(read(file)).not.toMatch(/canonicalGeography|CanonicalGeography|canonical-geography/);
    }
  });

  it('opens the manager shell for the primary administrator only', () => {
    expect(app).toMatch(/showCanonicalGeographyManager && isAdmin && isPrimaryAdmin && \(/);
  });
});
